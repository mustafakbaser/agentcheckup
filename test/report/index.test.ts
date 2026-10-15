import { describe, expect, it } from 'vitest';
import {
  format,
  FORMAT_DESCRIPTIONS,
  formatGithub,
  formatJson,
  formatMarkdown,
  formatSarif,
  formatStylish,
  FORMATS,
  isFormatName,
  plainStyle,
} from '../../src/report/index.js';
import { richResult } from './fixtures.js';

describe('format', () => {
  it('names five formats, each described', () => {
    expect(FORMATS).toEqual(['stylish', 'json', 'sarif', 'github', 'markdown']);
    expect(Object.keys(FORMAT_DESCRIPTIONS)).toEqual([...FORMATS]);
  });

  it('recognizes format names', () => {
    expect(isFormatName('sarif')).toBe(true);
    expect(isFormatName('SARIF')).toBe(false);
    expect(isFormatName('toString')).toBe(false);
  });

  it('dispatches to the formatters with their options', () => {
    expect(format(richResult, 'stylish')).toBe(formatStylish(richResult, { style: plainStyle }));
    expect(
      format(richResult, 'stylish', { ascii: true, showSuppressed: true, maxPerFile: 1 }),
    ).toBe(
      formatStylish(richResult, {
        style: plainStyle,
        ascii: true,
        showSuppressed: true,
        maxPerFile: 1,
      }),
    );
    expect(format(richResult, 'json')).toBe(formatJson(richResult));
    expect(format(richResult, 'sarif')).toBe(formatSarif(richResult));
    expect(format(richResult, 'github')).toBe(formatGithub(richResult));
    expect(format(richResult, 'markdown', { maxFindings: 1 })).toBe(
      formatMarkdown(richResult, { maxFindings: 1 }),
    );
  });
});
