import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { formatContextText, formatMatrixText } from '../../src/report/context-text.js';
import {
  claudePlan,
  contextReport,
  COMMAND_PATH,
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
import { ansiStyle, hasEscOrBel, stripKnownSgr, tagStyle, unsafeCodePoints } from './safety.js';

const result = withContext(richResult);
const hostile = withHostileContext(richResult);

/** Lines the GitHub Actions runner would parse as workflow commands. */
function commandLines(output: string): string[] {
  return output.split('\n').filter((line) => line.trimStart().startsWith('::'));
}

function section(output: string, title: string): string[] {
  const lines = output.split('\n');
  const start = lines.indexOf(title);
  if (start < 0) return [];
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

describe('formatContextText snapshots', () => {
  it('plans and matrix', async () => {
    await expect(formatContextText(result)).toMatchFileSnapshot(
      '__snapshots__/context-text.sample.txt',
    );
  });

  it('styled', async () => {
    await expect(formatContextText(result, { style: tagStyle })).toMatchFileSnapshot(
      '__snapshots__/context-text.styled.txt',
    );
  });

  it('ASCII only', async () => {
    const output = formatContextText(result, { ascii: true });
    expect(output).toMatch(/^[\t\n\x20-\x7e]*$/);
    await expect(output).toMatchFileSnapshot('__snapshots__/context-text.ascii.txt');
  });

  it('hostile', async () => {
    await expect(formatContextText(hostile)).toMatchFileSnapshot(
      '__snapshots__/context-text.hostile.txt',
    );
  });

  it('every trigger, pin state and fallback', async () => {
    await expect(formatContextText(withEdgeCases(richResult))).toMatchFileSnapshot(
      '__snapshots__/context-text.edge.txt',
    );
  });

  it('matrix alone', async () => {
    await expect(formatMatrixText(sampleContext)).toMatchFileSnapshot(
      '__snapshots__/context-matrix.sample.txt',
    );
  });
});

describe('formatContextText content', () => {
  const output = formatContextText(result);
  const claude = output.split('\n\nCodex context')[0]!;

  it('heads each plan with the agent and working directory', () => {
    expect(output.split('\n')[0]).toBe('Claude Code context · packages/api');
    expect(output).toContain('\nCodex context · packages/api\n');
    expect(output).toContain('\nCursor context · ./\n');
  });

  it('lists startup files in assembly order with the import tree and the total', () => {
    expect(section(claude, 'At session start                            bytes  ≈tokens')).toEqual([
      '   1  CLAUDE.md                             1,204      301',
      '   2    └ @AGENTS.md                        6,880    1,720',
      '   3  packages/api/CLAUDE.md                  412      103',
      '  4?  .claude/rules/testing.md                980      245',
      '   5  Skills listing (4 skills, metadata)   1,310      328',
      '                                    Total  10,786  ≈ 2,697',
      '  MCP, asks first:  github  stdio  npx -y @modelcontextprotocol/server-github@1.4.0 (pinned)',
      '  Hooks:            PreToolUse Bash → scripts/hooks/guard.sh (fails open)',
    ]);
  });

  it('shows on-demand entries with their triggers, skips with reasons and rule ids', () => {
    expect(section(claude, 'On demand')).toContain(
      '  .claude/skills/deploy/SKILL.md   body 9,402 bytes ≈ 2,351, when the model picks it',
    );
    expect(section(claude, 'On demand')).toContain(
      '  .claude/rules/api.md             900 bytes ≈ 225, when Claude opens src/api/**',
    );
    expect(section(claude, 'Skipped')).toEqual([
      '  .mcp.json › docs        "url" without "type"                     mcp/url-without-type',
      '  packages/api/AGENTS.md  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude',
    ]);
    expect(claude).toContain('\nNot read by Claude Code: .cursor/rules/api.mdc');
  });

  it('marks cuts and incomplete analysis', () => {
    expect(output).toContain('packages/api/AGENTS.md (cut at byte 25,888, line 812)  26,130');
    expect(section(output, 'Incomplete')).toEqual([
      '  .codex/config.toml  not analyzed: agentcheckup does not parse this format',
    ]);
  });

  it('ends with the token footnote and explains "?" only when used', () => {
    expect(
      output.endsWith(
        '≈tokens = characters ÷ 4\n? = unverified: neither documentation nor source code confirms it\n',
      ),
    ).toBe(true);
    const verified = formatContextText({
      ...result,
      context: contextReport([
        plan('cursor', {
          entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
        }),
      ]),
    });
    expect(verified.endsWith('\n\n≈tokens = characters ÷ 4\n')).toBe(true);
  });

  it('links MCP servers and hooks to the inventory, and falls back to the entry name', () => {
    const bare: ScanResult = {
      ...result,
      inventory: { mcpServers: [], hooks: [], permissions: [], env: [], incomplete: [] },
    };
    const output = formatContextText(bare);
    expect(output).toContain('  MCP, asks first:  github\n');
    expect(output).toContain('  Hooks:            PreToolUse\n');
  });

  it('says so when there is nothing to show', () => {
    expect(formatContextText(emptyResult)).toBe('No load plans in this report.\n');
    expect(formatMatrixText(undefined)).toBe('');
    expect(formatMatrixText(contextReport([claudePlan]))).toBe('');
  });

  it('renders "—" for files an agent does not read', () => {
    const matrix = formatMatrixText(sampleContext).split('\n');
    expect(matrix[0]).toBe('                               Claude Code   Codex       Cursor');
    expect(matrix).toContain('CLAUDE.md                      startup       —           startup');
    expect(formatMatrixText(sampleContext, { ascii: true })).toContain(
      'CLAUDE.md                      startup       -           startup',
    );
  });
});

describe('formatContextText safety', () => {
  const variants = [{}, { ascii: true }] as const;

  it.each([
    ['sample', result],
    ['hostile', hostile],
  ])('%s: no ESC, BEL, unsafe code point, trailing blank or workflow command', (_, input) => {
    for (const options of variants) {
      const output = formatContextText(input, options);
      expect(hasEscOrBel(output)).toBe(false);
      expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
      expect(output).not.toMatch(/[ \t]$/m);
      expect(commandLines(output)).toEqual([]);
      expect(output.endsWith('\n')).toBe(true);
      expect(output.endsWith('\n\n')).toBe(false);
    }
  });

  it('defuses a path that starts a line, visibly', () => {
    const output = formatContextText(hostile);
    expect(output).toContain('\n<U+003A>:error::matrix');
    expect(output).toContain(`  1  ${COMMAND_PATH} →`);
  });

  it('with real ANSI colors, every escape sequence comes from the style', () => {
    const output = formatContextText(hostile, { style: ansiStyle });
    expect(output).toContain('\u001b[1m');
    const stripped = stripKnownSgr(output);
    expect(hasEscOrBel(stripped)).toBe(false);
    expect(stripped).toBe(formatContextText(hostile));
  });
});

describe('formatContextText determinism', () => {
  it('gives identical output whatever order the input lists are in', () => {
    const expected = formatContextText(result);
    for (const seed of [1, 2, 3, 42, 1234]) {
      expect(formatContextText(shuffleReport(result, seed))).toBe(expected);
      expect(formatMatrixText(shuffleReport(result, seed).context)).toBe(
        formatMatrixText(result.context),
      );
    }
  });
});
