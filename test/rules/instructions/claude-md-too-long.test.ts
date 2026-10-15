import { describe, expect, it } from 'vitest';
import { claudeMdTooLongRule } from '../../../src/rules/instructions/claude-md-too-long.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/claude-md-too-long';
const rules = [claudeMdTooLongRule];

function numbered(count: number, eol = '\n'): string {
  let text = '';
  for (let i = 1; i <= count; i++) text += `- instruction ${String(i)}${eol}`;
  return text;
}

describe('instr/claude-md-too-long', () => {
  it('reports a CLAUDE.md over 200 lines at the first extra line', () => {
    const result = lint({ 'CLAUDE.md': numbered(342) }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: 'CLAUDE.md',
        message:
          "This file has 342 lines. Claude Code's documentation recommends keeping each CLAUDE.md under 200 lines, because longer files use more context and reduce adherence.",
        range: { start: { line: 201, column: 1 }, end: { line: 201, column: 18 } },
      },
    ]);
  });

  it('does not report exactly 200 lines, with or without a final newline', () => {
    expect(findings(lint({ 'CLAUDE.md': numbered(200) }, { rules }), RULE)).toEqual([]);
    expect(findings(lint({ 'CLAUDE.md': numbered(200).trimEnd() }, { rules }), RULE)).toEqual([]);
  });

  it('counts CRLF lines and checks CLAUDE.local.md and .claude/CLAUDE.md', () => {
    const result = lint(
      {
        '.claude/CLAUDE.md': numbered(201, '\r\n'),
        'CLAUDE.local.md': numbered(250),
        'AGENTS.md': numbered(500),
      },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => [finding.path, finding.range.start])).toEqual([
      ['.claude/CLAUDE.md', { line: 201, column: 1 }],
      ['CLAUDE.local.md', { line: 201, column: 1 }],
    ]);
  });

  it('honors the maxLines option', () => {
    const config = { rules: { [RULE]: ['warn', { maxLines: 300 }] } };
    expect(findings(lint({ 'CLAUDE.md': numbered(300) }, { rules, config }), RULE)).toEqual([]);
    const result = lint({ 'CLAUDE.md': numbered(301) }, { rules, config });
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        message:
          'This file has 301 lines, over the configured limit of 300. Longer CLAUDE.md files use more context and reduce adherence.',
        range: { start: { line: 301, column: 1 }, end: { line: 301, column: 18 } },
      }),
    ]);
  });

  it('rejects an invalid maxLines option', () => {
    const result = lint(
      { 'CLAUDE.md': 'x' },
      { rules, config: { rules: { [RULE]: ['warn', { maxLines: 0 }] } } },
    );
    expect(result.ruleFailures).toEqual([
      { ruleId: RULE, message: 'Option "maxLines" must be a positive integer, got 0.' },
    ]);
  });

  it('counts lines of non-ASCII text the same way', () => {
    const turkish = 'Değişiklikleri test et 🚀\n'.repeat(201);
    const result = lint({ 'CLAUDE.md': turkish }, { rules });
    expect(findings(result, RULE)[0]?.range).toEqual({
      start: { line: 201, column: 1 },
      end: { line: 201, column: 26 },
    });
  });

  it('leaves case variants to instr/filename-case', () => {
    const result = lint({ 'docs/claude.md': numbered(350) }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not run when Claude Code is not targeted', () => {
    const result = lint({ 'CLAUDE.md': numbered(400) }, { rules, targets: ['codex'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});
