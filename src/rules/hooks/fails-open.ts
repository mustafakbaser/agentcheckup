import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonInsertProperty, jsonReplaceValue } from '../../fix/edits.js';
import { failsOpen, TOOL_GATES } from '../../platforms/hooks.js';
import { configDocument } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { at, FileFindings, type JsonObject, type JsonPath, own, spanOf } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { SOURCES } from '../sources.js';
import type { HookPlatform } from './events.js';
import { hookHandlers, hookSourceOf } from './walk.js';

const ID = 'hooks/fails-open';

/** The setting that makes a hook fail closed, where the agent has one. */
const FAIL_CLOSED: Readonly<Partial<Record<HookPlatform, { key: string; value: string | true }>>> =
  {
    'claude-code': { key: 'onFailure', value: 'block' },
    cursor: { key: 'failClosed', value: true },
  };

function fixFor(
  artifact: Artifact,
  platform: HookPlatform,
  event: string,
  handler: JsonObject,
  path: JsonPath,
): Fix | undefined {
  const setting = FAIL_CLOSED[platform];
  if (setting === undefined) return undefined;
  const change =
    own(handler, setting.key) === undefined
      ? jsonInsertProperty(artifact, path, setting.key, setting.value)
      : jsonReplaceValue(artifact, [...path, setting.key], setting.value);
  if (change === undefined) return undefined;
  const written = `"${setting.key}": ${JSON.stringify(setting.value)}`;
  const notes =
    platform === 'claude-code'
      ? [
          `If this ${event} hook crashes, cannot start or times out, Claude Code blocks the tool call. Claude Code before v2.1.295 ignores "onFailure".`,
        ]
      : [
          `If this ${event} hook crashes, times out or exits with an error, Cursor blocks the action.`,
        ];
  return {
    id: `${ID}#${setting.key}`,
    class: 'review',
    title: `Set ${written} on this ${event} hook`,
    changes: [change],
    notes,
  };
}

function describe(platform: HookPlatform, event: string, type: string | undefined): string {
  switch (platform) {
    case 'claude-code':
      return `If this ${event} hook crashes, cannot start or times out, Claude Code lets the tool call proceed. If the hook enforces a policy, set "onFailure": "block" (Claude Code v2.1.295 or later).`;
    case 'cursor':
      return `If this ${event} hook crashes, times out or exits with an error other than code 2, Cursor lets the tool call proceed. If the hook enforces a policy, set "failClosed": true.`;
    case 'codex':
      return `If this ${event} hook fails or times out, Codex lets the tool call proceed and has no setting to block instead. If the hook enforces a policy, catch errors in the script and exit with code 2 and a reason on stderr.`;
    case 'gemini':
      return `If this ${event} hook exits with an error other than code 2, Gemini CLI shows a warning and runs the tool anyway. If the hook enforces a policy, catch errors in the script and exit with code 2.`;
    case 'copilot':
      return type === 'http'
        ? `If this ${event} HTTP hook fails, times out or answers with an error status, GitHub Copilot falls back to its usual permission flow, so the tool call can proceed.`
        : `If this ${event} hook exits with an error other than code 2, VS Code, which reads this PascalCase name, continues and runs the tool. The Copilot CLI and cloud agent deny the tool call when a preToolUse command hook fails.`;
    case 'windsurf':
      return `If this ${event} hook times out or exits with an error other than code 2, Devin Local logs it and runs the tool anyway. If the hook enforces a policy, catch errors in the script and exit with code 2.`;
  }
}

export const failsOpenRule = defineRule({
  meta: {
    id: ID,
    title: 'Tool-gating hook lets the tool call proceed when it fails',
    rationale: [
      'Hooks on events such as `PreToolUse` (Claude Code, Codex, Devin Local), `beforeShellExecution` (Cursor) and `BeforeTool` (Gemini CLI) can block a tool call, so they are used to enforce policies. By default all five agents fail open: when such a hook crashes or cannot start, the tool call proceeds as if the hook had allowed it. Claude Code, Codex, Cursor and Devin Local also let it proceed when the hook times out. A policy hook with a broken path or a slow dependency therefore protects nothing.',
      'This is documented behavior, so the finding is advice. To fail closed, set `"onFailure": "block"` on a Claude Code command or HTTP hook (v2.1.295 or later), or `"failClosed": true` on a Cursor hook. Codex, Gemini CLI and Devin Local have no such setting: the script has to catch its own errors and exit with code 2 (in Codex, with a reason on stderr).',
    ].join('\n\n'),
    category: 'risk',
    severity: 'info',
    appliesTo: [
      'claude-settings',
      'codex-hooks',
      'codex-config',
      'cursor-hooks',
      'gemini-settings',
      'devin-hooks',
      'devin-config',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini', 'windsurf'],
    sources: [
      SOURCES.claudeHooks,
      SOURCES.cursorHooks,
      SOURCES.codexHooks,
      SOURCES.geminiHooks,
      SOURCES.devinCliHooks,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Sets "onFailure": "block" on the Claude Code hook or "failClosed": true on the Cursor hook. Codex, Gemini CLI and Devin Local have no such setting, so their scripts must be changed by hand.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const source = hookSourceOf(artifact);
      if (source === undefined || !context.targets.has(source.platform)) continue;
      const { platform } = source;
      const doc = configDocument(context, artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'hooks that fail open');
      const canEdit = editable(artifact);
      for (const { event, handler, path, type } of hookHandlers(doc, platform, {
        root: source.root,
      })) {
        if (!TOOL_GATES[platform].has(event) || !failsOpen(platform, type, handler, event)) {
          continue;
        }
        const field = type === 'http' ? 'url' : 'command';
        const fix =
          canEdit && findings.listsNext
            ? fixFor(artifact, platform, event, handler, path)
            : undefined;
        // Codex, Gemini CLI and Devin Local: the message says what to change in the script.
        findings.report({
          artifact,
          ...at(spanOf(doc, [...path, field]) ?? spanOf(doc, path)),
          message: describe(platform, event, type),
          platforms: [platform],
          ...(fix === undefined ? {} : { fix }),
          ...(canEdit || FAIL_CLOSED[platform] === undefined
            ? {}
            : { guidance: sharedFileGuidance(artifact) }),
        });
      }
      findings.finish();
    }
  },
});
