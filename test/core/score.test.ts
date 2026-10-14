import { describe, expect, it } from 'vitest';
import { computeScore, gradeFor, RISK_CAP } from '../../src/core/score.js';
import type { Category, Finding, Severity } from '../../src/core/types.js';

function finding(
  path: string,
  severity: Severity,
  category: Category = 'loading',
  suppressed = false,
): Finding {
  const position = { line: 1, column: 1 };
  return {
    ruleId: 'test/rule',
    severity,
    category,
    message: 'm',
    path,
    range: { start: position, end: position },
    related: [],
    platforms: ['codex'],
    fingerprint: 'x:1',
    ...(suppressed ? { suppressed: { kind: 'inline', reason: 'r' } } : {}),
  };
}

describe('computeScore', () => {
  it('returns null, not 0 or 100, when there is nothing to score', () => {
    const report = computeScore([], []);
    expect(report.score).toBeNull();
    expect(report.grade).toBeNull();
  });

  it('gives a clean repository 100', () => {
    expect(computeScore(['AGENTS.md'], []).score).toBe(100);
  });

  it('subtracts 40 per error and 8 per warning, per artifact', () => {
    const report = computeScore(
      ['a.md'],
      [finding('a.md', 'error'), finding('a.md', 'warn'), finding('a.md', 'info')],
    );
    expect(report.artifacts).toEqual([{ path: 'a.md', score: 52 }]);
    expect(report.score).toBe(52);
    expect(report.categories.loading).toEqual({ errors: 1, warnings: 1, infos: 1 });
  });

  it('floors artifact scores at zero', () => {
    const errors = Array.from({ length: 10 }, () => finding('a.md', 'error'));
    expect(computeScore(['a.md'], errors).score).toBe(0);
  });

  it('weights the worst artifact so clean padding cannot hide a broken file', () => {
    const clean = Array.from({ length: 99 }, (_, index) => `skill-${index}/SKILL.md`);
    const broken = Array.from({ length: 3 }, () => finding('bad/SKILL.md', 'error'));
    const report = computeScore([...clean, 'bad/SKILL.md'], broken);
    // mean = 99, worst = 0 -> 0.7 * 99 + 0.3 * 0 = 69.3
    expect(report.score).toBe(69);
    expect(report.grade).toBe('D');
  });

  it('caps the score when a risk error is present', () => {
    const report = computeScore(['a.md', 'b.md'], [finding('a.md', 'error', 'risk')]);
    expect(report.capped).toBe(true);
    expect(report.score).toBe(RISK_CAP);
  });

  it('ignores suppressed findings', () => {
    const report = computeScore(['a.md'], [finding('a.md', 'error', 'risk', true)]);
    expect(report.score).toBe(100);
    expect(report.capped).toBe(false);
  });

  it('handles very large artifact counts without overflowing the stack', () => {
    const paths = Array.from({ length: 200_000 }, (_, index) => `${index}/SKILL.md`);
    expect(computeScore(paths, []).score).toBe(100);
  });

  it.each([
    [100, 'A'],
    [90, 'A'],
    [89, 'B'],
    [80, 'B'],
    [79, 'C'],
    [70, 'C'],
    [69, 'D'],
    [60, 'D'],
    [59, 'F'],
    [0, 'F'],
  ] as const)('grades %i as %s', (score, grade) => {
    expect(gradeFor(score)).toBe(grade);
  });
});
