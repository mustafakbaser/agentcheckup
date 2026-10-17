/**
 * `run.ts --fix-replay`: runs `agentcheckup fix` on an in-memory copy of every corpus repository
 * with every fix selected (safe, review and the mcp/literal-secret opt-in), and checks what a
 * user would rely on:
 *
 * - every fix verification kept resolves the findings it carries;
 * - the fixed copy has no new error or warning (new infos are allowed and listed);
 * - a second run on the fixed copy plans nothing (idempotency);
 * - the fixed copy still passes the consistency check (consistency.ts);
 * - no rule crashes on a fixed copy, `fixRounds` does not throw, and `applyPlan` accepts every
 *   fix the planner plans;
 * - verification drops no fix: a rule that offers a fix that fails verification has a bug.
 *
 * Each repository is scanned as the rest of the harness scans it: every built-in rule, every
 * platform targeted, no configuration, inline directives not trusted (the corpus has none).
 * Nothing is written: the fixed copy exists only in memory.
 *
 * The same module computes the aggregate "Fixes" section of corpus/SUMMARY.md: how many findings
 * have a safe fix, a fix that needs review, or guidance only, and how scores change after
 * `fix --write` and `fix --write --review` (docs/adr/0005-scoring.md: aggregates only).
 *
 * Output of the replay names repositories and paths, so it is for local review only, like
 * corpus/REPORT.md.
 */
import { compareStrings } from '../../src/core/compare.js';
import { analyze } from '../../src/core/engine.js';
import { createParseCache } from '../../src/core/parse-cache.js';
import type { Finding, FixClass, Severity, Snapshot } from '../../src/core/types.js';
import {
  applyPlan,
  type FixRun,
  type FixScanOptions,
  type FixSelection,
  type FixSkipReason,
  fixRounds,
  type PlannedFix,
  planFixes,
} from '../../src/fix/index.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { builtinRules } from '../../src/rules/index.js';
import { type RepoConsistency, repoConsistency } from './consistency.js';

/** How the corpus is scanned everywhere in the harness. */
export const REPLAY_SCAN_OPTIONS: FixScanOptions = { rules: builtinRules, trustDirectives: false };

/** Every fix, mcp/literal-secret included, so every rule's fix is exercised. */
export const EVERY_FIX: FixSelection = {
  classes: new Set<FixClass>(['safe', 'review']),
  literalSecret: true,
};

/** What `agentcheckup fix --write` applies. */
export const SAFE_FIXES: FixSelection = {
  classes: new Set<FixClass>(['safe']),
  literalSecret: false,
};

/** What `agentcheckup fix --write --review` applies: mcp/literal-secret stays opt-in. */
export const SAFE_AND_REVIEW_FIXES: FixSelection = {
  classes: new Set<FixClass>(['safe', 'review']),
  literalSecret: false,
};

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/**
 * What went wrong. Each is a bug in a rule's fix, in the planner or in a loader:
 * - `crash`: fixRounds threw.
 * - `apply-threw`: applyPlan refused a fix that planFixes planned on the same snapshot.
 * - `rule-crash`: a rule crashed on the fixed copy but not on the original.
 * - `verification-failed`: fixRounds dropped a fix: its findings stayed, or it added an error or
 *   a warning, or its edits did not fit the file.
 * - `refused-path`: the rule offered a fix the planner refuses to write (a symlinked file, a
 *   create or rename target that exists); the rule must give guidance instead.
 * - `unresolved`: a finding an applied fix carries is still in the scan of the fixed copy.
 * - `introduced`: the fixed copy has an error or a warning the original did not have.
 * - `not-idempotent`: a second run on the fixed copy plans a fix.
 * - `inconsistent`: the load plans of the fixed copy disagree with its findings, or a loader
 *   threw on it.
 */
export type ViolationKind =
  | 'crash'
  | 'apply-threw'
  | 'rule-crash'
  | 'verification-failed'
  | 'refused-path'
  | 'unresolved'
  | 'introduced'
  | 'not-idempotent'
  | 'inconsistent';

