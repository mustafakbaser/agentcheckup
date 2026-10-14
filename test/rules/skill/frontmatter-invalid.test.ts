import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { frontmatterInvalidRule } from '../../../src/rules/skill/frontmatter-invalid.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/frontmatter-invalid';
/** Outside every known skills root: every platform may load it once installed. */
const PATH = 'skills/deploy/SKILL.md';

function check(text: string, targets?: readonly PlatformId[], path = PATH) {
  const result = lint(
    { [path]: text },
    { rules: [frontmatterInvalidRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID); // throws if the rule crashed
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

const range = (line: number, column: number, endLine: number, endColumn: number) => ({
  start: { line, column },
  end: { line: endLine, column: endColumn },
});

const NESTED =
  'The frontmatter is not valid YAML (Nested mappings are not allowed in compact mappings).';
const VALIDATORS = 'the skills-ref validator and the anthropics/skills packager reject it.';

describe('skill/frontmatter-invalid', () => {
  it('reports an unquoted colon that Codex repairs as a portability warning', () => {
    expect(check('---\nname: deploy\ndescription: Deploys: production\n---\nRun.\n')).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code'],
        message: `${NESTED} Codex quotes the value and loads the skill, and ${VALIDATORS}`,
        range: range(3, 14, 3, 15),
      },
    ]);
  });

  it('does not report a repaired colon when only Codex is targeted', () => {
    expect(check('---\nname: deploy\ndescription: Deploys: production\n---\n', ['codex'])).toEqual(
      [],
    );
  });

  it('claims the documented Claude Code outcome for CRLF files', () => {
    const text = '---\r\nname: deploy\r\ndescription: Deploys: production\r\n---\r\nRun.\r\n';
    expect(check(text)).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code'],
        message: `${NESTED} Claude Code loads the skill with no fields set, Codex quotes the value and loads the skill, and ${VALIDATORS}`,
        range: range(3, 14, 3, 15),
      },
    ]);
  });

  it('reports a nested colon value that only Codex repairs', () => {
    const text =
      '---\nname: deploy\ndescription: Deploys.\nmetadata:\n  short-description: Ships: fast\n---\n';
    expect(check(text)[0]).toMatchObject({ severity: 'error', platforms: ['claude-code'] });
  });

  it('reports tab indentation, which Codex does not repair', () => {
    const text = '---\nname: deploy\nmetadata:\n\towner: ops\ndescription: Deploys.\n---\n';
    expect(check(text)).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex'],
        message: `The frontmatter is not valid YAML (Tabs are not allowed as indentation). Codex skips the skill, and ${VALIDATORS}`,
        range: range(4, 1, 4, 2),
      },
    ]);
    expect(check(text, ['claude-code'])).toEqual([
      expect.objectContaining({ severity: 'warn', platforms: ['claude-code'] }),
    ]);
  });

  it('reports YAML that no agent can repair', () => {
    expect(check('---\nname: deploy\ndescription: "Deploys\n---\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex'],
        message: `The frontmatter is not valid YAML (Missing closing "quote). Claude Code loads the skill with no fields set, Codex skips the skill, and ${VALIDATORS}`,
        range: range(4, 1, 4, 1),
      },
    ]);
  });

  it('reports frontmatter that is not a mapping', () => {
    expect(check('---\n- name\n- description\n---\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex', 'gemini'],
        message:
          'The frontmatter is not a mapping of keys to values. Codex and Gemini CLI skip the skill, and the skills-ref validator rejects it.',
        range: range(2, 1, 3, 14),
      },
    ]);
    // In .claude/skills only Claude Code, Cursor and Copilot read it, and none of them is
    // documented to fail on it; validators judge only distributable skills.
    expect(check('---\njust text\n---\n', undefined, '.claude/skills/x/SKILL.md')).toEqual([]);
  });

  it('reports a repeated Codex field as an error where Codex reads the skill', () => {
    const text = '---\nname: deploy\ndescription: One.\ndescription: Two.\n---\n';
    expect(check(text)).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex'],
        message:
          'The frontmatter repeats "description". Codex rejects a repeated field and skips the skill, and the skills-ref validator rejects duplicate keys.',
        range: range(4, 1, 4, 12),
      },
    ]);
    expect(
      check('---\nname: deploy\n"description": One.\n"description": Two.\n---\n')[0]?.message,
    ).toContain('repeats "description". Codex rejects');
    expect(check(text, undefined, '.claude/skills/deploy/SKILL.md')).toEqual([]);
    expect(check(text, undefined, '.agents/skills/deploy/SKILL.md')[0]?.message).toBe(
      'The frontmatter repeats "description". Codex rejects a repeated field and skips the skill.',
    );
  });

  it('reports other repeated keys as a portability warning', () => {
    expect(check('---\nname: deploy\ndescription: One.\ntags: a\ntags: b\n---\n')).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini'],
        message:
          'The frontmatter repeats "tags". The skills-ref validator rejects duplicate keys, and other YAML parsers either reject them or keep one of the values.',
        range: range(5, 1, 5, 5),
      },
    ]);
  });

  it('reports TOML and language-tagged frontmatter', () => {
    expect(check('+++\nname = "deploy"\n+++\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex', 'gemini'],
        message: `The frontmatter opens with "+++" (TOML), but agents read only YAML between \`---\` lines. Codex and Gemini CLI skip the skill, Claude Code reads the frontmatter as instructions, and ${VALIDATORS}`,
        range: range(1, 1, 1, 4),
      },
    ]);
    expect(check('---js\nmodule.exports = {}\n---\n')[0]?.message).toContain(
      'The frontmatter opens with "---js", but agents read only YAML',
    );
    expect(check('---yaml\nname: deploy\n---\n')).toHaveLength(1);
    expect(check('+++\nx = 1\n+++\n', undefined, '.cursor/skills/x/SKILL.md')).toEqual([]);
    expect(check('+++\nx = 1\n+++\n', undefined, '.claude/skills/x/SKILL.md')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['claude-code'],
        message:
          'The frontmatter opens with "+++" (TOML), but agents read only YAML between `---` lines. Claude Code reads the frontmatter as instructions.',
      }),
    ]);
  });

  it('describes only the agents that read the location', () => {
    const crlf = '---\r\nname: deploy\r\ndescription: Deploys: production\r\n---\r\n';
    expect(check(crlf, undefined, '.agents/skills/deploy/SKILL.md')).toEqual([]);
    expect(check(crlf, undefined, '.claude/skills/deploy/SKILL.md')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['claude-code'],
        message: `${NESTED} Claude Code loads the skill with no fields set.`,
      }),
    ]);
  });

  it('reports frontmatter beyond agentcheck limits as info only', () => {
    const text = `---\nname: deploy\ndescription: ${'x'.repeat(70_000)}\n---\n`;
    expect(check(text)).toEqual([
      {
        severity: 'info',
        platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini'],
        message:
          'agentcheck did not check this frontmatter: Frontmatter is 70,027 characters; the limit is 65,536.',
        range: range(1, 1, 4, 4),
      },
    ]);
  });

  it('does not report valid, empty, missing or unclosed frontmatter', () => {
    expect(check('---\nname: deploy\ndescription: "Deploys: production"\n---\n')).toEqual([]);
    expect(check('---\n---\nbody\n')).toEqual([]);
    expect(check('# No frontmatter\n')).toEqual([]);
    expect(check('---\nname: deploy\n')).toEqual([]);
    expect(check('---\r\nname: déploiement\r\ndescription: Çalıştırır 🚀\r\n---\r\n')).toEqual([]);
  });

  it('shortens long parser messages', () => {
    const text = `---\nname: deploy\ndescription: Deploys.\n${'k'.repeat(1100)}: [\n---\n`;
    const message = check(text)[0]?.message ?? '';
    expect(message.length).toBeLessThan(400);
  });

  it('handles a UTF-8 byte order mark before the frontmatter', () => {
    const body = new TextEncoder().encode('---\nname: deploy\ndescription: a: b\n---\n');
    const result = lint(
      { [PATH]: new Uint8Array([0xef, 0xbb, 0xbf, ...body]) },
      { rules: [frontmatterInvalidRule] },
    );
    expect(result.findings.map((f) => f.range.start)).toEqual([{ line: 3, column: 14 }]);
  });
});
