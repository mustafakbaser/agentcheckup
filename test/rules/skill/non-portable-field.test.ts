import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { nonPortableFieldRule } from '../../../src/rules/skill/non-portable-field.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';

const ID = 'skill/non-portable-field';
/** Outside every skills directory and plugin: uploaded or installed on its own. */
const DISTRIBUTABLE = 'skills/deploy/SKILL.md';
const REJECTED = 'claude.ai upload, the Claude API and the skills-ref validator reject the skill';

function check(
  frontmatter: string,
  path = DISTRIBUTABLE,
  options: Partial<LintOptions> & { targets?: readonly PlatformId[] } = {},
) {
  const result = lint(
    { [path]: `---\nname: deploy\ndescription: Deploys.\n${frontmatter}---\n` },
    { rules: [nonPortableFieldRule], ...options },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/non-portable-field', () => {
  describe('in a skill uploaded or installed on its own', () => {
    it('reports a Claude Code extension field at its key', () => {
      expect(check('when_to_use: Before every deploy\n')).toEqual([
        {
          severity: 'warn',
          platforms: ['claude-code'],
          message: `"when_to_use" is not an Agent Skills field: Claude Code reads it, but ${REJECTED}.`,
          range: { start: { line: 4, column: 1 }, end: { line: 4, column: 12 } },
        },
      ]);
    });

    it('names every agent that reads a shared extension', () => {
      expect(check('disable-model-invocation: true\n')[0]?.message).toBe(
        `"disable-model-invocation" is not an Agent Skills field: Claude Code, Cursor and GitHub Copilot read it, but ${REJECTED}.`,
      );
      expect(check('paths: src/**\n')[0]?.message).toContain('Claude Code and Cursor read it');
      expect(check('icon: rocket\n')[0]?.message).toContain('Cursor reads it');
    });

    it('reports all fields of the skill in one finding at the first one', () => {
      expect(check('tags: [deploy]\n__proto__: x\nconstructor: y\n')).toEqual([
        {
          severity: 'warn',
          platforms: ['claude-code'],
          message: `"tags", "__proto__" and "constructor" are not Agent Skills fields, so ${REJECTED}. Move your own keys under \`metadata\`.`,
          range: { start: { line: 4, column: 1 }, end: { line: 4, column: 5 } },
        },
      ]);
      expect(check('tags: x\n')[0]?.message).toBe(
        `"tags" is not an Agent Skills field, so ${REJECTED}. Move it under \`metadata\`.`,
      );
      expect(check('a: 1\nb: 2\nc: 3\nd: 4\ne: 5\n')[0]?.message).toBe(
        `"a", "b", "c" and 2 more are not Agent Skills fields, so ${REJECTED}. Move your own keys under \`metadata\`.`,
      );
    });

    it('is case-sensitive about field names', () => {
      expect(check('License: MIT\n')[0]?.message).toContain(
        '"License" is not an Agent Skills field',
      );
    });

    it('does not suggest metadata when every field is a known extension', () => {
      expect(check('model: opus\nagent: Explore\ncontext: fork\n')).toEqual([
        expect.objectContaining({
          message: `"model", "agent" and "context" are not Agent Skills fields, so ${REJECTED}.`,
          range: { start: { line: 4, column: 1 }, end: { line: 4, column: 6 } },
        }),
      ]);
    });

    it('only runs when Claude Code is targeted', () => {
      expect(check('when_to_use: x\n', DISTRIBUTABLE, { targets: ['codex', 'cursor'] })).toEqual(
        [],
      );
    });

    it('handles CRLF and non-ASCII keys', () => {
      const result = lint(
        { [DISTRIBUTABLE]: '---\r\nname: deploy\r\nsürüm: 1\r\n---\r\n' },
        { rules: [nonPortableFieldRule] },
      );
      expect(findings(result, ID).map((f) => [f.message, f.range.start])).toEqual([
        [
          `"sürüm" is not an Agent Skills field, so ${REJECTED}. Move it under \`metadata\`.`,
          { line: 3, column: 1 },
        ],
      ]);
    });
  });

  describe('in an agent skills directory or a plugin', () => {
    it('reports a field that some of the agents loading the skill do not list', () => {
      expect(check('user-invocable: false\n', '.claude/skills/deploy/SKILL.md')).toEqual([
        {
          severity: 'warn',
          platforms: ['cursor'],
          message:
            '"user-invocable" is a documented skill field in Claude Code and GitHub Copilot but not in Cursor, so the agents that load this skill treat it differently.',
          range: { start: { line: 4, column: 1 }, end: { line: 4, column: 15 } },
        },
      ]);
    });

    it('does not report a field that no agent loading the skill documents', () => {
      expect(check('when_to_use: x\n', '.agents/skills/deploy/SKILL.md')).toEqual([]);
      expect(check('color: blue\n', '.gemini/skills/deploy/SKILL.md')).toEqual([]);
    });

    it('does not report fields that every agent loading the skill reads', () => {
      const plugin = { paths: ['plugins/discord/.claude-plugin/plugin.json'] };
      expect(
        check(
          'user-invocable: false\nwhen_to_use: x\n',
          'plugins/discord/skills/access/SKILL.md',
          plugin,
        ),
      ).toEqual([]);
      expect(check('disable-model-invocation: true\n', '.claude/skills/deploy/SKILL.md')).toEqual(
        [],
      );
    });

    it('judges a plugin skill without aliases by its plugin agents', () => {
      const text = '---\nname: x\ndescription: d\ncontext: fork\n---\n';
      const claudeOnly = lint(
        { 'launcher/skills/x/SKILL.md': text },
        { rules: [nonPortableFieldRule], paths: ['launcher/.claude-plugin/plugin.json'] },
      );
      expect(findings(claudeOnly, ID)).toEqual([]);
      const both = lint(
        { 'launcher/skills/x/SKILL.md': text },
        {
          rules: [nonPortableFieldRule],
          paths: ['launcher/.claude-plugin/plugin.json', 'launcher/.codex-plugin/plugin.json'],
        },
      );
      expect(findings(both, ID).map((f) => f.message)).toEqual([
        '"context" is a documented skill field in Claude Code but not in Codex, so the agents that load this skill treat it differently.',
      ]);
    });

    it('counts the agents that load a plugin skill through symlinks in their skills directories', () => {
      const text = '---\nname: x\ndescription: d\ncontext: fork\n---\n';
      const result = lint(
        {
          'launcher/skills/x/SKILL.md': text,
          '.codex/skills/x/SKILL.md': text,
          '.gemini/skills/x/SKILL.md': text,
        },
        {
          rules: [nonPortableFieldRule],
          paths: ['launcher/.claude-plugin/plugin.json'],
          symlinks: {
            '.codex/skills/x/SKILL.md': 'launcher/skills/x/SKILL.md',
            '.gemini/skills/x/SKILL.md': 'launcher/skills/x/SKILL.md',
          },
        },
      );
      const reported = findings(result, ID);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toMatch(
        /^"context" is a documented skill field in Claude Code but not in .*Codex/,
      );
      expect(reported[0]?.message).toContain('Gemini CLI');
    });

    it('does not report unknown fields that every agent ignores', () => {
      expect(check('version: 1\nauthor: ops\n', '.claude/skills/deploy/SKILL.md')).toEqual([]);
    });

    it('does not report where only one agent loads the skill', () => {
      expect(check('color: blue\nwhen_to_use: x\n', '.gemini/skills/deploy/SKILL.md')).toEqual([]);
      expect(check('when_to_use: x\n', '.github/skills/deploy/SKILL.md')).toEqual([]);
    });

    it('only reports for targeted agents', () => {
      expect(
        check('when_to_use: x\n', '.claude/skills/deploy/SKILL.md', { targets: ['claude-code'] }),
      ).toEqual([]);
    });
  });

  it('accepts the six spec fields', () => {
    expect(
      check(
        'license: MIT\ncompatibility: Requires git\nmetadata:\n  owner: ops\nallowed-tools: Read Grep\n',
      ),
    ).toEqual([]);
  });

  it('skips missing and invalid frontmatter and bundled skills', () => {
    const result = lint(
      {
        'a/SKILL.md': '# x\n',
        'b/SKILL.md': '---\nwhen_to_use: a: b\n---\n',
        'b/assets/c/SKILL.md': '---\nname: c\nwhen_to_use: x\n---\n',
      },
      { rules: [nonPortableFieldRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });
});
