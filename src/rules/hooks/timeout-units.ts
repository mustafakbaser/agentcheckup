import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonReplaceValue } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { at, FileFindings, type JsonPath, own, spanOf } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { formatInteger } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import type { HookPlatform } from './events.js';
import { PLATFORM_LABEL } from './platform-text.js';
import { HOOK_SOURCES } from './sources.js';
import { hookHandlers, hookPlatformOf } from './walk.js';

const ID = 'hooks/timeout-units';

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

/**
 * The timeout in the agent's unit when `timeout` was written in the other one: milliseconds
 * for Gemini CLI, whole seconds (rounded up) for the others.
 */
export function convertedTimeout(platform: HookPlatform, timeout: number): number {
  return platform === 'gemini' ? Math.round(timeout * 1000) : Math.ceil(timeout / 1000);
}

export function describeTimeout(platform: HookPlatform, timeout: number): string | undefined {
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  const label = PLATFORM_LABEL[platform];
  const converted = String(convertedTimeout(platform, timeout));
  if (platform === 'gemini') {
    if (timeout >= 1000) return undefined;
    return `Hook timeout is ${formatNumber(timeout)} milliseconds (${String(timeout / 1000)} seconds), because ${label} reads "timeout" in milliseconds. If you meant ${formatNumber(timeout)} seconds, write ${converted}.`;
  }
  if (!looksLikeMilliseconds(timeout)) return undefined;
  return `Hook timeout is ${formatNumber(timeout)} seconds (${duration(timeout)}), because ${label} reads "timeout" in seconds. If you meant ${formatNumber(timeout)} milliseconds, write ${converted}.`;
}

function fixFor(
  artifact: Artifact,
  platform: HookPlatform,
  path: JsonPath,
  timeout: number,
): Fix | undefined {
  const value = convertedTimeout(platform, timeout);
  if (value < 1) return undefined;
  const change = jsonReplaceValue(artifact, path, value);
  if (change === undefined) return undefined;
  const unit = platform === 'gemini' ? 'milliseconds' : 'seconds';
  return {
    id: `${ID}#${platform === 'gemini' ? 'to-milliseconds' : 'to-seconds'}`,
    class: 'review',
    title: `Set the hook timeout to ${formatInteger(value)} ${unit}`,
    changes: [change],
    notes: [
      `Assumes ${formatNumber(timeout)} was meant in ${platform === 'gemini' ? 'seconds' : 'milliseconds'}; ${PLATFORM_LABEL[platform]} then cancels the hook after ${formatInteger(value)} ${unit}.`,
    ],
  };
}

export const timeoutUnitsRule = defineRule({
  meta: {
    id: ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Rewrites the number in the unit the agent reads: divided by 1,000 and rounded up for Claude Code, Codex and Cursor, multiplied by 1,000 for Gemini CLI. Only the number changes.',
    },
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
      const canEdit = editable(artifact);
      for (const { handler, path } of hookHandlers(doc, platform)) {
        const timeout = own(handler, 'timeout');
        if (typeof timeout !== 'number') continue;
        const message = describeTimeout(platform, timeout);
        if (message === undefined) continue;
        const fix = canEdit ? fixFor(artifact, platform, [...path, 'timeout'], timeout) : undefined;
        findings.report({
          artifact,
          ...at(spanOf(doc, [...path, 'timeout'])),
          message,
          platforms: [platform],
          ...(fix === undefined ? {} : { fix }),
          ...(canEdit ? {} : { guidance: sharedFileGuidance(artifact) }),
        });
      }
      findings.finish();
    }
  },
});
