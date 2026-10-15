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
import { HOSTILE_ALL, hostileResult } from './hostile.js';
import { unsafeCodePoints } from './safety.js';

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
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
