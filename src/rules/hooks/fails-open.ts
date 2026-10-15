import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { at, FileFindings, type JsonObject, own, spanOf } from '../json/access.js';
import { SOURCES } from '../sources.js';
import type { HookPlatform } from './events.js';
import { hookHandlers, hookPlatformOf } from './walk.js';

/** Events whose hooks can stop a tool call before it runs. */
const TOOL_GATES: Readonly<Record<HookPlatform, ReadonlySet<string>>> = {
  'claude-code': new Set(['PreToolUse']),
  codex: new Set(['PreToolUse']),
  cursor: new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']),
  gemini: new Set(['BeforeTool']),
};

function failsOpen(platform: HookPlatform, type: string | undefined, handler: JsonObject): boolean {
  switch (platform) {
    case 'claude-code':
      return (
        (type === 'command' || type === 'http') &&
        own(handler, 'onFailure') !== 'block' &&
        own(handler, 'async') !== true &&
        own(handler, 'asyncRewake') !== true
      );
    case 'cursor':
      return type === 'command' && own(handler, 'failClosed') !== true;
    case 'codex':
    case 'gemini':
      return type === 'command';
  }
}

function describe(platform: HookPlatform, event: string): string {
  switch (platform) {
    case 'claude-code':
      return `If this ${event} hook crashes, cannot start or times out, Claude Code lets the tool call proceed. If the hook enforces a policy, set "onFailure": "block" (Claude Code v2.1.295 or later).`;
    case 'cursor':
      return `If this ${event} hook crashes, times out or exits with an error other than code 2, Cursor lets the tool call proceed. If the hook enforces a policy, set "failClosed": true.`;
    case 'codex':
      return `If this ${event} hook fails or times out, Codex lets the tool call proceed and has no setting to block instead. If the hook enforces a policy, catch errors in the script and exit with code 2 and a reason on stderr.`;
    case 'gemini':
      return `If this ${event} hook exits with an error other than code 2, Gemini CLI shows a warning and runs the tool anyway. If the hook enforces a policy, catch errors in the script and exit with code 2.`;
  }
}

export const failsOpenRule = defineRule({
  meta: {
    id: 'hooks/fails-open',
    title: 'Tool-gating hook lets the tool call proceed when it fails',
    rationale: [
      'Hooks on events such as `PreToolUse` (Claude Code, Codex), `beforeShellExecution` (Cursor) and `BeforeTool` (Gemini CLI) can block a tool call, so they are used to enforce policies. By default all four agents fail open: when such a hook crashes or cannot start, the tool call proceeds as if the hook had allowed it. Claude Code, Codex and Cursor also let it proceed when the hook times out. A policy hook with a broken path or a slow dependency therefore protects nothing.',
      'This is documented behavior, so the finding is advice. To fail closed, set `"onFailure": "block"` on a Claude Code command or HTTP hook (v2.1.295 or later), or `"failClosed": true` on a Cursor hook. Codex and Gemini CLI have no such setting: the script has to catch its own errors and exit with code 2 (in Codex, with a reason on stderr).',
    ].join('\n\n'),
    category: 'risk',
    severity: 'info',
    appliesTo: ['claude-settings', 'codex-hooks', 'cursor-hooks', 'gemini-settings'],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini'],
    sources: [SOURCES.claudeHooks, SOURCES.cursorHooks, SOURCES.codexHooks, SOURCES.geminiHooks],
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
      }, 'hooks that fail open');
      for (const { event, handler, path, type } of hookHandlers(doc, platform)) {
        if (!TOOL_GATES[platform].has(event) || !failsOpen(platform, type, handler)) continue;
        const field = type === 'http' ? 'url' : 'command';
        findings.report({
          artifact,
          ...at(spanOf(doc, [...path, field]) ?? spanOf(doc, path)),
          message: describe(platform, event),
          platforms: [platform],
        });
      }
      findings.finish();
    }
  },
});
