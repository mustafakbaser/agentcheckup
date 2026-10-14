import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { descriptionTooLongRule } from '../../../src/rules/skill/description-too-long.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/description-too-long';

function check(
  frontmatter: string,
  path = 'skills/deploy/SKILL.md',
  targets?: readonly PlatformId[],
) {
  const result = lint(
    { [path]: `---\nname: deploy\n${frontmatter}---\nBody.\n` },
    { rules: [descriptionTooLongRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/description-too-long', () => {
  it('reports a description over 1,024 characters', () => {
    const description = 'd'.repeat(1025);
    expect(check(`description: ${description}\n`)).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code'],
        message:
          'The description is 1,025 characters, over the 1,024 that the Agent Skills specification allows, so the skills-ref validator and claude.ai upload reject the skill.',
        range: { start: { line: 3, column: 14 }, end: { line: 3, column: 1039 } },
      },
    ]);
  });

  it('counts code points, not UTF-16 units, and trims the value', () => {
    // 1,024 emoji are 2,048 UTF-16 units but 1,024 characters.
    expect(check(`description: "${'🚀'.repeat(1024)}"\n`)).toEqual([]);
    expect(check(`description: "  ${'ş'.repeat(1024)}  "\n`)).toEqual([]);
    expect(check(`description: "${'ş'.repeat(1025)}"\n`)).toHaveLength(1);
  });

  it('mentions the Claude Code listing cut when the description passes 1,536 characters', () => {
    expect(check(`description: ${'d'.repeat(1600)}\n`)[0]?.message).toBe(
      'The description is 1,600 characters, over the 1,024 that the Agent Skills specification allows, so the skills-ref validator and claude.ai upload reject the skill. Claude Code also cuts its skill listing entry at 1,536 characters.',
    );
  });

  it('reports when_to_use pushing the listing entry past 1,536 characters', () => {
    const result = check(`description: ${'d'.repeat(1000)}\nwhen_to_use: ${'w'.repeat(537)}\n`);
    expect(result).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code'],
        message:
          '`description` and `when_to_use` together are 1,537 characters, but Claude Code cuts the skill listing entry at 1,536, so Claude does not see the end of `when_to_use` when it chooses a skill.',
        range: { start: { line: 4, column: 14 }, end: { line: 4, column: 551 } },
      },
    ]);
    expect(check(`description: ${'d'.repeat(1000)}\nwhen_to_use: ${'w'.repeat(536)}\n`)).toEqual(
      [],
    );
  });

  it('counts numeric when_to_use values and ignores lists', () => {
    expect(
      check(`description: ${'d'.repeat(1024)}\nwhen_to_use: 123456789012345678901234567890\n`),
    ).toEqual([]);
    expect(check(`description: ${'d'.repeat(1530)}\nwhen_to_use: 1234567\n`)[0]?.severity).toBe(
      'error',
    );
    expect(check(`description: ${'d'.repeat(1000)}\nwhen_to_use: [${'w'.repeat(600)}]\n`)).toEqual(
      [],
    );
  });

  it('follows the location of the skill', () => {
    // Only uploads enforce 1,024; Claude Code cuts the listing at 1,536 wherever it loads the skill.
    expect(check(`description: ${'d'.repeat(1025)}\n`, '.gemini/skills/deploy/SKILL.md')).toEqual(
      [],
    );
    expect(check(`description: ${'d'.repeat(1025)}\n`, '.claude/skills/deploy/SKILL.md')).toEqual(
      [],
    );
    expect(check(`description: ${'d'.repeat(1600)}\n`, '.claude/skills/deploy/SKILL.md')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        platforms: ['claude-code'],
        message:
          'The description is 1,600 characters, but Claude Code cuts the skill listing entry at 1,536, so Claude does not see the end of the description when it chooses a skill.',
        range: { start: { line: 3, column: 14 }, end: { line: 3, column: 1614 } },
      }),
    ]);
    expect(
      check(
        `description: ${'d'.repeat(1000)}\nwhen_to_use: ${'w'.repeat(600)}\n`,
        '.agents/skills/deploy/SKILL.md',
      ),
    ).toEqual([]);
    expect(
      check(`description: ${'d'.repeat(1025)}\n`, 'skills/deploy/SKILL.md', ['codex']),
    ).toEqual([]);
  });

  it('does not report short, missing or non-text descriptions', () => {
    expect(check('description: Deploys the app. Use when shipping.\n')).toEqual([]);
    expect(check('when_to_use: always\n')).toEqual([]);
    expect(check('description: [a, b]\n')).toEqual([]);
    expect(check(`description: ${'d'.repeat(1024)}\n`)).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const result = lint(
      {
        'skills/deploy/SKILL.md': `---\r\nname: deploy\r\ndescription: ${'d'.repeat(1030)}\r\n---\r\n`,
      },
      { rules: [descriptionTooLongRule] },
    );
    expect(findings(result, ID).map((f) => f.range.start)).toEqual([{ line: 3, column: 14 }]);
  });
});
