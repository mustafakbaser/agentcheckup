import { describe, expect, it } from 'vitest';
import { partialRule } from '../../../src/rules/analysis/partial.js';
import { formatInteger } from '../../../src/rules/shared/format.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'analysis/partial';

describe('analysis/partial', () => {
  it('says nothing about an ordinary file', () => {
    const result = lint({ 'AGENTS.md': '# Project\n\n- Use pnpm.\n' }, { rules: [partialRule] });
    expect(findings(result, ID)).toEqual([]);
  });

  it('reports a file larger than the analysis window, as info', () => {
    const text = `# Big\n\n${'Plain sentence about the project.\n'.repeat(6000)}`;
    const result = lint({ 'AGENTS.md': text }, { rules: [partialRule] });
    const [finding] = findings(result, ID);
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toMatch(
      /^To bound parsing time, only the first [\d,]+ of [\d,]+ characters were analyzed/,
    );
    expect(result.score.score).toBe(100);
  });

  it('reports a file whose nesting forced a flat parse', () => {
    const text = '- - - - - - - - x\n'.repeat(4000);
    const result = lint({ 'CLAUDE.md': text }, { rules: [partialRule], targets: ['claude-code'] });
    expect(
      findings(result, ID)
        .map((finding) => finding.message)
        .join(' '),
    ).toMatch(/not parsed|ignored|analyzed/);
  });
});

describe('formatInteger', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1,000'],
    [32768, '32,768'],
    [1234567, '1,234,567'],
    [-41207, '-41,207'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatInteger(value)).toBe(expected);
  });
});
