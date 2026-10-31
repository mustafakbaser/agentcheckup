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

  it('parses files without their costly constructs once the scan spends its parser work', () => {
    // Each file has a nested list and emphasis: some container and inline cost.
    const text = '# Notes\n\n- one\n  - *two* and _three_\n- four\n';
    const files = { 'a/AGENTS.md': text, 'b/AGENTS.md': text, 'c/AGENTS.md': text };
    const run = (markdownCostBudget?: { inline: number; container: number; lazy: number }) =>
      findings(
        runRules(
          analyze(
            snapshotFrom(files),
            markdownCostBudget === undefined ? {} : { markdownCostBudget },
          ),
          { rules: [partialRule] },
        ),
        ID,
      ).map((finding) => [finding.path, finding.message]);
    expect(run()).toEqual([]);
    const single = analyze(snapshotFrom({ 'AGENTS.md': text }));
    const [artifact] = single.artifacts;
    if (artifact === undefined) throw new Error('no artifact');
    const { cost } = single.markdown(artifact).analysis;
    expect(cost.inline).toBeGreaterThan(0);
    expect(cost.container).toBeGreaterThan(0);
    // One file's cost spends all of this budget: the scan parses no more such files in full.
    expect(run({ inline: cost.inline, container: cost.container, lazy: 1 })).toHaveLength(2);
    // With a little left after the first file, the next one parses in full and overspends.
    expect(run({ inline: cost.inline + 1, container: cost.container + 1, lazy: 1 })).toEqual([
      [
        'c/AGENTS.md',
        'To bound parsing time, lists, block quotes and setext headings were not parsed, inline formatting in 1 paragraph was ignored. Rules did not check the skipped parts.',
      ],
    ]);
    // A budget that is spent from the start leaves cost-free files alone.
    const plain = { 'AGENTS.md': '# Plain\n\nNo formatting here.\n' };
    const spent = { inline: 0, container: 0, lazy: 0 };
    expect(
      findings(
        runRules(analyze(snapshotFrom(plain), { markdownCostBudget: spent }), {
          rules: [partialRule],
        }),
        ID,
      ),
    ).toEqual([]);
  });

  it('bounds the scan of many files that each stay just under the per-file guard', () => {
    // Inline delimiters back to back cost nearly the whole per-file inline budget in each file:
    // 40 such files took about 8 s. Now the first file spends the scan's budget, and the rest
    // are parsed with their delimiters defused.
    const line = `${'*a_ '.repeat(2040)}\n`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      files[`pkg${String(i).padStart(2, '0')}/AGENTS.md`] = `# Package ${String(i)}\n\n${line}`;
    }
    const started = performance.now();
    const result = runRules(analyze(snapshotFrom(files)), { rules: [partialRule] });
    const reported = findings(result, ID).map((finding) => finding.path);
    expect(reported).toHaveLength(39);
    expect(reported).not.toContain('pkg00/AGENTS.md');
    expect(performance.now() - started).toBeLessThan(20_000);
    // A repository of ordinary files is far from the budget.
    const ordinary: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      ordinary[`pkg${String(i)}/AGENTS.md`] = '# Notes\n\n- one\n  - *two* and `three`\n- four\n';
    }
    expect(
      findings(runRules(analyze(snapshotFrom(ordinary)), { rules: [partialRule] }), ID),
    ).toEqual([]);
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
