import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { formatStylish, plainStyle } from '../../src/report/stylish.js';
import {
  at,
  cleanResult,
  emptyResult,
  finding,
  makeResult,
  richResult,
  RULES,
} from './fixtures.js';
import { hostileResult } from './hostile.js';
import { ansiStyle, hasEscOrBel, stripKnownSgr, tagStyle, unsafeCodePoints } from './safety.js';

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
];

const plain = (
  result: ScanResult,
  options: Omit<Parameters<typeof formatStylish>[1], 'style'> = {},
) => formatStylish(result, { style: plainStyle, ...options });

describe('formatStylish snapshots', () => {
  it.each(FIXTURES)('%s', async (name, result) => {
    await expect(plain(result)).toMatchFileSnapshot(`__snapshots__/stylish.${name}.txt`);
  });

  it('hostile, with suppressed findings', async () => {
    await expect(plain(hostileResult, { showSuppressed: true })).toMatchFileSnapshot(
      '__snapshots__/stylish.hostile-suppressed.txt',
    );
  });

  it('rich, styled, with suppressed findings', async () => {
    await expect(
      formatStylish(richResult, { style: tagStyle, showSuppressed: true }),
    ).toMatchFileSnapshot('__snapshots__/stylish.rich-styled.txt');
  });

  it('rich, ASCII only', async () => {
    const output = plain(richResult, { ascii: true, showSuppressed: true });
    expect(output).toMatch(/^[\t\n\x20-\x7e]*$/);
    await expect(output).toMatchFileSnapshot('__snapshots__/stylish.rich-ascii.txt');
  });
});

describe('formatStylish safety', () => {
  const variants = [
    {},
    { showSuppressed: true },
    { ascii: true, showSuppressed: true },
    { maxPerFile: 1 },
  ] as const;

  it.each(FIXTURES)('%s: no ESC, BEL or other unsafe code point in any variant', (_, result) => {
    for (const options of variants) {
      const output = plain(result, options);
      expect(hasEscOrBel(output)).toBe(false);
      expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    }
  });

  it('with real ANSI colors, every escape sequence comes from the style', () => {
    const output = formatStylish(hostileResult, { style: ansiStyle, showSuppressed: true });
    expect(output).toContain('\u001b[31m');
    const stripped = stripKnownSgr(output);
    expect(hasEscOrBel(stripped)).toBe(false);
    expect(unsafeCodePoints(stripped, { newline: true })).toEqual([]);
    expect(stripped).toBe(plain(hostileResult, { showSuppressed: true }));
  });

  it('ends with exactly one newline', () => {
    for (const [, result] of FIXTURES) {
      const output = plain(result);
      expect(output.endsWith('\n')).toBe(true);
      expect(output.endsWith('\n\n')).toBe(false);
      expect(output).not.toMatch(/[ \t]$/m);
    }
  });
});

