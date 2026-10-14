import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { nameReservedWordRule } from '../../../src/rules/skill/name-reserved-word.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';

const ID = 'skill/name-reserved-word';
const skill = (name: string) => `---\nname: ${name}\ndescription: Deploys.\n---\n`;

function check(
  files: Record<string, string>,
  options: Partial<LintOptions> & { targets?: readonly PlatformId[] } = {},
) {
  const result = lint(files, { rules: [nameReservedWordRule], ...options });
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/name-reserved-word', () => {
  it('reports the reserved words as an upload problem', () => {
    expect(check({ 'skills/claude-tools/SKILL.md': skill('claude-tools') })).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code'],
        message:
          'Skill name "claude-tools" contains the reserved word "claude", so the Claude API and claude.ai upload reject the skill.',
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 19 } },
      },
    ]);
    expect(check({ 'skills/x/SKILL.md': skill('anthropic-helper') })[0]?.message).toContain(
      'the reserved word "anthropic"',
    );
    expect(check({ 'skills/x/SKILL.md': skill('Claude_Helper') })).toHaveLength(1);
  });

  it('reports the anthropic-skills namespace as a Claude Code loading error', () => {
    expect(check({ '.claude/skills/x/SKILL.md': skill('anthropic-skills:pdf') })).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code'],
        message:
          'Skill name "anthropic-skills:pdf" is reserved for skills synced from claude.ai, so Claude Code skips the skill.',
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 27 } },
      },
    ]);
    expect(check({ 'skills/x/SKILL.md': skill('anthropic-skills') })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message:
          'Skill name "anthropic-skills" is reserved for skills synced from claude.ai, so Claude Code skips the skill. The Claude API and claude.ai upload also reject a name that contains "anthropic".',
      }),
    ]);
    // Inside a plugin, Claude Code loads it.
    expect(
      check(
        { 'plugin/skills/x/SKILL.md': skill('anthropic-skills') },
        { paths: ['plugin/.claude-plugin/plugin.json'] },
      ),
    ).toEqual([]);
  });

  it('reports reserved skill folder names under .claude/skills', () => {
    expect(check({ '.claude/skills/Synced/SKILL.md': skill('deploy') })).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code'],
        message:
          'The skill directory "Synced" is reserved for skills synced from claude.ai, so Claude Code skips this skill.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
    expect(check({ '.claude/skills/anthropic-skills/SKILL.md': '# x\n' })[0]?.message).toBe(
      'The skill directory "anthropic-skills" is reserved for skills synced from claude.ai, so Claude Code skips this skill.',
    );
  });

  it('checks reserved folder names through symlinked paths', () => {
    const result = check(
      {
        '.agents/skills/synced/SKILL.md': skill('synced'),
        '.claude/skills/synced/SKILL.md': skill('synced'),
      },
      { symlinks: { '.claude/skills/synced/SKILL.md': '.agents/skills/synced/SKILL.md' } },
    );
    expect(result.map((f) => f.severity)).toEqual(['error']);
  });

  it('ignores reserved folder names outside the Claude Code skill directories', () => {
    expect(check({ '.agents/skills/synced/SKILL.md': skill('synced') })).toEqual([]);
    expect(check({ '.claude/skills/team/synced/SKILL.md': skill('synced') })).toEqual([]);
    // Nested `.claude/skills` directories are not the documented project location.
    expect(check({ 'packages/web/.claude/skills/synced/SKILL.md': skill('synced') })).toEqual([]);
    expect(
      check({ 'packages/web/.claude/skills/anthropic-skills/SKILL.md': '# x\n' })[0]?.severity,
    ).toBe('error');
    expect(check({ 'plugins/x/skills/synced/SKILL.md': skill('synced') })).toEqual([]);
  });

  it('does not report ordinary names', () => {
    for (const name of ['deploy', 'claud', 'anthropi', 'pdf-processing', 'dağıt']) {
      expect(check({ [`skills/${name}/SKILL.md`]: skill(name) })).toEqual([]);
    }
    expect(check({ 'skills/x/SKILL.md': '---\ndescription: claude\n---\n' })).toEqual([]);
    expect(check({ 'skills/x/SKILL.md': '---\nname: claude: x\n---\n' })).toEqual([]);
  });

  it('reports the reserved words only for skills uploaded on their own', () => {
    expect(check({ '.claude/skills/claude-tools/SKILL.md': skill('claude-tools') })).toEqual([]);
    expect(
      check(
        { 'plugin/skills/claude-coach/SKILL.md': skill('claude-coach') },
        { paths: ['plugin/.claude-plugin/plugin.json'] },
      ),
    ).toEqual([]);
  });

  it('does not run when Claude Code is not targeted', () => {
    expect(check({ 'skills/x/SKILL.md': skill('claude-tools') }, { targets: ['codex'] })).toEqual(
      [],
    );
  });
});
