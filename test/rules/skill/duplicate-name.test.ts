import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { duplicateNameRule } from '../../../src/rules/skill/duplicate-name.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';

const ID = 'skill/duplicate-name';
const skill = (name?: string) =>
  `---\n${name === undefined ? '' : `name: ${name}\n`}description: Deploys.\n---\nSteps.\n`;

function check(
  files: Record<string, string>,
  options: Partial<LintOptions> & { targets?: readonly PlatformId[] } = {},
) {
  const result = lint(files, { rules: [duplicateNameRule], ...options });
  findings(result, ID);
  return result.findings.map((f) => ({
    path: f.path,
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
    related: f.related,
  }));
}

describe('skill/duplicate-name', () => {
  it('reports the second skill with the same name in one skills directory', () => {
    expect(
      check({
        '.claude/skills/a/SKILL.md': skill('deploy'),
        '.claude/skills/b/SKILL.md': skill('deploy'),
      }),
    ).toEqual([
      {
        path: '.claude/skills/b/SKILL.md',
        severity: 'warn',
        platforms: ['claude-code', 'copilot', 'cline'],
        message:
          'Skill name "deploy" is also used by ".claude/skills/a/SKILL.md". Claude Code gives "/deploy" to only one of them, GitHub Copilot requires names to be unique, and Cline loads only one of them.',
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } },
        related: [
          {
            path: '.claude/skills/a/SKILL.md',
            message: 'Also named "deploy".',
            range: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } },
          },
        ],
      },
    ]);
  });

  it('compares a name with another skill directory name', () => {
    const result = check({
      '.claude/skills/deploy/SKILL.md': skill(),
      '.claude/skills/x/SKILL.md': skill('deploy'),
    });
    expect(result.map((f) => [f.path, f.platforms, f.message])).toEqual([
      [
        '.claude/skills/x/SKILL.md',
        ['claude-code', 'cline'],
        'Skill name "deploy" is also used by ".claude/skills/deploy/SKILL.md". Claude Code gives "/deploy" to only one of them, and Cline loads only one of them.',
      ],
    ]);
  });

  it('compares nested skills only for platforms that search the whole tree', () => {
    const result = check({
      '.agents/skills/a/tool/SKILL.md': skill(),
      '.agents/skills/b/tool/SKILL.md': skill(),
    });
    // Cursor identifies a skill by its directory and does not document a clash: information.
    expect(result.map((f) => [f.platforms, f.message])).toEqual([
      [
        ['codex', 'cursor'],
        'Skill name "tool" is also used by ".agents/skills/a/tool/SKILL.md". Codex lists both under the same name, and Cursor reads both and does not document which one the name reaches.',
      ],
    ]);
  });

  it('reports Gemini CLI keeping one of two skills', () => {
    expect(
      check({
        '.gemini/skills/a/SKILL.md': skill('deploy'),
        '.gemini/skills/b/SKILL.md': skill('deploy'),
      })[0]?.message,
    ).toBe(
      'Skill name "deploy" is also used by ".gemini/skills/a/SKILL.md". Gemini CLI loads only one of them.',
    );
  });

  it('compares names after trimming and NFKC normalization', () => {
    const fullwidth = String.fromCodePoint(0xff44, 0xff45, 0xff50, 0xff4c, 0xff4f, 0xff59);
    expect(
      check({
        '.claude/skills/a/SKILL.md': skill('" deploy "'),
        '.claude/skills/b/SKILL.md': skill(fullwidth),
      }),
    ).toHaveLength(1);
    // Only Cline compares names without regard to letter case.
    expect(
      check({
        '.claude/skills/a/SKILL.md': skill('deploy'),
        '.claude/skills/b/SKILL.md': skill('Deploy'),
      }).map((f) => [f.platforms, f.message]),
    ).toEqual([
      [
        ['cline'],
        'Skill name "Deploy" is also used by ".claude/skills/a/SKILL.md" as "deploy". Cline loads only one of them.',
      ],
    ]);
    expect(
      check(
        {
          '.claude/skills/a/SKILL.md': skill('deploy'),
          '.claude/skills/b/SKILL.md': skill('Deploy'),
        },
        { targets: ['claude-code', 'copilot'] },
      ),
    ).toEqual([]);
  });

  it('compares the skills directories of one project for the agents that read both', () => {
    const result = check({
      '.agents/skills/deploy/SKILL.md': skill('deploy'),
      '.claude/skills/deploy/SKILL.md': skill('deploy'),
    });
    expect(result).toEqual([
      {
        path: '.claude/skills/deploy/SKILL.md',
        severity: 'warn',
        platforms: ['cursor', 'copilot', 'windsurf', 'cline'],
        message:
          'Skill name "deploy" is also used by ".agents/skills/deploy/SKILL.md". GitHub Copilot requires names to be unique, Cline loads only one of them, and Cursor and Devin Local read both and do not document which one the name reaches.',
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } },
        related: [
          {
            path: '.agents/skills/deploy/SKILL.md',
            message: 'Also named "deploy".',
            range: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } },
          },
        ],
      },
    ]);
    // Claude Code and Codex each read one of the two directories.
    expect(
      check(
        {
          '.agents/skills/deploy/SKILL.md': skill('deploy'),
          '.claude/skills/deploy/SKILL.md': skill('deploy'),
        },
        { targets: ['claude-code', 'codex'] },
      ),
    ).toEqual([]);
    // Gemini CLI reads .gemini/skills and .agents/skills, and keeps one of them.
    expect(
      check({
        '.agents/skills/a/SKILL.md': skill('deploy'),
        '.gemini/skills/b/SKILL.md': skill('deploy'),
      }).map((f) => [f.path, f.platforms]),
    ).toEqual([['.gemini/skills/b/SKILL.md', ['gemini']]]);
  });

  it('suggests keeping one copy of a skill copied into two skills directories', () => {
    const lintResult = lint(
      {
        '.agents/skills/deploy/SKILL.md': skill('deploy'),
        '.claude/skills/deploy/SKILL.md': skill('deploy'),
      },
      { rules: [duplicateNameRule] },
    );
    expect(lintResult.findings.map((f) => f.guidance)).toEqual([
      'if both are the same skill, keep one copy and make ".claude/skills/deploy" a symlink to ".agents/skills/deploy"; otherwise rename one of them',
    ]);
  });

  it('does not compare skills of different projects or outside skills directories', () => {
    expect(
      check({
        '.claude/skills/deploy/SKILL.md': skill('deploy'),
        'apps/web/.claude/skills/deploy/SKILL.md': skill('deploy'),
        'apps/api/.agents/skills/deploy/SKILL.md': skill('deploy'),
        '.cursor/skills/ship/SKILL.md': skill('deploy'),
        'skills/a/SKILL.md': skill('deploy'),
        'skills/b/SKILL.md': skill('deploy'),
      }),
    ).toEqual([]);
  });

  it('treats a skill reached through several symlinks as one skill', () => {
    expect(
      check(
        {
          '.claude/skills/a/SKILL.md': skill('deploy'),
          '.claude/skills/b/SKILL.md': skill('deploy'),
        },
        { symlinks: { '.claude/skills/b/SKILL.md': '.claude/skills/a/SKILL.md' } },
      ),
    ).toEqual([]);
  });

  it('finds a duplicate through a symlinked path', () => {
    const result = check(
      {
        '.agents/skills/deploy/SKILL.md': skill('deploy'),
        '.claude/skills/deploy/SKILL.md': skill('deploy'),
        '.claude/skills/ship/SKILL.md': skill('deploy'),
      },
      { symlinks: { '.claude/skills/deploy/SKILL.md': '.agents/skills/deploy/SKILL.md' } },
    );
    // One finding: the other skill is one skill, whichever of its paths a platform reads.
    expect(result.map((f) => [f.path, f.message])).toEqual([
      [
        '.claude/skills/ship/SKILL.md',
        'Skill name "deploy" is also used by ".claude/skills/deploy/SKILL.md". Claude Code gives "/deploy" to only one of them, GitHub Copilot requires names to be unique, and Cline loads only one of them.',
      ],
    ]);
  });

  it('names the symlinked path through which a skill collides', () => {
    const result = check(
      {
        'skills/a/SKILL.md': skill('deploy'),
        'skills/b/SKILL.md': skill('deploy'),
        '.gemini/skills/a/SKILL.md': skill('deploy'),
        '.gemini/skills/b/SKILL.md': skill('deploy'),
      },
      {
        symlinks: {
          '.gemini/skills/a/SKILL.md': 'skills/a/SKILL.md',
          '.gemini/skills/b/SKILL.md': 'skills/b/SKILL.md',
        },
      },
    );
    expect(result.map((f) => [f.path, f.message])).toEqual([
      [
        'skills/b/SKILL.md',
        `Skill name "deploy" is also used by ".gemini/skills/a/SKILL.md", in the same skills directory as this skill's symlink ".gemini/skills/b/SKILL.md". Gemini CLI loads only one of them.`,
      ],
    ]);
  });

  it('honors targets and skips files Codex does not discover', () => {
    const files = {
      '.claude/skills/a/SKILL.md': skill('deploy'),
      '.claude/skills/b/SKILL.md': skill('deploy'),
    };
    expect(check(files, { targets: ['codex', 'cursor'] })).toEqual([]);
    expect(
      check({ '.agents/skills/a/x/skill.md': skill(), '.agents/skills/b/x/SKILL.md': skill() }),
    ).toEqual([]);
  });

  it('counts a skill without frontmatter under its directory name where agents load it so', () => {
    const files = {
      '.agents/skills/canary/SKILL.md': skill('canary'),
      '.claude/skills/canary/SKILL.md': '@../../../.agents/skills/canary/SKILL.md\n',
    };
    // GitHub Copilot needs a name, and Claude Code reads only one of the two directories.
    expect(check(files).map((f) => [f.path, f.severity, f.platforms, f.message])).toEqual([
      [
        '.claude/skills/canary/SKILL.md',
        'warn',
        ['cursor', 'windsurf', 'cline'],
        'Skill name "canary" is also used by ".agents/skills/canary/SKILL.md". Cline loads only one of them, and Cursor and Devin Local read both and do not document which one the name reaches.',
      ],
    ]);
    // Cline drops a skill without a body, so only Cursor and Devin Local see two skills.
    expect(
      check({ ...files, '.claude/skills/canary/SKILL.md': '' }).map((f) => [
        f.severity,
        f.platforms,
      ]),
    ).toEqual([['info', ['cursor', 'windsurf']]]);
  });

  it('skips skills without readable frontmatter', () => {
    expect(
      check({
        '.claude/skills/a/SKILL.md': '# a\n',
        '.claude/skills/b/SKILL.md': '---\nname: [\n---\n',
      }),
    ).toEqual([]);
  });
});
