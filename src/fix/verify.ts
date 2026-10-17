/**
 * Verification rounds of `agentcheckup fix`: plan, apply in memory, scan the fixed copy again,
 * keep what verifies, and repeat, because one fix can enable another. Pure: works on snapshots
 * and returns data; nothing is written. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 *
 * A round:
 * 1. Plans the scan's fixes ({@link planFixes}).
 * 2. Judges each planned fix as if it were applied alone to the snapshot and the result scanned
 *    with root load plans. The fix passes when every finding it carries is gone, no new error,
 *    warning or rule failure appeared, and no `risk` finding it does not carry is gone: a fix
 *    that moves or rewrites text must never hide a payload, not even behind a suppression.
 *    Findings match by rule and path, mapped through renames, as a multiset: fingerprints change
 *    with the edits. Comparing the two scans with compareWithBaseline gives the fix's effects:
 *    startup token deltas per agent, and gate hits. A `safe` fix with a gate hit is demoted to
 *    `review`, and skipped when review fixes are not selected.
 * 3. Drops the fixes that failed and plans again, so a fix that lost a conflict to a failed one
 *    gets its turn.
 * 4. Applies the passing fixes together and verifies the combination. When fixes that pass
 *    alone fail together, they are added one at a time in plan order, keeping each that still
 *    verifies.
 *
 * Step 2 does not scan once per fix ({@link FixRoundsOptions.strategy}). The fixes are split into
 * groups whose footprints (the paths a fix changes, and the paths of the findings it carries) are
 * disjoint, and each group is applied and scanned once. What the group scan shows is attributed
 * to its fixes by footprint:
 * - findings on a fix's paths decide whether it passes, exactly as its own scan would;
 * - a change of an agent's startup total is split by the load-plan entries that changed, each
 *   owned by the fix whose footprint holds its path, real path or import chain; each fix gets
 *   the total its own scan would have: the original total plus its entries' change;
 * - a gate hit belongs to the fix whose footprint holds the item's file.
 * A group scan is used only when everything it shows can be attributed: no finding changed on a
 * path outside every footprint, no new rule failure, every changed startup entry and gate hit has
 * exactly one owner, and the plan totals are the sums of their entries. Otherwise the group is
 * halved and each half judged the same way, down to single fixes, which are scanned alone. A fix
 * that fails in a group is scanned alone to confirm it, and the rest of the group again without
 * it, so a fix is never dropped because of another one. This gives the decisions and effects of
 * scanning each fix alone as long as a fix changes findings, plans and the inventory only through
 * the files in its footprint, or visibly elsewhere; test/fix/verify-batch.test.ts compares both
 * strategies. A change that one fix causes only in another fix's files is credited to that other
 * fix: when that fix also undoes it, or it changes that fix's startup entries, the verdicts can
 * differ from the fixes' own scans. Step 4 still verifies every fix that is kept, together.
 *
 * Every scan shares one {@link ParseCache}, so a file is parsed again only when a fix changed it.
 *
 * Bounds: at most {@link MAX_ROUNDS} rounds, {@link MAX_FIXES} fixes per run and
 * {@link MAX_WRITTEN_FILE_BYTES} per written file. Fixes past a bound are skipped with `limit`.
 *
 * Cost: one full parse, then per round one scan per group (as many groups as the most fixes that
 * share a path) and one for the combination, more only when something cannot be attributed or a
 * fix fails.
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
import { createParseCache, type ParseCache } from '../core/parse-cache.js';
import type { Finding, Snapshot } from '../core/types.js';
import type { LoadEntry, LoadPlan } from '../platforms/load/types.js';
import { applyPlan, FixApplyError } from './apply.js';
import type {
  AwaitingInput,
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
 * working directory and matrix options do not apply. Without `parseCache`, the run makes its own.
 */
export type FixScanOptions = ScanOptions & Pick<ContextOptions, 'agents' | 'contextWindow'>;

