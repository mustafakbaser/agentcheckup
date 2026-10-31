/**
 * Text helpers shared by the fix builders, the planner and the applier: line endings next to an
 * offset, text edits on decoded text, composing two rounds of edits, and encoding text back to
 * the bytes of a file. Pure. Offsets index decoded text in UTF-16 code units, as everywhere
 * (src/core/types.ts).
 */
import { decode } from '../core/text.js';
import type { DecodedText, TextEdit } from '../core/types.js';

/** A line terminator as it appears in decoded text. */
export type Eol = '\n' | '\r\n';

/** Index of the line (0-based) that contains `offset`. Binary search over sorted line starts. */
export function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The terminator of line `index` (0-based), or undefined for the last line without one. */
export function terminatorOf(
  text: string,
  lineStarts: readonly number[],
  index: number,
): Eol | undefined {
  const next = lineStarts[index + 1];
  if (next === undefined) return undefined;
  return next >= 2 && text.charCodeAt(next - 2) === 0x0d ? '\r\n' : '\n';
}

/**
 * The line ending a new line at `offset` takes: the file's own when it uses one kind; in a file
 * with mixed endings, the ending of the line at `offset`, or of the nearest line before it that
 * has one; LF in a file without line breaks.
 */
export function eolNear(
  decoded: Pick<DecodedText, 'text' | 'lineStarts' | 'lineEnding'>,
  offset: number,
): Eol {
  switch (decoded.lineEnding) {
    case 'lf':
    case 'none':
      return '\n';
    case 'crlf':
      return '\r\n';
    case 'mixed': {
      const { text, lineStarts } = decoded;
      for (let index = lineIndexAt(lineStarts, offset); index >= 0; index--) {
        const eol = terminatorOf(text, lineStarts, index);
        if (eol !== undefined) return eol;
      }
      return '\n';
    }
  }
}

/** True when `text` contains a line feed or carriage return. */
export function hasLineBreak(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}

/** Replaces every CRLF and lone LF in `text` with `eol`. Lone CRs are left alone. */
export function withEol(text: string, eol: Eol): string {
  if (!text.includes('\n')) return text;
  const lf = text.replaceAll('\r\n', '\n');
  return eol === '\n' ? lf : lf.replaceAll('\n', '\r\n');
}

/** Leading spaces and tabs of the line that starts at `lineStart`. */
export function indentAt(text: string, lineStart: number): string {
  let end = lineStart;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code !== 0x20 && code !== 0x09) break;
    end++;
  }
  return text.slice(lineStart, end);
}

/** Offset where the line containing `offset` starts. Linear in the line's length. */
export function lineStartBefore(text: string, offset: number): number {
  const newline = text.lastIndexOf('\n', offset - 1);
  return newline + 1;
}

/** Offset of the end of the line containing `offset`, before its terminator. */
export function lineEndAfter(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  if (newline === -1) return text.length;
  return newline > offset && text.charCodeAt(newline - 1) === 0x0d ? newline - 1 : newline;
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/** Why a list of edits does not fit a text, or undefined when it does. */
export function editProblem(text: string, edits: readonly TextEdit[]): string | undefined {
  let previousEnd = -1;
  let previousInsert = -1;
  for (const edit of edits) {
    const { offset, length } = edit;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      return 'an edit has a negative or fractional offset or length';
    }
    const end = offset + length;
    if (end > text.length) return 'an edit reaches past the end of the file';
    if (offset < previousEnd) return 'edits overlap or are out of order';
    if (length === 0 && offset === previousInsert) return 'two insertions at one offset';
    if (splitsPair(text, offset) || splitsPair(text, end)) {
      return 'an edit splits a line break or a surrogate pair';
    }
    previousEnd = end;
    previousInsert = length === 0 ? offset : -1;
    if (length > 0) previousInsert = -1;
  }
  return undefined;
}

/** True when `offset` falls between CR and LF, or between the halves of a surrogate pair. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (before === 0x0d && after === 0x0a) return true;
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Applies sorted, non-overlapping edits. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;
  const parts: string[] = [];
  let position = 0;
  for (const edit of edits) {
    parts.push(text.slice(position, edit.offset), edit.text);
    position = edit.offset + edit.length;
  }
  parts.push(text.slice(position));
  return parts.join('');
}

/** Orders edits by offset; at one offset an insertion comes before a replacement. */
export function compareEdits(a: TextEdit, b: TextEdit): number {
  return a.offset - b.offset || a.length - b.length;
}

export function sameEdit(a: TextEdit, b: TextEdit): boolean {
  return a.offset === b.offset && a.length === b.length && a.text === b.text;
}

type Bias = 'left' | 'right';

