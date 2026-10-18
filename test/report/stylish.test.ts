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
import { withContext, withHostileContext } from '../helpers/context.js';
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

// The snapshots from before fixes existed are the `compact` level: the same output plus a
// `fixable` tag on findings that carry a fix.
describe('formatStylish snapshots', () => {
  it.each(FIXTURES)('%s', async (name, result) => {
    await expect(plain(result, { level: 'compact' })).toMatchFileSnapshot(
      `__snapshots__/stylish.${name}.txt`,
    );
  });

  it('hostile, with suppressed findings', async () => {
    await expect(
      plain(hostileResult, { showSuppressed: true, level: 'compact' }),
    ).toMatchFileSnapshot('__snapshots__/stylish.hostile-suppressed.txt');
  });

  it('rich, styled, with suppressed findings', async () => {
    await expect(
      formatStylish(richResult, { style: tagStyle, showSuppressed: true, level: 'compact' }),
    ).toMatchFileSnapshot('__snapshots__/stylish.rich-styled.txt');
  });

  it('rich, ASCII only', async () => {
    const output = plain(richResult, { ascii: true, showSuppressed: true, level: 'compact' });
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

describe('formatStylish with a baseline', () => {
  const result = withContext(richResult);
  const output = plain(result, { level: 'compact' });

  it('matches the snapshot', async () => {
    await expect(output).toMatchFileSnapshot('__snapshots__/stylish.baseline.txt');
  });

  it('marks new findings in their own aligned column', () => {
    const lines = output.split('\n');
    expect(lines).toContain(
      '  12:3  error  new  Line contains 3 invisible Unicode tag characters.  risk/hidden-unicode',
    );
    expect(lines).toContain(
      '   1:1  info        Start with a one-paragraph project overview.       clarity/missing-overview',
    );
    expect(lines).toContain('                       ↳ docs/: Closest existing directory');
    expect(plain(richResult)).not.toMatch(/ {2}new {2}/);
  });

  it('leaves the marker column out when no shown finding is new', () => {
    const unchanged = plain(
      {
        ...result,
        findings: result.findings.map((finding) => ({
          ...finding,
          baseline: 'unchanged' as const,
        })),
      },
      { level: 'compact' },
    );
    expect(unchanged.split('\n')).toContain(
      '   1:1  info   Start with a one-paragraph project overview.       clarity/missing-overview',
    );
  });

  it('says how many findings are new and lists the changes that need review', () => {
    expect(output).toContain('\n2 new, 6 unchanged, 2 resolved since the baseline\n');
    expect(output).toContain(
      '✖ 5 security-relevant changes since the baseline need review\n' +
        '    New MCP server, not pinned: stdio, npx -y @acme/browser-mcp, not pinned\n',
    );
    expect(output).toContain(
      '    Hidden Unicode: AGENTS.md:12 has 3 invisible Unicode tag characters\n\n',
    );
    const quiet = withContext(cleanResult);
    const none = plain({
      ...quiet,
      baseline: {
        ...quiet.baseline!,
        findings: { new: 0, unchanged: 0, resolved: [] },
        gate: { classes: [], hits: [] },
      },
    });
    expect(none).toContain('\n0 new, 0 unchanged since the baseline\n');
    expect(none).not.toContain('need review');
  });

  it('marks new findings of rules newer than the baseline as "new rule"', () => {
    const newer = plain({
      ...result,
      baseline: {
        ...result.baseline!,
        against: {
          version: '0.1.0',
          ruleset: '2026.09',
          sameRuleset: false,
          newRules: ['instructions/broken-import'],
        },
      },
    });
    expect(newer).toMatch(
      /^ {4}3:5 {2}error {4}new rule {2}Imported file docs\/missing\.md does not exist\. +instructions\/broken-import$/m,
    );
    expect(newer).toMatch(/^ {2}12:3 {2}error {2}new {7}Line contains 3 invisible Unicode/m);
    // Continuation lines stay under the message.
    expect(newer).toContain(`\n${' '.repeat(28)}↳ docs/: Closest existing directory\n`);
    expect(newer).toContain(
      '\n2 new (1 from new rules), 6 unchanged, 2 resolved since the baseline\n',
    );
    // Without a finding of a new rule, the column keeps its narrow width.
    expect(output).not.toContain('new rule');
  });

  it('warns when the baseline comes from another ruleset', () => {
    const other = plain({
      ...result,
      baseline: {
        ...result.baseline!,
        against: { version: '0.1.0', ruleset: '2026.09', sameRuleset: false, newRules: [] },
      },
    });
    expect(other).toContain(
      '! The baseline was written with ruleset 2026.09, so findings from rules it did not run count as new.',
    );
  });

  it('never prints a line the Actions runner reads as a workflow command', () => {
    const commandPath = makeResult({
      findings: [finding(RULES.fileTooLarge, '::error file=a::pwned/AGENTS.md', 'x')],
    });
    const hostile = withHostileContext(hostileResult);
    for (const input of [commandPath, hostile]) {
      for (const options of [{}, { ascii: true }, { showSuppressed: true }]) {
        const text = plain(input, options);
        expect(text.split('\n').filter((line) => line.trimStart().startsWith('::'))).toEqual([]);
        expect(hasEscOrBel(text)).toBe(false);
        expect(unsafeCodePoints(text, { newline: true })).toEqual([]);
      }
    }
    expect(plain(commandPath).split('\n')[0]).toBe('<U+003A>:error file=a::pwned/AGENTS.md');
  });
});
