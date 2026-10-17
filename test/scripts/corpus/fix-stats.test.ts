import { describe, expect, it } from 'vitest';
import { scanSnapshot } from '../../../src/core/engine.js';
import { builtinRules } from '../../../src/rules/index.js';
import {
  fixFacts,
  median,
  type RepoFixFacts,
  renderFixSection,
  scoreChanges,
} from '../../../scripts/corpus/fix-stats.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';

function facts(
  score: RepoFixFacts['score'],
  findings: Partial<RepoFixFacts['findings']> = {},
  crashes: RepoFixFacts['crashes'] = {},
): RepoFixFacts {
  return { findings: { safe: 0, review: 0, guidance: 0, none: 0, ...findings }, score, crashes };
}

function scanned(files: FileMap): RepoFixFacts {
  const snapshot = snapshotFrom(files, { paths: ['.git/'] });
  return fixFacts(
    snapshot,
    scanSnapshot(snapshot, { rules: builtinRules, trustDirectives: false }),
  );
}

describe('fixFacts', () => {
  it('counts findings by fix class and scores the fixed copies', () => {
    const result = scanned({
      'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
      'CLAUDE.md': '# Claude notes\n\nUse the staging database for manual tests.\n',
      '.cursor/rules/x.md': 'Prefer named exports in TypeScript files.\n',
    });
    expect(result.findings).toMatchObject({ safe: 1, review: 1 });
    expect(result.crashes).toEqual({});
    const { before, safe, review } = result.score;
    expect(before).not.toBeNull();
    expect(safe).toBeGreaterThan(before ?? 100);
    expect(review).toBeGreaterThan(safe ?? 100);
  });

  it('keeps the score of a repository without fixable findings', () => {
    const result = scanned({ 'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n' });
    expect(result.findings).toEqual({ safe: 0, review: 0, guidance: 0, none: 0 });
    expect(result.score.safe).toBe(result.score.before);
    expect(result.score.review).toBe(result.score.before);
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
    const text = renderFixSection([
      facts({ before: 80, safe: 90, review: 95 }, { safe: 2, review: 1, guidance: 3, none: 4 }),
      facts({ before: 70, safe: 70, review: 70 }, { none: 10 }, { review: 'boom' }),
    ]);
    expect(text).toContain('| With a safe fix | 2 | 10% | 1 |');
    expect(text).toContain('| Neither | 14 | 70% | 2 |');
    expect(text).toContain('| Repositories with a higher score | 1 | 1 |');
    expect(text).toContain('| Median gain | +10 | +15 |');
    expect(text).toContain('| Fix runs that crashed | 0 | 1 |');
    expect(text).not.toContain('boom');
  });
});
