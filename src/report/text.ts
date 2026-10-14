/**
 * Small text helpers shared by the formatters. Locale-independent: output is byte-identical on
 * every machine.
 */
import type { Severity, SkipReason, SymlinkProblem } from '../core/types.js';

/** Inclusive ranges rendered two columns wide by terminals (East Asian Wide/Fullwidth, emoji). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO_WIDTH_MARK = /^[\p{Mn}\p{Me}]$/u;

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [low, high] of ranges) {
    if (cp < low) return false;
    if (cp <= high) return true;
  }
  return false;
}

/**
 * Terminal column width, code-point aware: combining marks, ZWJ, presentation selectors and
 * skin-tone modifiers are zero wide, the character after a ZWJ joins the previous glyph, East
 * Asian wide characters and emoji are two wide. An approximation: terminals disagree on some
 * emoji, but ASCII, accented Latin, CJK and common emoji line up.
 */
export function displayWidth(text: string): number {
  let width = 0;
  let joined = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d) {
      joined = true;
      continue;
    }
    const zero =
      joined ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
      ZERO_WIDTH_MARK.test(ch);
    joined = false;
    if (zero) continue;
    width += inRanges(cp, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

/**
 * Cuts `text` to at most `max` code points, ending with `ellipsis` when cut. Never splits a
 * surrogate pair. Applied to untrusted text before sanitizing.
 */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  let count = 0;
  let end = 0;
  for (const ch of text) {
    if (count === max) return `${text.slice(0, end)}${ellipsis}`;
    count++;
    end += ch.length;
  }
  return text;
}

/** `1 error`, `2 errors`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Human severity word. Severity is always spelled out, never conveyed by color alone. */
export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
};

/** Higher is more severe. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 2, warn: 1, info: 0 };

export const SKIP_REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  'too-large': 'too large',
  binary: 'binary',
  'special-file': 'not a regular file',
  unreadable: 'unreadable',
  'file-limit': 'file limit reached',
  'byte-limit': 'byte limit reached',
  'depth-limit': 'too deep',
};

export const SYMLINK_PROBLEM_LABELS: Readonly<Record<SymlinkProblem, string>> = {
  'outside-root': 'points outside the scan root',
  broken: 'broken',
  'not-a-regular-file': 'not a regular file',
};

/**
 * Counts occurrences of each key, in the order of `order`, omitting zero counts:
 * `too large: 2, binary: 1`.
 */
export function breakdown<K extends string>(
  values: readonly K[],
  labels: Readonly<Record<K, string>>,
): string {
  const counts = new Map<K, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (Object.keys(labels) as K[])
    .filter((key) => counts.has(key))
    .map((key) => `${labels[key]}: ${counts.get(key) ?? 0}`)
    .join(', ');
}

/**
 * Plain-text rendering of the small Markdown subset used in rule rationales: links become
 * `text (url)`, code spans and strong emphasis lose their markers, backslash escapes resolve.
 */
export function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/\[([^[\]\n]*)\]\(([^()\s]*)\)/g, '$1 ($2)')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\\([!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-])/g, '$1');
}
