import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import {
  descriptionMissingRule,
  firstBodyLine,
} from '../../../src/rules/skill/description-missing.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/description-missing';

function check(text: string, path = 'skills/deploy/SKILL.md', targets?: readonly PlatformId[]) {
  const result = lint(
    { [path]: text },
    { rules: [descriptionMissingRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/description-missing', () => {
  it('reports a missing description with the line Claude Code uses instead', () => {
    expect(check('---\nname: deploy\n---\n\n# Deploy the app\n\nRun it.\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini'],
        message:
          'The frontmatter has no `description`. Codex and Gemini CLI skip the skill, Claude Code uses the first non-empty line of the body instead ("# Deploy the app"), and Cursor, GitHub Copilot and claude.ai upload require the field.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      },
    ]);
  });

  it('is a warning for a Claude Code project skill', () => {
    expect(check('---\nname: deploy\n---\nRun it.\n', '.claude/skills/deploy/SKILL.md')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        platforms: ['claude-code', 'cursor', 'copilot'],
        message:
          'The frontmatter has no `description`. Claude Code uses the first non-empty line of the body instead ("Run it."), and Cursor and GitHub Copilot require the field.',
      }),
    ]);
    expect(check('---\nname: deploy\n---\n', '.github/skills/deploy/SKILL.md')[0]?.message).toBe(
      'The frontmatter has no `description`. GitHub Copilot requires the field.',
    );
  });

  it('reports an empty description at its key', () => {
    expect(check('---\nname: deploy\ndescription: ""\n---\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini'],
        message:
          '`description` is empty. Codex skips the skill, Gemini CLI loads it with no description, and Cursor, GitHub Copilot and claude.ai upload require a value.',
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
      },
    ]);
    expect(check('---\nname: deploy\ndescription:\n---\nBody\n')).toHaveLength(1);
    expect(check('---\nname: deploy\ndescription: ~\n---\n')).toHaveLength(1);
    expect(check('---\nname: deploy\ndescription: "   "\n---\n')).toHaveLength(1);
  });

  it('claims no Claude Code fallback for an empty description', () => {
    expect(
      check(
        '---\nname: deploy\ndescription: ""\n---\n# Deploy\n',
        '.claude/skills/deploy/SKILL.md',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'warn',
        platforms: ['cursor', 'copilot'],
        message: '`description` is empty. Cursor and GitHub Copilot require a value.',
      }),
    ]);
    const claudePlugin = lint(
      { 'plugin/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: ~\n---\n# Deploy\n' },
      { rules: [descriptionMissingRule], paths: ['plugin/.claude-plugin/plugin.json'] },
    );
    expect(findings(claudePlugin, ID)).toEqual([]);
  });

  it('reports a description that is not text', () => {
    expect(check('---\nname: deploy\ndescription:\n  - Deploys\n---\nBody\n')).toEqual([
      expect.objectContaining({
        severity: 'error',
        message:
          '`description` is a list, not text. Codex cannot read the frontmatter and skips the skill, and the skills-ref validator rejects it.',
      }),
    ]);
    expect(check('---\nname: deploy\ndescription: {a: b}\n---\n')[0]?.message).toContain(
      'is a map',
    );
  });

  it('accepts numbers and booleans, which agents read as text', () => {
    expect(check('---\nname: deploy\ndescription: 42\n---\n')).toEqual([]);
    expect(check('---\nname: deploy\ndescription: true\n---\n')).toEqual([]);
  });

  it('does not report a description or other frontmatter states', () => {
    expect(check('---\nname: deploy\ndescription: Deploys. Use when shipping.\n---\n')).toEqual([]);
    expect(check('---\r\nname: dağıt\r\ndescription: Uygulamayı dağıtır 🚀\r\n---\r\n')).toEqual(
      [],
    );
    expect(check('# No frontmatter\n')).toEqual([]);
    expect(check('---\nname: [\n---\n')).toEqual([]);
  });

  it('only reports for targeted platforms that read the skill', () => {
    expect(check('---\nname: deploy\n---\n', '.agents/skills/deploy/SKILL.md', ['codex'])).toEqual([
      expect.objectContaining({ severity: 'error', platforms: ['codex'] }),
    ]);
    expect(check('---\nname: deploy\n---\n', '.claude/skills/deploy/SKILL.md', ['codex'])).toEqual(
      [],
    );
  });
});

describe('firstBodyLine', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(firstBodyLine('\n\n## Deploy  \nmore')).toBe('## Deploy');
    expect(firstBodyLine('Plain line\r\n')).toBe('Plain line');
    expect(firstBodyLine('\n  \n')).toBeUndefined();
  });
});
