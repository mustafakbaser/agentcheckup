import { describe, expect, it } from 'vitest';
import { decode, lineText, positionAt, rangeOf } from '../../src/core/text.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('decode', () => {
  it('decodes plain UTF-8 without a BOM', () => {
    const decoded = decode(utf8('# Title\nbody\n'));
    expect(decoded).toMatchObject({
      text: '# Title\nbody\n',
      encoding: 'utf-8',
      hasBom: false,
      hadDecodeErrors: false,
      lineEnding: 'lf',
    });
    expect(decoded.lineStarts).toEqual([0, 8, 13]);
  });

  it('strips a UTF-8 BOM and records it', () => {
    const decoded = decode(bytes(0xef, 0xbb, 0xbf, 0x2d, 0x2d, 0x2d));
    expect(decoded.text).toBe('---');
    expect(decoded.hasBom).toBe(true);
    expect(decoded.encoding).toBe('utf-8');
  });

  it('decodes UTF-16 LE and BE when a BOM is present', () => {
    expect(decode(bytes(0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00))).toMatchObject({
      text: 'A\n',
      encoding: 'utf-16le',
      hasBom: true,
    });
    expect(decode(bytes(0xfe, 0xff, 0x00, 0x41))).toMatchObject({
      text: 'A',
      encoding: 'utf-16be',
    });
  });

  it('replaces invalid UTF-8 instead of throwing', () => {
    const decoded = decode(bytes(0x61, 0xff, 0x62));
    expect(decoded.hadDecodeErrors).toBe(true);
    expect(decoded.text).toBe('a�b');
  });

  it.each([
    ['a\r\nb\r\n', 'crlf'],
    ['a\nb\r\n', 'mixed'],
    ['single line', 'none'],
    ['', 'none'],
  ] as const)('detects line endings in %j', (text, expected) => {
    expect(decode(utf8(text)).lineEnding).toBe(expected);
  });
});

describe('positions', () => {
  const decoded = decode(utf8('ab\r\ncd\n\nşğ😀x'));

  it('maps offsets to 1-based line and UTF-16 column', () => {
    expect(positionAt(decoded, 0)).toEqual({ line: 1, column: 1 });
    expect(positionAt(decoded, 4)).toEqual({ line: 2, column: 1 });
    expect(positionAt(decoded, 8)).toEqual({ line: 4, column: 1 });
    // The emoji is two UTF-16 code units, so `x` sits at column 5.
    expect(positionAt(decoded, decoded.text.indexOf('x'))).toEqual({ line: 4, column: 5 });
  });

  it('clamps offsets outside the text', () => {
    expect(positionAt(decoded, -5)).toEqual({ line: 1, column: 1 });
    expect(positionAt(decoded, 10_000)).toEqual(positionAt(decoded, decoded.text.length));
  });

  it('returns a whole-file range when no span is given', () => {
    expect(rangeOf(decoded, undefined)).toEqual({
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
    });
    expect(rangeOf(decoded, { offset: 4, length: 2 })).toEqual({
      start: { line: 2, column: 1 },
      end: { line: 2, column: 3 },
    });
  });

  it('extracts line text without terminators', () => {
    expect(lineText(decoded, 1)).toBe('ab');
    expect(lineText(decoded, 3)).toBe('');
    expect(lineText(decoded, 4)).toBe('şğ😀x');
    expect(lineText(decoded, 99)).toBe('');
  });
});
