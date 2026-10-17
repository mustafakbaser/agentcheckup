/**
 * The file-by-agent matrix in text and Markdown (src/report/context-text.ts and
 * context-markdown.ts): full labels up to four columns, one letter per cell under a grouped
 * header above that, columns of agents that read none of the files left out with a line that
 * names them, and one line for an empty matrix and for each empty plan. Also how a skip whose
 * fix needs your words is labeled.
 */
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import type { ArtifactKind } from '../../src/core/types.js';
import {
  ALL_CONTEXT_AGENTS,
  type ContextAgent,
  type ContextReport,
  type MatrixCell,
} from '../../src/platforms/load/types.js';
import { formatContextMarkdown, formatMatrixMarkdown } from '../../src/report/context-markdown.js';
import { formatContextText, formatMatrixText } from '../../src/report/context-text.js';
import { formatMarkdown } from '../../src/report/markdown.js';
import { formatStylish, plainStyle } from '../../src/report/stylish.js';
import { contextReport, entry, plan, size, skip } from '../helpers/context.js';
import { emptyResult } from './fixtures.js';
import { tagStyle } from './safety.js';

const CELLS: Readonly<Record<string, MatrixCell>> = {
  S: 'startup',
  P: 'on-path',
  D: 'start-dir',
  L: 'listed',
  M: 'model-selected',
  U: 'manual',
  C: 'partial',
  X: 'skipped',
  '?': 'unknown',
  '-': 'not-read',
};

/**
 * Rows with one letter per agent, in ALL_CONTEXT_AGENTS order: Claude Code, Codex, Cursor,
 * Copilot CLI, VS Code and cloud agent, Gemini CLI, Devin Local, Cline.
 */
const ROWS: readonly (readonly [string, ArtifactKind, string])[] = [
  ['.agents/skills/release-notes', 'skill', '-LLLLLLLL'],
  ['.claude/rules/testing.md', 'claude-rule', 'P---P----'],
  ['.claude/skills/deploy', 'skill', 'L-LLLL-LL'],
  ['.codex/config.toml', 'codex-config', '-?-------'],
  ['.cursor/rules/api.mdc', 'cursor-rule', '--P----P-'],
  ['.cursor/rules/style.md', 'cursor-rule-md', '--X----U-'],
  ['.github/copilot-instructions.md', 'copilot-instructions', '---SSS---'],
  ['.github/instructions/api.instructions.md', 'copilot-path-instructions', '---PMP---'],
  ['.mcp.json', 'mcp-json', 'X--SS--S-'],
  ['AGENTS.md', 'agents-md', 'XSSSSS-SS'],
  ['CLAUDE.md', 'claude-md', 'S-SSSS-S-'],
  ['GEMINI.md', 'gemini-md', '---S-SS--'],
  ['packages/api/AGENTS.md', 'agents-md', 'XDPP-P-P-'],
  ['packages/web/AGENTS.md', 'agents-md', 'PCPP-P-P-'],
  ['services/billing/ledger/export/AGENTS.md', 'agents-md', 'PDPP-P-P-'],
];

/**
 * A report with a plan per agent and the matrix of `rows` for `agents`, without the rows none of
 * them reads, as buildMatrix leaves them out.
 */
function matrixReport(agents: readonly ContextAgent[], rows = ROWS): ContextReport {
  const indexes = agents.map((agent) => ALL_CONTEXT_AGENTS.indexOf(agent));
  const matrixRows = rows
    .map(([path, kind, letters]) => ({
      path,
      kind,
      cells: indexes.map((index) => CELLS[letters.charAt(index)] ?? 'not-read'),
    }))
    .filter((row) => row.cells.some((cell) => cell !== 'not-read'));
  return contextReport(
    agents.map((agent) => plan(agent)),
    { matrix: { rows: matrixRows } },
  );
}

const THREE = ['claude-code', 'codex', 'cursor'] as const;
const FOUR = ['claude-code', 'codex', 'cursor', 'gemini'] as const;
const FIVE = ['claude-code', 'codex', 'cursor', 'copilot-cli', 'gemini'] as const;

