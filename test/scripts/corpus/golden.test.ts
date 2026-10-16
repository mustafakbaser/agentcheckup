import { describe, expect, it } from 'vitest';
import {
  compareGolden,
  fingerprintChanges,
  type Golden,
  type GoldenFinding,
  makeGolden,
} from '../../../scripts/corpus/golden.js';

function finding(
  ruleId: string,
  line: number,
  fingerprint: string,
  messageHash = 'm',
): GoldenFinding {
  return {
    ruleId,
    path: '.mcp.json',
    range: { start: { line, column: 1 }, end: { line, column: 5 } },
    severity: 'error',
    fingerprint,
    messageHash,
  };
}

function golden(findings: readonly GoldenFinding[]): Golden {
  return makeGolden([{ repo: 'acme/app', sha: 'abc', findings }]);
}

describe('--check-golden --ignore-fingerprints', () => {
  const saved = golden([
    finding('a/x', 3, 'f1:1'),
    finding('a/x', 9, 'f2:1'),
    finding('b/y', 1, 'f3:1'),
  ]);

  it('matches findings that differ only in their fingerprint, and counts them by rule', () => {
    const current = golden([
      finding('a/x', 3, 'g1:1'),
      finding('a/x', 9, 'f2:1'),
      finding('b/y', 1, 'g3:1'),
    ]);
    expect(compareGolden(saved, current).length).toBe(1);
    expect(compareGolden(saved, current, undefined, { fingerprints: false })).toEqual([]);
    expect(fingerprintChanges(saved, current)).toEqual([
      { ruleId: 'a/x', findings: 2, changed: 1 },
      { ruleId: 'b/y', findings: 1, changed: 1 },
    ]);
  });

  it('still reports every other difference', () => {
    const current = golden([
      finding('a/x', 4, 'f1:1'),
      finding('a/x', 9, 'f2:1', 'other message'),
      finding('b/y', 1, 'f3:1'),
    ]);
    const differences = compareGolden(saved, current, undefined, { fingerprints: false });
    expect(differences).toHaveLength(1);
    expect(differences[0]?.rules).toEqual([
      expect.objectContaining({
        ruleId: 'a/x',
        removed: [finding('a/x', 3, 'f1:1'), finding('a/x', 9, 'f2:1')],
        added: [finding('a/x', 4, 'f1:1'), finding('a/x', 9, 'f2:1', 'other message')],
      }),
    ]);
    // Nothing paired: no fingerprint change to count for a/x.
    expect(fingerprintChanges(saved, current)).toEqual([
      { ruleId: 'b/y', findings: 1, changed: 0 },
    ]);
  });

  it('compares duplicates as a multiset', () => {
    const twice = golden([finding('a/x', 3, 'f:1'), finding('a/x', 3, 'f:2')]);
    const swapped = golden([finding('a/x', 3, 'f:2'), finding('a/x', 3, 'g:1')]);
    expect(fingerprintChanges(twice, swapped)).toEqual([
      { ruleId: 'a/x', findings: 2, changed: 1 },
    ]);
    expect(compareGolden(twice, swapped, undefined, { fingerprints: false })).toEqual([]);
  });
});
