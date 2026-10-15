import { describe, expect, it } from 'vitest';
import { bodyTooLongRule } from '../../../src/rules/skill/body-too-long.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/body-too-long';
const PATH = 'skills/deploy/SKILL.md';
const FRONTMATTER = '---\nname: deploy\ndescription: Deploys.\n---\n';
const body = (lines: number, line = 'step') =>
  Array.from({ length: lines }, (_, i) => `${line} ${i + 1}`).join('\n') + '\n';

function check(text: string, config?: unknown) {
  const result = lint(
    { [PATH]: text },
    { rules: [bodyTooLongRule], ...(config ? { config } : {}) },
  );
  return findings(result, ID).map((f) => ({
    severity: f.severity,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/body-too-long', () => {
  it('reports a body over 500 lines at the first line past the limit', () => {
    expect(check(FRONTMATTER + body(501))).toEqual([
      {
        severity: 'info',
        message:
          'The skill body is 501 lines, over the 500 that Claude Code and the Agent Skills specification recommend. Agents load the whole body when the skill runs, so move reference material into separate files.',
        range: { start: { line: 505, column: 1 }, end: { line: 505, column: 9 } },
      },
    ]);
  });

  it('does not report a body of exactly 500 lines', () => {
    expect(check(FRONTMATTER + body(500))).toEqual([]);
    expect(check(body(500))).toEqual([]);
  });

  it('counts the whole file when there is no frontmatter', () => {
    expect(check(body(501))[0]?.range.start.line).toBe(501);
  });

  it('honors the maxLines option and ignores invalid values', () => {
    const config = (maxLines: unknown) => ({ rules: { [ID]: ['warn', { maxLines }] } });
    expect(check(FRONTMATTER + body(101), config(100))[0]?.message).toBe(
      'The skill body is 101 lines, over the configured maximum of 100. Agents load the whole body when the skill runs, so move reference material into separate files.',
    );
    expect(check(FRONTMATTER + body(101), config('100'))).toEqual([]);
    expect(check(FRONTMATTER + body(101), config(-1))).toEqual([]);
    expect(check(FRONTMATTER + body(101), config(1.5))).toEqual([]);
  });

  it('reports an estimated token count over 5,000 as info', () => {
    const long = `${'x'.repeat(100)}\n`.repeat(250);
    expect(check(FRONTMATTER + long)).toEqual([
      {
        severity: 'info',
        message:
          'The skill body is about 6,313 tokens (estimated), over the 5,000 that the Agent Skills specification recommends. After compaction, Claude Code keeps only the first 5,000 tokens, which end at about this line.',
        range: { start: { line: 203, column: 1 }, end: { line: 203, column: 101 } },
      },
    ]);
  });

  it('mentions Claude Code compaction only where Claude Code loads the skill', () => {
    const long = `${'x'.repeat(100)}\n`.repeat(250);
    const result = lint(
      { '.gemini/skills/deploy/SKILL.md': FRONTMATTER + long },
      { rules: [bodyTooLongRule] },
    );
    expect(findings(result, ID).map((f) => [f.severity, f.message])).toEqual([
      [
        'info',
        'The skill body is about 6,313 tokens (estimated), over the 5,000 that the Agent Skills specification recommends. Move reference material into separate files.',
      ],
    ]);
  });

  it('does not affect the score', () => {
    const result = lint({ [PATH]: FRONTMATTER + body(900) }, { rules: [bodyTooLongRule] });
    expect(result.score.score).toBe(100);
  });

  it('counts emoji as one character for the estimate', () => {
    expect(check(FRONTMATTER + '🚀'.repeat(19_999))).toEqual([]);
    expect(check(FRONTMATTER + '🚀'.repeat(20_004))).toHaveLength(1);
  });

  it('handles CRLF line endings and invalid frontmatter', () => {
    const crlf = '---\r\nname: deploy\r\n---\r\n' + body(501).replaceAll('\n', '\r\n');
    expect(check(crlf)[0]?.range.start.line).toBe(504);
    expect(check('---\nname: [\n---\n' + body(501))[0]?.range.start.line).toBe(504);
  });

  it('does not report short skills', () => {
    expect(check(`${FRONTMATTER}Dağıtım adımları 🚀\n`)).toEqual([]);
    expect(check('')).toEqual([]);
  });
});
