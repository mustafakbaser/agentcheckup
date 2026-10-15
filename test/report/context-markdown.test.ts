import { describe, expect, it } from 'vitest';
import { formatContextMarkdown, formatMatrixMarkdown } from '../../src/report/context-markdown.js';
import {
  contextReport,
  entry,
  plan,
  sampleContext,
  shuffleReport,
  size,
  withContext,
  withEdgeCases,
  withHostileContext,
} from '../helpers/context.js';
import { emptyResult, richResult } from './fixtures.js';
import { unsafeCodePoints } from './safety.js';

const result = withContext(richResult);
const hostile = withHostileContext(richResult);

/** Pipes that split table cells: not preceded by a backslash. */
function cellSeparators(row: string): number {
  let count = 0;
  for (let index = 0; index < row.length; index++) {
    if (row.charAt(index) === '\\') index++;
    else if (row.charAt(index) === '|') count++;
  }
  return count;
}

/** Every table in the output: its header's cell count and its rows. */
function tables(output: string): { columns: number; rows: string[] }[] {
  const found: { columns: number; rows: string[] }[] = [];
  const lines = output.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (
      !line.startsWith('| ') ||
      (!(lines[index + 1] ?? '').startsWith('| :') && !(lines[index + 1] ?? '').startsWith('| -'))
    )
      continue;
    const rows: string[] = [];
    let next = index + 2;
    while ((lines[next] ?? '').startsWith('| ')) rows.push(lines[next++]!);
    found.push({ columns: cellSeparators(line), rows });
    index = next;
  }
  return found;
}

describe('formatContextMarkdown', () => {
  it('matches the snapshot', async () => {
    await expect(formatContextMarkdown(result)).toMatchFileSnapshot(
      '__snapshots__/context-markdown.sample.txt',
    );
  });

  it('hostile matches the snapshot', async () => {
    await expect(formatContextMarkdown(hostile)).toMatchFileSnapshot(
      '__snapshots__/context-markdown.hostile.txt',
    );
  });

  it('every trigger, pin state and fallback match the snapshot', async () => {
    await expect(formatContextMarkdown(withEdgeCases(richResult))).toMatchFileSnapshot(
      '__snapshots__/context-markdown.edge.txt',
    );
  });

  it('matrix alone matches the snapshot', async () => {
    await expect(formatMatrixMarkdown(sampleContext)).toMatchFileSnapshot(
      '__snapshots__/context-matrix.sample.md.txt',
    );
  });

  it('has the same sections as the text output, as tables', () => {
    const output = formatContextMarkdown(result);
    expect(output.split('\n')[0]).toBe('## Claude Code context · packages/api');
    expect(output).toContain('| # | File | Bytes | ≈Tokens | Via |');
    expect(output).toContain('| 2 | ↳ @&#8203;AGENTS\\.md | 6,880 | 1,720 | CLAUDE\\.md |');
    expect(output).toContain('|  | **Total** | **10,786** | **≈ 2,697** |  |');
    expect(output).toContain(
      '| MCP, asks first | github · stdio · npx \\-y @&#8203;modelcontextprotocol/server\\-github@&#8203;1\\.4\\.0 \\(pinned\\) |',
    );
    expect(output).toContain(
      '| \\.claude/rules/api\\.md | 900 bytes ≈ 225 | when Claude opens src/api/\\*\\* |',
    );
    expect(output).toContain(
      '| packages/api/AGENTS\\.md | a CLAUDE\\.md on the path is read instead | [`instr/agents-md-ignored-by-claude`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/agents-md-ignored-by-claude.md) |',
    );
    expect(output).toContain('### Incomplete');
    expect(output).toContain('| CLAUDE\\.md | startup | — | startup |');
    expect(
      output.endsWith(
        '_≈Tokens = characters ÷ 4._\n\n_? = unverified: neither documentation nor source code confirms it._\n',
      ),
    ).toBe(true);
  });

  it.each([
    ['sample', result],
    ['hostile', hostile],
  ])('%s: no raw HTML, mentions, issue references, script links or broken tables', (_, input) => {
    const output = formatContextMarkdown(input);
    expect(output).not.toContain('<');
    expect(output).not.toMatch(/@[\p{L}\p{N}]/u);
    expect(output).not.toMatch(/(?<!&)#\d/);
    expect(output).not.toMatch(/javascript:/i);
    expect(output).not.toMatch(/(?<!\\)!\[/);
    expect(output).not.toMatch(/(?<!\\)::/);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    const found = tables(output);
    expect(found.length).toBeGreaterThan(3);
    for (const table of found) {
      for (const row of table.rows) expect(cellSeparators(row)).toBe(table.columns);
    }
  });

  it('caps every table at maxRows and says so', () => {
    const entries = Array.from({ length: 30 }, (_, index) =>
      entry('rule', `.claude/rules/r${String(index).padStart(2, '0')}.md`, {
        trigger: 'on-path',
        patterns: ['src/**'],
        size: size(10),
      }),
    );
    const many = { ...result, context: contextReport([plan('claude-code', { entries })]) };
    const output = formatContextMarkdown(many, { maxRows: 5 });
    expect(output).toContain('Showing 5 of 30 files.');
    expect(output.match(/^\| \\\.claude\/rules\/r/gm)).toHaveLength(5);
    expect(formatContextMarkdown(many, { maxRows: Number.NaN })).toContain(
      'Showing 0 of 30 files.',
    );
  });

  it('says so when there is nothing to show', () => {
    expect(formatContextMarkdown(emptyResult)).toBe('No load plans in this report.\n');
    expect(formatMatrixMarkdown(undefined)).toBe('');
  });

  it('gives identical output whatever order the input lists are in', () => {
    const expected = formatContextMarkdown(result);
    for (const seed of [1, 2, 3, 42, 1234]) {
      expect(formatContextMarkdown(shuffleReport(result, seed))).toBe(expected);
    }
  });
});