export interface Violation {
  readonly repo: string;
  readonly kind: ViolationKind;
  /** `''` when no rule is concerned, as for a crash of fixRounds. */
  readonly ruleId: string;
  /** `''` when no path is concerned. */
  readonly path: string;
  readonly reason: string;
}

/** A finding, reduced to what the comparison of two scans needs. */
export interface FindingKey {
  readonly ruleId: string;
  readonly path: string;
  readonly severity: Severity;
  readonly fingerprint: string;
}

/** What became of one fix in the replay. */
export interface ReplayDecision {
  readonly ruleId: string;
  readonly fixId: string;
  readonly outcome: 'applied' | 'skipped' | 'deferred';
  /** Present exactly when `outcome` is `skipped` or `deferred`. */
  readonly reason?: FixSkipReason;
  /** A `safe` fix that verification made `review`: it adds or changes a gated inventory item. */
  readonly demoted: boolean;
}

/** One repository's replay. Holds paths and rule ids, never file content. */
export interface RepoReplay {
  readonly repo: string;
  /** Milliseconds for the whole replay of this repository. */
  readonly ms: number;
  /** Rounds of the first run that applied a fix. */
  readonly rounds: number;
  /** Files the first run changed. */
  readonly files: number;
  readonly decisions: readonly ReplayDecision[];
  readonly violations: readonly Violation[];
  /** New infos in the fixed copy: allowed, but listed. */
  readonly introducedInfos: readonly Omit<FindingKey, 'fingerprint'>[];
}

// ---------------------------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------------------------

const keyOf = (ruleId: string, path: string, severity: Severity): string =>
  `${ruleId}\u0000${path}\u0000${severity}`;

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function splitKey(key: string): { ruleId: string; path: string; severity: Severity } {
  const [ruleId = '', path = '', severity = 'info'] = key.split('\u0000');
  return { ruleId, path, severity: severity as Severity };
}

/**
 * Compares the scan of the fixed copy with the scan of the original, independently of the
 * verification in src/fix/verify.ts and more strictly: findings match by rule, path (mapped
 * through `renames`, old path to new) and severity, as a multiset, so a warning that becomes an
 * error counts as introduced. Returns
 * - an `unresolved` violation for each (rule, path, severity) where the applied fixes claim more
 *   findings than are gone;
 * - an `introduced` violation for each new error or warning;
 * - the new infos.
 *
 * `applied` lists, per applied fix, its rule and the fingerprints of the findings it carries in
 * the original scan; fingerprints the original scan does not have are ignored.
 */
export function compareFindings(
  repo: string,
  before: readonly FindingKey[],
  after: readonly FindingKey[],
  renames: ReadonlyMap<string, string>,
  applied: readonly { readonly ruleId: string; readonly findings: readonly string[] }[],
): { violations: Violation[]; introducedInfos: Omit<FindingKey, 'fingerprint'>[] } {
  const was = new Map<string, number>();
  const byFingerprint = new Map<string, string>();
  for (const finding of before) {
    const key = keyOf(finding.ruleId, renames.get(finding.path) ?? finding.path, finding.severity);
    increment(was, key);
    byFingerprint.set(finding.fingerprint, key);
  }
  const is = new Map<string, number>();
  for (const finding of after) increment(is, keyOf(finding.ruleId, finding.path, finding.severity));

  const claimed = new Map<string, number>();
  const claimedBy = new Map<string, string>();
  for (const fix of applied) {
    for (const fingerprint of new Set(fix.findings)) {
      const key = byFingerprint.get(fingerprint);
      if (key === undefined) continue;
      increment(claimed, key);
      claimedBy.set(key, fix.ruleId);
    }
  }

  const violations: Violation[] = [];
  const introducedInfos: Omit<FindingKey, 'fingerprint'>[] = [];
  for (const [key, count] of [...claimed].sort(([a], [b]) => compareStrings(a, b))) {
    const left = is.get(key) ?? 0;
    const allowed = (was.get(key) ?? 0) - count;
    if (left <= allowed) continue;
    const { ruleId, path, severity } = splitKey(key);
    violations.push({
      repo,
      kind: 'unresolved',
      ruleId: claimedBy.get(key) ?? ruleId,
      path,
      reason:
        `${String(left - allowed)} of ${String(count)} ${severity} finding(s) of ${ruleId} the ` +
        'applied fixes carry are still there',
    });
  }
  for (const [key, count] of [...is].sort(([a], [b]) => compareStrings(a, b))) {
    const surplus = count - (was.get(key) ?? 0);
    if (surplus <= 0) continue;
    const { ruleId, path, severity } = splitKey(key);
    if (severity === 'info') {
      for (let index = 0; index < surplus; index++)
        introducedInfos.push({ ruleId, path, severity });
      continue;
    }
    violations.push({
      repo,
      kind: 'introduced',
      ruleId,
      path,
      reason: `${String(surplus)} new ${severity === 'error' ? 'error(s)' : 'warning(s)'}`,
    });
  }
  return { violations, introducedInfos };
}

