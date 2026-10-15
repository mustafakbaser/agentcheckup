import { describe, expect, it } from 'vitest';
import {
  cleanMessage,
  isJsWhitespace,
  mergeSpans,
  nextSpanStart,
  spanBetween,
  spansContain,
} from '../../src/parse/spans.js';

describe('span helpers', () => {
  it('clamps spans to the text', () => {
    expect(spanBetween(-5, 3, 10)).toEqual({ offset: 0, length: 3 });
    expect(spanBetween(8, 20, 10)).toEqual({ offset: 8, length: 2 });
    expect(spanBetween(6, 2, 10)).toEqual({ offset: 6, length: 0 });
    expect(spanBetween(15, 20, 10)).toEqual({ offset: 10, length: 0 });
  });

  it('sorts and merges overlapping and touching spans', () => {
    expect(
      mergeSpans([
        { offset: 10, length: 5 },
        { offset: 0, length: 3 },
        { offset: 12, length: 10 },
        { offset: 3, length: 2 },
        { offset: 30, length: 0 },
      ]),
    ).toEqual([
      { offset: 0, length: 5 },
      { offset: 10, length: 12 },
      { offset: 30, length: 0 },
    ]);
    expect(mergeSpans([])).toEqual([]);
  });

  it('answers containment and next-span queries by binary search', () => {
    const spans = mergeSpans([
      { offset: 2, length: 3 },
      { offset: 10, length: 1 },
    ]);
    expect([0, 1, 2, 4, 5, 9, 10, 11].map((offset) => spansContain(spans, offset))).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(spansContain([], 0)).toBe(false);
    expect(nextSpanStart(spans, 0, 99)).toBe(2);
    expect(nextSpanStart(spans, 3, 99)).toBe(10);
    expect(nextSpanStart(spans, 10, 99)).toBe(99);
    expect(nextSpanStart([], 5, 7)).toBe(7);
  });

  it('matches the JavaScript \\s class', () => {
    for (let code = 0; code <= 0xffff; code++) {
      expect(isJsWhitespace(code), `U+${code.toString(16)}`).toBe(
        /\s/.test(String.fromCharCode(code)),
      );
    }
  });

  it('cleans messages from untrusted text', () => {
    expect(cleanMessage('bad\u001b[31m\u0007 key\u0085')).toBe('bad [31m  key ');
    expect(cleanMessage('x'.repeat(500))).toBe(`${'x'.repeat(200)}…`);
    expect(cleanMessage('x'.repeat(200))).toBe('x'.repeat(200));
    expect(cleanMessage('🚀 ok')).toBe('🚀 ok');
  });
});
