/**
 * Verification rounds of `agentcheckup fix`: plan, apply in memory, scan the fixed copy again,
 * keep what verifies, and repeat, because one fix can enable another. Pure: works on snapshots
 * and returns data; nothing is written. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 *
 * A round:
 * 1. Plans the scan's fixes ({@link planFixes}).
 * 2. Applies each planned fix alone to the snapshot and scans the result with root load plans.
 *    The fix passes when every finding it carries is gone and no new error, warning or rule
 *    failure appeared. Findings match by rule and path, mapped through renames, as a multiset:
 *    fingerprints change with the edits. Comparing the two scans with compareWithBaseline gives
 *    the fix's effects: startup token deltas per agent, and gate hits. A `safe` fix with a gate
 *    hit is demoted to `review`, and skipped when review fixes are not selected.
 * 3. Drops the fixes that failed and plans again, so a fix that lost a conflict to a failed one
 *    gets its turn.
 * 4. Applies the passing fixes together and verifies the combination. When fixes that pass
 *    alone fail together, they are added one at a time in plan order, keeping each that still
 *    verifies.
 *
 * Bounds: at most {@link MAX_ROUNDS} rounds, {@link MAX_FIXES} fixes per run and
 * {@link MAX_WRITTEN_FILE_BYTES} per written file. Fixes past a bound are skipped with `limit`.
 *
 * Cost: one scan per planned fix plus one per round, more only when fixes interact.
 */
import { compareWithBaseline, GATE_CLASSES } from '../core/baseline.js';
import { compareStrings } from '../core/compare.js';
import {
  analyze,
  type ContextOptions,
  type ContextScanResult,
  type ScanOptions,
  scanWithContext,
} from '../core/engine.js';
import type { Finding, Snapshot } from '../core/types.js';
import { applyPlan, FixApplyError } from './apply.js';
import type {
  Conflict,
  FixEffect,
  FixPlan,
  FixSelection,
  FixSkipReason,
  FixVerification,
  ManualStep,
  PlannedFix,
} from './index.js';
import { type FixCandidate, fixKey, MAX_FIXES, planFixes } from './plan.js';
import { sameBytes } from './text.js';

/** Most verification rounds per run (ADR 0008). */
export const MAX_ROUNDS = 3;

/** Largest file a fix may write, in bytes (ADR 0008). */
export const MAX_WRITTEN_FILE_BYTES = 1024 * 1024;

/**
 * Scan options for verification. Plans are always made for the root, without the matrix: the
 * working directory and matrix options do not apply.
 */
export type FixScanOptions = ScanOptions & Pick<ContextOptions, 'agents' | 'contextWindow'>;

/** The combined change to one file across every applied fix, for diffs. */
export interface FileDiff {
  /** The path after fixing. */
  readonly path: string;
  /**
   * - `edit`: same path, new bytes (text, encoding or both).
   * - `create`: a new file; no `before`.
   * - `rename`: moved from `from`, possibly with new bytes.
   */
  readonly op: 'edit' | 'create' | 'rename';
  readonly from?: string;
  /** The bytes the scan read. Absent for a created file. */
  readonly before?: Uint8Array;
  readonly after: Uint8Array;
}

/** What {@link fixRounds} returns. */
export interface FixRun {
  /** The input with every applied fix, in memory. */
  readonly snapshot: Snapshot;
  /** The scan of the input, with root load plans. */
  readonly before: ContextScanResult;
  /** The scan of {@link snapshot}, with root load plans. */
  readonly after: ContextScanResult;
  /** Changed files, sorted by path. */
  readonly files: readonly FileDiff[];
  /**
   * Fixes applied to the in-memory copy and verified, in round order, with their effects.
   * Status `planned`: nothing is written yet; the writer marks them `applied`.
   */
  readonly applied: readonly PlannedFix[];
  /** Fixes left out with reason `refused-path`, `verification-failed` or `limit`. */
  readonly skipped: readonly PlannedFix[];
  /** Fixes that lost a conflict in the last round, with reason `conflict`. */
  readonly deferred: readonly PlannedFix[];
  /** The conflicts that deferred them. */
  readonly conflicts: readonly Conflict[];
  /** Findings left to the user, as they are in {@link after}. */
  readonly manual: readonly ManualStep[];
  /** {@link after} compared with {@link before}. */
  readonly verification: FixVerification;
  /** Rounds that applied at least one fix. */
  readonly rounds: number;
}

type Scan = ContextScanResult;