/** The class a rule gave the fix, from a finding of the original scan that carries it. */
function declaredClass(
  fix: PlannedFix,
  before: ReadonlyMap<string, Finding>,
): FixClass | undefined {
  for (const fingerprint of fix.findings) {
    const declared = before.get(fingerprint)?.fix;
    if (declared?.id === fix.fix.id) return declared.class;
  }
  return undefined;
}

/** Every fix of a run, as the summary counts it. */
export function decisionsOf(
  run: Pick<FixRun, 'before' | 'applied' | 'skipped' | 'deferred'>,
): ReplayDecision[] {
  const before = new Map(run.before.findings.map((finding) => [finding.fingerprint, finding]));
  const demoted = (fix: PlannedFix): boolean =>
    fix.fix.class === 'review' && declaredClass(fix, before) === 'safe';
  const decision = (fix: PlannedFix, outcome: ReplayDecision['outcome']): ReplayDecision => ({
    ruleId: fix.ruleId,
    fixId: fix.fix.id,
    outcome,
    ...(fix.status === 'skipped' ? { reason: fix.reason } : {}),
    demoted: demoted(fix),
  });
  return [
    ...run.applied.map((fix) => decision(fix, 'applied')),
    ...run.skipped.map((fix) => decision(fix, 'skipped')),
    ...run.deferred.map((fix) => decision(fix, 'deferred')),
  ];
}

/** Where a fix is: the path of the first of its findings in `scan`, else its first change. */
function pathOf(fix: PlannedFix, scan: Pick<FixRun['before'], 'findings'>): string {
  const finding = scan.findings.find((item) => fix.findings.includes(item.fingerprint));
  if (finding !== undefined) return finding.path;
  const [change] = fix.fix.changes;
  if (change === undefined) return '';
  return change.kind === 'rename' ? change.from : change.path;
}

/** Fixes the first run dropped: a rule offered a fix the tool would not apply. */
export function droppedFixViolations(
  repo: string,
  run: Pick<FixRun, 'before' | 'skipped'>,
): Violation[] {
  const violations: Violation[] = [];
  for (const fix of run.skipped) {
    if (fix.status !== 'skipped') continue;
    if (fix.reason !== 'verification-failed' && fix.reason !== 'refused-path') continue;
    violations.push({
      repo,
      kind: fix.reason,
      ruleId: fix.ruleId,
      path: pathOf(fix, run.before),
      reason: `${fix.fix.id} (${fix.fix.class}): ${fix.fix.title}`,
    });
  }
  return violations;
}

/** Every fix a second run on the fixed copy plans, as `not-idempotent`. */
export function idempotencyViolations(
  repo: string,
  second: Pick<FixRun, 'before' | 'applied' | 'skipped' | 'deferred'>,
): Violation[] {
  const fixes = [...second.applied, ...second.skipped, ...second.deferred];
  return fixes.map((fix) => ({
    repo,
    kind: 'not-idempotent' as const,
    ruleId: fix.ruleId,
    path: pathOf(fix, second.before),
    reason:
      `a second run plans ${fix.fix.id} (${fix.fix.class}): ${fix.fix.title}` +
      (fix.status === 'skipped' ? ` [${fix.reason}]` : ''),
  }));
}