/** How {@link fixRounds} judges the fixes of a round. */
export interface FixRoundsOptions {
  /**
   * - `batch` (default): in groups of fixes with disjoint footprints, one scan per group, as the
   *   module comment describes.
   * - `isolated`: one scan per fix. Slow on repositories with many fixes; the reference the
   *   batch strategy is tested against.
   */
  readonly strategy?: 'batch' | 'isolated';
}

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
  /**
   * Selected fixes that need the user's words, as the scan of the input has them: never applied
   * here. `agentcheckup fix -i` completes them against the input (src/fix/input.ts).
   */
  readonly awaitingInput: readonly AwaitingInput[];
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

export interface ScanComparison {
  /**
   * Every finding the fixes carry is gone, no error, warning or rule failure is new, and no
   * `risk` finding the fixes do not carry is gone.
   */
  readonly ok: boolean;
  readonly introduced: readonly Finding[];
  readonly resolved: number;
  readonly remaining: number;
}

/**
 * Compares two scans by rule and path (mapped through `renames`) as a multiset. `claimed` are
 * the fixes whose findings must be gone; findings of `risk` rules they do not carry must stay.
 */
export function compareScans(
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
  // A risk finding may go only when a fix claims it: gone or newly suppressed counts as lost.
  const risks = new Map<string, number>();
  for (const finding of previous) {
    if (finding.category === 'risk') {
      increment(risks, keyOf(finding.ruleId, renames.get(finding.path) ?? finding.path));
    }
  }
  for (const [key, was] of risks) {
    if ((counts.get(key) ?? 0) < was + (expected.get(key) ?? 0)) ok = false;
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

type GateEffect = Extract<FixEffect, { kind: 'gate' }>;

/** compareWithBaseline of `after` against `before`, with every gate class. */
function planDiff(before: Scan, after: Scan) {
  return compareWithBaseline(after, before, { gate: GATE_CLASSES }).diff;
}

/** The gate hits of a comparison, as effects. */
function gateEffects(diff: ReturnType<typeof planDiff>): GateEffect[] {
  return diff.gate.hits.map((hit) => ({
    kind: 'gate',
    class: hit.class,
    id: hit.id,
    change: hit.change,
    summary: hit.summary,
  }));
}

/** Token deltas and gate hits of `after` against `before`. */
function effectsOf(before: Scan, after: Scan): FixEffect[] {
  const diff = planDiff(before, after);
  const effects: FixEffect[] = [];
  for (const delta of diff.context) {
    const { before: old, after: now } = delta.startupTokens;
    if (old !== now) {
      effects.push({ kind: 'tokens', agent: delta.agent, cwd: delta.cwd, before: old, after: now });
    }
  }
  effects.push(...gateEffects(diff));
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

/** `fixes` applied to a snapshot: the result, or why they could not apply, and its scan. */
interface Trial {
  /** Undefined when the fixes cannot apply; `limit` when they write a file too large. */
  readonly next: Snapshot | 'limit' | undefined;
  readonly scan?: Scan;
}

// ---------------------------------------------------------------------------------------------
// Attribution of a group scan
// ---------------------------------------------------------------------------------------------

/** What a group scan says about one of its fixes: what its own scan would say. */
interface Verdict {
  readonly verified: boolean;
  readonly effects: readonly FixEffect[];
}

/** The paths a fix changes, and the paths of the findings it carries in `scan`. */
function footprintOf(planned: PlannedFix, scan: Scan): Set<string> {
  const paths = new Set<string>();
  for (const change of planned.fix.changes) {
    if (change.kind === 'rename') {
      paths.add(change.from);
      paths.add(change.to);
    } else {
      paths.add(change.path);
    }
  }
  const carried = new Set(planned.findings);
  for (const finding of scan.findings)
    if (carried.has(finding.fingerprint)) paths.add(finding.path);
  return paths;
}

/** Fixes in plan order, split into groups whose footprints are disjoint: first fit. */
function disjointGroups(
  fixes: readonly PlannedFix[],
  footprints: ReadonlyMap<PlannedFix, ReadonlySet<string>>,
): PlannedFix[][] {
  const groups: { readonly fixes: PlannedFix[]; readonly used: Set<string> }[] = [];
  for (const planned of fixes) {
    const paths = [...(footprints.get(planned) ?? [])];
    let group = groups.find((candidate) => !paths.some((path) => candidate.used.has(path)));
    if (group === undefined) {
      group = { fixes: [], used: new Set() };
      groups.push(group);
    }
    group.fixes.push(planned);
    for (const path of paths) group.used.add(path);
  }
  return groups.map((group) => group.fixes);
}

/** The estimate load plans use: `Math.ceil(chars / 4)` (Size in src/platforms/load/types.ts). */
const tokensOf = (chars: number): number => Math.ceil(chars / 4);

/**
 * What an entry adds to its plan's startup total: its size when it loads at startup, and for
 * Cursor also a skill's listing, which is in the prompt while the body waits for the model
 * (src/platforms/load/cursor.ts). {@link startupShares} checks the sum against the total.
 */
function startupChars(plan: LoadPlan, entry: LoadEntry): number {
  if (entry.size === undefined) return 0;
  if (entry.trigger === 'startup') return entry.size.chars;
  const listed = plan.agent === 'cursor' && entry.role === 'skill';
  return listed && entry.trigger === 'model-selected' ? entry.size.chars : 0;
}

/** True when the plan's startup total is the sum of its entries, as {@link startupChars} counts. */
function decomposes(plan: LoadPlan): boolean {
  const { chars, tokens } = plan.totals.startup;
  const sum = plan.entries.reduce((total, entry) => total + startupChars(plan, entry), 0);
  return sum === chars && tokens === tokensOf(chars);
}

/**
 * Per fix, the change of the plan's startup characters its own scan would show: the change of
 * the entries it owns. Undefined when an entry that changed has no owner or several, or when a
 * total is not the sum of its entries.
 */
function startupShares(
  before: LoadPlan,
  after: LoadPlan,
  owners: (paths: readonly string[]) => readonly PlannedFix[],
): Map<PlannedFix, number> | undefined {
  interface Share {
    readonly chars: number;
    readonly owners: readonly PlannedFix[];
  }
  const sharesOf = (plan: LoadPlan): Map<string, Share> => {
    const map = new Map<string, Share>();
    for (const entry of plan.entries) {
      const chars = startupChars(plan, entry);
      if (chars === 0 || map.has(entry.id)) continue;
      map.set(entry.id, {
        chars,
        owners: owners([entry.path, entry.realPath, ...(entry.via ?? [])]),
      });
    }
    return map;
  };
  const old = sharesOf(before);
  const now = sharesOf(after);
  const shares = new Map<PlannedFix, number>();
  const add = (share: Share, sign: number): boolean => {
    const [owner, ...others] = share.owners;
    if (owner === undefined || others.length > 0) return false;
    shares.set(owner, (shares.get(owner) ?? 0) + sign * share.chars);
    return true;
  };
  const same = (a: Share, b: Share): boolean =>
    a.chars === b.chars &&
    a.owners.length === b.owners.length &&
    a.owners.every((owner, index) => b.owners[index] === owner);
  let changed = false;
  for (const id of new Set([...old.keys(), ...now.keys()])) {
    const was = old.get(id);
    const is = now.get(id);
    if (was !== undefined && is !== undefined && same(was, is)) continue;
    changed = true;
    if (was !== undefined && !add(was, -1)) return undefined;
    if (is !== undefined && !add(is, 1)) return undefined;
  }
  if (!changed && before.totals.startup.chars === after.totals.startup.chars) return shares;
  return decomposes(before) && decomposes(after) ? shares : undefined;
}

/** Path → the fix whose footprint holds it. Undefined when two footprints share a path. */
function ownership(
  members: readonly PlannedFix[],
  footprints: ReadonlyMap<PlannedFix, ReadonlySet<string>>,
): Map<string, PlannedFix> | undefined {
  const owner = new Map<string, PlannedFix>();
  for (const member of members) {
    for (const path of footprints.get(member) ?? []) {
      if (owner.has(path)) return undefined;
      owner.set(path, member);
    }
  }
  return owner;
}

/** A finding as the attribution compares it on a path no fix touches. */
const findingText = (finding: Finding): string =>
  [
    finding.ruleId,
    finding.path,
    finding.severity,
    finding.fingerprint,
    finding.message,
    finding.suppressed === undefined ? '' : 'suppressed',
  ].join('\u0000');

/** The file of a gate hit's item, or of the finding behind a `unicode` hit, in `after`. */
function gatePaths(after: Scan): (effect: GateEffect) => string | undefined {
  const files = new Map<string, string>();
  const { inventory } = after;
  for (const item of [
    ...inventory.mcpServers,
    ...inventory.hooks,
    ...inventory.permissions,
    ...inventory.env,
  ]) {
    if (!files.has(item.id)) files.set(item.id, item.file);
  }
  const incomplete = new Set(inventory.incomplete);
  const findings = new Map(after.findings.map((finding) => [finding.fingerprint, finding.path]));
  return (effect) => {
    if (effect.class === 'unicode') return findings.get(effect.id);
    const file = files.get(effect.id);
    if (file !== undefined) return file;
    if (!incomplete.has(effect.id)) return undefined;
    const colon = effect.id.startsWith('invalid-json:') ? effect.id.indexOf(':') : -1;
    return effect.id.slice(colon + 1);
  };
}

/**
 * The verdict on each fix of a group from the group's scan, as the module comment describes, or
 * undefined when the scan shows something that cannot be attributed to exactly one fix.
 */
function attribute(
  before: Scan,
  after: Scan,
  members: readonly PlannedFix[],
  footprints: ReadonlyMap<PlannedFix, ReadonlySet<string>>,
): Map<PlannedFix, Verdict> | undefined {
  const failedBefore = new Set(before.ruleFailures.map((failure) => failure.ruleId));
  if (after.ruleFailures.some((failure) => !failedBefore.has(failure.ruleId))) return undefined;
  const owner = ownership(members, footprints);
  if (owner === undefined) return undefined;
  const owners = (paths: readonly string[]): PlannedFix[] => {
    const found = new Set<PlannedFix>();
    for (const path of paths) {
      const member = owner.get(path);
      if (member !== undefined) found.add(member);
    }
    return members.filter((member) => found.has(member));
  };

  // Findings: none may change on a path outside every footprint.
  const outside = (scan: Scan): string[] =>
    scan.findings
      .filter((finding) => !owner.has(finding.path))
      .map(findingText)
      .sort(compareStrings);
  const [was, is] = [outside(before), outside(after)];
  if (was.length !== is.length || was.some((text, index) => is[index] !== text)) return undefined;

  // Startup totals, split by the entries each fix owns.
  const tokens = new Map<PlannedFix, FixEffect[]>();
  const plans = new Map(
    before.context.plans.map((plan) => [`${plan.agent}\u0000${plan.cwd}`, plan]),
  );
  const diff = planDiff(before, after);
  for (const delta of diff.context) {
    const old = plans.get(`${delta.agent}\u0000${delta.cwd}`);
    const now = after.context.plans.find(
      (plan) => plan.agent === delta.agent && plan.cwd === delta.cwd,
    );
    if (old === undefined || now === undefined) return undefined;
    const shares = startupShares(old, now, owners);
    if (shares === undefined) return undefined;
    const { chars, tokens: total } = old.totals.startup;
    for (const member of members) {
      const share = shares.get(member);
      if (share === undefined) continue;
      const own = tokensOf(chars + share);
      if (own === total) continue;
      const list = tokens.get(member) ?? [];
      list.push({ kind: 'tokens', agent: delta.agent, cwd: delta.cwd, before: total, after: own });
      tokens.set(member, list);
    }
  }

  // Gate hits, by the file of the item.
  const gates = new Map<PlannedFix, FixEffect[]>();
  const pathOf = gatePaths(after);
  for (const effect of gateEffects(diff)) {
    const path = pathOf(effect);
    const [member, ...others] = path === undefined ? [] : owners([path]);
    if (member === undefined || others.length > 0) return undefined;
    const list = gates.get(member) ?? [];
    list.push(effect);
    gates.set(member, list);
  }

  const verdicts = new Map<PlannedFix, Verdict>();
  for (const member of members) {
    const paths = footprints.get(member) ?? new Set<string>();
    const within = (scan: Scan): Pick<Scan, 'findings' | 'ruleFailures'> => ({
      findings: scan.findings.filter((finding) => paths.has(finding.path)),
      ruleFailures: [],
    });
    verdicts.set(member, {
      verified: compareScans(within(before), within(after), renamesOf([member]), [member]).ok,
      effects: [...(tokens.get(member) ?? []), ...(gates.get(member) ?? [])],
    });
  }
  return verdicts;
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

/** Everything one run shares between rounds. */
class Run {
  readonly options: ScanOptions & ContextOptions & { readonly parseCache: ParseCache };
  readonly selection: FixSelection;
  readonly strategy: NonNullable<FixRoundsOptions['strategy']>;
  readonly skipped = new Map<string, { fix: PlannedFix; scan: Scan }>();
  /** `${fix.id}\0${fingerprint}` of fixes that failed: not planned again for those findings. */
  readonly failed = new Set<string>();
  /** Fixes applied to a snapshot and scanned, by the snapshot and the fixes' keys. */
  readonly #trials = new WeakMap<Snapshot, Map<string, Trial>>();

  constructor(options: FixScanOptions, selection: FixSelection, settings: FixRoundsOptions) {
    this.options = {
      ...options,
      cwd: '',
      matrix: false,
      parseCache: options.parseCache ?? createParseCache(),
    };
    this.selection = selection;
    this.strategy = settings.strategy ?? 'batch';
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

  /**
   * Applies `fixes` to `current` and scans the result, once per snapshot and set of fixes: a
   * group whose fixes all pass is the combination the round verifies next.
   */
  trial(current: Snapshot, fixes: readonly PlannedFix[]): Trial {
    let trials = this.#trials.get(current);
    if (trials === undefined) {
      trials = new Map();
      this.#trials.set(current, trials);
    }
    // By content: verification may have demoted a fix's class, which applying ignores.
    const key = fixes
      .map((fix) => fixKey(fix.ruleId, { ...fix.fix, class: 'safe' }))
      .sort(compareStrings)
      .join('\u0001');
    const known = trials.get(key);
    if (known !== undefined) return known;
    let trial: Trial;
    try {
      const next = applyPlan(current, { fixes });
      trial = oversized(current, next) ? { next: 'limit' } : { next, scan: this.scan(next) };
    } catch (error) {
      if (!(error instanceof FixApplyError)) throw error;
      trial = { next: undefined };
    }
    trials.set(key, trial);
    return trial;
  }

  /** The evaluation of a fix whose verification and effects are known. */
  judge(candidate: PlannedFix, verdict: Verdict): Evaluation {
    if (!verdict.verified) return { ok: false, fix: skip(candidate, 'verification-failed') };
    const { effects } = verdict;
    const gated = effects.some((effect) => effect.kind === 'gate');
    const fix =
      gated && candidate.fix.class === 'safe'
        ? { ...candidate.fix, class: 'review' as const }
        : candidate.fix;
    const planned: PlannedFix = { ...candidate, fix, effects: [...effects] };
    if (!this.selection.classes.has(fix.class)) {
      return { ok: false, fix: skip(planned, 'verification-failed') };
    }
    return { ok: true, fix: planned };
  }

  /** One fix alone: verification, effects, gate demotion. */
  evaluate(current: Snapshot, scan: Scan, candidate: PlannedFix): Evaluation {
    const { next, scan: after } = this.trial(current, [candidate]);
    if (next === 'limit') return { ok: false, fix: skip(candidate, 'limit') };
    if (next === undefined || after === undefined) {
      return { ok: false, fix: skip(candidate, 'verification-failed') };
    }
    const verified = compareScans(scan, after, renamesOf([candidate]), [candidate]).ok;
    return this.judge(candidate, {
      verified,
      effects: verified ? effectsOf(scan, after) : [],
    });
  }

  /** Every candidate of a round, by fix key, judged with the run's strategy. */
  evaluateAll(
    current: Snapshot,
    scan: Scan,
    candidates: readonly PlannedFix[],
  ): Map<string, Evaluation> {
    const out = new Map<string, Evaluation>();
    if (this.strategy === 'isolated') {
      for (const candidate of candidates) {
        out.set(fixKey(candidate.ruleId, candidate.fix), this.evaluate(current, scan, candidate));
      }
      return out;
    }
    const footprints = new Map(
      candidates.map((candidate) => [candidate, footprintOf(candidate, scan)] as const),
    );
    for (const group of disjointGroups(candidates, footprints)) {
      this.evaluateGroup(current, scan, group, footprints, out);
    }
    return out;
  }

  /**
   * Fixes with disjoint footprints, judged from one scan when it can be attributed; otherwise
   * in halves, down to single fixes. Fixes that fail are scanned alone, and the rest again.
   */
  evaluateGroup(
    current: Snapshot,
    scan: Scan,
    members: readonly PlannedFix[],
    footprints: ReadonlyMap<PlannedFix, ReadonlySet<string>>,
    out: Map<string, Evaluation>,
  ): void {
    const [only] = members;
    if (only === undefined) return;
    if (members.length === 1) {
      out.set(fixKey(only.ruleId, only.fix), this.evaluate(current, scan, only));
      return;
    }
    const { scan: after } = this.trial(current, members);
    const verdicts = after === undefined ? undefined : attribute(scan, after, members, footprints);
    if (verdicts === undefined) {
      const half = Math.ceil(members.length / 2);
      this.evaluateGroup(current, scan, members.slice(0, half), footprints, out);
      this.evaluateGroup(current, scan, members.slice(half), footprints, out);
      return;
    }
    const failing = members.filter((member) => verdicts.get(member)?.verified !== true);
    if (failing.length > 0) {
      for (const member of failing) {
        out.set(fixKey(member.ruleId, member.fix), this.evaluate(current, scan, member));
      }
      const rest = members.filter((member) => !failing.includes(member));
      this.evaluateGroup(current, scan, rest, footprints, out);
      return;
    }
    for (const member of members) {
      const verdict = verdicts.get(member);
      if (verdict !== undefined)
        out.set(fixKey(member.ruleId, member.fix), this.judge(member, verdict));
    }
  }

  /**
   * `fixes` applied together: verified, and with no gate hit that none of them had alone.
   * Undefined when the combination fails.
   */
  combine(current: Snapshot, scan: Scan, fixes: readonly PlannedFix[]): Applied | undefined {
    const { next, scan: after } = this.trial(current, fixes);
    if (next === undefined || next === 'limit' || after === undefined) return undefined;
    if (!compareScans(scan, after, renamesOf(fixes), fixes).ok) return undefined;
    const known = new Set(
      fixes.flatMap((fix) =>
        fix.effects.flatMap((effect) => (effect.kind === 'gate' ? [gateKey(effect)] : [])),
      ),
    );
    const unexplained = gateEffects(planDiff(scan, after)).some(
      (effect) => !known.has(gateKey(effect)),
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

    const fresh = candidates.filter(
      (candidate) => !evaluations.has(fixKey(candidate.ruleId, candidate.fix)),
    );
    for (const [key, evaluation] of run.evaluateAll(current, scan, fresh)) {
      evaluations.set(key, evaluation);
    }
    let failed = false;
    const passing: PlannedFix[] = [];
    for (const candidate of candidates) {
      const evaluation = evaluations.get(fixKey(candidate.ruleId, candidate.fix));
      if (evaluation === undefined) throw new Error(`${candidate.fix.id} was not evaluated.`);
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
  options: FixRoundsOptions = {},
): FixRun {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
    throw new RangeError(`maxRounds must be an integer from 1 to ${MAX_ROUNDS}.`);
  }
  const run = new Run(scanOptions, selection, options);
  const before = run.scan(snapshot);
  const origins = new Map<string, string>();
  const created = new Set<string>();
  const applied: { fix: PlannedFix; scan: Scan }[] = [];
  let current = snapshot;
  let scan = before;
  let rounds = 0;
  let last: Round | undefined;
  let awaitingInput: readonly AwaitingInput[] = [];
  // The scan the last round that applied fixes started from, and that round's renames.
  let lastScan = before;
  let lastRenames: ReadonlyMap<string, string> = new Map();

  for (let round = 1; round <= maxRounds; round++) {
    last = runRound(run, current, scan, MAX_FIXES - applied.length);
    // Input is asked about the files as they are, before any fix.
    if (round === 1) awaitingInput = last.plan.awaitingInput;
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
    awaitingInput,
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