function activeFindings(scan: Pick<Scan, 'findings'>): Finding[] {
  return scan.findings.filter((finding) => finding.suppressed === undefined);
}

const keyOf = (ruleId: string, path: string): string => `${ruleId}\u0000${path}`;

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Follows the renames and creates of `fixes` in order: `origins` maps a renamed file's current
 * path to its path in the scan, `created` holds the paths of new files.
 */
function trackChanges(
  fixes: readonly PlannedFix[],
  origins: Map<string, string>,
  created: Set<string>,
): void {
  for (const planned of fixes) {
    for (const change of planned.fix.changes) {
      if (change.kind === 'create') created.add(change.path);
      if (change.kind !== 'rename') continue;
      if (created.delete(change.from)) {
        created.add(change.to);
        continue;
      }
      const origin = origins.get(change.from) ?? change.from;
      origins.delete(change.from);
      origins.set(change.to, origin);
    }
  }
}

/** Old path → new path for the files `fixes` rename. */
function renamesOf(fixes: readonly PlannedFix[]): Map<string, string> {
  const origins = new Map<string, string>();
  trackChanges(fixes, origins, new Set());
  return new Map([...origins].map(([now, was]) => [was, now]));
}

interface ScanComparison {
  /** Every finding the fixes carry is gone, and no error, warning or rule failure is new. */
  readonly ok: boolean;
  readonly introduced: readonly Finding[];
  readonly resolved: number;
  readonly remaining: number;
}

/**
 * Compares two scans by rule and path (mapped through `renames`) as a multiset. `claimed` are
 * the fixes whose findings must be gone.
 */
function compareScans(
  before: Pick<Scan, 'findings' | 'ruleFailures'>,
  after: Pick<Scan, 'findings' | 'ruleFailures'>,
  renames: ReadonlyMap<string, string>,
  claimed: readonly PlannedFix[],
): ScanComparison {
  const previous = activeFindings(before);
  const pool = new Map<string, number>();
  const byFingerprint = new Map<string, string>();
  for (const finding of previous) {
    const key = keyOf(finding.ruleId, renames.get(finding.path) ?? finding.path);
    increment(pool, key);
    byFingerprint.set(finding.fingerprint, key);
  }
  const expected = new Map<string, number>();
  for (const planned of claimed) {
    for (const fingerprint of planned.findings) {
      const key = byFingerprint.get(fingerprint);
      if (key !== undefined) increment(expected, key, -1);
    }
  }

  const slots = new Map(pool);
  const counts = new Map<string, number>();
  const introduced: Finding[] = [];
  let matched = 0;
  for (const finding of activeFindings(after)) {
    const key = keyOf(finding.ruleId, finding.path);
    increment(counts, key);
    const free = slots.get(key) ?? 0;
    if (free > 0) {
      slots.set(key, free - 1);
      matched++;
    } else {
      introduced.push(finding);
    }
  }

  let ok = introduced.every((finding) => finding.severity === 'info');
  for (const [key, removed] of expected) {
    if ((counts.get(key) ?? 0) > (pool.get(key) ?? 0) + removed) ok = false;
  }
  const failedBefore = new Set(before.ruleFailures.map((failure) => failure.ruleId));
  if (after.ruleFailures.some((failure) => !failedBefore.has(failure.ruleId))) ok = false;
  return { ok, introduced, resolved: previous.length - matched, remaining: matched };
}

/** True when `next` writes a file larger than the bound. */
function oversized(current: Snapshot, next: Snapshot): boolean {
  const unchanged = new Set(current.files);
  return next.files.some(
    (file) => !unchanged.has(file) && file.bytes.length > MAX_WRITTEN_FILE_BYTES,
  );
}

const gateKey = (effect: Extract<FixEffect, { kind: 'gate' }>): string =>
  `${effect.class}\u0000${effect.id}\u0000${effect.change}`;

/** Token deltas and gate hits of `after` against `before`. */
function effectsOf(before: Scan, after: Scan): FixEffect[] {
  const { diff } = compareWithBaseline(after, before, { gate: GATE_CLASSES });
  const effects: FixEffect[] = [];
  for (const delta of diff.context) {
    const { before: old, after: now } = delta.startupTokens;
    if (old !== now) {
      effects.push({ kind: 'tokens', agent: delta.agent, cwd: delta.cwd, before: old, after: now });
    }
  }
  for (const hit of diff.gate.hits) {
    effects.push({
      kind: 'gate',
      class: hit.class,
      id: hit.id,
      change: hit.change,
      summary: hit.summary,
    });
  }
  return effects;
}

