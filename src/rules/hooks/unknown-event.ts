import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonRenameKey } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import type { Severity } from '../../core/types.js';
import { codexMisplacedEvents, devinEventInOtherCase } from '../../platforms/hooks.js';
import { configDocument, TOML_KINDS } from '../../platforms/kinds.js';
import { at, FileFindings, keySpanOf } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { HOOK_EVENTS, HOOK_PLATFORMS, type HookPlatform } from './events.js';
import { PLATFORM_LABEL } from './platform-text.js';
import { HOOK_SOURCES } from './sources.js';
import { type HookEvent, hookEvents, hookSourceOf } from './walk.js';

const ID = 'hooks/unknown-event';

const CONSEQUENCE: Readonly<Record<HookPlatform, string>> = {
  'claude-code': 'Claude Code skips these hooks with a Settings Warning.',
  codex: 'Codex ignores them without a warning, so these hooks never run.',
  cursor: 'Cursor never fires such an event, so these hooks never run.',
  gemini: 'Gemini CLI skips these hooks with an "Invalid hook event name" warning.',
  copilot: 'GitHub Copilot never fires such an event, so these hooks never run.',
  windsurf: 'Devin Local never fires such an event, so these hooks never run.',
};

/** Edit distance, bounded: strings longer than 40 characters are never compared. */
function distance(a: string, b: string): number {
  if (a.length > 40 || b.length > 40) return Number.POSITIVE_INFINITY;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current.push(
        Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Number.POSITIVE_INFINITY;
}

interface UnknownEvent {
  readonly message: string;
  /** The event the message names as the intended one, if any. */
  readonly suggestion?: string;
  /** Set when the consequence is not documented: information only. */
  readonly severity?: Severity;
}

function unknownEvent(platform: HookPlatform, name: string): UnknownEvent {
  const label = PLATFORM_LABEL[platform];
  const events = HOOK_EVENTS[platform];
  const consequence = CONSEQUENCE[platform];
  const lower = name.toLowerCase();
  const spelled = events.find((event) => event.toLowerCase() === lower);
  if (spelled !== undefined && platform === 'windsurf' && devinEventInOtherCase(name)) {
    return {
      message: `${quote(name)} is not a ${label} hook event; it is spelled ${quote(spelled)}. Devin Local documents event names in this spelling only and does not say whether it matches another, so these hooks may never run.`,
      suggestion: spelled,
      severity: 'info',
    };
  }
  if (spelled !== undefined) {
    return {
      message: `${quote(name)} is not a ${label} hook event; it is spelled ${quote(spelled)}. ${consequence}`,
      suggestion: spelled,
    };
  }
  const owner = HOOK_PLATFORMS.find(
    (other) => other !== platform && HOOK_EVENTS[other].includes(name),
  );
  if (owner !== undefined) {
    return {
      message: `${quote(name)} is a ${PLATFORM_LABEL[owner]} hook event, not a ${label} one. ${consequence}`,
    };
  }
  let nearest: string | undefined;
  let best = 3;
  for (const event of events) {
    const d = distance(lower, event.toLowerCase());
    if (d < best) {
      best = d;
      nearest = event;
    }
  }
  const hint = nearest === undefined ? '' : ` (did you mean ${quote(nearest)}?)`;
  return {
    message: `${quote(name)} is not a ${label} hook event${hint}. ${consequence}`,
    ...(nearest === undefined ? {} : { suggestion: nearest }),
  };
}

export function describeUnknownEvent(platform: HookPlatform, name: string): string {
  return unknownEvent(platform, name).message;
}

function fixFor(
  artifact: Artifact,
  platform: HookPlatform,
  event: HookEvent,
  suggestion: string,
): Fix | undefined {
  const change = jsonRenameKey(artifact, event.path, suggestion);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#rename`,
    class: 'review',
    title: `Rename hook event ${quote(event.name)} to ${quote(suggestion)}`,
    changes: [change],
    notes: [`${PLATFORM_LABEL[platform]} starts running the hooks under this event.`],
  };
}

