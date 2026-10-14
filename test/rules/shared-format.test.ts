import { describe, expect, it } from 'vitest';
import { formatInteger, plural, quote } from '../../src/rules/shared/format.js';

describe('formatInteger', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1,000'],
    [32_768, '32,768'],
    [1_234_567, '1,234,567'],
    [-41_207, '-41,207'],
    [12.9, '12'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('formats %d as %s', (value, expected) => {
    expect(formatInteger(value)).toBe(expected);
  });
});

describe('plural', () => {
  it('uses the singular only for exactly one', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2_000, 'directory', 'directories')).toBe('2,000 directories');
  });
});

describe('quote', () => {
  it('wraps short values', () => {
    expect(quote('AGENTS.md')).toBe('"AGENTS.md"');
  });

  it('truncates by code points without splitting surrogate pairs', () => {
    expect(quote('😀'.repeat(5), 3)).toBe('"😀😀😀…"');
    expect(quote('x'.repeat(61))).toBe(`"${'x'.repeat(60)}…"`);
    expect(quote('x'.repeat(60))).toBe(`"${'x'.repeat(60)}"`);
  });
});
