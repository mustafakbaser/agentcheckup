import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { at, FileFindings, own, spanOf } from '../json/access.js';
import { formatInteger } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import type { HookPlatform } from './events.js';
import { PLATFORM_LABEL } from './platform-text.js';
import { HOOK_SOURCES } from './sources.js';
import { hookHandlers, hookPlatformOf } from './walk.js';

function formatNumber(value: number): string {
  return Number.isInteger(value) ? formatInteger(value) : String(value);
}

/** `5000` seconds -> `about 83 minutes`. */
function duration(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes < 120) return `about ${formatInteger(Math.round(minutes))} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `about ${formatInteger(Math.round(hours))} hours`;
  return `about ${formatInteger(Math.round(hours / 24))} days`;
}

/**
 * A seconds value that reads as milliseconds: at least 1000 and a multiple of 500 (1000, 1500,
 * 5000, 30000), or a day or more. Long but plausible durations such as 1200, 1800 or 3600 seconds
 * are not reported.
 */
export function looksLikeMilliseconds(seconds: number): boolean {
  return (seconds >= 1000 && seconds % 500 === 0) || seconds >= 86_400;
}

export function describeTimeout(platform: HookPlatform, timeout: number): string | undefined {
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  const label = PLATFORM_LABEL[platform];
  if (platform === 'gemini') {
    if (timeout >= 1000) return undefined;
    return `Hook timeout is ${formatNumber(timeout)} milliseconds (${String(timeout / 1000)} seconds), because ${label} reads "timeout" in milliseconds. If you meant ${formatNumber(timeout)} seconds, write ${String(timeout * 1000)}.`;
  }
  if (!looksLikeMilliseconds(timeout)) return undefined;
  return `Hook timeout is ${formatNumber(timeout)} seconds (${duration(timeout)}), because ${label} reads "timeout" in seconds. If you meant ${formatNumber(timeout)} milliseconds, write ${String(Math.ceil(timeout / 1000))}.`;
}

export const timeoutUnitsRule = defineRule({
  meta: {
    id: 'hooks/timeout-units',
    title: 'Hook timeout looks like the wrong unit',
    rationale: [
      'Claude Code, Codex and Cursor read a hook\'s `timeout` in seconds; Claude Code and Codex default to 600. Gemini CLI reads it in milliseconds and defaults to 60,000. A value in the other unit is off by a factor of 1,000: `"timeout": 5000` meant as five seconds lets a hung hook block Claude Code for 83 minutes, and `"timeout": 30` cancels a Gemini CLI hook after 30 milliseconds.',
      'In seconds-based files the rule reports values of 1,000 or more that are multiples of 500, and values of a day or more; durations such as 1,800 or 3,600 seconds are not reported. In Gemini CLI settings it reports values below 1,000.',
      'Write the timeout in the unit of the agent that reads the file.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['claude-settings', 'codex-hooks', 'cursor-hooks', 'gemini-settings'],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini'],
    sources: [
      SOURCES.claudeHooks,
      SOURCES.codexHooks,
      HOOK_SOURCES.codexHookDiscovery,
      SOURCES.cursorHooks,
      HOOK_SOURCES.geminiHookReference,
      HOOK_SOURCES.geminiHookRunner,
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
      }, 'hook timeouts in the wrong unit');
      for (const { handler, path } of hookHandlers(doc, platform)) {
        const timeout = own(handler, 'timeout');
        if (typeof timeout !== 'number') continue;
        const message = describeTimeout(platform, timeout);
        if (message === undefined) continue;
        findings.report({
          artifact,
          ...at(spanOf(doc, [...path, 'timeout'])),
          message,
          platforms: [platform],
        });
      }
      findings.finish();
    }
  },
});
