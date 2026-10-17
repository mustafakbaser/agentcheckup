import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { nameDirMismatchRule } from '../../../src/rules/skill/name-dir-mismatch.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';

const ID = 'skill/name-dir-mismatch';
const skill = (name: string) => `---\nname: ${name}\ndescription: Deploys.\n---\n`;

function check(
  files: Record<string, string>,
  options: Partial<LintOptions> & { targets?: readonly PlatformId[] } = {},
) {
  const result = lint(files, { rules: [nameDirMismatchRule], ...options });
  findings(result, ID);
  return result.findings.map((f) => ({
    path: f.path,
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

const CONSEQUENCE =
  'GitHub Copilot in VS Code does not load the skill, and Cursor, Cline and the Agent Skills specification require them to match.';

describe('skill/name-dir-mismatch', () => {
  it('reports a name that differs from the directory of a distributable skill', () => {
    expect(check({ 'skills/deploy-prod/SKILL.md': skill('deploy') })).toEqual([
      {
        path: 'skills/deploy-prod/SKILL.md',
        severity: 'error',
        platforms: ['claude-code', 'cursor', 'copilot', 'cline'],
        message: `Skill name "deploy" does not match its directory "deploy-prod". ${CONSEQUENCE}`,
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } },
      },
    ]);
  });

  it('judges a project skill only by the agents that load it', () => {
    expect(check({ '.agents/skills/deploy-prod/SKILL.md': skill('deploy') })).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['cursor', 'copilot', 'cline'],
        message:
          'Skill name "deploy" does not match its directory "deploy-prod". GitHub Copilot in VS Code does not load the skill, and Cursor and Cline require them to match.',
      }),
    ]);
  });

  it('compares case-sensitively after NFKC normalization', () => {
    expect(check({ 'skills/Deploy/SKILL.md': skill('deploy') })).toHaveLength(1);
    // Fullwidth letters normalize to ASCII under NFKC, as skills-ref compares them.
    const fullwidth = String.fromCodePoint(0xff44, 0xff45, 0xff50, 0xff4c, 0xff4f, 0xff59);
    expect(check({ [`skills/${fullwidth}/SKILL.md`]: skill('deploy') })).toEqual([]);
    expect(check({ 'skills/dağıt/SKILL.md': skill('dağıt') })).toEqual([]);
  });

  it('names Cline, whose documentation requires the match, as a warning', () => {
    expect(check({ '.cline/skills/deploy-prod/SKILL.md': skill('deploy') })).toEqual([
      expect.objectContaining({
        severity: 'warn',
        platforms: ['cline'],
        message:
          'Skill name "deploy" does not match its directory "deploy-prod". Cline requires them to match.',
      }),
    ]);
  });

  it('does not report where no agent that loads the skill enforces the match', () => {
    expect(check({ '.gemini/skills/deploy-prod/SKILL.md': skill('deploy') })).toEqual([]);
    expect(
      check(
        { '.agents/skills/deploy-prod/SKILL.md': skill('deploy') },
        { targets: ['codex', 'gemini'] },
      ),
    ).toEqual([]);
  });

  it('judges plugin skills by the plugin agents', () => {
    const claude = { paths: ['plugins/dev/.claude-plugin/plugin.json'] };
    expect(
      check({ 'plugins/dev/skills/agent-dev/SKILL.md': skill('agent-development') }, claude),
    ).toEqual([]);
    const cursor = { paths: ['plugins/dev/.cursor-plugin/plugin.json'] };
    expect(
      check({ 'plugins/dev/skills/agent-dev/SKILL.md': skill('agent-development') }, cursor).map(
        (f) => [f.severity, f.platforms, f.message],
      ),
    ).toEqual([
      [
        'warn',
        ['cursor'],
        'Skill name "agent-development" does not match its directory "agent-dev". Cursor requires them to match.',
      ],
    ]);
    expect(
      check(
        { 'my-plugin/SKILL.md': skill('review') },
        { paths: ['my-plugin/.codex-plugin/plugin.json'] },
      ),
    ).toEqual([]);
  });

  it('skips a SKILL.md bundled inside another skill', () => {
    expect(
      check({
        'skills/toolsmith/SKILL.md': skill('toolsmith'),
        'skills/toolsmith/assets/sample-skill/SKILL.md': skill('decision-record'),
      }),
    ).toEqual([]);
  });

  it('checks the directory of each symlinked path', () => {
    const result = check(
      {
        '.agents/skills/deploy/SKILL.md': skill('deploy'),
        '.claude/skills/ship/SKILL.md': skill('deploy'),
      },
      { symlinks: { '.claude/skills/ship/SKILL.md': '.agents/skills/deploy/SKILL.md' } },
    );
    expect(result.map((f) => [f.path, f.message])).toEqual([
      [
        '.agents/skills/deploy/SKILL.md',
        'Skill name "deploy" does not match the directory "ship" of its symlink ".claude/skills/ship/SKILL.md". GitHub Copilot in VS Code does not load the skill, and Cursor and Cline require them to match.',
      ],
    ]);
  });

  it('ignores symlinked paths that only lenient platforms read', () => {
    expect(
      check(
        {
          'skills/deploy/SKILL.md': skill('deploy'),
          '.gemini/skills/skills-deploy/SKILL.md': skill('deploy'),
        },
        { symlinks: { '.gemini/skills/skills-deploy/SKILL.md': 'skills/deploy/SKILL.md' } },
      ),
    ).toEqual([]);
  });

  it('does not report matching names, plugin roots or skills at the scan root', () => {
    expect(check({ 'skills/deploy/SKILL.md': skill('deploy') })).toEqual([]);
    expect(check({ 'skills/deploy/SKILL.md': skill('" deploy "') })).toEqual([]);
    expect(check({ 'SKILL.md': skill('deploy') })).toEqual([]);
    expect(
      check(
        { 'my-plugin/SKILL.md': skill('review') },
        { paths: ['my-plugin/.claude-plugin/plugin.json'] },
      ),
    ).toEqual([]);
  });

  it('leaves missing names and invalid frontmatter to other rules', () => {
    expect(check({ 'skills/deploy/SKILL.md': '---\ndescription: x\n---\n' })).toEqual([]);
    expect(check({ 'skills/deploy/SKILL.md': skill('""') })).toEqual([]);
    expect(check({ 'skills/deploy/SKILL.md': skill('[a]') })).toEqual([]);
    expect(check({ 'skills/deploy/SKILL.md': '---\nname: other: x\n---\n' })).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const result = check({ 'skills/deploy/SKILL.md': '---\r\nname: ship\r\n---\r\n' });
    expect(result.map((f) => f.range)).toEqual([
      { start: { line: 2, column: 7 }, end: { line: 2, column: 11 } },
    ]);
  });
});
