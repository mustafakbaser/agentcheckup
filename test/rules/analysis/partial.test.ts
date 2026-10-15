import { describe, expect, it } from 'vitest';
import { analyze, runRules } from '../../../src/core/engine.js';
import { partialRule } from '../../../src/rules/analysis/partial.js';
import { formatInteger } from '../../../src/rules/shared/format.js';
import { findings, lint, snapshotFrom } from '../../helpers/lint.js';

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

  it('reports imported files too, as info that does not count toward the score', () => {
    const text = `# Readme\n\n${'Plain sentence about the project.\n'.repeat(6000)}`;
    const result = lint(
      { 'CLAUDE.md': '@README.md\n', 'README.md': text },
      { rules: [partialRule], imported: ['README.md'] },
    );
    expect(findings(result, ID).map((finding) => [finding.path, finding.severity])).toEqual([
      ['README.md', 'info'],
    ]);
    expect(result.score.artifacts.map((artifact) => artifact.path)).toEqual(['CLAUDE.md']);
  });

  it('parses agent configuration before the files it imports', () => {
    // A.md sorts before CLAUDE.md, but the budget goes to CLAUDE.md first.
    const files = {
      'A.md': `${'a'.repeat(99)}\n`,
      'CLAUDE.md': `@A.md\n${'c'.repeat(93)}\n`,
    };
    const analysis = analyze(snapshotFrom(files, { imported: ['A.md'] }), {
      markdownBudget: 150,
    });
    const result = runRules(analysis, { rules: [partialRule] });
    expect(findings(result, ID).map((finding) => finding.path)).toEqual(['A.md']);
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
