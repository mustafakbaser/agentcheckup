import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { nameFormatRule } from '../../../src/rules/skill/name-format.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/name-format';

function check(name: string, path = 'skills/x/SKILL.md', targets?: readonly PlatformId[]) {
  const result = lint(
    { [path]: `---\nname: ${name}\ndescription: Deploys.\n---\n` },
    { rules: [nameFormatRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

const UPLOAD = 'the skills-ref validator and claude.ai upload reject the skill';

describe('skill/name-format', () => {
  it('reports uppercase letters and other characters', () => {
    expect(check('Deploy_Prod')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'cursor', 'copilot'],
        message: `Skill name "Deploy_Prod" has uppercase letters and contains "_", which is not a lowercase letter, digit or hyphen. GitHub Copilot in VS Code does not load the skill, Cursor requires lowercase letters, digits and hyphens, and ${UPLOAD}.`,
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 18 } },
      },
    ]);
  });

  it('reports a name over 64 characters, counted in code points', () => {
    const long = 'a'.repeat(65);
    expect(check(long)[0]).toEqual(
      expect.objectContaining({
        severity: 'error',
        platforms: ['claude-code', 'codex', 'copilot'],
        message: `Skill name "${'a'.repeat(60)}…" is 65 characters long (the limit is 64). Codex skips the skill, GitHub Copilot in VS Code allows at most 64 characters, and ${UPLOAD}.`,
      }),
    );
    expect(check('a'.repeat(64))).toEqual([]);
    // 64 non-ASCII letters are 64 code points: only the packager complains.
    expect(check('ğ'.repeat(64))[0]?.severity).toBe('warn');
  });

  it('measures length after NFKC normalization', () => {
    // U+FB01 (fi ligature) expands to two letters under NFKC: 33 ligatures are 66 characters.
    const ligatures = String.fromCodePoint(0xfb01).repeat(33);
    expect(check(ligatures)[0]?.message).toContain('is 66 characters long (the limit is 64)');
    // Codex counts the raw 33 characters and loads the skill.
    expect(check(ligatures)[0]?.platforms).not.toContain('codex');
  });

  it('reports hyphens at the edges and doubled hyphens, which every validator rejects', () => {
    expect(check('-deploy-')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['claude-code'],
        message: `Skill name "-deploy-" starts and ends with a hyphen. The skills-ref validator and the anthropics/skills packager reject the skill.`,
      }),
    ]);
    expect(check('deploy-')[0]?.message).toContain('ends with a hyphen');
    expect(check('-deploy')[0]?.message).toContain('starts with a hyphen');
    expect(check('pdf--tools')[0]?.message).toBe(
      'Skill name "pdf--tools" contains "--". The skills-ref validator and the anthropics/skills packager reject the skill.',
    );
  });

  it('reports non-ASCII letters for the packager only', () => {
    expect(check('dağıt')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        platforms: ['claude-code'],
        message:
          'Skill name "dağıt" uses non-ASCII letters or digits ("ğ" and "ı"). The anthropics/skills packager accepts only a-z, 0-9 and hyphens, so it rejects the skill.',
      }),
    ]);
    expect(check('部署')).toHaveLength(1);
    expect(check('İstanbul')[0]?.message).toContain('has uppercase letters');
  });

  it('names invisible characters by code point and mentions Claude Code', () => {
    const zeroWidth = `deploy${String.fromCodePoint(0x200b)}prod`;
    expect(check(zeroWidth)[0]?.message).toBe(
      `Skill name "${zeroWidth}" contains U+200B, which is not a lowercase letter, digit or hyphen. GitHub Copilot in VS Code does not load the skill, Cursor requires lowercase letters, digits and hyphens, Claude Code refuses the name, and ${UPLOAD}.`,
    );
    expect(check('"two  spaces"')[0]?.message).toContain('Claude Code refuses the name');
    expect(check('one space')[0]?.message).not.toContain('Claude Code');
    expect(check('"<b>x</b>"')[0]?.message).toContain('contains "<", ">" and "/", which are not');
  });

  it('reports names that are not text', () => {
    expect(check('[a, b]')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['claude-code', 'codex'],
        message:
          '`name` is a list, not text. Codex cannot read the frontmatter and skips the skill, and the skills-ref validator rejects it.',
      }),
    ]);
    expect(check('{a: b}')[0]?.message).toContain('is a map');
  });

  it('does not report valid names or values handled elsewhere', () => {
    for (const name of [
      'deploy',
      'pdf-processing',
      'a',
      'v2-tools',
      '"quoted-name"',
      '42',
      'true',
      '""',
      '~',
    ]) {
      expect(check(name)).toEqual([]);
    }
    // Leading and trailing spaces in a quoted name are trimmed, as skills-ref does.
    expect(check('" deploy "')).toEqual([]);
  });

  it('judges skills in agent directories and plugins only by the agents that load them', () => {
    expect(check('Deploy', '.claude/skills/Deploy/SKILL.md')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['cursor', 'copilot'],
        message:
          'Skill name "Deploy" has uppercase letters. GitHub Copilot in VS Code does not load the skill, and Cursor requires lowercase letters, digits and hyphens.',
      }),
    ]);
    expect(check('Deploy', '.gemini/skills/Deploy/SKILL.md')).toEqual([]);
    expect(check('-deploy-', '.claude/skills/x/SKILL.md')).toEqual([]);
    expect(check('a'.repeat(70), '.claude/skills/x/SKILL.md', ['codex'])).toEqual([]);
    expect(check('a'.repeat(70), '.agents/skills/x/SKILL.md', ['codex'])[0]?.severity).toBe(
      'error',
    );
    const plugin = lint(
      {
        'plugins/dev/skills/agent-development/SKILL.md':
          '---\nname: Agent Development\ndescription: d\n---\n',
      },
      { rules: [nameFormatRule], paths: ['plugins/dev/.claude-plugin/plugin.json'] },
    );
    expect(findings(plugin, ID)).toEqual([]);
  });

  it('skips skills in template, example and fixture folders', () => {
    const skill = '---\nname: Test Skill\ndescription: d\n---\n';
    const result = lint(
      {
        'template/SKILL.md': skill,
        'x/test/scout/assets/plugins/test-plugin/skills/test-skill/SKILL.md': skill,
        'docs/examples/demo/SKILL.md': skill,
        'pkg/__fixtures__/s/SKILL.md': skill,
        'my-templates/s/SKILL.md': skill,
      },
      { rules: [nameFormatRule] },
    );
    expect(findings(result, ID)).toEqual([]);
    // The file name itself is not a folder: a skill directory still counts.
    expect(check('Test_Skill', 'skills/x/SKILL.md')).toHaveLength(1);
  });

  it('skips a SKILL.md bundled inside another skill', () => {
    const result = lint(
      {
        'skills/outer/SKILL.md': '---\nname: outer\n---\n',
        'skills/outer/assets/Sample/SKILL.md': '---\nname: Test Skill\n---\n',
      },
      { rules: [nameFormatRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const result = lint(
      { 'skills/x/SKILL.md': '---\r\nname: Bad_Name\r\n---\r\n' },
      { rules: [nameFormatRule] },
    );
    expect(findings(result, ID).map((f) => f.range)).toEqual([
      { start: { line: 2, column: 7 }, end: { line: 2, column: 15 } },
    ]);
  });

  it('skips missing and invalid frontmatter', () => {
    const result = lint(
      { 'a/SKILL.md': '# Bad_Name\n', 'b/SKILL.md': '---\nname: Bad_Name: x\n---\n' },
      { rules: [nameFormatRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });
});
