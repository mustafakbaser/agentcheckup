import { describe, expect, it } from 'vitest';
import { ruleNeverAppliedRule } from '../../../src/rules/cursor/rule-never-applied.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'cursor/rule-never-applied';
const rules = [ruleNeverAppliedRule];
const PATH = '.cursor/rules/migrations.mdc';

function run(text: string) {
  return findings(lint({ [PATH]: text }, { rules }), RULE);
}

describe('cursor/rule-never-applied', () => {
  it('reports a rule without frontmatter', () => {
    expect(run('Every migration needs up and down.\n')).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: PATH,
        message:
          'This rule has no frontmatter, so Cursor applies it only when you @-mention it. Add "description", "globs" or "alwaysApply: true" to apply it automatically.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it('reports frontmatter that sets none of the three fields', () => {
    expect(run('---\ndescription: ""\nglobs: []\n---\nBody\n')).toEqual([
      expect.objectContaining({
        message:
          'This rule sets none of "alwaysApply", "description" and "globs", so Cursor applies it only when you @-mention it. Add one of them to apply it automatically.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      }),
    ]);
  });

  describe('does not report', () => {
    it.each([
      ['an explicit manual rule', '---\nalwaysApply: false\n---\nBody\n'],
      [
        'the empty fields Cursor writes for manual rules',
        '---\ndescription:\nglobs:\nalwaysApply: false\n---\n',
      ],
      ['an always-applied rule', '---\nalwaysApply: true\n---\n'],
      ['a glob rule', '---\nglobs: src/**\n---\n'],
      ['a glob list', '---\nglobs:\n  - src/**\n---\n'],
      ['an agent-requested rule', '---\ndescription: Database migrations\n---\n'],
      ['invalid frontmatter (cursor/rule-frontmatter reports it)', '---\nglobs: [\n---\n'],
      ['unclosed frontmatter', '---\nglobs: x\n'],
    ])('%s', (_label, text) => {
      expect(run(text)).toEqual([]);
    });
  });
});
