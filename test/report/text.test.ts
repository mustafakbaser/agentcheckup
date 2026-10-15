import { describe, expect, it } from 'vitest';
import {
  breakdown,
  displayWidth,
  markdownToPlain,
  plural,
  SKIP_REASON_LABELS,
  truncate,
} from '../../src/report/text.js';

const c = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

describe('displayWidth', () => {
  it('counts ASCII and accented Latin as one column each', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('Ünïcödé')).toBe(7);
    expect(displayWidth(`e${c(0x301)}`)).toBe(1);
  });

  it('counts CJK and emoji as two columns', () => {
    expect(displayWidth('设置')).toBe(4);
    expect(displayWidth('😀')).toBe(2);
    expect(displayWidth(`👍${c(0x1f3fd)}`)).toBe(2);
    expect(displayWidth(`👨${c(0x200d)}👩${c(0x200d)}👧`)).toBe(2);
    expect(displayWidth(`✅`)).toBe(2);
  });

  it('counts presentation selectors as zero', () => {
    expect(displayWidth(`x${c(0xfe0f)}`)).toBe(1);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('😀😀', 2)).toBe('😀😀');
  });

  it('cuts by code points and never splits a surrogate pair', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('😀😀😀', 2)).toBe('😀😀…');
    expect(truncate('abcdef', 3, '...')).toBe('abc...');
  });
});

describe('plural', () => {
  it('picks the form by count', () => {
    expect(plural(1, 'error')).toBe('1 error');
    expect(plural(0, 'error')).toBe('0 errors');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('breakdown', () => {
  it('counts in label order and omits zero counts', () => {
    expect(breakdown(['binary', 'too-large', 'binary'], SKIP_REASON_LABELS)).toBe(
      'too large: 1, binary: 2',
    );
  });
});

describe('markdownToPlain', () => {
  it('drops code spans, strong emphasis, link syntax and escapes', () => {
    expect(
      markdownToPlain('Use `@path`, **not** [the docs](https://example.com/x). 1\\. \\*literal\\*'),
    ).toBe('Use @path, not the docs (https://example.com/x). 1. *literal*');
  });
});
