import { describe, expect, it } from 'vitest';
import { legacyCursorrulesRule } from '../../../src/rules/cursor/legacy-cursorrules.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'cursor/legacy-cursorrules';
const rules = [legacyCursorrulesRule];

describe('cursor/legacy-cursorrules', () => {
  it('notes a .cursorrules file', () => {
    const result = lint({ '.cursorrules': 'Use TypeScript.\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: '.cursorrules',
        message:
          '.cursorrules is a legacy file that Cursor says "will be deprecated". Move its content to AGENTS.md or to an Always Apply rule in .cursor/rules.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it('does not report project rules', () => {
    const result = lint({ '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\n' }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not run when Cursor is not targeted', () => {
    expect(findings(lint({ '.cursorrules': 'x' }, { rules, targets: ['cline'] }), RULE)).toEqual(
      [],
    );
  });
});
