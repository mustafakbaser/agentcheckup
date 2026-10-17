/**
 * Message formatting shared by every rule family.
 *
 * Output must be identical on every machine, so nothing here depends on the locale:
 * `toLocaleString` would print `41.207` on a Turkish or German machine and `41,207` elsewhere.
 * Untrusted values are quoted and length-bounded here; control and invisible characters are left
 * to the output sanitizers in src/report/sanitize.ts.
 */
import { formatInteger } from '../../core/format.js';
import type { PlatformId } from '../../core/types.js';
import { AGENT_NAMES, ALL_CONTEXT_AGENTS, CONTEXT_PLATFORM } from '../../platforms/load/types.js';

export { formatInteger };

/** `1 line`, `2 lines`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInteger(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Longest untrusted excerpt quoted in a message, in code points. */
export const MAX_QUOTED_LENGTH = 60;
/** Paths are quoted with more room, so that typical repository paths stay whole. */
export const MAX_QUOTED_PATH_LENGTH = 120;

/**
 * Wraps an untrusted value in double quotes, truncated to `max` code points (never splitting a
 * surrogate pair) with a trailing ellipsis. Line breaks and tabs become spaces so the excerpt
 * stays on one line.
 */
export function quote(value: string, max = MAX_QUOTED_LENGTH): string {
  let out = '';
  let count = 0;
  for (const char of value) {
    if (count === max) return `"${out}…"`;
    out += char === '\n' || char === '\r' || char === '\t' ? ' ' : char;
    count++;
  }
  return `"${out}"`;
}

/** An untrusted repository path, quoted. */
export function quotePath(path: string): string {
  return quote(path, MAX_QUOTED_PATH_LENGTH);
}

const PLATFORM_NAMES: Readonly<Record<PlatformId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  cline: 'Cline',
};

export function platformName(platform: PlatformId): string {
  return PLATFORM_NAMES[platform];
}

/** `['a', 'b', 'c']` -> `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** `['codex', 'gemini']` -> `Codex and Gemini CLI`. */
export function platformList(platforms: readonly PlatformId[]): string {
  return joinNames(platforms.map(platformName));
}

/**
 * Who reads a platform's files, by name: its agent when it has one, such as Devin Local for
 * `windsurf` (AGENT_NAMES), and the platform when several agents share it, such as GitHub
 * Copilot for its CLI, VS Code and cloud agent.
 */
export function readerName(platform: PlatformId): string {
  const agents = ALL_CONTEXT_AGENTS.filter((agent) => CONTEXT_PLATFORM[agent] === platform);
  const [only] = agents;
  return agents.length === 1 && only !== undefined ? AGENT_NAMES[only] : platformName(platform);
}

/** `['copilot', 'windsurf']` -> `GitHub Copilot and Devin Local`. */
export function readerList(platforms: readonly PlatformId[]): string {
  return joinNames(platforms.map(readerName));
}

/**
 * `Codex skips the skill`, `Codex and Gemini CLI skip the skill`, or undefined when the list is
 * empty. `verb` holds the singular and plural forms.
 */
export function platformsDo(
  platforms: readonly PlatformId[],
  verb: readonly [singular: string, plural: string],
  rest: string,
): string | undefined {
  if (platforms.length === 0) return undefined;
  return `${platformList(platforms)} ${platforms.length === 1 ? verb[0] : verb[1]} ${rest}`;
}

/**
 * Joins clauses that may contain "and" themselves: `A`, `A, and B`, `A, B, and C`. The serial
 * comma keeps the clause boundaries readable.
 */
export function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1] ?? ''}`;
}

/** Upper-cases the first character and ends the text with a period. */
export function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The YAML or JSON type of a parsed value, as a noun phrase for messages. */
export function describeType(value: unknown): string {
  if (value === null) return 'empty (null)';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return 'a map';
}

/** `U+202E`: upper-case hex, at least four digits. */
export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}
