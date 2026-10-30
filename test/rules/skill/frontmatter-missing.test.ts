import { describe, expect, it } from 'vitest';
import { frontmatterMissingRule } from '../../../src/rules/skill/frontmatter-missing.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/frontmatter-missing';
const PATH = 'skills/deploy/SKILL.md';
const run = (text: string | Uint8Array, targets?: Parameters<typeof lint>[1]['targets']) =>
  findings(
    lint({ [PATH]: text }, { rules: [frontmatterMissingRule], ...(targets ? { targets } : {}) }),
    ID,
  );

const GENERIC =
  'SKILL.md does not start with `---`, so it has no frontmatter. Codex and Gemini CLI skip the skill, and Claude Code uses the directory name as its name and the first non-empty line of the body as its description.';

describe('skill/frontmatter-missing', () => {
  it('reports a skill without frontmatter at line 1', () => {
    expect(run('# Deploy\n\nRun the deploy script.\n')).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: PATH,
        message: GENERIC,
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
      },
    ]);
  });

  it('is only a warning when Claude Code is the only target', () => {
    const result = lint(
      { [PATH]: '# Deploy\n' },
      { rules: [frontmatterMissingRule], targets: ['claude-code'] },
    );
    expect(result.findings.map((f) => [f.severity, f.platforms])).toEqual([
      ['warn', ['claude-code']],
    ]);
  });

  it('lists only targeted platforms', () => {
    const result = lint(
      { [PATH]: '# Deploy\n' },
      { rules: [frontmatterMissingRule], targets: ['codex', 'cursor'] },
    );
    expect(result.findings.map((f) => [f.severity, f.platforms])).toEqual([['error', ['codex']]]);
  });

  it('does not run when no affected platform is targeted', () => {
    expect(run('# Deploy\n', ['cursor', 'copilot'])).toEqual([]);
  });

  it('reports an empty file without a span', () => {
    expect(run('')).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: PATH,
        message:
          'SKILL.md is empty, so it has no frontmatter. Codex and Gemini CLI skip the skill.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
    expect(run(' \n\n')).toHaveLength(1);
  });

  it('explains frontmatter that starts after blank lines', () => {
    expect(run('\n\n---\nname: deploy\ndescription: Deploys.\n---\n')).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: PATH,
        message:
          'The frontmatter starts on line 3, but agents look for it only on line 1. Codex and Gemini CLI skip the skill, and Claude Code reads the frontmatter as instructions.',
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 4 } },
      },
    ]);
  });

  it('does not claim Codex skips an indented but closed delimiter', () => {
    const result = lint(
      { [PATH]: '  ---\nname: deploy\ndescription: Deploys.\n---\n' },
      { rules: [frontmatterMissingRule] },
    );
    expect(result.findings.map((f) => [f.message, f.platforms, f.range.start])).toEqual([
      [
        'The `---` on line 1 is indented. Gemini CLI skips the skill, and Claude Code reads the frontmatter as instructions.',
        ['claude-code', 'gemini'],
        { line: 1, column: 1 },
      ],
    ]);
    expect(run('  ---\nname: deploy\n', ['codex'])).toHaveLength(1);
    expect(run('  ---\nname: deploy\n---\n', ['codex'])).toEqual([]);
  });

  it('reports an indented delimiter that is never closed', () => {
    expect(run('\t---\nname: deploy\n')[0]?.message).toBe(
      'The `---` on line 1 is indented and never closed. Codex and Gemini CLI skip the skill, and Claude Code reads the frontmatter as instructions.',
    );
  });

  it('reports unclosed frontmatter at the opening delimiter', () => {
    expect(run('---\nname: deploy\ndescription: Deploys.\n\nRun it.\n')).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: PATH,
        message:
          'The frontmatter opened on line 1 has no closing `---` line. Codex and Gemini CLI skip the skill.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      },
    ]);
  });

  it('reports a block closed only by a line that starts with ---, for Codex and Gemini CLI', () => {
    const text = '---\nname: deploy\ndescription: a---b\n----\nbody\n';
    const result = lint({ [PATH]: text }, { rules: [frontmatterMissingRule] });
    expect(result.findings.map((f) => [f.message, f.platforms])).toEqual([
      [
        'The frontmatter opened on line 1 has no closing `---` line. Codex and Gemini CLI skip the skill.',
        ['codex', 'gemini'],
      ],
    ]);
  });

  it('reports a ---- closing line under .gemini/skills for Gemini CLI, not --- with blanks', () => {
    const path = '.gemini/skills/deploy/SKILL.md';
    const result = lint(
      { [path]: '---\nname: deploy\ndescription: Deploys.\n----\nbody\n' },
      { rules: [frontmatterMissingRule] },
    );
    expect(result.findings.map((f) => [f.path, f.severity, f.platforms, f.message])).toEqual([
      [
        path,
        'error',
        ['gemini'],
        'The frontmatter opened on line 1 has no closing `---` line. Gemini CLI skips the skill.',
      ],
    ]);
    for (const close of ['--- ', '---\t', '--- \t']) {
      const text = `---\nname: deploy\ndescription: Deploys.\n${close}\nbody\n`;
      expect(findings(lint({ [path]: text }, { rules: [frontmatterMissingRule] }), ID)).toEqual([]);
    }
  });

  it('reports an indented closing delimiter only for Gemini CLI', () => {
    const text = '---\nname: deploy\ndescription: Deploys.\n  ---\nbody\n';
    const result = lint({ [PATH]: text }, { rules: [frontmatterMissingRule] });
    expect(result.findings.map((f) => [f.message, f.platforms, f.range.start.line])).toEqual([
      ['The closing `---` on line 4 is indented. Gemini CLI skips the skill.', ['gemini'], 4],
    ]);
    // A later `---x` line does not close the block for Gemini CLI either.
    expect(
      run('---\nname: deploy\n  ---\n---x\n').map((f) => [f.message, f.range.start.line]),
    ).toEqual([['The closing `---` on line 3 is indented. Gemini CLI skips the skill.', 3]]);
  });

  it('does not report valid, invalid or unsupported frontmatter', () => {
    expect(run('---\nname: deploy\ndescription: Deploys.\n---\nbody\n')).toEqual([]);
    expect(run('---\r\nname: deploy\r\ndescription: Deploys.\r\n---\r\nbody\r\n')).toEqual([]);
    expect(run('---\nname: [\n---\n')).toEqual([]);
    expect(run('+++\nname = "deploy"\n+++\n')).toEqual([]);
    expect(run('---\n---\n')).toEqual([]);
  });

  it('reads past a UTF-8 byte order mark', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('---\nname: a\n---\n'),
    ]);
    expect(run(bytes)).toEqual([]);
  });

  it('handles non-ASCII text and CRLF line endings', () => {
    expect(run('# Dağıtım 🚀\r\n\r\nÇalıştır.\r\n')[0]?.range).toEqual({
      start: { line: 1, column: 1 },
      // `# Dağıtım 🚀` is 12 UTF-16 code units: the emoji counts twice.
      end: { line: 1, column: 13 },
    });
  });

  it('claims only what the platforms that read the location do', () => {
    const claude = lint(
      { '.claude/skills/deploy/SKILL.md': '# Deploy\n' },
      { rules: [frontmatterMissingRule] },
    );
    expect(claude.findings.map((f) => [f.severity, f.platforms])).toEqual([
      ['warn', ['claude-code']],
    ]);
    const agents = lint(
      { '.agents/skills/deploy/SKILL.md': '# Deploy\n' },
      { rules: [frontmatterMissingRule] },
    );
    expect(agents.findings.map((f) => [f.severity, f.platforms])).toEqual([
      ['error', ['codex', 'gemini']],
    ]);
    const cursor = lint(
      { '.cursor/skills/deploy/SKILL.md': '# Deploy\n' },
      { rules: [frontmatterMissingRule] },
    );
    expect(cursor.findings).toEqual([]);
  });

  it('follows symlink aliases into other skill roots', () => {
    const result = lint(
      {
        '.cursor/skills/deploy/SKILL.md': '# Deploy\n',
        '.claude/skills/deploy/SKILL.md': '# Deploy\n',
      },
      {
        rules: [frontmatterMissingRule],
        symlinks: { '.claude/skills/deploy/SKILL.md': '.cursor/skills/deploy/SKILL.md' },
      },
    );
    expect(result.findings.map((f) => [f.path, f.severity, f.platforms])).toEqual([
      ['.cursor/skills/deploy/SKILL.md', 'warn', ['claude-code']],
    ]);
  });

  it('only applies to skills', () => {
    const result = lint({ 'AGENTS.md': '# Agents\n' }, { rules: [frontmatterMissingRule] });
    expect(result.findings).toEqual([]);
  });
});
