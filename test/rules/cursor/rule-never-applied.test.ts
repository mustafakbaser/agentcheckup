import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/core/engine.js';
import { completeInput, verifyCompletedInput } from '../../../src/fix/input.js';
import { fixRounds, type FixScanOptions } from '../../../src/fix/verify.js';
import { ruleNeverAppliedRule } from '../../../src/rules/cursor/rule-never-applied.js';
import { builtinRules } from '../../../src/rules/index.js';
import { textOf } from '../../fix/helpers.js';
import { findings, lint, snapshotFrom } from '../../helpers/lint.js';

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

  describe('asks for globs with fix -i', () => {
    const options: FixScanOptions = { rules: builtinRules };

    /** The rule's fix completed with `answer`, verified with every built-in rule. */
    function answered(text: string, answer: string): string {
      const snapshot = snapshotFrom({ [PATH]: text });
      const run = fixRounds(snapshot, options, {
        classes: new Set(['review']),
        ruleIds: new Set([RULE]),
        literalSecret: false,
      });
      const [entry] = run.awaitingInput;
      if (entry === undefined) throw new Error('No fix awaits input.');
      expect(entry.fix.id).toBe('cursor/rule-never-applied#globs');
      const completion = completeInput(entry.fix, answer, analyze(snapshot, options));
      if (!completion.ok) throw new Error(completion.message);
      const verified = verifyCompletedInput(snapshot, options, entry, completion.fix);
      if (!verified.ok) throw new Error(verified.message);
      return textOf(verified.run.snapshot, PATH);
    }

    it('adds frontmatter with the globs to a rule without it', () => {
      expect(answered('Every migration needs up and down.\n', 'db/migrations/**')).toBe(
        '---\nglobs: "db/migrations/**"\n---\nEvery migration needs up and down.\n',
      );
    });

    it('replaces empty fields with the globs as one string', () => {
      expect(answered('---\ndescription: ""\nglobs: []\n---\nBody\n', 'db/**, sql/**')).toBe(
        '---\ndescription: ""\nglobs: "db/**, sql/**"\n---\nBody\n',
      );
    });

    it('asks nothing about a rule it does not report', () => {
      const snapshot = snapshotFrom({ [PATH]: '---\nalwaysApply: false\n---\nBody\n' });
      const run = fixRounds(snapshot, options, {
        classes: new Set(['review']),
        ruleIds: new Set([RULE]),
        literalSecret: false,
      });
      expect(run.awaitingInput).toEqual([]);
    });
  });
});