function skip(planned: PlannedFix, reason: FixSkipReason): PlannedFix {
  const { status: _status, reason: _reason, ...rest } = planned;
  return { ...rest, status: 'skipped', reason };
}

type Evaluation =
  | { readonly ok: true; readonly fix: PlannedFix }
  | { readonly ok: false; readonly fix: PlannedFix };

interface Applied {
  readonly snapshot: Snapshot;
  readonly scan: Scan;
}

/** Everything one run shares between rounds. */
class Run {
  readonly options: ScanOptions & ContextOptions;
  readonly selection: FixSelection;
  readonly skipped = new Map<string, { fix: PlannedFix; scan: Scan }>();
  /** `${fix.id}\0${fingerprint}` of fixes that failed: not planned again for those findings. */
  readonly failed = new Set<string>();

  constructor(options: FixScanOptions, selection: FixSelection) {
    this.options = { ...options, cwd: '', matrix: false };
    this.selection = selection;
  }

  readonly exclude = (candidate: FixCandidate): boolean =>
    candidate.findings.some((finding) =>
      this.failed.has(`${candidate.fix.id}\u0000${finding.fingerprint}`),
    );

  fail(fix: PlannedFix, scan: Scan): void {
    if (fix.status !== 'skipped') return;
    for (const fingerprint of fix.findings) this.failed.add(`${fix.fix.id}\u0000${fingerprint}`);
    this.skipped.set(`${fixKey(fix.ruleId, fix.fix)}\u0000${fix.findings.join(',')}`, {
      fix,
      scan,
    });
  }

  scan(snapshot: Snapshot): Scan {
    return scanWithContext(snapshot, this.options);
  }

  /** Applies `fixes` to `current`; undefined when they cannot apply or write a file too large. */
  apply(current: Snapshot, fixes: readonly PlannedFix[]): Snapshot | 'limit' | undefined {
    let next: Snapshot;
    try {
      next = applyPlan(current, { fixes });
    } catch (error) {
      if (error instanceof FixApplyError) return undefined;
      throw error;
    }
    return oversized(current, next) ? 'limit' : next;
  }

  /** One fix alone: verification, effects, gate demotion. */
  evaluate(current: Snapshot, scan: Scan, candidate: PlannedFix): Evaluation {
    const next = this.apply(current, [candidate]);
    if (next === 'limit') return { ok: false, fix: skip(candidate, 'limit') };
    if (next === undefined) return { ok: false, fix: skip(candidate, 'verification-failed') };
    const after = this.scan(next);
    if (!compareScans(scan, after, renamesOf([candidate]), [candidate]).ok) {
      return { ok: false, fix: skip(candidate, 'verification-failed') };
    }
    const effects = effectsOf(scan, after);
    const gated = effects.some((effect) => effect.kind === 'gate');
    const fix =
      gated && candidate.fix.class === 'safe'
        ? { ...candidate.fix, class: 'review' as const }
        : candidate.fix;
    const planned: PlannedFix = { ...candidate, fix, effects };
    if (!this.selection.classes.has(fix.class)) {
      return { ok: false, fix: skip(planned, 'verification-failed') };
    }
    return { ok: true, fix: planned };
  }

  /**
   * `fixes` applied together: verified, and with no gate hit that none of them had alone.
   * Undefined when the combination fails.
   */
  combine(current: Snapshot, scan: Scan, fixes: readonly PlannedFix[]): Applied | undefined {
    const next = this.apply(current, fixes);
    if (next === undefined || next === 'limit') return undefined;
    const after = this.scan(next);
    if (!compareScans(scan, after, renamesOf(fixes), fixes).ok) return undefined;
    const known = new Set(
      fixes.flatMap((fix) =>
        fix.effects.flatMap((effect) => (effect.kind === 'gate' ? [gateKey(effect)] : [])),
      ),
    );
    const unexplained = effectsOf(scan, after).some(
      (effect) => effect.kind === 'gate' && !known.has(gateKey(effect)),
    );
    return unexplained ? undefined : { snapshot: next, scan: after };
  }
}

interface Round {
  /** The last plan of the round. */
  readonly plan: FixPlan;
  readonly applied: readonly PlannedFix[];
  readonly result?: Applied;
}

