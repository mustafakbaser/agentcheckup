/**
 * Independent safety predicates for formatter output. Deliberately not shared with
 * src/report/sanitize.ts: a bug in the sanitizer's tables must not hide itself in the tests.
 */
import fc from 'fast-check';
import { HOSTILE_STRINGS } from './hostile.js';

/** Code points that must never reach an output channel raw. */
const FORBIDDEN_INVISIBLE = new Set([
  0x061c, 0x200b, 0x200c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

function isPictographic(ch: string): boolean {
  return /^\p{Extended_Pictographic}$/u.test(ch);
}

/** Can be followed by ZWJ in an emoji sequence: emoji, skin tone, or emoji presentation. */
function joinable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return isPictographic(ch) || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0xfe0f;
}

function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

/**
 * Every unsafe code point in `text`, as `U+XXXX` strings: controls (C0 except the allowed ones,
 * DEL, C1), bidi controls, zero-width characters, tags, lone surrogates, and ZWJ / VS16 outside
 * emoji context.
 */
export function unsafeCodePoints(
  text: string,
  allow: { tab?: boolean; newline?: boolean } = {},
): string[] {
  const found: string[] = [];
  const chars = Array.from(text);
  chars.forEach((ch, index) => {
    const cp = ch.codePointAt(0)!;
    const previous = chars[index - 1] ?? '';
    const next = chars[index + 1] ?? '';
    let bad = false;
    if (cp === 0x09) bad = allow.tab !== true;
    else if (cp === 0x0a) bad = allow.newline !== true;
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) bad = true;
    else if (FORBIDDEN_INVISIBLE.has(cp) || isTag(cp)) bad = true;
    else if (cp >= 0xd800 && cp <= 0xdfff) bad = true;
    else if (cp === 0x200d) bad = !joinable(previous) || !isPictographic(next);
    else if (cp === 0xfe0f || cp === 0xfe0e) {
      const keycap = /^[#*\d]$/.test(previous) && next.codePointAt(0) === 0x20e3;
      bad = !isPictographic(previous) && !keycap;
    } else if ((cp >= 0xfe00 && cp <= 0xfe0d) || (cp >= 0xe0100 && cp <= 0xe01ef)) bad = true;
    if (bad) found.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  });
  return found;
}

/** True when the text contains ESC (0x1B) or BEL (0x07) anywhere. */
export function hasEscOrBel(text: string): boolean {
  return text.includes('\u001b') || text.includes('\u0007');
}

/** Any code point, lone surrogates included, mixed with fragments of the hostile corpus. */
export const hostileText: fc.Arbitrary<string> = fc.string({
  unit: fc.oneof(
    fc.integer({ min: 0, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp)),
    fc.integer({ min: 0, max: 0xa0 }).map((cp) => String.fromCodePoint(cp)),
    fc.constantFrom(...HOSTILE_STRINGS),
    fc.constantFrom(
      '\r',
      '\n',
      '\r\n',
      '\u001b',
      '::',
      '##[',
      '%',
      ':',
      ',',
      '@',
      '#',
      '|',
      '<',
      '[',
      ']',
      '\\',
    ),
  ),
  maxLength: 40,
});

/**
 * The lines of `text` the Actions runner reads as workflow commands: those whose first non-blank
 * characters are `::` (ActionCommand.TryParseV2), and those with `##[` anywhere, the older
 * syntax `##[name k=v;k=v]data` (ActionCommand.TryParse).
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionCommand.cs
 */
export function commandLines(text: string): string[] {
  return text
    .split(/\r\n?|\n/)
    .filter((line) => line.trimStart().startsWith('::') || line.includes('##['));
}

/**
 * Parses one workflow command line the way the Actions runner does (ActionCommand.TryParseV2):
 * `::name props::data`, properties split on `,` then the first `=`, values unescaped.
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionCommandManager.cs
 */
export function parseWorkflowCommand(line: string): {
  command: string;
  properties: Record<string, string>;
  data: string;
} {
  if (!line.startsWith('::')) throw new Error(`Not a command: ${line}`);
  const end = line.indexOf('::', 2);
  if (end < 0) throw new Error(`No data separator: ${line}`);
  const head = line.slice(2, end);
  const space = head.indexOf(' ');
  const command = space < 0 ? head : head.slice(0, space);
  const properties: Record<string, string> = {};
  if (space >= 0) {
    for (const pair of head.slice(space + 1).split(',')) {
      const eq = pair.indexOf('=');
      properties[pair.slice(0, eq)] = unescapeProperty(pair.slice(eq + 1));
    }
  }
  return { command, properties, data: unescapeData(line.slice(end + 2)) };
}

export function unescapeData(text: string): string {
  return text.replaceAll('%0D', '\r').replaceAll('%0A', '\n').replaceAll('%25', '%');
}

export function unescapeProperty(text: string): string {
  return text
    .replaceAll('%0D', '\r')
    .replaceAll('%0A', '\n')
    .replaceAll('%3A', ':')
    .replaceAll('%2C', ',')
    .replaceAll('%25', '%');
}

/** ANSI style that wraps with real SGR codes, to prove only the style emits ESC. */
export const ansiStyle = {
  red: (text: string) => `\u001b[31m${text}\u001b[39m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[39m`,
  blue: (text: string) => `\u001b[34m${text}\u001b[39m`,
  green: (text: string) => `\u001b[32m${text}\u001b[39m`,
  dim: (text: string) => `\u001b[2m${text}\u001b[22m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  underline: (text: string) => `\u001b[4m${text}\u001b[24m`,
  gray: (text: string) => `\u001b[90m${text}\u001b[39m`,
};

/** Removes exactly the SGR sequences {@link ansiStyle} emits. */
export function stripKnownSgr(text: string): string {
  let out = text;
  for (const code of ['31', '33', '34', '32', '2', '1', '4', '90', '39', '22', '24']) {
    out = out.replaceAll(`\u001b[${code}m`, '');
  }
  return out;
}

/** Tag style: makes the styled regions visible in snapshots. */
export const tagStyle = {
  red: (text: string) => `<red>${text}</red>`,
  yellow: (text: string) => `<yellow>${text}</yellow>`,
  blue: (text: string) => `<blue>${text}</blue>`,
  green: (text: string) => `<green>${text}</green>`,
  dim: (text: string) => `<dim>${text}</dim>`,
  bold: (text: string) => `<b>${text}</b>`,
  underline: (text: string) => `<u>${text}</u>`,
  gray: (text: string) => `<gray>${text}</gray>`,
};

/**
 * tsc's problem matcher, which actions/setup-node registers too:
 * `^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*(.*)$`.
 * Without its backtracking: a line matches it exactly when it starts with a character other than
 * white space and has {@link TSC_POSITION} after that character.
 * https://github.com/actions/setup-node/blob/main/.github/tsc.json
 */
const TSC_POSITION = /[(:]\d+[,:]\d+(?:\):\s+|\s+-\s+)(?:error|warning|info)\s+TS\d+\s*:/;
/**
 * The start of eslint-compact's problem matcher, which actions/setup-node registers too:
 * `^(.+):\sline\s(\d+),\scol\s(\d+),\s([Ee]rror|[Ww]arning|[Ii]nfo)\s-\s(.+)\s\((.+)\)$`.
 * https://github.com/actions/setup-node/blob/main/.github/eslint-compact.json
 */
const ESLINT_COMPACT_POSITION = /:\sline\s\d+,\scol\s\d+,\s(?:[Ee]rror|[Ww]arning|[Ii]nfo)\s-\s/g;

/** True when `rest` matches `^(.+)\s\((.+)\)$`, the end of eslint-compact's matcher. */
function endsAsCompact(rest: string): boolean {
  if (!rest.endsWith(')')) return false;
  for (let index = 1; index + 3 < rest.length; index++) {
    if (/\s/.test(rest.charAt(index)) && rest.charAt(index + 1) === '(') return true;
  }
  return false;
}

/**
 * The annotations the tsc and eslint-compact matchers make from `output`, one per line they
 * match, as `matcher: line`. The runner applies each to every line, after removing colors.
 */
export function singleLineMatcherAnnotations(output: string): string[] {
  const found: string[] = [];
  for (const line of stripKnownSgr(output).split('\n')) {
    if (/^\S/.test(line) && TSC_POSITION.test(line.slice(1))) found.push(`tsc: ${line}`);
    const compact = [...line.matchAll(ESLINT_COMPACT_POSITION)].some(
      (match) => match.index > 0 && endsAsCompact(line.slice(match.index + match[0].length)),
    );
    if (compact) found.push(`eslint-compact: ${line}`);
  }
  return found;
}
