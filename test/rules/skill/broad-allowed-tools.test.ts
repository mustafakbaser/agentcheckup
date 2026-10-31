import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import {
  broadAllowedToolsRule,
  splitToolRules,
} from '../../../src/rules/skill/broad-allowed-tools.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/broad-allowed-tools';

function check(allowedTools: string, path = 'skills/x/SKILL.md', targets?: readonly PlatformId[]) {
  const result = lint(
    { [path]: `---\nname: x\ndescription: Does x.\nallowed-tools: ${allowedTools}\n---\n` },
    { rules: [broadAllowedToolsRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

const BASH =
  '`allowed-tools` pre-approves "Bash" without limits. During the turn that invokes this skill, Claude Code runs any shell command without asking.';

describe('skill/broad-allowed-tools', () => {
  it('reports an unscoped Bash grant at the rule', () => {
    expect(check('Read Bash Grep')).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code'],
        message: BASH,
        range: { start: { line: 4, column: 21 }, end: { line: 4, column: 25 } },
      },
    ]);
  });

  it('reports all broad grants of a platform in one finding at the value', () => {
    expect(check('Bash(*), Bash( * ), PowerShell(*), Write, Edit')).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code'],
        message:
          '`allowed-tools` pre-approves "Bash(*)", "Bash( * )", "PowerShell(*)", "Write" and "Edit" without limits. During the turn that invokes this skill, Claude Code runs any shell command, runs any PowerShell command, writes any file and edits any file without asking.',
        range: { start: { line: 4, column: 16 }, end: { line: 4, column: 62 } },
      },
    ]);
  });

  it('adds the workspace trust qualifier for Claude Code project skills', () => {
    expect(check('Bash', '.claude/skills/x/SKILL.md')[0]?.message).toBe(
      '`allowed-tools` pre-approves "Bash" without limits. During the turn that invokes this skill, Claude Code runs any shell command without asking, even in a `-p` run in a directory you never trusted.',
    );
    const plugin = lint(
      { 'plugin/skills/x/SKILL.md': '---\nname: x\nallowed-tools: Bash\n---\n' },
      { rules: [broadAllowedToolsRule], paths: ['plugin/.claude-plugin/plugin.json'] },
    );
    expect(findings(plugin, ID).map((f) => f.message)).toEqual([BASH]);
  });

  it('reports shell and bash for GitHub Copilot', () => {
    expect(check('shell bash', '.github/skills/x/SKILL.md')).toEqual([
      expect.objectContaining({
        platforms: ['copilot'],
        message:
          '`allowed-tools` pre-approves "shell" and "bash", so GitHub Copilot runs terminal commands for this skill without asking for confirmation.',
      }),
    ]);
  });

  it('reports exec for Devin Local, which auto-approves it in the skills it reads', () => {
    const exec = [
      'windsurf',
      '`allowed-tools` auto-approves "exec", so Devin Local runs any shell command without a permission prompt while this skill runs inline.',
    ];
    const shown = (tools: string, path: string) =>
      check(tools, path).map((f) => [f.platforms.join(','), f.message]);
    expect(shown('exec read grep', '.devin/skills/x/SKILL.md')).toEqual([exec]);
    expect(shown('exec', '.claude/skills/x/SKILL.md')).toEqual([exec]);
    // Its own tools that read, and narrow or capitalized forms, are not reported.
    for (const tools of ['read grep glob', 'Exec(git status)', 'Exec', 'exec(*)']) {
      expect(check(tools, '.devin/skills/x/SKILL.md')).toEqual([]);
    }
    // Devin Local does not read `.cursor/skills`, and Cursor does not document `allowed-tools`.
    expect(check('exec', '.cursor/skills/x/SKILL.md')).toEqual([]);
    expect(check('exec', '.devin/skills/x/SKILL.md', ['claude-code'])).toEqual([]);
  });

  it('does not report exec in a skill Devin Local does not import', () => {
    const result = lint(
      {
        '.devin/config.json': '{ "read_config_from": { "claude": false } }\n',
        '.claude/skills/x/SKILL.md': '---\nname: x\nallowed-tools: exec Bash\n---\n',
        '.github/skills/y/SKILL.md': '---\nname: y\nallowed-tools: exec\n---\n',
      },
      { rules: [broadAllowedToolsRule] },
    );
    findings(result, ID);
    expect(result.findings.map((f) => `${f.path} ${f.platforms.join(',')}`)).toEqual([
      '.claude/skills/x/SKILL.md claude-code',
      '.github/skills/y/SKILL.md windsurf',
    ]);
  });

  it('reports each platform separately', () => {
    expect(check('Bash shell').map((f) => [f.platforms, f.range.start.column])).toEqual([
      [['claude-code'], 16],
      [['copilot'], 21],
    ]);
  });

  it('reads YAML lists and comma-separated items', () => {
    const result = lint(
      { 'skills/x/SKILL.md': '---\nname: x\nallowed-tools:\n  - Read\n  - Bash, Grep\n---\n' },
      { rules: [broadAllowedToolsRule] },
    );
    expect(findings(result, ID).map((f) => [f.message, f.range.start])).toEqual([
      [BASH, { line: 5, column: 5 }],
    ]);
  });

  it('does not report scoped or read-only grants', () => {
    for (const tools of [
      'Read Grep Glob',
      'Bash(git status *) Bash(git diff *)',
      'Bash(${CLAUDE_SKILL_DIR}/scripts/run.sh *)',
      'Bash(npm run test:*)',
      'Edit(src/**) Write(docs/**)',
      'WebFetch(domain:example.com)',
      '"*"',
      'mcp__github__*',
      'bash(git:*) Shell',
      'Bash()',
    ]) {
      expect(check(tools)).toEqual([]);
    }
  });

  it('only reports platforms that read the skill and are targeted', () => {
    expect(check('Bash', '.agents/skills/x/SKILL.md')).toEqual([]);
    expect(check('shell', '.claude/skills/x/SKILL.md').map((f) => f.platforms)).toEqual([
      ['copilot'],
    ]);
    expect(check('Bash', 'skills/x/SKILL.md', ['codex'])).toEqual([]);
  });

  it('ignores missing, empty and non-text values', () => {
    const result = lint(
      {
        'a/SKILL.md': '---\nname: a\n---\n',
        'b/SKILL.md': '---\nname: b\nallowed-tools:\n---\n',
        'c/SKILL.md': '---\nname: c\nallowed-tools: 3\n---\n',
        'd/SKILL.md': '---\nname: d\nallowed-tools: {Bash: true}\n---\n',
        'e/SKILL.md': '---\nallowed-tools: Bash: x\n---\n',
      },
      { rules: [broadAllowedToolsRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('falls back to the value span when a rule is written with escapes', () => {
    const result = lint(
      { 'skills/x/SKILL.md': '---\nname: x\nallowed-tools: "\\x42ash"\n---\n' },
      { rules: [broadAllowedToolsRule] },
    );
    expect(findings(result, ID).map((f) => f.range)).toEqual([
      { start: { line: 3, column: 16 }, end: { line: 3, column: 25 } },
    ]);
  });
});

describe('splitToolRules', () => {
  it('splits on spaces and commas outside parentheses', () => {
    expect(splitToolRules('Bash(git add *), Read  Grep,Bash(a, b)')).toEqual([
      'Bash(git add *)',
      'Read',
      'Grep',
      'Bash(a, b)',
    ]);
    expect(splitToolRules('  ')).toEqual([]);
    expect(splitToolRules('Dağıt\tRead')).toEqual(['Dağıt', 'Read']);
  });
});