function runRound(run: Run, current: Snapshot, scan: Scan, budget: number): Round {
  const analysis = analyze(current, run.options);
  const evaluations = new Map<string, Evaluation>();
  for (;;) {
    const plan = planFixes(analysis, scan, run.selection, {
      maxFixes: budget,
      exclude: run.exclude,
    });
    const candidates = plan.fixes.filter((fix) => fix.status === 'planned');
    if (candidates.length === 0) return { plan, applied: [] };

    let failed = false;
    const passing: PlannedFix[] = [];
    for (const candidate of candidates) {
      const key = fixKey(candidate.ruleId, candidate.fix);
      let evaluation = evaluations.get(key);
      if (evaluation === undefined) {
        evaluation = run.evaluate(current, scan, candidate);
        evaluations.set(key, evaluation);
      }
      if (evaluation.ok) {
        passing.push(evaluation.fix);
      } else {
        failed = true;
        run.fail(evaluation.fix, scan);
      }
    }
    // Plan again without the failed fixes: a fix that lost a conflict to one may apply now.
    if (failed) continue;

    const together = run.combine(current, scan, passing);
    if (together !== undefined) return { plan, applied: passing, result: together };

    // Fixes that pass alone but fail together: add them one at a time, in plan order.
    const kept: PlannedFix[] = [];
    let result: Applied | undefined;
    for (const candidate of passing) {
      const trial = run.combine(current, scan, [...kept, candidate]);
      if (trial === undefined) {
        run.fail(skip(candidate, 'verification-failed'), scan);
        continue;
      }
      kept.push(candidate);
      result = trial;
    }
    if (result !== undefined) return { plan, applied: kept, result };
  }
}

/**
 * Maps the fingerprints of a fix planned in a later round back to the findings of the first
 * scan: the same fingerprint when the first scan has it, else an unclaimed first-scan finding of
 * the same rule at the file's original path.
 */
function remapper(
  first: Scan,
  origins: () => ReadonlyMap<string, string>,
): (fix: PlannedFix, scan: Scan) => PlannedFix {
  const original = new Set(first.findings.map((finding) => finding.fingerprint));
  const claimed = new Set<string>();
  const pool = activeFindings(first);
  return (fix, scan) => {
    if (scan === first) return fix;
    const byFingerprint = new Map(scan.findings.map((finding) => [finding.fingerprint, finding]));
    const paths = origins();
    const findings = fix.findings.map((fingerprint) => {
      if (original.has(fingerprint)) return fingerprint;
      const finding = byFingerprint.get(fingerprint);
      if (finding === undefined) return fingerprint;
      const path = paths.get(finding.path) ?? finding.path;
      const match = pool.find(
        (candidate) =>
          candidate.ruleId === finding.ruleId &&
          candidate.path === path &&
          !claimed.has(candidate.fingerprint) &&
          !fix.findings.includes(candidate.fingerprint),
      );
      if (match === undefined) return fingerprint;
      claimed.add(match.fingerprint);
      return match.fingerprint;
    });
    return { ...fix, findings: [...new Set(findings)].sort(compareStrings) };
  };
}

/**
 * Plans, applies and verifies fixes in rounds on an in-memory copy of `snapshot`, as the module
 * comment describes, and returns the fixed copy with what happened to every selected fix.
 * `maxRounds` is between 1 and {@link MAX_ROUNDS}.
 */
