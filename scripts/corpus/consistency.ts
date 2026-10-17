/**
 * `run.ts --consistency`: load plans against findings on every corpus repository, with the
 * check test/platforms/load/consistency.test.ts runs on fixtures (src/platforms/load/
 * consistency.ts). Each repository is scanned like `agentcheckup --untrusted`, then planned with
 * the matrix plans: every agent at the root and Codex in each AGENTS.md directory.
 *
 * Output names repositories and paths, so it is for local review only, like corpus/REPORT.md.
 */
import { compareStrings } from '../../src/core/compare.js';
import { analyze, type RuleResult, runRules } from '../../src/core/engine.js';
import type { ParseCache } from '../../src/core/parse-cache.js';
import type { Snapshot } from '../../src/core/types.js';
import {
  type AllowanceName,
  checkConsistency,
  type ConsistencyReport,
  type Mismatch,
  mismatchesByRule,
} from '../../src/platforms/load/consistency.js';
import { contextAgentsOf } from '../../src/platforms/load/index.js';
import { matrixPlans } from '../../src/platforms/load/matrix.js';
import type { ContextAgent } from '../../src/platforms/load/types.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { builtinRules } from '../../src/rules/index.js';

export interface RepoConsistency {
  readonly repo: string;
  readonly result: RuleResult;
  /** Plans checked. */
  readonly plans: number;
  readonly report: ConsistencyReport;
  /** Message of a loader that threw; the report is then empty. */
  readonly crash?: string;
}

/**
 * Scans one repository, plans it and checks both directions. `parseCache` shares parses with
 * other scans of the repository. `agents` are the agents to plan (run.ts `--agents`), every
 * modeled agent by default.
 */
export function repoConsistency(
  repo: string,
  snapshot: Snapshot,
  parseCache?: ParseCache,
  agents?: readonly ContextAgent[],
): RepoConsistency {
  const options = { rules: builtinRules, trustDirectives: false } as const;
  // As scanSnapshot with these options: no configuration, every platform targeted.
  const analysis = analyze(snapshot, parseCache === undefined ? {} : { parseCache });
  const result = runRules(analysis, options);
  try {
    const plans = matrixPlans(analysis, {
      agents: agents ?? contextAgentsOf(analysis.targetList),
      config: analysis.config,
    });
    const report = checkConsistency({ findings: result.findings, plans, view: analysis });
    return { repo, result, plans: plans.length, report };
  } catch (error) {
    return {
      repo,
      result,
      plans: 0,
      report: { mismatches: [], allowed: {} },
      crash: error instanceof Error ? error.message : String(error),
    };
  }
}

function line(mismatch: Mismatch, repo: string): string {
  const where =
    mismatch.cwd === undefined ? '' : ` (plan at ${mismatch.cwd === '' ? '.' : mismatch.cwd})`;
  const code = mismatch.code === undefined ? '' : ` ${mismatch.code}`;
  return `  ${mismatch.kind}  ${mismatch.agent}  ${repo}  ${mismatch.path}${code}${where}`;
}

/** The text `--consistency` prints, and the number of mismatches and crashes. */
export function renderConsistency(results: readonly RepoConsistency[]): {
  readonly text: string;
  readonly problems: number;
} {
  const tagged = results.flatMap((item) =>
    item.report.mismatches.map((mismatch) => ({ mismatch, repo: item.repo })),
  );
  const allowed = new Map<AllowanceName, number>();
  for (const item of results) {
    for (const [name, count] of Object.entries(item.report.allowed) as [AllowanceName, number][]) {
      allowed.set(name, (allowed.get(name) ?? 0) + count);
    }
  }
  const crashes = results.filter((item) => item.crash !== undefined);
  const repos = new Set(tagged.map((item) => item.repo)).size;
  const out: string[] = [
    `Consistency: ${String(results.length)} repositories, ` +
      `${String(results.reduce((sum, item) => sum + item.plans, 0))} plans, ` +
      `${String(tagged.length)} mismatches in ${String(repos)} repositories.`,
  ];
  const byRule = mismatchesByRule(tagged.map((item) => item.mismatch));
  const repoOf = new Map(tagged.map((item) => [item.mismatch, item.repo]));
  for (const [ruleId, mismatches] of byRule) {
    out.push('', `${ruleId === '' ? '(no rule id)' : ruleId} (${String(mismatches.length)})`);
    const sorted = [...mismatches].sort(
      (a, b) =>
        compareStrings(repoOf.get(a) ?? '', repoOf.get(b) ?? '') || compareStrings(a.path, b.path),
    );
    for (const mismatch of sorted) out.push(line(mismatch, repoOf.get(mismatch) ?? ''));
  }
  if (crashes.length > 0) {
    out.push('', `Loader crashes (${String(crashes.length)})`);
    for (const item of crashes) out.push(`  ${item.repo}: ${item.crash ?? ''}`);
  }
  out.push(
    '',
    `Allowances applied: ${
      allowed.size === 0
        ? 'none'
        : [...allowed]
            .sort(([a], [b]) => compareStrings(a, b))
            .map(([name, count]) => `${name} ${String(count)}`)
            .join(', ')
    }.`,
  );
  return {
    text: `${out.map((text) => forTerminal(text)).join('\n')}\n`,
    problems: tagged.length + crashes.length,
  };
}
