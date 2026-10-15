import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { formatMarkdown } from '../../src/report/markdown.js';
import {
  at,
  cleanResult,
  emptyResult,
  finding,
  makeResult,
  richResult,
  RULES,
} from './fixtures.js';
import {
  baselineDiff,
  sampleBaseline,
  shuffleReport,
  withContext,
  withHostileContext,
} from '../helpers/context.js';
import { HOSTILE_ALL, hostileResult } from './hostile.js';
import { unsafeCodePoints } from './safety.js';

const baselineResult = withContext(richResult);

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
  ['baseline', baselineResult],
  ['hostile-baseline', withHostileContext(hostileResult)],
];

/** Pipes that split table cells: not preceded by a backslash. */
function cellSeparators(row: string): number {
  let count = 0;
  for (let index = 0; index < row.length; index++) {
    if (row.charAt(index) === '\\') index++;
    else if (row.charAt(index) === '|') count++;
  }
  return count;
}

function tableRows(output: string): string[] {
  const lines = output.split('\n');
  const start = lines.indexOf('| Location | Severity | Rule | Message |');
  if (start < 0) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('| ')) break;
    rows.push(line);
  }
  return rows;
}

describe('formatMarkdown', () => {
  it.each(FIXTURES)('%s matches the snapshot', async (name, result) => {
    await expect(formatMarkdown(result)).toMatchFileSnapshot(`__snapshots__/markdown.${name}.txt`);
  });

  it.each(FIXTURES)('%s: no raw HTML, mentions, issue references or script links', (_, result) => {
    const output = formatMarkdown(result);
    expect(output).not.toContain('<');
    expect(output).not.toMatch(/@[\p{L}\p{N}]/u);
    expect(output).not.toMatch(/(?<!&)#\d/);
    expect(output).not.toMatch(/javascript:/i);
    expect(output).not.toMatch(/(?<!\\)!\[/);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
  });

  it.each(FIXTURES)('%s: every findings row has exactly four cells', (_, result) => {
    for (const row of tableRows(formatMarkdown(result))) {
      expect(cellSeparators(row)).toBe(5);
    }
  });

  it('heads with the score and grade', () => {
    expect(formatMarkdown(richResult).split('\n')[0]).toBe(
      '## agentcheckup: agent config score 49/100 (F)',
    );
    expect(formatMarkdown(emptyResult).split('\n')[0]).toBe(
      '## agentcheckup: no agent configuration files found',
    );
  });

  it('lists unsuppressed findings, most severe first, rules linked to their docs', () => {
    const rows = tableRows(formatMarkdown(richResult));
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.split(' | ')[1])).toEqual([
      'error',
      'error',
      'warning',
      'warning',
      'info',
      'info',
    ]);
    expect(rows[1]).toBe(
      '| CLAUDE\\.md:3 | error | [`instructions/broken-import`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instructions/broken-import.md) | Imported file docs/missing\\.md does not exist\\. |',
    );
  });

  it('does not link rule ids that are not plain identifiers', () => {
    const rows = tableRows(formatMarkdown(hostileResult));
    const evil = rows.find((row) => row.includes('title=x'))!;
    expect(evil).toContain('| evil\\:rule,title=x |');
  });

  it('truncates to maxFindings and says so', () => {
    const output = formatMarkdown(richResult, { maxFindings: 2 });
    expect(tableRows(output)).toHaveLength(2);
    expect(output).toContain(
      'Showing 2 of 6 findings, most severe first. Run `npx agentcheckup` locally for the full report.',
    );
    const none = formatMarkdown(richResult, { maxFindings: 0 });
    expect(none).not.toContain('| Location |');
    expect(none).toContain('Showing 0 of 6 findings');
    expect(formatMarkdown(richResult, { maxFindings: Number.POSITIVE_INFINITY })).toContain(
      'Showing 0 of 6 findings',
    );
  });

  it('stays under the PR comment size limit with hostile, verbose findings', () => {
    const findings = Array.from({ length: 500 }, (_, index) =>
      finding(RULES.fileTooLarge, `dir/${'<@'.repeat(150)}${index}.md`, HOSTILE_ALL.repeat(3), {
        range: at(index + 1, 1),
      }),
    );
    const result = makeResult({ findings, score: { score: 0, grade: 'F', capped: false } });
    const output = formatMarkdown(result, { maxFindings: 500 });
    expect(output.length).toBeLessThan(65_536);
    const shown = tableRows(output).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(500);
    expect(output).toContain(`Showing ${shown} of 500 findings`);
  });

  it('caps configuration warnings', () => {
    const result = makeResult({
      configWarnings: ['a', 'b', 'c', 'd', 'e'],
      score: { score: 100, grade: 'A', capped: false },
    });
    expect(formatMarkdown(result)).toContain('**Configuration:** 2 more warnings');
  });
});