export function fixRounds(
  snapshot: Snapshot,
  scanOptions: FixScanOptions,
  selection: FixSelection,
  maxRounds = MAX_ROUNDS,
): FixRun {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
    throw new RangeError(`maxRounds must be an integer from 1 to ${MAX_ROUNDS}.`);
  }
  const run = new Run(scanOptions, selection);
  const before = run.scan(snapshot);
  const origins = new Map<string, string>();
  const created = new Set<string>();
  const applied: { fix: PlannedFix; scan: Scan }[] = [];
  let current = snapshot;
  let scan = before;
  let rounds = 0;
  let last: Round | undefined;
  // The scan the last round that applied fixes started from, and that round's renames.
  let lastScan = before;
  let lastRenames: ReadonlyMap<string, string> = new Map();

  for (let round = 1; round <= maxRounds; round++) {
    last = runRound(run, current, scan, MAX_FIXES - applied.length);
    if (last.result === undefined) break;
    for (const fix of last.applied) applied.push({ fix, scan });
    trackChanges(last.applied, origins, created);
    lastScan = scan;
    lastRenames = renamesOf(last.applied);
    current = last.result.snapshot;
    scan = last.result.scan;
    rounds = round;
  }

  const remap = remapper(before, () => origins);
  const reported = new Map<string, PlannedFix>();
  const appliedOut = applied.map(({ fix, scan: at }) => {
    const out = remap(fix, at);
    reported.set(decisionKey(fix), out);
    return out;
  });
  const skipped = [...run.skipped.values()].map(({ fix, scan: at }) => remap(fix, at));
  const deferred: PlannedFix[] = [];
  const conflicts: Conflict[] = [];

  // What is left after the last round. When the rounds ran out, plan once more: a fix that lost
  // a conflict in the last round stays deferred; any other fix needed another round (`limit`).
  const exhausted = last?.result !== undefined;
  const final =
    last !== undefined && !exhausted
      ? last.plan
      : planFixes(analyze(current, run.options), scan, selection, {
          maxFixes: MAX_FIXES - applied.length,
          exclude: run.exclude,
        });
  const losers = new Map<string, Conflict>();
  if (exhausted && last !== undefined) {
    for (const conflict of last.plan.conflicts) {
      losers.set(placeKey(conflict.loser, lastScan, lastRenames), conflict);
    }
  }
  for (const fix of final.fixes) {
    if (fix.status === 'skipped') {
      const out = remap(fix, scan);
      reported.set(decisionKey(fix), out);
      if (out.reason === 'conflict') deferred.push(out);
      else skipped.push(out);
      continue;
    }
    const lost = losers.get(placeKey(fix, scan, new Map()));
    const out = remap(skip(fix, lost === undefined ? 'limit' : 'conflict'), scan);
    reported.set(decisionKey(fix), out);
    if (lost === undefined) {
      skipped.push(out);
      continue;
    }
    deferred.push(out);
    conflicts.push({
      ...lost,
      winner: reported.get(decisionKey(lost.winner)) ?? lost.winner,
      loser: out,
    });
  }
  for (const conflict of final.conflicts) {
    conflicts.push({
      ...conflict,
      winner: reported.get(decisionKey(conflict.winner)) ?? conflict.winner,
      loser: reported.get(decisionKey(conflict.loser)) ?? conflict.loser,
    });
  }

  const verification = compareScans(
    before,
    scan,
    new Map([...origins].map(([now, was]) => [was, now])),
    [],
  );
  return {
    snapshot: current,
    before,
    after: scan,
    files: fileDiffs(snapshot, current, origins, created),
    applied: appliedOut,
    skipped,
    deferred,
    conflicts,
    manual: final.manual,
    verification: {
      resolved: verification.resolved,
      remaining: verification.remaining,
      introduced: verification.introduced,
    },
    rounds,
  };
}

/** Identity of a decision within one plan: its rule, fix id and findings. */
function decisionKey(fix: PlannedFix): string {
  return `${fix.ruleId}\u0000${fix.fix.id}\u0000${fix.findings.join(',')}`;
}

/**
 * Identity of a fix across rounds, where offsets and fingerprints change: its rule, fix id and
 * the paths of its findings, mapped through `renames`.
 */
function placeKey(fix: PlannedFix, scan: Scan, renames: ReadonlyMap<string, string>): string {
  const paths = new Set<string>();
  for (const finding of scan.findings) {
    if (fix.findings.includes(finding.fingerprint)) {
      paths.add(renames.get(finding.path) ?? finding.path);
    }
  }
  return `${fix.ruleId}\u0000${fix.fix.id}\u0000${[...paths].sort(compareStrings).join('\u0000')}`;
}

function fileDiffs(
  original: Snapshot,
  current: Snapshot,
  origins: ReadonlyMap<string, string>,
  created: ReadonlySet<string>,
): FileDiff[] {
  const files = new Map(original.files.map((file) => [file.path, file]));
  const diffs: FileDiff[] = [];
  for (const file of current.files) {
    if (created.has(file.path)) {
      diffs.push({ path: file.path, op: 'create', after: file.bytes });
      continue;
    }
    const from = origins.get(file.path) ?? file.path;
    const old = files.get(from);
    if (old === undefined) continue;
    if (from !== file.path) {
      diffs.push({ path: file.path, op: 'rename', from, before: old.bytes, after: file.bytes });
    } else if (!sameBytes(old.bytes, file.bytes)) {
      diffs.push({ path: file.path, op: 'edit', before: old.bytes, after: file.bytes });
    }
  }
  return diffs.sort((a, b) => compareStrings(a.path, b.path));
}
