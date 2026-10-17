import { describe, expect, it } from 'vitest';
import { scanSnapshot } from '../../../src/core/engine.js';
import { builtinRules } from '../../../src/rules/index.js';
import {
  fixFacts,
  kindsOf,
  median,
  offerOf,
  type RepoFixFacts,
  renderFixSection,
  type ReplayFacts,
  replayFacts,
  scoreChanges,
  summarizeReplay,
} from '../../../scripts/corpus/fix-stats.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';

function facts(
  score: RepoFixFacts['score'],
  findings: Partial<RepoFixFacts['findings']> = {},
  crashes: RepoFixFacts['crashes'] = {},
): RepoFixFacts {
  return {
    findings: { safe: 0, review: 0, input: 0, task: 0, none: 0, ...findings },
    score,
    crashes,
  };
}

function replayed(overrides: Partial<ReplayFacts> = {}): ReplayFacts {
  return {
    planned: 0,
    applied: 0,
    notApplied: 0,
    demoted: 0,
    files: 0,
    answers: { applied: 0, rejected: 0, unanswered: 0 },
    violations: 0,
    ...overrides,
  };
}

function snapshotOf(files: FileMap) {
  return snapshotFrom(files, { paths: ['.git/'] });
}

function scanned(files: FileMap): RepoFixFacts {
  const snapshot = snapshotOf(files);
  return fixFacts(
    snapshot,
    scanSnapshot(snapshot, { rules: builtinRules, trustDirectives: false }),
  );
}

/** One finding of each offer. */
const EVERY_OFFER: FileMap = {
  // A safe fix: Claude Code skips AGENTS.md, and CLAUDE.md can import it.
  'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
  // A task: an import of a missing file has no fix.
  'CLAUDE.md': '# Claude notes\n\n@docs/missing.md\n',
  // A fix that needs review: renaming a Cursor rule to .mdc.
  '.cursor/rules/x.md': 'Prefer named exports in TypeScript files.\n',
  // A fix that needs words: the description says nothing about when to use the skill.
  '.claude/skills/pdf/SKILL.md':
    '---\nname: pdf\ndescription: Extract text and tables from PDF files, fill forms and merge documents.\n---\n\nRun the script.\n',
  // None: a deprecated transport in an MCP file has no fix and is never a task.
  '.mcp.json': '{ "mcpServers": { "docs": { "type": "sse", "url": "https://x.example/sse" } } }\n',
};

describe('offerOf', () => {
  it('tells a ready fix, a fix that needs words, a task and a finding left to the user', () => {
    const snapshot = snapshotOf(EVERY_OFFER);
    const result = scanSnapshot(snapshot, { rules: builtinRules, trustDirectives: false });
    const kinds = kindsOf(result.artifacts);
    const offers = new Map(
      result.findings.map((finding) => [finding.ruleId, offerOf(finding, kinds)]),
    );
    expect(offers.get('instr/agents-md-ignored-by-claude')).toBe('safe');
    expect(offers.get('cursor/md-file-ignored')).toBe('review');
    expect(offers.get('skill/description-quality')).toBe('input');
    expect(offers.get('instr/import-unresolved')).toBe('task');
    expect(offers.get('mcp/insecure-transport')).toBe('none');
    // Without the kinds of the scan, the path alone tells the same.
    const unknown = result.findings.find((finding) => finding.ruleId === 'mcp/insecure-transport');
    expect(unknown === undefined ? undefined : offerOf(unknown, new Map())).toBe('none');
  });
});

describe('fixFacts', () => {
  it('counts findings by offer and scores the fixed copies', () => {
    const result = scanned(EVERY_OFFER);
    expect(result.findings).toMatchObject({ safe: 1, review: 1, input: 1, task: 1 });
    expect(result.findings.none).toBeGreaterThanOrEqual(1);
    expect(result.crashes).toEqual({});
    const { before, safe, review } = result.score;
    expect(before).not.toBeNull();
    expect(safe).toBeGreaterThan(before ?? 100);
    expect(review).toBeGreaterThan(safe ?? 100);
  });

  it('keeps the score of a repository without fixable findings', () => {
    const result = scanned({ 'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n' });
    expect(result.findings).toEqual({ safe: 0, review: 0, input: 0, task: 0, none: 0 });
    expect(result.score.safe).toBe(result.score.before);
    expect(result.score.review).toBe(result.score.before);
  });
});