describe('text matrix layouts', () => {
  it.each([
    ['3', THREE],
    ['4', FOUR],
    ['5', FIVE],
    ['9', ALL_CONTEXT_AGENTS],
  ])('%s columns', async (count, agents) => {
    await expect(formatMatrixText(matrixReport(agents))).toMatchFileSnapshot(
      `__snapshots__/context-matrix.${count}.txt`,
    );
  });

  it('keeps full labels up to four columns', () => {
    const four = formatMatrixText(matrixReport(FOUR)).split('\n');
    expect(four[0]).toBe(
      'Files by agent                             Claude Code   Codex       Cursor    Gemini CLI',
    );
    expect(four).toContain('startup    loaded at session start');
    expect(four.join('\n')).not.toContain('Copilot');
  });

  it('above four columns, shows one letter per cell under a grouped header, with a key', () => {
    const lines = formatMatrixText(matrixReport(ALL_CONTEXT_AGENTS)).split('\n');
    expect(lines.slice(0, 2)).toEqual([
      'Files by agent              Claude Codex Cursor Copilot       Gemini Devin Cline',
      '                                                CLI VSC Cloud',
    ]);
    expect(lines).toContain(
      'AGENTS.md                   X      S     S      S   S   S     —      S     S',
    );
    expect(lines).toContain('C  partial         loaded, but cut by a limit');
    expect(lines).toContain('—  not-read        not read by this agent');
    // Every line with cells fits 80 characters; a longer path has a line of its own.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    const deep = lines.indexOf('services/billing/ledger/export/AGENTS.md');
    expect(lines[deep + 1]).toBe(
      '                            P      D     P      P   —   P     —      P     —',
    );
  });

  it('gives one surface of a group the group label, with the surface under it', () => {
    const lines = formatMatrixText(matrixReport(FIVE)).split('\n');
    expect(lines.slice(0, 2)).toEqual([
      'Files by agent                            Claude Codex Cursor Copilot Gemini',
      '                                                              CLI',
    ]);
    expect(lines).toContain(
      'services/billing/ledger/export/AGENTS.md  P      D     P      P       —',
    );
  });

  it('has no second header row without a surface, and uses ASCII dashes on request', () => {
    const agents = ['claude-code', 'codex', 'cursor', 'gemini', 'windsurf'] as const;
    const output = formatMatrixText(matrixReport(agents), { ascii: true });
    expect(output).toMatch(/^[\t\n\x20-\x7e]*$/);
    const lines = output.split('\n');
    expect(lines[0]).toBe(
      'Files by agent                            Claude Codex Cursor Gemini Devin',
    );
    expect(lines[1]).toBe('.agents/skills/release-notes              -      L     L      L      L');
    expect(lines).toContainEqual(expect.stringMatching(/^- {2}not-read +not read by this agent$/));
  });

  it('colors cells and bolds both header rows', () => {
    const output = formatMatrixText(matrixReport(ALL_CONTEXT_AGENTS), { style: tagStyle });
    expect(output).toContain('<b>Copilot</b>');
    expect(output).toContain('<b>CLI</b> <b>VSC</b> <b>Cloud</b>');
    expect(output).toContain('<yellow>X</yellow>');
    expect(output).toContain('<green>S</green>');
    expect(output).toContain('<dim>—</dim>');
  });
});

describe('Markdown matrix', () => {
  it('keeps full surface names for nine columns', async () => {
    const output = formatMatrixMarkdown(matrixReport(ALL_CONTEXT_AGENTS));
    expect(output).toContain(
      '| File | Claude Code | Codex | Cursor | Copilot CLI | Copilot in VS Code | Copilot cloud agent | Gemini CLI | Devin Local | Cline |',
    );
    expect(output).not.toContain('Not shown');
    await expect(output).toMatchFileSnapshot('__snapshots__/context-matrix.9.md.txt');
  });
});

describe('columns of agents that read none of the files', () => {
  const rows: typeof ROWS = [
    ['AGENTS.md', 'agents-md', 'XS-------'],
    ['CLAUDE.md', 'claude-md', 'S--------'],
  ];

  it('are left out of text and Markdown, with a line that names them', () => {
    const report = matrixReport(['claude-code', 'codex', 'gemini'], rows);
    const text = formatMatrixText(report);
    expect(text.split('\n')[0]).toBe('Files by agent   Claude Code   Codex');
    expect(text).toContain(
      '\nCLAUDE.md        startup       —\nNot shown: Gemini CLI reads none of these files\n',
    );
    const markdown = formatMatrixMarkdown(report);
    expect(markdown).toContain('| File | Claude Code | Codex |\n');
    expect(markdown).toContain('\n\nNot shown: Gemini CLI reads none of these files.\n');
  });

  it('are named together, and count for the switch to the compact layout', () => {
    const agents = ['claude-code', 'codex', 'cursor', 'copilot-cli', 'gemini', 'cline'] as const;
    const text = formatMatrixText(
      matrixReport(agents, [
        ['AGENTS.md', 'agents-md', 'XSSS-----'],
        ['CLAUDE.md', 'claude-md', 'S-SS-----'],
      ]),
    );
    // Four columns are left: full labels.
    expect(text.split('\n')[0]).toBe(
      'Files by agent   Claude Code   Codex     Cursor    Copilot CLI',
    );
    expect(text).toContain('Not shown: Gemini CLI and Cline read none of these files\n');
  });

  it('stay in JSON, and nothing is left out when every agent reads a file', () => {
    const report = matrixReport(['claude-code', 'codex', 'gemini'], rows);
    expect(report.matrix?.rows.every((row) => row.cells.length === 3)).toBe(true);
    expect(formatMatrixText(matrixReport(THREE))).not.toContain('Not shown');
    expect(formatMatrixMarkdown(matrixReport(THREE))).not.toContain('Not shown');
  });

  it('give one line when no agent reads any file', () => {
    const empty = contextReport([plan('gemini'), plan('cline')], { matrix: { rows: [] } });
    expect(formatMatrixText(empty)).toBe(
      'Files by agent: no agent reads a configuration file here\n',
    );
    expect(formatMatrixMarkdown(empty)).toBe(
      'Files by agent: no agent reads a configuration file here.\n',
    );
  });
});

