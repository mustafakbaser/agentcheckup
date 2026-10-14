/**
 * Small span and text helpers shared by the parsers. Everything here is linear or logarithmic in
 * its input: the parsers run on untrusted files, so no helper may scan the text more than once.
 */
import type { Span } from '../core/types.js';

/** Builds a span from half-open `[start, end)` offsets, clamped to `[0, limit]`. */
export function spanBetween(start: number, end: number, limit: number): Span {
  const from = Math.min(Math.max(0, start), limit);
  const to = Math.min(Math.max(from, end), limit);
  return { offset: from, length: to - from };
}

/** Sorts spans by offset and merges overlapping or touching ones. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.offset - b.offset || a.length - b.length);
  const merged: Span[] = [];
  let current: { offset: number; end: number } | undefined;
  for (const span of sorted) {
    const end = span.offset + span.length;
    if (current && span.offset <= current.end) {
      current.end = Math.max(current.end, end);
      continue;
    }
    if (current) merged.push({ offset: current.offset, length: current.end - current.offset });
    current = { offset: span.offset, end };
  }
  if (current) merged.push({ offset: current.offset, length: current.end - current.offset });
  return merged;
}

/**
 * Index of the last span in `sorted` (sorted by offset, non-overlapping) whose offset is
 * `<= offset`, or -1. Binary search.
 */
function lastStartingAtOrBefore(sorted: readonly Span[], offset: number): number {
  let low = 0;
  let high = sorted.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const span = sorted[mid];
    if (span === undefined) break;
    if (span.offset <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** True when `offset` lies in `[span.offset, span.offset + span.length)` for some sorted span. */
export function spansContain(sorted: readonly Span[], offset: number): boolean {
  const span = sorted[lastStartingAtOrBefore(sorted, offset)];
  return span !== undefined && offset < span.offset + span.length;
}

/** Offset of the first span starting after `offset`, or `fallback` when there is none. */
export function nextSpanStart(sorted: readonly Span[], offset: number, fallback: number): number {
  const next = sorted[lastStartingAtOrBefore(sorted, offset) + 1];
  return next === undefined ? fallback : next.offset;
}

/** JavaScript `\s`: what a `/\s/` based tokenizer treats as whitespace. */
export function isJsWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

const MAX_MESSAGE_LENGTH = 200;

/**
 * Makes a library or user-derived message safe to print: control characters (which could carry
 * terminal escape sequences from a hostile file) become spaces and the length is bounded.
 */
export function cleanMessage(message: string): string {
  let out = '';
  for (const char of message) {
    if (out.length >= MAX_MESSAGE_LENGTH) return `${out}…`;
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  return out;
}