describe('replayFacts', () => {
  it('counts what the replay applied and what the synthetic answers did', () => {
    const facts = replayFacts('test/repo', snapshotOf(EVERY_OFFER));
    expect(facts.violations).toBe(0);
    expect(facts.planned).toBeGreaterThanOrEqual(2);
    expect(facts.applied).toBe(facts.planned);
    expect(facts.notApplied).toBe(0);
    expect(facts.files).toBeGreaterThanOrEqual(2);
    expect(facts.answers).toEqual({ applied: 1, rejected: 0, unanswered: 0 });
  });

  it('adds up decisions and answers, and counts every violation', () => {
    const decision = (outcome: 'applied' | 'skipped', demoted = false) => ({
      ruleId: 'x/y',
      fixId: 'x/y#z',
      outcome,
      ...(outcome === 'skipped' ? { reason: 'conflict' as const } : {}),
      demoted,
    });
    const violation = { repo: 'r', kind: 'crash' as const, ruleId: '', path: '', reason: '' };
    const entry = (outcome: 'applied' | 'refused' | 'failed' | 'unanswered') => ({
      ruleId: 'x/y',
      fixId: 'x/y#w',
      outcome,
    });
    expect(
      summarizeReplay(
        {
          decisions: [decision('applied', true), decision('applied'), decision('skipped')],
          files: 2,
          violations: [violation],
        },
        {
          entries: [entry('applied'), entry('refused'), entry('failed'), entry('unanswered')],
          violations: [violation],
        },
      ),
    ).toEqual({
      planned: 3,
      applied: 2,
      notApplied: 1,
      demoted: 1,
      files: 2,
      answers: { applied: 1, rejected: 2, unanswered: 1 },
      violations: 2,
    });
    expect(summarizeReplay({ decisions: [], files: 0, violations: [] }, undefined)).toEqual(
      replayed(),
    );
  });
});

describe('aggregates', () => {
  it('takes the median of an odd and an even count', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 10])).toBe(3.5);
  });

  it('counts higher and lower scores and the median gain', () => {
    const all = [
      facts({ before: 80, safe: 90, review: 95 }),
      facts({ before: 70, safe: 70, review: 74 }),
      facts({ before: 60, safe: 58, review: 58 }),
      facts({ before: null, safe: null, review: null }),
    ];
    expect(scoreChanges(all, 'safe')).toEqual({ higher: 1, medianGain: 10, lower: 1 });
    expect(scoreChanges(all, 'review')).toEqual({ higher: 2, medianGain: 9.5, lower: 1 });
  });

  it('renders counts only, with no repository names', () => {
    const all = [
      facts(
        { before: 80, safe: 90, review: 95 },
        { safe: 2, review: 1, input: 3, task: 3, none: 1 },
      ),
      facts({ before: 70, safe: 70, review: 70 }, { task: 6, none: 4 }, { review: 'boom' }),
    ];
    const text = renderFixSection(all);
    expect(text).toContain('| With a safe fix | 2 | 10% | 1 |');
    expect(text).toContain('| With a fix that needs your words | 3 | 15% | 1 |');
    expect(text).toContain('| A task for a coding agent | 9 | 45% | 2 |');
    expect(text).toContain('| None of these: left to you | 5 | 25% | 2 |');
    expect(text).toContain('| Repositories with a higher score | 1 | 1 |');
    expect(text).toContain('| Median gain | +10 | +15 |');
    expect(text).toContain('| Fix runs that crashed | 0 | 1 |');
    expect(text).not.toContain('boom');
    expect(text).not.toContain('Replay');
  });

  it('adds the replay totals when there are replays', () => {
    const text = renderFixSection(
      [facts({ before: 80, safe: 80, review: 80 })],
      [
        replayed({
          planned: 1200,
          applied: 1199,
          notApplied: 1,
          files: 900,
          answers: { applied: 600, rejected: 0, unanswered: 211 },
        }),
        replayed({ planned: 3, applied: 3, files: 2, violations: 1 }),
        replayed(),
      ],
    );
    expect(text).toContain('| Fixes planned | 1,203 |');
    expect(text).toContain('| Applied and verified | 1,202 |');
    expect(text).toContain('| Skipped or deferred | 1 |');
    expect(text).toContain('| Files changed | 902 |');
    expect(text).toContain('| Repositories with a changed file | 2 |');
    expect(text).toContain('| Fixes that need your words | 811 |');
    expect(text).toContain('| Answered with synthetic text and verified | 600 |');
    expect(text).toContain('| Not answered: no synthetic text for the field | 211 |');
    expect(text).toContain('| Violations | 1 |');
  });
});