describe('empty plans', () => {
  const loaded = plan('codex', {
    entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
  });
  const result = (plans: Parameters<typeof contextReport>[0]): ScanResult => ({
    ...emptyResult,
    context: contextReport(plans),
  });

  it('print one line each, consecutive ones in one block', () => {
    const output = formatContextText(
      result([
        loaded,
        plan('gemini', {
          assumptions: [
            { key: 'gemini.folder_trust', value: false, origin: 'default', evidence: [] },
          ],
        }),
        plan('cline'),
      ]),
    );
    expect(output).toContain(
      '\n\nGemini CLI context · ./: loads nothing from this repository\n' +
        'Cline context · ./: loads nothing from this repository\n\n',
    );
    expect(output).not.toContain('folder trust');
    const markdown = formatContextMarkdown(result([loaded, plan('gemini')]));
    expect(markdown).toContain(
      '\n\n## Gemini CLI context · ./: loads nothing from this repository\n\n',
    );
  });

  it('may name files the agent does not read, and are not empty with anything else', () => {
    const notRead = plan('gemini', { skipped: [skip('instructions', 'AGENTS.md', 'not-read')] });
    expect(formatContextText(result([notRead]))).toContain(
      'Gemini CLI context · ./: loads nothing from this repository\n',
    );
    for (const full of [
      loaded,
      plan('gemini', { skipped: [skip('instructions', 'GEMINI.md', 'blank-file')] }),
      plan('gemini', { incomplete: ['unread:GEMINI.md'] }),
      plan('gemini', { ignored: 2 }),
    ]) {
      expect(formatContextText(result([full]))).not.toContain('loads nothing');
      expect(formatContextMarkdown(result([full]))).not.toContain('loads nothing');
    }
  });
});

describe('a skip whose fix needs your words', () => {
  const skips = [
    skip('skill', '.agents/skills/a/SKILL.md', 'no-description', {
      ruleId: 'skill/description-missing',
      fix: 'input',
    }),
    skip('skill', '.agents/skills/b/SKILL.md', 'no-description', {
      ruleId: 'skill/description-missing',
      fix: 'review',
    }),
    skip('skill', '.agents/skills/c/SKILL.md', 'bom', { ruleId: 'skill/frontmatter-bom' }),
  ];
  const result: ScanResult = {
    ...emptyResult,
    context: contextReport([plan('codex', { skipped: skips })]),
  };

  it('says so in the context text and Markdown, and counts as fixable', () => {
    const text = formatContextText(result);
    expect(text).toMatch(
      /a\/SKILL\.md +no description +skill\/description-missing +needs your words \(fix -i\)\n/,
    );
    expect(text).toMatch(/b\/SKILL\.md +no description +skill\/description-missing +fix: review\n/);
    expect(text).toMatch(
      /c\/SKILL\.md +a byte order mark comes before the frontmatter +skill\/frontmatter-bom\n/,
    );
    expect(text).toContain('2 of 3 skips can be fixed: agentcheckup fix');
    expect(formatContextText(result, { style: tagStyle })).toContain(
      '<blue>needs your words (fix -i)</blue>',
    );
    const markdown = formatContextMarkdown(result);
    expect(markdown).toContain(' | needs your words (fix -i) |\n');
    expect(markdown).toContain(' | review |\n');
  });

  it('says so in what each agent misses', () => {
    expect(formatStylish(result, { style: plainStyle })).toMatch(
      /skill a is skipped: no description +needs your words \(fix -i\)\n/,
    );
    expect(formatMarkdown(result)).toContain('| needs your words (fix -i) |');
  });
});
