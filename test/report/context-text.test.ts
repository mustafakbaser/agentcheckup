import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { rebaseResult } from '../../src/core/rebase.js';
import { formatContextText, formatMatrixText } from '../../src/report/context-text.js';
import {
  claudePlan,
  contextReport,
  COMMAND_PATH,
  entry,
  inventory,
  mcpServer,
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

  it('counts the files the configuration ignores in one line, and is silent without any', () => {
    const ignoring = (ignored: number | undefined): string =>
      formatContextText({
        ...result,
        context: contextReport([
          plan('cursor', {
            entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
            ...(ignored === undefined ? {} : { ignored }),
          }),
        ]),
      });
    expect(ignoring(22)).toContain(
      '\n\nIgnored by configuration: 22 files are not shown; Cursor may still load them\n',
    );
    expect(ignoring(1)).toContain(
      'Ignored by configuration: 1 file is not shown; Cursor may still load it\n',
    );
    expect(ignoring(1_234)).toContain('1,234 files are not shown');
    expect(ignoring(undefined)).not.toContain('Ignored by configuration');
    expect(output).not.toContain('Ignored by configuration');
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
    expect(matrix[0]).toBe('Files by agent                 Claude Code   Codex       Cursor');
    expect(matrix).toContain('CLAUDE.md                      startup       —           startup');
    expect(formatMatrixText(sampleContext, { ascii: true })).toContain(
      'CLAUDE.md                      startup       -           startup',
    );
  });
});

describe('formatContextText wording and layout', () => {
  const single = (item: ReturnType<typeof plan>, extra: Partial<ScanResult> = {}): string =>
    formatContextText({ ...result, context: contextReport([item]), ...extra });

  it('names the scanned directory once and shows paths relative to it', () => {
    expect(formatContextText(rebaseResult(result, 'repo/sub'))).toBe(
      `Paths are relative to repo/sub\n\n${formatContextText(result)}`,
    );
  });

  it('phrases known assumptions and keeps unknown keys as they are', () => {
    const output = single(
      plan('codex', {
        entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
        assumptions: [
          { key: 'codex.context_window', value: 200_000, origin: 'flag', evidence: [] },
          {
            key: 'codex.project_doc_fallback_filenames',
            value: '[]',
            origin: 'default',
            evidence: [],
          },
          {
            key: 'codex.project_doc_max_bytes',
            value: 65_536,
            origin: 'rule-option',
            evidence: [],
          },
          {
            key: 'codex.project_root_markers',
            value: '[".git", ".hg"]',
            origin: 'default',
            evidence: [],
          },
          { key: 'codex.trust_level', value: 'untrusted', origin: 'default', evidence: [] },
          { key: 'cursor.thirdPartyConfigs', value: false, origin: 'repository', evidence: [] },
          { key: 'cursor.trustedWorkspace', value: false, origin: 'default', evidence: [] },
          { key: 'zz.other', value: 'x', origin: 'default', evidence: [] },
        ],
      }),
    );
    expect(output.split('\n').slice(1, 4)).toEqual([
      'Assumes AGENTS.md budget 65,536 bytes (rule option), root markers .git and .hg,',
      '  no fallback file names, trust level untrusted, context window 200,000 tokens (from a flag),',
      '  third-party configs off (from the repository), untrusted workspace, zz.other = x (default)',
    ]);
  });

  it('sums up hidden scopes: names as they are, home directories for paths, no system paths', () => {
    const output = single(
      plan('claude-code', {
        entries: [entry('instructions', 'CLAUDE.md', { position: 1, size: size(8) })],
        hidden: [
          { scope: 'managed', locations: ['/etc/a/CLAUDE.md', 'C:\\A\\CLAUDE.md'], roles: [] },
          { scope: 'user', locations: ['~/.claude/rules/', '$HOME_X/AGENTS.md', '~'], roles: [] },
          { scope: 'plugin', locations: ['installed plugins'], roles: [] },
        ],
      }),
    );
    expect(output).toContain(
      '\nNot visible: managed settings, user settings ($HOME_X, ~, ~/.claude), installed plugins\n',
    );
  });

  it('puts the rest of a row with a long path on the next line, under its column', () => {
    const long = `deep/${'x'.repeat(70)}/AGENTS.md`;
    const output = single(
      plan('codex', {
        entries: [
          entry('instructions', 'AGENTS.md', { position: 1, size: size(8) }),
          entry('instructions', long, { position: 2, size: size(4) }),
          entry('instructions', 'a/AGENTS.md', { trigger: 'on-path', size: size(4) }),
          entry('instructions', long, { id: 'x', trigger: 'on-path', size: size(4) }),
        ],
      }),
    );
    // The numbers stay under their headings: `bytes` ends at column 23, `≈tokens` at 32.
    expect(output).toContain(
      '\nAt session start  bytes  ≈tokens\n  1  AGENTS.md        8        2\n',
    );
    expect(output).toContain(`\n  2  ${long}\n${' '.repeat(22)}4        1\n`);
    expect(output).toContain(
      `\n  a/AGENTS.md  4 bytes ≈ 1, when Codex opens a matching file\n  ${long}\n` +
        '               4 bytes ≈ 1, when Codex opens a matching file\n',
    );
  });

  it('says when nothing loads at session start, and leaves out an unknown transport', () => {
    const server = mcpServer('.cursor/mcp.json', 'linear', {
      transport: 'unknown',
      url: { origin: 'https://mcp.linear.app', tls: true, loopback: false },
    });
    const output = single(
      plan('cursor', {
        entries: [
          entry('mcp-server', '.cursor/mcp.json', { name: 'linear', inventoryId: server.id }),
          entry('import', 'docs/b.md', {
            trigger: 'on-path',
            via: ['CLAUDE.md', 'docs/a.md'],
            patterns: ['docs/**'],
            size: size(4),
          }),
        ],
      }),
      { inventory: inventory({ mcpServers: [server] }) },
    );
    expect(output).toContain(
      '\nAt session start: no files\n  MCP:  linear  https://mcp.linear.app\n',
    );
    expect(output).toContain(
      '\n  docs/b.md  4 bytes ≈ 1, when Cursor opens docs/**, imported by docs/a.md\n',
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
