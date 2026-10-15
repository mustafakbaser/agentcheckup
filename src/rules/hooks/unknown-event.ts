import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { codexMisplacedEvents } from '../../platforms/hooks.js';
import { at, FileFindings, keySpanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { HOOK_EVENTS, HOOK_PLATFORMS, type HookPlatform } from './events.js';
import { PLATFORM_LABEL } from './platform-text.js';
import { HOOK_SOURCES } from './sources.js';
import { hookEvents, hookPlatformOf } from './walk.js';

const CONSEQUENCE: Readonly<Record<HookPlatform, string>> = {
  'claude-code': 'Claude Code skips these hooks with a Settings Warning.',
  codex: 'Codex ignores them without a warning, so these hooks never run.',
  cursor: 'Cursor never fires such an event, so these hooks never run.',
  gemini: 'Gemini CLI skips these hooks with an "Invalid hook event name" warning.',
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

export function describeUnknownEvent(platform: HookPlatform, name: string): string {
  const label = PLATFORM_LABEL[platform];
  const events = HOOK_EVENTS[platform];
  const consequence = CONSEQUENCE[platform];
  const lower = name.toLowerCase();
  const spelled = events.find((event) => event.toLowerCase() === lower);
  if (spelled !== undefined) {
    return `${quote(name)} is not a ${label} hook event; it is spelled ${quote(spelled)}. ${consequence}`;
  }
  const owner = HOOK_PLATFORMS.find(
    (other) => other !== platform && HOOK_EVENTS[other].includes(name),
  );
  if (owner !== undefined) {
    return `${quote(name)} is a ${PLATFORM_LABEL[owner]} hook event, not a ${label} one. ${consequence}`;
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
  return `${quote(name)} is not a ${label} hook event${hint}. ${consequence}`;
}

export const unknownEventRule = defineRule({
  meta: {
    id: 'hooks/unknown-event',
    title: 'Hook event name is not one the agent fires',
    rationale: [
      'Each agent fires a fixed, case-sensitive set of hook events: Claude Code and Codex use PascalCase names such as `PreToolUse`, Cursor camelCase names such as `beforeShellExecution`, and Gemini CLI its own names such as `BeforeTool`. Hooks under any other name never run. Claude Code skips them with a Settings Warning, Gemini CLI with an "Invalid hook event name" warning, and Codex without a warning.',
      'Wrong case (`preToolUse` in Claude Code, `PreToolUse` in `.cursor/hooks.json`) and names copied from another agent are the usual causes; the message gives the right name. In `.codex/hooks.json`, an event at the top level instead of inside `"hooks"` makes Codex skip the whole file.',
      'Rename the key to an event the agent fires.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['claude-settings', 'codex-hooks', 'cursor-hooks', 'gemini-settings'],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini'],
    sources: [
      SOURCES.claudeHooks,
      SOURCES.claudeSettings,
      SOURCES.codexHooks,
      HOOK_SOURCES.codexHookConfig,
      SOURCES.cursorHooks,
      HOOK_SOURCES.geminiHookReference,
      HOOK_SOURCES.geminiHookRegistry,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platform = hookPlatformOf(artifact);
      if (platform === undefined || !context.targets.has(platform)) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'unknown hook event names');
      const known = new Set(HOOK_EVENTS[platform]);
      for (const event of hookEvents(doc, platform)) {
        if (known.has(event.name)) continue;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, event.path)),
          message: describeUnknownEvent(platform, event.name),
          platforms: [platform],
        });
      }
      for (const { name: key, path } of platform === 'codex' ? codexMisplacedEvents(doc) : []) {
        findings.report({
          artifact,
          ...at(keySpanOf(doc, path)),
          message: `Event ${quote(key)} is outside the "hooks" object. Codex allows only "description" and "hooks" at the top level, so it skips the whole file and none of its hooks run.`,
          platforms: [platform],
        });
      }
      findings.finish();
    }
  },
});
