import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { duplicateNameRule } from '../../../src/rules/skill/duplicate-name.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';

const ID = 'skill/duplicate-name';
const skill = (name?: string) =>
  `---\n${name === undefined ? '' : `name: ${name}\n`}description: Deploys.\n---\n`;

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
        platforms: ['claude-code', 'copilot'],
        message:
          'Skill name "deploy" is also used by ".claude/skills/a/SKILL.md". Claude Code gives "/deploy" to only one of them, and GitHub Copilot requires names to be unique.',
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
        ['claude-code'],
        'Skill name "deploy" is also used by ".claude/skills/deploy/SKILL.md". Claude Code gives "/deploy" to only one of them.',
      ],
    ]);
  });

  it('compares nested skills only for platforms that search the whole tree', () => {
    const result = check({
      '.agents/skills/a/tool/SKILL.md': skill(),
      '.agents/skills/b/tool/SKILL.md': skill(),
    });
    expect(result.map((f) => [f.platforms, f.message])).toEqual([
      [
        ['codex'],
        'Skill name "tool" is also used by ".agents/skills/a/tool/SKILL.md". Codex lists both under the same name.',
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
    expect(
      check({
        '.claude/skills/a/SKILL.md': skill('deploy'),
        '.claude/skills/b/SKILL.md': skill('Deploy'),
      }),
    ).toEqual([]);
  });

  it('does not compare skills in different skills directories', () => {
    expect(
      check({
        '.claude/skills/deploy/SKILL.md': skill('deploy'),
        'apps/web/.claude/skills/deploy/SKILL.md': skill('deploy'),
        '.agents/skills/deploy/SKILL.md': skill('deploy'),
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
    expect(result.map((f) => [f.path, f.message])).toEqual([
      [
        '.claude/skills/ship/SKILL.md',
        'Skill name "deploy" is also used by ".claude/skills/deploy/SKILL.md". Claude Code gives "/deploy" to only one of them, and GitHub Copilot requires names to be unique.',
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

  it('skips skills without readable frontmatter', () => {
    expect(
      check({
        '.claude/skills/a/SKILL.md': '# a\n',
        '.claude/skills/b/SKILL.md': '---\nname: [\n---\n',
      }),
    ).toEqual([]);
  });
});