export const unknownEventRule = defineRule({
  meta: {
    id: ID,
    title: 'Hook event name is not one the agent fires',
    rationale: [
      'Each agent fires a fixed, case-sensitive set of hook events: Claude Code and Codex use PascalCase names such as `PreToolUse`, Cursor camelCase names such as `beforeShellExecution`, and Gemini CLI its own names such as `BeforeTool`. Hooks under any other name never run. Claude Code skips them with a Settings Warning, Gemini CLI with an "Invalid hook event name" warning, and Codex without a warning. Codex\'s list follows its source, which fires `PreModelRequest` and `PostModelRequest` around each model request before its documentation lists them.',
      'Devin Local fires the eight events its documentation lists, such as `PreToolUse` and `PostCompaction`, for the hooks in `.devin/hooks.v1.json` and under `"hooks"` in `.devin/config.json` and `.devin/config.local.json`; hooks under any other name never run. Whether it also matches a listed name in another letter case is not documented, so such a name is information only. Cascade\'s snake_case events in `.devin/hooks.json` are not checked.',
      'Wrong case (`preToolUse` in Claude Code, `PreToolUse` in `.cursor/hooks.json`) and names copied from another agent are the usual causes; the message gives the right name. In `.codex/hooks.json`, an event at the top level instead of inside `"hooks"` makes Codex skip the whole file. Inline `[hooks]` tables in `.codex/config.toml` are checked too, without a fix.',
      'Rename the key to an event the agent fires.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: [
      'claude-settings',
      'codex-hooks',
      'codex-config',
      'cursor-hooks',
      'gemini-settings',
      'devin-config',
      'devin-hooks',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini', 'windsurf'],
    sources: [
      SOURCES.claudeHooks,
      SOURCES.claudeSettings,
      SOURCES.codexHooks,
      HOOK_SOURCES.codexHookConfig,
      HOOK_SOURCES.codexHookEvents,
      SOURCES.cursorHooks,
      HOOK_SOURCES.geminiHookReference,
      HOOK_SOURCES.geminiHookRegistry,
      SOURCES.devinCliHooks,
      SOURCES.devinCliHookEvents,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Renames the key to the event the message names: the same name in the right case, or the event within two edits of it. Always a review fix, because the hooks under it start to run. Not offered when the file already has that event.',
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
      }, 'unknown hook event names');
      const known = new Set(HOOK_EVENTS[platform]);
      const canEdit = editable(artifact);
      // No fix builder edits TOML.
      const toml = TOML_KINDS.has(artifact.kind);
      const events = hookEvents(doc, platform, source.root);
      const declared = new Set(events.map((event) => event.name));
      for (const event of events) {
        if (known.has(event.name)) continue;
        const { message, suggestion, severity } = unknownEvent(platform, event.name);
        const taken = suggestion !== undefined && declared.has(suggestion);
        const fix =
          canEdit && !toml && suggestion !== undefined && !taken
            ? fixFor(artifact, platform, event, suggestion)
            : undefined;
        const guidance = !canEdit
          ? sharedFileGuidance(artifact)
          : taken
            ? `move these hooks into the existing ${quote(suggestion)} entry`
            : toml && suggestion !== undefined
              ? `rename the event to ${quote(suggestion)}`
              : undefined;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, event.path)),
          message,
          platforms: [platform],
          ...(severity === undefined ? {} : { severity }),
          ...(fix === undefined ? {} : { fix }),
          ...(guidance === undefined ? {} : { guidance }),
        });
      }
      const misplaced = artifact.kind === 'codex-hooks' ? codexMisplacedEvents(doc) : [];
      for (const { name: key, path } of misplaced) {
        findings.report({
          artifact,
          ...at(keySpanOf(doc, path)),
          message: `Event ${quote(key)} is outside the "hooks" object. Codex allows only "description" and "hooks" at the top level, so it skips the whole file and none of its hooks run.`,
          platforms: [platform],
          guidance: `move ${quote(key)} and its hooks into the top-level "hooks" object`,
        });
      }
      findings.finish();
    }
  },
});
