import { describe, expect, it } from 'vitest';
import { windsurfRuleTooLongRule } from '../../../src/rules/instructions/windsurf-rule-too-long.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/windsurf-rule-too-long';
const rules = [windsurfRuleTooLongRule];

/** `count` lines of 100 characters: 99 letters and LF. */
function lines(count: number, eol = '\n'): string {
  return `${'w'.repeat(100 - eol.length)}${eol}`.repeat(count);
}

describe('instr/windsurf-rule-too-long', () => {
  it('reports a workspace rule over 12,000 characters where the limit is crossed', () => {
    const result = lint({ '.windsurf/rules/style.md': lines(130) }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: '.windsurf/rules/style.md',
        message:
          "This rule has 13,000 characters. Windsurf's Cascade agent limits each workspace rule file to 12,000 characters, and the text from line 121 on is past that limit.",
        range: { start: { line: 121, column: 1 }, end: { line: 121, column: 100 } },
      },
    ]);
  });

  it('does not report exactly 12,000 characters', () => {
    const result = lint({ '.devin/rules/style.md': lines(120) }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not count the frontmatter', () => {
    const text = `---\ntrigger: glob\nglobs: "**/*.ts"\n---\n${lines(120)}`;
    const result = lint({ '.devin/rules/style.md': text }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('counts a CRLF line break as one character', () => {
    const text = `${'w'.repeat(98)}\r\n`.repeat(121);
    const result = lint({ '.windsurf/rules/crlf.md': text }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('counts an emoji as one character', () => {
    const result = lint({ '.windsurfrules': '😀'.repeat(12_000) }, { rules });
    expect(findings(result, RULE)).toEqual([]);
    const over = lint({ '.windsurfrules': `${'😀'.repeat(12_000)}ğ` }, { rules });
    expect(findings(over, RULE)).toEqual([
      expect.objectContaining({
        message:
          "This rule has 12,001 characters. Windsurf's Cascade agent limits each workspace rule file to 12,000 characters, and the text from line 1 on is past that limit.",
        range: { start: { line: 1, column: 24_001 }, end: { line: 1, column: 24_002 } },
      }),
    ]);
  });

  it('does not run when Windsurf is not targeted', () => {
    const result = lint({ '.windsurfrules': lines(200) }, { rules, targets: ['cursor'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});