describe('formatStylish layout', () => {
  it('aligns severity, message and rule id columns within a file', () => {
    const lines = plain(richResult).split('\n');
    const claude = lines.slice(lines.indexOf('CLAUDE.md') + 1, lines.indexOf('CLAUDE.md') + 8);
    const rows = claude.filter((line) => /^\s+\d+:\d+/.test(line));
    expect(rows).toHaveLength(3);
    const severityColumns = new Set(rows.map((row) => row.search(/error|warning|info/)));
    const ruleColumns = new Set(
      rows.map((row) => row.search(/(?:budget|instructions|portability)\/[a-z-]+$/)),
    );
    expect(severityColumns.size).toBe(1);
    expect(ruleColumns.size).toBe(1);
    expect(rows[2]).toMatch(/^ {2}140:1 {2}info {5}/);
  });

  it('aligns wide characters by display width', () => {
    const result = makeResult({
      findings: [
        finding(RULES.fileTooLarge, 'a.md', '设置文件过大', { range: at(1, 1) }),
        finding(RULES.fileTooLarge, 'a.md', 'abcdefghijkl', { range: at(2, 1) }),
      ],
    });
    const rows = plain(result).split('\n').slice(1, 3);
    expect(rows[0]).toBe('  1:1  warning  设置文件过大  budget/file-too-large');
    expect(rows[1]).toBe('  2:1  warning  abcdefghijkl  budget/file-too-large');
  });

  it('spells out severities, so color is never the only signal', () => {
    const output = plain(richResult);
    expect(output).toContain('  error    Imported file');
    expect(output).toContain('  warning  File is 52,310');
    expect(output).toContain('  info     @-imports');
  });

  it('hides suppressed findings unless asked, but always counts them', () => {
    expect(plain(richResult)).not.toContain('Pipes a remote script');
    expect(plain(richResult)).not.toContain('skills/deploy/SKILL.md');
    expect(plain(richResult)).toContain('· 2 suppressed');
    const shown = plain(richResult, { showSuppressed: true });
    expect(shown).toContain('Pipes a remote script');
    expect(shown).toContain('suppressed by inline directive: Documented install step');
    expect(shown).toContain('suppressed by configuration: Generated file');
  });

  it('limits findings per file', () => {
    const output = plain(richResult, { maxPerFile: 1 });
    expect(output).toContain('  … and 2 more in this file');
    expect(output).toContain('  … and 1 more in this file');
    expect(plain(richResult, { maxPerFile: 0 })).toContain('… and 2 more in this file');
    expect(plain(richResult, { maxPerFile: Number.NaN })).not.toContain('more in this file');
  });

  it('reports a missing configuration instead of a score', () => {
    expect(plain(emptyResult)).toBe('No agent configuration files found.\n');
  });

  it('summarizes a clean run', () => {
    expect(plain(cleanResult)).toBe(
      '✔ No problems found (2 files checked)\nAgent config score 100/100 (A) · ruleset 2026.10\n',
    );
    expect(plain(cleanResult, { ascii: true })).toBe(
      'No problems found (2 files checked)\nAgent config score 100/100 (A) - ruleset 2026.10\n',
    );
  });

  it('uses the info symbol when there are only infos, and mentions suppressed-only runs', () => {
    const infos = makeResult({
      artifacts: [{ path: 'AGENTS.md', kind: 'agents-md', readers: ['codex'] }],
      findings: [finding(RULES.vague, 'AGENTS.md', 'Add an overview.')],
      score: { score: 100, grade: 'A', capped: false },
    });
    expect(plain(infos)).toContain('ℹ 1 problem (0 errors, 0 warnings, 1 info)');
    const suppressedOnly = makeResult({
      artifacts: [{ path: 'AGENTS.md', kind: 'agents-md', readers: ['codex'] }],
      findings: [
        finding(RULES.vague, 'AGENTS.md', 'Add an overview.', {
          suppressed: { kind: 'inline', reason: 'Intentional' },
        }),
      ],
      score: { score: 100, grade: 'A', capped: false },
    });
    expect(plain(suppressedOnly)).toContain('✔ No problems found (1 file checked) · 1 suppressed');
  });

  it('colors grades by band', () => {
    const graded = (score: number, grade: 'A' | 'B' | 'C' | 'D' | 'F') =>
      formatStylish(makeResult({ score: { score, grade, capped: false } }), { style: tagStyle });
    expect(graded(85, 'B')).toContain('(<green>B</green>)');
    expect(graded(65, 'D')).toContain('(<yellow>D</yellow>)');
    expect(graded(10, 'F')).toContain('(<red>F</red>)');
  });

  it('caps long lists: related locations, configuration warnings, rule failures', () => {
    const many = <T>(count: number, make: (index: number) => T): T[] =>
      Array.from({ length: count }, (_, index) => make(index));
    const result = makeResult({
      findings: [
        finding(RULES.fileTooLarge, 'a.md', 'x'.repeat(600), {
          related: many(5, (index) => `r${index}.md`).map((path) => ({ path, message: 'here' })),
        }),
      ],
      configWarnings: many(12, (index) => `Warning ${index}`),
      ruleFailures: many(11, (index) => ({ ruleId: `x/rule-${index}`, message: 'boom' })),
      skipped: many(5, (index) => ({ path: `big${index}.md`, reason: 'too-large' as const })),
    });
    const output = plain(result);
    expect(output).toContain('↳ … and 2 more related locations');
    expect(output).toContain('! … and 2 more configuration warnings');
    expect(output).toContain('    … and 1 more');
    expect(output).toContain('✖ 11 rules failed to run. Results are incomplete.');
    expect(output).toContain('big0.md, big1.md, big2.md, … and 2 more');
    expect(output).toContain(`${'x'.repeat(500)}…`);
    expect(output).not.toContain('x'.repeat(501));
  });
});
