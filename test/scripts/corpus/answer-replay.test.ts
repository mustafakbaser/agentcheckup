import { describe, expect, it } from 'vitest';
import type { FixInput } from '../../../src/core/types.js';
import type { AwaitingInput } from '../../../src/fix/index.js';
import { fixRounds } from '../../../src/fix/verify.js';
import {
  renderAnswers,
  replayAnswers,
  syntheticAnswer,
} from '../../../scripts/corpus/answer-replay.js';
import { EVERY_FIX, REPLAY_SCAN_OPTIONS } from '../../../scripts/corpus/fix-replay.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';

function entry(field: FixInput['field'], path: string, initial?: string): AwaitingInput {
  const target: FixInput['target'] =
    field === 'suppression-reason'
      ? { kind: 'directive', path, line: 2, ruleId: 'test/rule' }
      : { kind: 'frontmatter', path, key: 'x' };
  return {
    fix: {
      id: 'test/rule#words',
      class: 'review',
      title: 'Words',
      changes: [],
      input: {
        field,
        question: 'Words?',
        label: 'words',
        ...(initial === undefined ? {} : { initial }),
        target,
      },
    },
    ruleId: 'test/rule',
    findings: [],
    path,
    line: 1,
  };
}

function replay(files: FileMap) {
  const snapshot = snapshotFrom(files);
  const before = fixRounds(snapshot, REPLAY_SCAN_OPTIONS, EVERY_FIX, 1).before;
  return replayAnswers('owner/repo', snapshot, before);
}

const LONG = 'Extract text and tables from PDF files, fill forms and merge documents.';

describe('syntheticAnswer', () => {
  it('answers each field as a user could, and leaves suppression reasons alone', () => {
    const skill = '.claude/skills/pdf/SKILL.md';
    expect(syntheticAnswer(entry('skill-when-clause', skill))).toBe(
      'Use when the user asks about pdf.',
    );
    expect(syntheticAnswer(entry('skill-description', skill))).toBe(
      'Helps with pdf tasks in this project. Use when the user asks about pdf.',
    );
    expect(syntheticAnswer(entry('cursor-globs', '.cursor/rules/style.mdc'))).toBe(
      'src/**/*.ts, test/**/*.ts',
    );
    expect(syntheticAnswer(entry('allowed-tools', skill, 'Bash(git add *) Read'))).toBe(
      'Bash(git add *) Read',
    );
    expect(syntheticAnswer(entry('allowed-tools', skill))).toBeUndefined();
    expect(syntheticAnswer(entry('suppression-reason', skill))).toBeUndefined();
  });
});

describe('replayAnswers', () => {
  it('applies every answered fix together, resolving what it asked about', () => {
    const answers = replay({
      '.claude/skills/pdf/SKILL.md': `---\nname: pdf\ndescription: ${LONG}\n---\n\nRun it.\n`,
      '.claude/skills/deploy/SKILL.md':
        '---\nname: deploy\ndescription: Deploys the app\n---\n\nGo.\n',
      '.cursor/rules/tabs.mdc': '---\ndescription:\n---\nUse tabs.\n',
    });
    expect(answers.violations).toEqual([]);
    expect(answers.entries.map((item) => [item.fixId, item.outcome])).toEqual([
      ['skill/description-quality#rewrite', 'applied'],
      ['skill/description-quality#when-clause', 'applied'],
      ['cursor/rule-never-applied#globs', 'applied'],
    ]);
  });

  it('counts an answer the builder refuses, and asks nothing of a clean repository', () => {
    const refused = replay({
      'skills/a<b>/SKILL.md': '---\nname: x\ndescription: Helps with the docs\n---\n',
    });
    expect(refused.entries).toEqual([
      {
        ruleId: 'skill/description-quality',
        fixId: 'skill/description-quality#rewrite',
        outcome: 'refused',
        message: 'A skill description cannot contain "<" or ">": agents read them as XML tags.',
      },
    ]);
    expect(replay({ 'AGENTS.md': '# Agents\n\nUse pnpm.\n' }).entries).toEqual([]);
  });
});

describe('renderAnswers', () => {
  it('counts outcomes by rule, groups messages and lists violations', () => {
    const text = renderAnswers([
      {
        repo: 'owner/repo',
        ms: 5,
        entries: [
          { ruleId: 'test/a', fixId: 'test/a#x', outcome: 'applied' },
          { ruleId: 'test/a', fixId: 'test/a#x', outcome: 'failed', message: 'still there' },
          { ruleId: 'test/b', fixId: 'test/b#y', outcome: 'unanswered' },
        ],
        violations: [
          { repo: 'owner/repo', kind: 'unresolved', ruleId: 'test/a', path: 'A.md', reason: 'x' },
        ],
      },
    ]);
    expect(text.violations).toBe(1);
    expect(text.text).toContain(
      'Synthetic answers: 3 fixes need words; 1 applied, 1 failed, 0 refused, 1 unanswered.',
    );
    expect(text.text).toContain('  test/a: 1 applied, 1 failed, 0 refused, 0 unanswered');
    expect(text.text).toContain('  1x test/a failed: still there');
    expect(text.text).toContain('  unresolved  owner/repo  test/a  A.md  x');
    expect(renderAnswers([]).text).toContain('Violations with synthetic answers: none.');
  });
});
