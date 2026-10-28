/**
 * `--policy <file>`: reads an organization policy before the scan and checks the scan against
 * it. See docs/policy.md and docs/adr/0011-organization-policy.md.
 */
import { resolve } from 'node:path';
import type { BaselineReport } from '../core/baseline-input.js';
import { type ScanOptions, type ScanResult, scanWithContext } from '../core/engine.js';
import type { Snapshot } from '../core/types.js';
import { isInsideDirectory, readPolicyFile } from '../io/policy-file.js';
import {
  evaluatePolicy,
  parsePolicy,
  type Policy,
  type PolicyPlan,
  type PolicySubject,
} from '../policy/index.js';
import { plural } from '../report/text.js';
import { quote } from '../rules/shared/format.js';

/** A policy file that parses but is not a valid policy: one line per problem. Exit code 2. */
export class PolicyFileError extends Error {
  override readonly name = 'PolicyFileError';
  readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    super(lines.join('\n'));
    this.lines = lines;
  }
}

export interface LoadedPolicy {
  readonly policy: Policy;
  /** SHA-256 of the file's bytes. */
  readonly sha256: string;
  readonly insideScanRoot: boolean;
}

/**
 * Reads and validates the `--policy` file. Read before the scan, so a bad policy fails fast.
 * Throws InputFileError for a file that cannot be read or parsed, and PolicyFileError for a
 * policy with problems, each line starting with the file name as given.
 */
export async function loadPolicy(
  file: string | undefined,
  root: string,
  cwd: string,
): Promise<LoadedPolicy | undefined> {
  if (file === undefined) return undefined;
  const filePath = resolve(cwd, file);
  const { json, sha256 } = await readPolicyFile(filePath);
  const parsed = parsePolicy(json);
  if ('errors' in parsed) {
    throw new PolicyFileError(parsed.errors.map((error) => `${file}: ${error}`));
  }
  return { policy: parsed.policy, sha256, insideScanRoot: await isInsideDirectory(filePath, root) };
}

/**
 * Checks `scanned` against the policy and adds the result as `policy`. Runs before rebasing:
 * violation paths are then relative to the scanned directory and are rebased with the rest of
 * the report, while violation ids never are. The baseline report is passed as it was read; the
 * policy core removes its `pathBase`.
 */
export function withPolicy(
  scanned: ScanResult,
  loaded: LoadedPolicy | undefined,
  baseline: BaselineReport | undefined,
  snapshot: Snapshot,
  scanOptions: ScanOptions,
): ScanResult {
  if (loaded === undefined) return scanned;
  const plans = budgetPlans(loaded.policy, scanned, snapshot, scanOptions);
  const current: PolicySubject = {
    inventory: scanned.inventory,
    ...(scanned.agents === undefined ? {} : { agents: scanned.agents }),
    ...(plans === undefined ? {} : { context: { plans } }),
  };
  const report = evaluatePolicy(loaded.policy, {
    sha256: loaded.sha256,
    current,
    ...(baseline === undefined ? {} : { baseline }),
    insideScanRoot: loaded.insideScanRoot,
  });
  return { ...scanned, policy: report };
}

/**
 * `Policy "acme agent policy": 2 violations fail the run.`, for formats that do not show the
 * policy to a person (json, sarif, badge), so exit code 1 does not come without a reason.
 * Undefined when no violation fails. Raw text: the caller sanitizes it.
 */
export function policyFailure(result: ScanResult): string | undefined {
  const report = result.policy;
  if (report === undefined) return undefined;
  const failing = report.violations.filter((violation) => violation.fails).length;
  if (failing === 0) return undefined;
  const verb = failing === 1 ? 'fails' : 'fail';
  return `Policy ${quote(report.name)}: ${plural(failing, 'violation')} ${verb} the run.`;
}

/**
 * The load plans the policy's budgets read: every agent it names, at the root and in each
 * directory the matrix plans, whatever `--targets` says. A scan with `--context` has them when it
 * planned those agents. Otherwise a second scan plans them; only its plans are used, so the
 * findings, the score and the report's own plans stay those of the scan that was asked for.
 */
function budgetPlans(
  policy: Policy,
  scanned: ScanResult,
  snapshot: Snapshot,
  scanOptions: ScanOptions,
): readonly PolicyPlan[] | undefined {
  const agents = policy.budgets.map((budget) => budget.agent);
  if (agents.length === 0) return undefined;
  const context = scanned.context;
  if (context?.matrix !== undefined && agents.every((agent) => context.agents.includes(agent))) {
    return context.plans;
  }
  const { targets: _targets, ...options } = scanOptions;
  return scanWithContext(snapshot, { ...options, agents, matrix: true, countIgnored: false })
    .context.plans;
}
