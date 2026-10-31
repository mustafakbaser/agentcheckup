import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  estimateTokens,
  lineCount,
  utf8ByteLength,
} from '../../src/core/measure.js';

describe('measure', () => {
  it('counts UTF-8 bytes, which is what Codex budgets in', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('ş')).toBe(2);
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it('counts code points, not UTF-16 units', () => {
    expect('😀'.length).toBe(2);
    expect(codePointLength('😀')).toBe(1);
    expect(codePointLength('İstanbul')).toBe(8);
  });

  it('counts a lone surrogate as one code point of three bytes, as TextEncoder writes U+FFFD', () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    for (const text of [high, low, `a${high}`, `${high}${high}${low}`, `${low}${high}`, '']) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
      expect(codePointLength(text)).toBe(Array.from(text).length);
    }
    expect(utf8ByteLength(high)).toBe(3);
    expect(codePointLength(`${high}${high}${low}`)).toBe(2);
  });

  it('agrees with TextEncoder and the string iterator on any text', () => {
    // Code units of every width, surrogates of both kinds among them, so lone ones come up often.
    const unit = fc
      .oneof(
        fc.integer({ min: 0, max: 0x7f }),
        fc.integer({ min: 0x80, max: 0x7ff }),
        fc.integer({ min: 0x800, max: 0xffff }),
        fc.integer({ min: 0xd800, max: 0xdfff }),
      )
      .map((code) => String.fromCharCode(code));
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 64 }), (text) => {
        expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
        expect(codePointLength(text)).toBe(Array.from(text).length);
      }),
      { numRuns: 2000 },
    );
  });

  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo', 2],
    ['one\r\ntwo\r\n', 2],
    ['\n\n', 2],
  ])('counts lines in %j', (text, expected) => {
    expect(lineCount(text)).toBe(expected);
  });

  it('estimates tokens at four characters each', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
