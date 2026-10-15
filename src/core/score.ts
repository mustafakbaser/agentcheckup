import { SCORE_FORMULA_VERSION } from './meta.js';
import { CATEGORIES, type Category, type Finding } from './types.js';

/**
 * Score formula v1. Documented in docs/scoring.md; any change bumps SCORE_FORMULA_VERSION.
 *
 * - Only unsuppressed `error` and `warn` findings count. `info` never affects the score.
 * - Each artifact starts at 100 and loses ERROR_PENALTY per error and WARN_PENALTY per warning,
 *   floored at 0. An error means a documented platform behavior breaks the file: one error
 *   takes a file to 60 (D), three take it to 0.
 * - The repository score blends the mean with the worst artifact, so padding a repository with
 *   many trivial clean files cannot hide one broken file.
 * - Any unsuppressed `risk` error caps the score at RISK_CAP: a red badge, whatever else is true.
 * - No artifacts means no score (null), not 0 or 100.
 */
export const ERROR_PENALTY = 40;
export const WARN_PENALTY = 8;
export const MEAN_WEIGHT = 0.7;
export const WORST_WEIGHT = 0.3;
export const RISK_CAP = 49;

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface CategoryTally {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export interface ScoreReport {
  readonly formula: number;
  readonly score: number | null;
  readonly grade: Grade | null;
  /** True when a risk finding capped the score. */
  readonly capped: boolean;
  readonly categories: Readonly<Record<Category, CategoryTally>>;
  readonly artifacts: readonly { readonly path: string; readonly score: number }[];
}

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function computeScore(
  artifactPaths: readonly string[],
  findings: readonly Finding[],
): ScoreReport {
  const categories = Object.fromEntries(
    CATEGORIES.map((category) => [category, { errors: 0, warnings: 0, infos: 0 }]),
  ) as Record<Category, { errors: number; warnings: number; infos: number }>;

  const penalties = new Map<string, number>(artifactPaths.map((path) => [path, 0]));
  let capped = false;

  for (const finding of findings) {
    if (finding.suppressed) continue;
    const tally = categories[finding.category];
    if (finding.severity === 'info') {
      tally.infos++;
      continue;
    }
    if (finding.severity === 'error') tally.errors++;
    else tally.warnings++;

    const penalty = finding.severity === 'error' ? ERROR_PENALTY : WARN_PENALTY;
    penalties.set(finding.path, (penalties.get(finding.path) ?? 0) + penalty);
    if (finding.category === 'risk' && finding.severity === 'error') capped = true;
  }

  const artifacts = artifactPaths.map((path) => ({
    path,
    score: Math.max(0, 100 - (penalties.get(path) ?? 0)),
  }));

  if (artifacts.length === 0) {
    return {
      formula: SCORE_FORMULA_VERSION,
      score: null,
      grade: null,
      capped: false,
      categories,
      artifacts,
    };
  }

  const scores = artifacts.map((artifact) => artifact.score);
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  // reduce, not Math.min(...scores): spreading a very large array overflows the call stack.
  const worst = scores.reduce((low, value) => Math.min(low, value), 100);
  let score = Math.round(MEAN_WEIGHT * mean + WORST_WEIGHT * worst);
  if (capped) score = Math.min(score, RISK_CAP);

  return {
    formula: SCORE_FORMULA_VERSION,
    score,
    grade: gradeFor(score),
    capped,
    categories,
    artifacts,
  };
}
