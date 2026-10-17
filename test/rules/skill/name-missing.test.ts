import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { nameMissingRule } from '../../../src/rules/skill/name-missing.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/name-missing';

function check(path: string, text: string, targets?: readonly PlatformId[]) {
  const result = lint(
    { [path]: text },
    { rules: [nameMissingRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/name-missing', () => {
  it('reports a skill without a name where Gemini CLI reads it', () => {
    expect(check('.agents/skills/deploy/SKILL.md', '---\ndescription: Deploys.\n---\n')).toEqual([
      {
        severity: 'error',
        platforms: ['cursor', 'copilot', 'gemini', 'cline'],
        message:
          'The frontmatter has no `name`. Gemini CLI skips the skill, Codex and Devin Local use the directory name "deploy", and Cursor, GitHub Copilot and Cline require the field.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      },
    ]);
  });

  it('adds the upload requirement for a distributable skill', () => {
    expect(check('skills/deploy/SKILL.md', '---\ndescription: Deploys.\n---\n')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['claude-code', 'cursor', 'copilot', 'gemini', 'cline'],
        message:
          'The frontmatter has no `name`. Gemini CLI skips the skill, Claude Code, Codex and Devin Local use the directory name "deploy", and Cursor, GitHub Copilot, Cline and claude.ai upload require the field.',
      }),
    ]);
  });

  it('is a portability warning for a Claude Code project skill', () => {
    expect(check('.claude/skills/deploy/SKILL.md', '---\ndescription: Deploys.\n---\n')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        platforms: ['cursor', 'copilot', 'cline'],
        message:
          'The frontmatter has no `name`. Claude Code and Devin Local use the directory name "deploy", and Cursor, GitHub Copilot and Cline require the field.',
      }),
    ]);
    expect(
      check('.gemini/skills/deploy/SKILL.md', '---\ndescription: x\n---\n', ['gemini']),
    ).toEqual([
      expect.objectContaining({
        message: 'The frontmatter has no `name`. Gemini CLI skips the skill.',
      }),
    ]);
  });

  it('does not report a skill that only agents with a fallback load', () => {
    expect(
      check('.claude/skills/deploy/SKILL.md', '---\ndescription: Deploys.\n---\n', ['claude-code']),
    ).toEqual([]);
    expect(
      check('.agents/skills/deploy/SKILL.md', '---\ndescription: x\n---\n', ['codex']),
    ).toEqual([]);
    const plugin = lint(
      { 'plugin/skills/deploy/SKILL.md': '---\ndescription: x\n---\n' },
      { rules: [nameMissingRule], paths: ['plugin/.claude-plugin/plugin.json'] },
    );
    expect(findings(plugin, ID)).toEqual([]);
  });

  it('reports an empty name at its key', () => {
    expect(check('skills/deploy/SKILL.md', '---\nname: ""\ndescription: Deploys.\n---\n')).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code', 'cursor', 'copilot', 'gemini', 'cline'],
        message:
          '`name` is empty. Gemini CLI loads the skill without a usable name, Codex uses the directory name "deploy", and Cursor, GitHub Copilot, Cline and claude.ai upload require a value.',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
      },
    ]);
    expect(
      check('skills/deploy/SKILL.md', '---\nname:\ndescription: Deploys.\n---\n'),
    ).toHaveLength(1);
    expect(
      check('skills/deploy/SKILL.md', '---\nname: ~\ndescription: Deploys.\n---\n'),
    ).toHaveLength(1);
    expect(check('skills/deploy/SKILL.md', '---\nname: "  "\n---\n')).toHaveLength(1);
  });

  it('describes a skill at the scan root without a directory name', () => {
    expect(check('SKILL.md', '---\ndescription: Deploys.\n---\n')[0]?.message).toBe(
      'The frontmatter has no `name`. Gemini CLI skips the skill, Claude Code, Codex and Devin Local use the directory name, and Cursor, GitHub Copilot, Cline and claude.ai upload require the field.',
    );
  });

  it('treats an empty frontmatter block as having no name', () => {
    expect(check('skills/deploy/SKILL.md', '---\n---\nBody.\n')).toHaveLength(1);
  });

  it('does not report a skill with a name', () => {
    expect(check('skills/deploy/SKILL.md', '---\nname: deploy\ndescription: x\n---\n')).toEqual([]);
    expect(check('skills/dağıt/SKILL.md', '---\r\nname: dağıt 🚀\r\n---\r\n')).toEqual([]);
    expect(check('skills/deploy/SKILL.md', '---\nname: 42\n---\n')).toEqual([]);
  });

  it('leaves missing and invalid frontmatter to other rules', () => {
    expect(check('skills/deploy/SKILL.md', '# Deploy\n')).toEqual([]);
    expect(check('skills/deploy/SKILL.md', '---\ndescription: [\n---\n')).toEqual([]);
  });

  it('is case-sensitive about the key', () => {
    expect(check('skills/deploy/SKILL.md', '---\nName: deploy\n---\n')).toHaveLength(1);
  });
});
