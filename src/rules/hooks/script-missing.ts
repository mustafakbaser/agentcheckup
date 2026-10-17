import { RULESET_VERSION } from '../../core/meta.js';
import { normalizeRelative, pathStatus } from '../../core/paths.js';
import type { Snapshot } from '../../core/types.js';
import {
  hookCommandSyntax,
  resolveScript as resolve,
  scriptCandidate as candidate,
} from '../../platforms/hook-command.js';
import { configDocument } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { at, FileFindings, type JsonObject, own, projectRootOf, spanOf } from '../json/access.js';
import { quote, quotePath } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import type { HookPlatform } from './events.js';
import { HOOK_SOURCES } from './sources.js';
import { hookHandlers, hookSourceOf } from './walk.js';

/** Handlers examined per file; bounds the work on hostile input. */
const MAX_HANDLERS = 500;

interface BelowIndex {
  /** Root-relative paths (directories without their trailing `/`) by last segment. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly answers: Map<string, boolean>;
  /** Path comparisons left for this snapshot; past zero every query answers "may exist". */
  budget: number;
}

/** Paths examined per query; a name shared by more paths answers "may exist". */
const MAX_BUCKET = 2_000;
/** Path comparisons per snapshot across all queries. */
const COMPARISON_BUDGET = 1_000_000;

const BELOW = new WeakMap<Snapshot, BelowIndex>();

function belowIndex(snapshot: Snapshot): BelowIndex {
  const cached = BELOW.get(snapshot);
  if (cached !== undefined) return cached;
  const byName = new Map<string, string[]>();
  for (const entry of snapshot.paths) {
    const path = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const list = byName.get(name);
    if (list === undefined) byName.set(name, [path]);
    else list.push(path);
  }
  const index: BelowIndex = { byName, answers: new Map(), budget: COMPARISON_BUDGET };
  BELOW.set(snapshot, index);
  return index;
}

/**
 * Whether `relative` exists under some subdirectory of `root`, where a session started in that
 * subdirectory would find it. Claude Code runs hooks in the session's current directory.
 * Built on a per-snapshot index, memoized and bounded, so many hooks over a large tree stay
 * cheap. When a bound is reached the answer is "may exist", which only suppresses findings.
 */
export function existsBelow(snapshot: Snapshot, root: string, relative: string): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized === undefined || normalized === '') return true;
  const index = belowIndex(snapshot);
  const key = `${root}\u0000${normalized}`;
  const known = index.answers.get(key);
  if (known !== undefined) return known;
  const bucket = index.byName.get(normalized.slice(normalized.lastIndexOf('/') + 1)) ?? [];
  let answer = true;
  if (bucket.length <= MAX_BUCKET && index.budget >= bucket.length) {
    index.budget -= bucket.length;
    const suffix = `/${normalized}`;
    const prefix = root === '' ? '' : `${root}/`;
    answer = bucket.some((path) => path.startsWith(prefix) && path.endsWith(suffix));
  }
  index.answers.set(key, answer);
  return answer;
}

/**
 * Claude Code events where `"onFailure": "block"` turns a hook failure into a block: the events
 * whose exit code 2 blocks, minus Stop, SubagentStop, TaskCompleted and TeammateIdle, where
 * onFailure has no effect. PermissionRequest is handled separately (the request is denied).
 */
const CLAUDE_FAILURE_BLOCKS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'TaskCreated',
  'ConfigChange',
  'PostToolBatch',
  'PreCompact',
  'PreModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'WorktreeCreate',
  'WorktreeRemove',
]);

/** What `"onFailure": "block"` does for this Claude Code hook, if anything. */
function claudeFailureEffect(handler: JsonObject, event: string): 'block' | 'deny' | undefined {
  if (own(handler, 'onFailure') !== 'block') return undefined;
  if (own(handler, 'async') === true || own(handler, 'asyncRewake') === true) return undefined;
  if (event === 'PermissionRequest') return 'deny';
  return CLAUDE_FAILURE_BLOCKS.has(event) ? 'block' : undefined;
}

