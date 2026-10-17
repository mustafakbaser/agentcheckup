import type { DecodedText, LineEnding, Position, Range, Span } from './types.js';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * Decodes file bytes. Never throws: invalid sequences become U+FFFD and are flagged, so a
 * rule can report the encoding problem instead of the scan crashing on hostile input.
 */
export function decode(bytes: Uint8Array): DecodedText {
  let encoding: DecodedText['encoding'] = 'utf-8';
  let hasBom = false;
  let start = 0;

  if (bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    hasBom = true;
    start = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    hasBom = true;
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    hasBom = true;
    start = 2;
  }

  const body = bytes.subarray(start);
  let text: string;
  let hadDecodeErrors = false;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    hadDecodeErrors = true;
    text = new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(body);
  }

  const { lineStarts, lineEnding } = scanLines(text);
  return { text, encoding, hasBom, hadDecodeErrors, lineEnding, lineStarts };
}

function scanLines(text: string): { lineStarts: number[]; lineEnding: LineEnding } {
  const lineStarts = [0];
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      if (i > 0 && text.charCodeAt(i - 1) === 0x0d) crlf++;
      else lf++;
      lineStarts.push(i + 1);
    }
  }
  let lineEnding: LineEnding = 'none';
  if (lf > 0 && crlf > 0) lineEnding = 'mixed';
  else if (crlf > 0) lineEnding = 'crlf';
  else if (lf > 0) lineEnding = 'lf';
  return { lineStarts, lineEnding };
}

/** Converts an offset to a 1-based line/column. Offsets past the end clamp to the end. */
export function positionAt(decoded: DecodedText, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, decoded.text.length));
  const starts = decoded.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if ((starts[mid] ?? 0) <= clamped) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: clamped - (starts[low] ?? 0) + 1 };
}

export function rangeOf(decoded: DecodedText, span: Span | undefined): Range {
  if (span === undefined) {
    const start = { line: 1, column: 1 };
    return { start, end: start };
  }
  return {
    start: positionAt(decoded, span.offset),
    end: positionAt(decoded, span.offset + span.length),
  };
}

/** The text of line `line` (1-based) without its line terminator. */
export function lineText(decoded: DecodedText, line: number): string {
  const start = decoded.lineStarts[line - 1];
  if (start === undefined) return '';
  const next = decoded.lineStarts[line];
  let end = next ?? decoded.text.length;
  if (end > start && decoded.text.charCodeAt(end - 1) === 0x0a) end--;
  if (end > start && decoded.text.charCodeAt(end - 1) === 0x0d) end--;
  return decoded.text.slice(start, end);
}

/**
 * Levenshtein distance between `a` and `b` when it is at most `max`, otherwise `max + 1`. Stops
 * as soon as a row exceeds `max`, so the cost is bounded by the shorter string's length times
 * the longer one's, and the strings are short.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return Math.min(previous[b.length] ?? max + 1, max + 1);
}