/** Mismatches and loader crashes on the fixed copy, as `inconsistent`. */
export function consistencyViolations(
  repo: string,
  checked: Pick<RepoConsistency, 'report' | 'crash'>,
): Violation[] {
  const violations: Violation[] = checked.report.mismatches.map((mismatch) => ({
    repo,
    kind: 'inconsistent' as const,
    ruleId: mismatch.ruleId,
    path: mismatch.path,
    reason:
      `${mismatch.kind} for ${mismatch.agent}` +
      (mismatch.code === undefined ? '' : ` (${mismatch.code})`) +
      (mismatch.cwd === undefined
        ? ''
        : ` in the plan at ${mismatch.cwd === '' ? '.' : mismatch.cwd}`),
  }));
  if (checked.crash !== undefined) {
    violations.push({
      repo,
      kind: 'inconsistent',
      ruleId: '',
      path: '',
      reason: `a loader threw: ${checked.crash}`,
    });
  }
  return violations;
}

/** Rules that crash on the fixed copy but not on the original. */
export function ruleCrashViolations(
  repo: string,
  before: readonly { readonly ruleId: string }[],
  after: readonly { readonly ruleId: string; readonly message: string }[],
): Violation[] {
  const crashed = new Set(before.map((failure) => failure.ruleId));
  return after
    .filter((failure) => !crashed.has(failure.ruleId))
    .map((failure) => ({
      repo,
      kind: 'rule-crash' as const,
      ruleId: failure.ruleId,
      path: '',
      reason: failure.message,
    }));
}

// ---------------------------------------------------------------------------------------------
// Replay of one repository
// ---------------------------------------------------------------------------------------------

const keysOf = (findings: readonly Finding[]): FindingKey[] =>
  findings
    .filter((finding) => finding.suppressed === undefined)
    .map(({ ruleId, path, severity, fingerprint }) => ({ ruleId, path, severity, fingerprint }));