function consequence(platform: HookPlatform, handler: JsonObject, event: string): string {
  switch (platform) {
    case 'claude-code': {
      const effect = claudeFailureEffect(handler, event);
      if (effect === 'block') {
        return 'The hook fails on every run, and because of "onFailure": "block", Claude Code blocks the action every time.';
      }
      if (effect === 'deny') {
        return 'The hook fails on every run, and because of "onFailure": "block", Claude Code denies the permission request every time.';
      }
      return 'The hook fails on every run; Claude Code reports a hook error and continues without it.';
    }
    case 'cursor':
      return own(handler, 'failClosed') === true
        ? 'The hook fails on every run, and because of "failClosed": true, Cursor blocks the action every time.'
        : 'The hook fails on every run, and Cursor continues without it.';
    case 'codex':
      return 'The hook fails on every run, and Codex continues without it.';
    case 'gemini':
      return 'The hook fails on every run, and Gemini CLI continues without it.';
    case 'copilot':
      return event === 'preToolUse'
        ? 'The hook fails on every run, and GitHub Copilot denies the tool call every time.'
        : 'The hook fails on every run, and GitHub Copilot continues without it.';
    case 'windsurf':
      return 'The hook fails on every run, and Devin Local continues without it.';
  }
}

export const scriptMissingRule = defineRule({
  meta: {
    id: 'hooks/script-missing',
    title: 'Hook command runs a script that does not exist',
    rationale: [
      'A command hook whose script is missing fails on every run. Claude Code treats a hook that "fails to start, for example because the script or executable doesn\'t exist" as a non-blocking error and, by default, lets the action proceed; Codex and Cursor also continue. The check the hook was meant to run never happens. With `"onFailure": "block"` (Claude Code) or `"failClosed": true` (Cursor), the same mistake blocks the action every time instead.',
      "The rule reports only paths it can resolve with certainty: `$CLAUDE_PROJECT_DIR`, `$CURSOR_PROJECT_DIR`, relative paths in Cursor (which runs project hooks from the project root), `$(git rev-parse --show-toplevel)` in a repository-root `.codex/hooks.json`, and script arguments of interpreters such as `node`, `python3` and `bash`. Claude Code runs hooks in the session's current directory, so a relative path there is reported only when no directory in the project has the file. Ignored and unlisted directories are never reported.",
      'Fix the path or add the script.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'error',
    appliesTo: ['claude-settings', 'codex-hooks', 'codex-config', 'cursor-hooks'],
    platforms: ['claude-code', 'codex', 'cursor'],
    sources: [
      SOURCES.claudeHooks,
      SOURCES.cursorHooks,
      SOURCES.codexHooks,
      HOOK_SOURCES.codexHookDiscovery,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const source = hookSourceOf(artifact);
      if (
        source === undefined ||
        source.platform === 'gemini' ||
        !context.targets.has(source.platform)
      ) {
        continue;
      }
      const { platform } = source;
      const doc = configDocument(context, artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'hooks with a missing script');
      const root = projectRootOf(artifact);
      const syntax = hookCommandSyntax(context.snapshot, platform, root);
      for (const { event, handler, path, type } of hookHandlers(doc, platform, {
        root: source.root,
      }).slice(0, MAX_HANDLERS)) {
        if (type !== 'command') continue;
        const found = candidate(handler, path, syntax);
        if (found === undefined) continue;
        const resolved = resolve(found.word, platform, root);
        if (resolved === undefined || pathStatus(context.snapshot, resolved.path) !== 'missing')
          continue;
        if (
          resolved.plain &&
          platform === 'claude-code' &&
          existsBelow(context.snapshot, root, found.word.text)
        ) {
          continue;
        }
        findings.report({
          artifact,
          ...at(spanOf(doc, found.path)),
          message: `Hook runs ${quote(resolved.path)}, which does not exist. ${consequence(platform, handler, event)}`,
          platforms: [platform],
          guidance: `create ${quotePath(resolved.path)}, correct the path in the hook command, or remove the hook`,
        });
      }
      findings.finish();
    }
  },
});
