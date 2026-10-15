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