/** applyPlan on every fix the first round plans, alone and together. */
function applyViolations(
  repo: string,
  snapshot: Snapshot,
  run: FixRun,
  options: FixScanOptions,
): Violation[] {
  const plan = planFixes(analyze(snapshot, options), run.before, EVERY_FIX);
  const planned = plan.fixes.filter((fix) => fix.status === 'planned');
  const violations: Violation[] = [];
  const attempt = (fixes: readonly PlannedFix[], ruleId: string, path: string): void => {
    try {
      applyPlan(snapshot, { fixes });
    } catch (error) {
      violations.push({
        repo,
        kind: 'apply-threw',
        ruleId,
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const fix of planned) attempt([fix], fix.ruleId, pathOf(fix, run.before));
  if (violations.length === 0 && planned.length > 1) attempt(planned, '', '');
  return violations;
}

/**
 * Runs the replay on one repository's snapshot. Throws nothing: a crash is a violation. Also
 * returns the scan of the original, which is the scan the rest of the harness makes, or undefined
 * when fixRounds threw.
 */
export function replayRepo(
  repo: string,
  snapshot: Snapshot,
): { readonly replay: RepoReplay; readonly before: FixRun['before'] | undefined } {
  const start = performance.now();
  // Every scan of the repository and of its fixed copies shares the parses of unchanged files.
  const options: FixScanOptions = { ...REPLAY_SCAN_OPTIONS, parseCache: createParseCache() };
  let first: FixRun;
  try {
    first = fixRounds(snapshot, options, EVERY_FIX);
  } catch (error) {
    const replay: RepoReplay = {
      repo,
      ms: performance.now() - start,
      rounds: 0,
      files: 0,
      decisions: [],
      introducedInfos: [],
      violations: [
        {
          repo,
          kind: 'crash',
          ruleId: '',
          path: '',
          reason: error instanceof Error ? (error.stack ?? error.message) : String(error),
        },
      ],
    };
    return { replay, before: undefined };
  }

  const renames = new Map<string, string>();
  for (const file of first.files) if (file.from !== undefined) renames.set(file.from, file.path);
  const compared = compareFindings(
    repo,
    keysOf(first.before.findings),
    keysOf(first.after.findings),
    renames,
    first.applied,
  );
  const violations: Violation[] = [
    ...applyViolations(repo, snapshot, first, options),
    ...droppedFixViolations(repo, first),
    ...ruleCrashViolations(repo, first.before.ruleFailures, first.after.ruleFailures),
    ...compared.violations,
  ];

  if (first.files.length > 0) {
    try {
      const second = fixRounds(first.snapshot, options, EVERY_FIX);
      violations.push(...idempotencyViolations(repo, second));
    } catch (error) {
      violations.push({
        repo,
        kind: 'crash',
        ruleId: '',
        path: '',
        reason: `second run: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    violations.push(
      ...consistencyViolations(repo, repoConsistency(repo, first.snapshot, options.parseCache)),
    );
  }

  const replay: RepoReplay = {
    repo,
    ms: performance.now() - start,
    rounds: first.rounds,
    files: first.files.length,
    decisions: decisionsOf(first),
    violations,
    introducedInfos: compared.introducedInfos,
  };
  return { replay, before: first.before };
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

/** Per rule: what the replay did with its fixes, over every repository. */
export interface RuleTally {
  readonly ruleId: string;
  /** Every fix the planner selected: applied, skipped and deferred. */
  readonly planned: number;
  readonly applied: number;
  readonly skipped: Readonly<Partial<Record<FixSkipReason, number>>>;
  readonly deferred: number;
  readonly demoted: number;
  /** Skipped with reason `verification-failed`. */
  readonly verificationFailures: number;
  /** Violations of any kind on this rule. */
  readonly violations: number;
}

/** Tallies by rule, sorted by rule id. Violations without a rule are counted under `''`. */
export function tallyByRule(replays: readonly RepoReplay[]): RuleTally[] {
  interface Mutable {
    planned: number;
    applied: number;
    skipped: Partial<Record<FixSkipReason, number>>;
    deferred: number;
    demoted: number;
    verificationFailures: number;
    violations: number;
  }
  const tallies = new Map<string, Mutable>();
  const tally = (ruleId: string): Mutable => {
    let found = tallies.get(ruleId);
    if (found === undefined) {
      found = {
        planned: 0,
        applied: 0,
        skipped: {},
        deferred: 0,
        demoted: 0,
        verificationFailures: 0,
        violations: 0,
      };
      tallies.set(ruleId, found);
    }
    return found;
  };
  for (const replay of replays) {
    for (const decision of replay.decisions) {
      const entry = tally(decision.ruleId);
      entry.planned += 1;
      if (decision.demoted) entry.demoted += 1;
      if (decision.outcome === 'applied') entry.applied += 1;
      else if (decision.outcome === 'deferred') entry.deferred += 1;
      else if (decision.reason !== undefined) {
        entry.skipped[decision.reason] = (entry.skipped[decision.reason] ?? 0) + 1;
        if (decision.reason === 'verification-failed') entry.verificationFailures += 1;
      }
    }
    for (const violation of replay.violations) tally(violation.ruleId).violations += 1;
  }
  return [...tallies]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([ruleId, entry]) => ({ ruleId, ...entry }));
}

/** Nearest-rank percentile of sorted numbers; 0 for none. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : `${' '.repeat(width - text.length)}${text}`;
}

const ms = (value: number): string => `${String(Math.round(value))} ms`;

const repositories = (count: number): string =>
  `${String(count)} ${count === 1 ? 'repository' : 'repositories'}`;

/** Every violation, sorted by repository, rule, path, kind and reason. */
export function sortedViolations(replays: readonly RepoReplay[]): Violation[] {
  return replays
    .flatMap((replay) => replay.violations)
    .sort(
      (a, b) =>
        compareStrings(a.repo, b.repo) ||
        compareStrings(a.ruleId, b.ruleId) ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.kind, b.kind) ||
        compareStrings(a.reason, b.reason),
    );
}

/** The text `--fix-replay` prints, and the number of violations. */
export function renderReplay(replays: readonly RepoReplay[]): {
  readonly text: string;
  readonly violations: number;
} {
  const tallies = tallyByRule(replays);
  const withFixes = tallies.filter((entry) => entry.planned > 0);
  const total = (pick: (entry: RuleTally) => number): number =>
    tallies.reduce((sum, entry) => sum + pick(entry), 0);
  const skippedTotal = (entry: RuleTally): number =>
    Object.values(entry.skipped).reduce((sum, count) => sum + count, 0);
  const violations = sortedViolations(replays);

  const out: string[] = [
    `Fix replay: ${repositories(replays.length)}, every fix selected (safe, review and ` +
      'mcp/literal-secret).',
    `${String(total((entry) => entry.planned))} fixes planned, ` +
      `${String(total((entry) => entry.applied))} applied, ` +
      `${String(total(skippedTotal))} skipped, ${String(total((entry) => entry.deferred))} deferred, ` +
      `${String(total((entry) => entry.demoted))} demoted to review, ` +
      `${String(total((entry) => entry.verificationFailures))} verification failures; ` +
      `${String(replays.reduce((sum, replay) => sum + replay.files, 0))} files changed in ` +
      `${repositories(replays.filter((replay) => replay.files > 0).length)}.`,
    '',
  ];

  const header = ['Rule', 'Planned', 'Applied', 'Skipped', 'Deferred', 'Demoted', 'Failed'];
  const rows = withFixes.map((entry) => [
    entry.ruleId,
    String(entry.planned),
    String(entry.applied),
    String(skippedTotal(entry)),
    String(entry.deferred),
    String(entry.demoted),
    String(entry.verificationFailures),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const format = (row: readonly string[]): string =>
    row
      .map((cell, column) =>
        column === 0 ? pad(cell, widths[0] ?? 0) : padStart(cell, widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd();
  if (rows.length === 0) out.push('No fixes planned.');
  else out.push(format(header), ...rows.map(format));

  const reasons = withFixes.flatMap((entry) =>
    Object.entries(entry.skipped).map(
      ([reason, count]) => `  ${entry.ruleId}: ${reason} ${String(count)}`,
    ),
  );
  if (reasons.length > 0) out.push('', 'Skipped, by reason:', ...reasons);

  const infos = new Map<string, number>();
  for (const replay of replays) {
    for (const info of replay.introducedInfos) increment(infos, info.ruleId);
  }
  out.push(
    '',
    infos.size === 0
      ? 'New infos in the fixed copies: none.'
      : `New infos in the fixed copies (allowed): ${[...infos]
          .sort(([a], [b]) => compareStrings(a, b))
          .map(([ruleId, count]) => `${ruleId} ${String(count)}`)
          .join(', ')}.`,
  );

  const times = replays.map((replay) => replay.ms).sort((a, b) => a - b);
  const slowest = [...replays].sort((a, b) => b.ms - a.ms || compareStrings(a.repo, b.repo));
  out.push(
    '',
    `Time: total ${ms(times.reduce((sum, value) => sum + value, 0))}, median ${ms(percentile(times, 0.5))}, ` +
      `p90 ${ms(percentile(times, 0.9))}, max ${ms(times.at(-1) ?? 0)}.`,
    `Slowest: ${slowest
      .slice(0, 5)
      .map((replay) => `${replay.repo} ${ms(replay.ms)}`)
      .join(', ')}.`,
  );

  out.push('', `Violations: ${violations.length === 0 ? 'none.' : String(violations.length)}`);
  for (const violation of violations) {
    out.push(
      `  ${violation.kind}  ${violation.repo}  ${violation.ruleId === '' ? '-' : violation.ruleId}  ` +
        `${violation.path === '' ? '-' : violation.path}  ${violation.reason}`,
    );
  }
  return {
    text: `${out.map((line) => forTerminal(line)).join('\n')}\n`,
    violations: violations.length,
  };
}