/**
 * Maps an offset of the text before `edits` to the text after them. At an insertion point,
 * `left` stays before the inserted text and `right` moves after it.
 */
function mapForward(edits: readonly TextEdit[], point: number, bias: Bias): number {
  let delta = 0;
  for (const edit of edits) {
    const end = edit.offset + edit.length;
    if (edit.offset > point || (edit.offset === point && bias === 'left')) break;
    if (end <= point) {
      delta += edit.text.length - edit.length;
      continue;
    }
    return bias === 'left' ? edit.offset + delta : edit.offset + delta + edit.text.length;
  }
  return point + delta;
}

/**
 * Maps an offset of the text after `edits` back to the text before them. An offset inside
 * inserted text maps to the start (`left`) or end (`right`) of the range it replaced.
 */
function mapBackward(edits: readonly TextEdit[], point: number, bias: Bias): number {
  let delta = 0;
  for (const edit of edits) {
    const start = edit.offset + delta;
    const end = start + edit.text.length;
    if (start > point || (start === point && bias === 'left')) break;
    if (end <= point) {
      delta += edit.text.length - edit.length;
      continue;
    }
    return bias === 'left' ? edit.offset : edit.offset + edit.length;
  }
  return point - delta;
}

/**
 * Composes two lists of edits into one on the original text: `first` applies to `original`,
 * `second` to the result. Edits that touch or overlap merge into one, whose text is cut from the
 * final text. Both lists must be sorted and non-overlapping, as {@link editProblem} checks.
 */
export function composeEdits(
  original: string,
  first: readonly TextEdit[],
  second: readonly TextEdit[],
): TextEdit[] {
  if (second.length === 0) return [...first];
  const middle = applyEdits(original, first);
  const final = applyEdits(middle, second);
  const ranges: [number, number][] = first.map((edit) => [edit.offset, edit.offset + edit.length]);
  for (const edit of second) {
    ranges.push([
      mapBackward(first, edit.offset, 'left'),
      mapBackward(first, edit.offset + edit.length, 'right'),
    ]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const clusters: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = clusters.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else clusters.push([start, end]);
  }
  const composed: TextEdit[] = [];
  for (const [start, end] of clusters) {
    const from = mapForward(second, mapForward(first, start, 'left'), 'left');
    const to = mapForward(second, mapForward(first, end, 'right'), 'right');
    const text = final.slice(from, to);
    if (end - start === 0 && text === '') continue;
    composed.push({ offset: start, length: end - start, text });
  }
  return composed;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Encodes decoded text back to bytes in `encoding`, with a byte order mark when `bom`. */
export function encodeText(
  text: string,
  encoding: DecodedText['encoding'],
  bom: boolean,
): Uint8Array {
  if (encoding === 'utf-8') {
    const body = encoder.encode(text);
    if (!bom) return body;
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);
    return bytes;
  }
  const start = bom ? 2 : 0;
  const bytes = new Uint8Array(start + text.length * 2);
  const little = encoding === 'utf-16le';
  if (bom) bytes.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const at = start + i * 2;
    bytes[at] = little ? unit & 0xff : unit >>> 8;
    bytes[at + 1] = little ? unit >>> 8 : unit & 0xff;
  }
  return bytes;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ROUND_TRIPS = new WeakMap<
  DecodedText,
  { readonly bytes: Uint8Array; readonly result: boolean }
>();

/**
 * True when the file decoded without errors and encoding its text again gives its bytes back:
 * the only files a fix may edit (docs/adr/0008-write-fixes-to-the-scanned-repository.md). Known
 * per decoding of the same bytes: rules ask in every scan that `fix` runs to verify its fixes,
 * and a file the fixes leave alone keeps its bytes and its decoding.
 */
export function roundTrips(bytes: Uint8Array, decoded: DecodedText): boolean {
  const known = ROUND_TRIPS.get(decoded);
  if (known?.bytes === bytes) return known.result;
  const result =
    !decoded.hadDecodeErrors &&
    sameBytes(encodeText(decoded.text, decoded.encoding, decoded.hasBom), bytes);
  ROUND_TRIPS.set(decoded, { bytes, result });
  return result;
}

/**
 * Encodes `text` and checks that decoding gives it back, so a lone surrogate in inserted text
 * cannot turn into U+FFFD on disk unnoticed. Undefined when it does not.
 */
export function encodeChecked(
  text: string,
  encoding: DecodedText['encoding'],
  bom: boolean,
): Uint8Array | undefined {
  const bytes = encodeText(text, encoding, bom);
  const back = decode(bytes);
  if (back.hadDecodeErrors || back.text !== text) return undefined;
  if (back.encoding !== encoding || back.hasBom !== bom) return undefined;
  return bytes;
}