describe('formatMarkdown with a baseline', () => {
  const output = formatMarkdown(baselineResult);

  it('summarizes the changes that need review, one row per item', () => {
    const start = output.indexOf('### Agent configuration changes');
    const summary = output.slice(start, output.indexOf('> [!CAUTION]')).trimEnd().split('\n');
    expect(summary).toEqual([
      '### Agent configuration changes',
      '',
      '**Needs review: 5 security-relevant changes**',
      '',
      '| Change | Where | Detail |',
      '| :----- | :---- | :----- |',
      '| **New MCP server, not pinned** | \\.cursor/mcp\\.json › browser | stdio, npx \\-y @&#8203;acme/browser\\-mcp, not pinned |',
      '| Permission widened | \\.claude/settings\\.json | permissions\\.allow adds Bash\\(curl\\:\\*\\) |',
      '| Hook changed | \\.claude/settings\\.json › PreToolUse | PreToolUse Bash runs scripts/hooks/guard\\.sh, command changed |',
      '| Env override | \\.claude/settings\\.json | ANTHROPIC\\_BASE\\_URL → https\\://llm\\-proxy\\.example\\.net |',
      '| Hidden Unicode | AGENTS\\.md:12 | AGENTS\\.md\\:12 has 3 invisible Unicode tag characters |',
      '',
      'Findings: 2 new errors, 2 resolved.',
      '',
      'Session-start context: Claude Code (packages/api) ≈1,977 → ≈2,697 tokens (+720) · ' +
        'Codex (packages/api) ≈7,801 → ≈8,253 tokens (+452), codex\\.project\\_doc\\_max\\_bytes ' +
        '31,204 → 33,010 bytes, now over the 32,768-byte limit · Cursor unchanged',
    ]);
  });

  it('lists new findings first and marks them', () => {
    const findings = tableRows(output);
    expect(findings).toHaveLength(6);
    expect(findings.slice(0, 2).map((row) => row.split(' | ')[1])).toEqual([
      '**new** error',
      '**new** error',
    ]);
    expect(findings.slice(2).every((row) => !row.includes('**new**'))).toBe(true);
  });

  it('is the same whatever order the baseline lists are in', () => {
    for (const seed of [1, 2, 3]) {
      expect(formatMarkdown(shuffleReport(baselineResult, seed))).toBe(output);
    }
  });

  it('reports a quiet gate, a gate that is off, unmarked findings and another ruleset', () => {
    const quiet = formatMarkdown({
      ...richResult,
      baseline: baselineDiff({ gate: { classes: ['mcp'], hits: [] } }),
    });
    expect(quiet).toContain('**No security-relevant changes need review.**');
    expect(quiet).toContain('Findings: no new findings, 0 resolved.');

    const off = formatMarkdown({
      ...richResult,
      baseline: baselineDiff({
        findings: { new: 3, unchanged: 5, resolved: [] },
        against: { version: '0.1.0', ruleset: '2026.09', sameRuleset: false },
        context: [],
      }),
    });
    expect(off).not.toContain('Needs review');
    expect(off).toContain(
      'Findings: 3 new findings, 0 resolved. The baseline was written with ruleset 2026\\.09, so findings from rules it did not run count as new.',
    );
    expect(off).not.toContain('Session-start context');
  });

  it('shows a limit crossed back under, and a limit without a known unit', () => {
    const delta = sampleBaseline.context[1]!;
    const back = formatMarkdown({
      ...richResult,
      baseline: baselineDiff({
        context: [
          {
            ...delta,
            limits: [
              { key: 'k.bytes', subject: 'x', before: 40_000, after: 30_000, limit: 32_768 },
              { key: 'k.none', subject: 'y', before: null, after: 9, limit: 8 },
              { key: 'k.same', subject: 'z', before: 9, after: 10, limit: 8 },
            ],
          },
        ],
      }),
    });
    expect(back).toContain('k\\.bytes 40,000 → 30,000, back under the limit of 32,768');
    expect(back).toContain('k\\.none 9, now over the limit of 8');
    expect(back).not.toContain('k\\.same');
  });

  it('stays under the PR comment size limit with many hostile changes and findings', () => {
    const findings = Array.from({ length: 500 }, (_, index) =>
      finding(RULES.fileTooLarge, `dir/${'<@'.repeat(150)}${index}.md`, HOSTILE_ALL.repeat(3), {
        range: at(index + 1, 1),
        baseline: 'new',
      }),
    );
    const hits = Array.from({ length: 500 }, (_, index) => ({
      class: 'mcp' as const,
      id: `mcp:${'<@'.repeat(100)}.json#s${index}`,
      change: 'added' as const,
      summary: HOSTILE_ALL.repeat(3),
    }));
    const deltas = Array.from({ length: 40 }, (_, index) => ({
      ...sampleBaseline.context[0]!,
      cwd: `${'<@'.repeat(100)}${index}`,
    }));
    const result: ScanResult = {
      ...makeResult({ findings, score: { score: 0, grade: 'F', capped: false } }),
      baseline: baselineDiff({ context: deltas, gate: { classes: ['mcp'], hits } }),
    };
    const big = formatMarkdown(result, { maxFindings: 500 });
    expect(big.length).toBeLessThan(65_536);
    expect(big).toMatch(/Showing \d+ of 500 changes\./);
    expect(big).toMatch(/Showing \d+ of 500 findings/);
    expect(big).toContain('· and 30 more plans');
  });
});
