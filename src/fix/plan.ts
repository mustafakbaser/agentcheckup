/**
 * The fix planner: which of a scan's fixes to apply in one round, in a fixed order, and which to
 * leave out and why. Pure and deterministic: the plan depends on the scan, never on the order of
 * its findings. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 */
import { compareStrings } from '../core/compare.js';
import type { Analysis, RuleResult } from '../core/engine.js';
import type { Finding, Fix, Severity } from '../core/types.js';
import {
  type CompiledFix,
  compileFix,
  conflictBetween,
  conflictKeys,
  createWorkspace,
} from './compile.js';
import type {
  Conflict,
  FixPlan,
  FixSelection,
  FixSkipReason,
  ManualStep,
  PlannedFix,
} from './index.js';

/** Most fixes one run applies (ADR 0008). */
export const MAX_FIXES = 1000;

/** The rule whose fixes apply only when the user opts in (FixSelection.literalSecret). */
export const LITERAL_SECRET_RULE = 'mcp/literal-secret';

/** A fix the planner considers: one rule's fix and the findings that carry it. */
export interface FixCandidate {
  readonly ruleId: string;
  readonly fix: Fix;
  /** Unsuppressed findings that carry this exact fix. */
  readonly findings: readonly Finding[];
}

export interface PlanOptions {
  /**
   * Most fixes to plan; selected fixes past it are skipped with reason `limit`, lowest priority
   * first. Default {@link MAX_FIXES}.
   */
  readonly maxFixes?: number;
  /**
   * Leaves a candidate out of the plan, as if it was not selected: verification uses this for
   * fixes that failed in an earlier round. Its findings can still give manual steps.
   */
  readonly exclude?: (candidate: FixCandidate) => boolean;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 2, warn: 1, info: 0 };

/** JSON with object keys sorted, so equal fixes give equal text whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Identity of a fix: equal for the same rule's fixes with the same content. */
export function fixKey(ruleId: string, fix: Fix): string {
  return `${ruleId}\u0000${stableJson(fix)}`;
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    compareStrings(a.path, b.path) ||
    a.range.start.line - b.range.start.line ||
    a.range.start.column - b.range.start.column ||
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.message, b.message) ||
    compareStrings(a.fingerprint, b.fingerprint)
  );
}

interface Group extends FixCandidate {
  readonly key: string;
  readonly findings: Finding[];
}

interface Compiled {
  readonly group: Group;
  readonly compiled: CompiledFix;
  /** The group's first finding in report order. */
  readonly first: Finding;
  readonly severity: number;
}

/** Report order: the position of the first finding, then the rule and the fix. */
function compareGroups(a: Group, b: Group): number {
  const [left, right] = [a.findings[0], b.findings[0]];
  if (left === undefined || right === undefined) return 0;
  return (
    compareFindings(left, right) ||
    compareStrings(a.fix.id, b.fix.id) ||
    compareStrings(a.key, b.key)
  );
}

/**
 * Priority when fixes conflict: `safe` before `review`, then the higher severity, then the lower
 * rule id, then the earlier position (path, line, column), then the fix id.
 */
function comparePriority(a: Compiled, b: Compiled): number {
  return (
    Number(a.group.fix.class === 'review') - Number(b.group.fix.class === 'review') ||
    b.severity - a.severity ||
    compareStrings(a.group.ruleId, b.group.ruleId) ||
    compareFindings(a.first, b.first) ||
    compareStrings(a.group.fix.id, b.group.fix.id) ||
    compareStrings(a.group.key, b.group.key)
  );
}

function decision(group: Group): Omit<PlannedFix, 'status' | 'reason'> {
  return {
    fix: group.fix,
    ruleId: group.ruleId,
    findings: group.findings.map((finding) => finding.fingerprint).sort(compareStrings),
    effects: [],
  };
}

function skippedFix(group: Group, reason: FixSkipReason): PlannedFix {
  return { ...decision(group), status: 'skipped', reason };
}

function manualKey(step: ManualStep): string {
  return `${step.path}\u0000${step.line}\u0000${step.ruleId}\u0000${step.guidance}`;
}

/** The finding as a manual step, when it has guidance or `guidance` replaces it. */
function manualStep(finding: Finding, guidance = finding.guidance): ManualStep | undefined {
  if (guidance === undefined || guidance.trim() === '') return undefined;
  return {
    ruleId: finding.ruleId,
    path: finding.path,
    line: finding.range.start.line,
    guidance,
  };
}

/**
 * Plans one round of fixes for a scan of `analysis`' snapshot:
 * 1. Takes the unsuppressed findings that carry a fix, of the selected classes and rules;
 *    mcp/literal-secret only with `selection.literalSecret`. Findings with the same rule and an
 *    identical fix merge into one planned fix.
 * 2. Compiles each fix against the snapshot. A fix that names a path that is not normalized,
 *    a file reached through a symlink, a file that does not decode cleanly, or a create or
 *    rename target that exists, is skipped with `refused-path` and becomes a manual step. A fix
 *    whose edits do not fit the file is skipped with `verification-failed`.
 * 3. Accepts fixes in priority order ({@link comparePriority}). A fix that overlaps an accepted
 *    one (see {@link Conflict}) is skipped with `conflict`; identical edits are not conflicts.
 *    Past `maxFixes`, fixes are skipped with `limit`.
 * 4. Lists manual steps: findings in the selected rules with `guidance` and no selected fix.
 *
 * Fixes are listed in report order of their first finding; conflicts and manual steps by path.
 */
export function planFixes(
  analysis: Analysis,
  result: Pick<RuleResult, 'findings'>,
  selection: FixSelection,
  options: PlanOptions = {},
): FixPlan {
  const maxFixes = options.maxFixes ?? MAX_FIXES;
  const inRules = (ruleId: string): boolean =>
    selection.ruleIds === undefined || selection.ruleIds.has(ruleId);

  const groups = new Map<string, Group>();
  const manual = new Map<string, ManualStep>();
  const addManual = (step: ManualStep | undefined): void => {
    if (step !== undefined) manual.set(manualKey(step), step);
  };

  const findings = result.findings.filter((finding) => finding.suppressed === undefined);
  for (const finding of [...findings].sort(compareFindings)) {
    if (!inRules(finding.ruleId)) continue;
    const { fix } = finding;
    const selected =
      fix !== undefined &&
      selection.classes.has(fix.class) &&
      (finding.ruleId !== LITERAL_SECRET_RULE || selection.literalSecret);
    if (!selected) {
      addManual(manualStep(finding));
      continue;
    }
    const key = fixKey(finding.ruleId, fix);
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, { key, ruleId: finding.ruleId, fix, findings: [finding] });
    else group.findings.push(finding);
  }

  const workspace = createWorkspace(analysis.snapshot, (path) => {
    const artifact = analysis.index.get(path);
    return artifact?.path === path ? artifact.decoded : undefined;
  });
  const decided = new Map<Group, PlannedFix>();
  const candidates: Compiled[] = [];
  for (const group of [...groups.values()].sort(compareGroups)) {
    if (options.exclude?.(group) === true) {
      for (const finding of group.findings) addManual(manualStep(finding));
      continue;
    }
    const outcome = compileFix(group.fix, workspace);
    if (!outcome.ok) {
      if (outcome.kind === 'refused-path') {
        decided.set(group, skippedFix(group, 'refused-path'));
        for (const finding of group.findings) {
          addManual(manualStep(finding, finding.guidance ?? outcome.guidance));
        }
      } else {
        decided.set(group, skippedFix(group, 'verification-failed'));
        for (const finding of group.findings) addManual(manualStep(finding));
      }
      continue;
    }
    const first = group.findings[0];
    if (first === undefined) continue;
    candidates.push({
      group,
      compiled: outcome.compiled,
      first,
      severity: Math.max(...group.findings.map((finding) => SEVERITY_RANK[finding.severity])),
    });
  }

  interface Accepted {
    readonly index: number;
    readonly candidate: Compiled;
    readonly planned: PlannedFix;
  }
  // Accepted fixes by the files and targets they touch: only those can conflict.
  const touching = new Map<string, Accepted[]>();
  let acceptedCount = 0;
  const conflicts: Conflict[] = [];
  for (const candidate of [...candidates].sort(comparePriority)) {
    if (acceptedCount >= maxFixes) {
      decided.set(candidate.group, skippedFix(candidate.group, 'limit'));
      continue;
    }
    const keys = conflictKeys(candidate.compiled);
    const related = [...new Set(keys.flatMap((key) => touching.get(key) ?? []))].sort(
      (a, b) => a.index - b.index,
    );
    let lost = false;
    for (const winner of related) {
      const conflict = conflictBetween(candidate.compiled, winner.candidate.compiled);
      if (conflict === undefined) continue;
      const loser = skippedFix(candidate.group, 'conflict');
      conflicts.push({ kind: conflict.kind, path: conflict.path, winner: winner.planned, loser });
      decided.set(candidate.group, loser);
      lost = true;
      break;
    }
    if (lost) continue;
    const planned: PlannedFix = { ...decision(candidate.group), status: 'planned' };
    const entry: Accepted = { index: acceptedCount++, candidate, planned };
    for (const key of new Set(keys)) {
      const list = touching.get(key);
      if (list === undefined) touching.set(key, [entry]);
      else list.push(entry);
    }
    decided.set(candidate.group, planned);
  }

  const ordered = [...decided.keys()]
    .sort(compareGroups)
    .map((group) => decided.get(group))
    .filter((planned): planned is PlannedFix => planned !== undefined);
  const order = new Map(ordered.map((planned, index) => [planned, index]));
  conflicts.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.kind, b.kind) ||
      (order.get(a.loser) ?? 0) - (order.get(b.loser) ?? 0),
  );
  return { fixes: ordered, conflicts, manual: sortedSteps(manual.values()) };
}

/** Manual steps by path, line, rule and guidance. */
function sortedSteps(steps: Iterable<ManualStep>): ManualStep[] {
  return [...steps].sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      a.line - b.line ||
      compareStrings(a.ruleId, b.ruleId) ||
      compareStrings(a.guidance, b.guidance),
  );
}

/**
 * What a scan leaves to the user when no more fixes are applied, as after `fix -i` wrote the
 * accepted fixes: the manual steps {@link planFixes} lists for the selection, and a step for each
 * finding whose fix stays unapplied: its `guidance` or, without one, the step `fallback` names
 * (`-i` names the title of a fix the user declined). Findings without either are left out. Sorted
 * as {@link planFixes} sorts manual steps.
 */
export function leftSteps(
  analysis: Analysis,
  result: Pick<RuleResult, 'findings'>,
  selection: FixSelection,
  fallback: (finding: Finding) => string | undefined,
): ManualStep[] {
  const plan = planFixes(analysis, result, selection);
  const steps = new Map(plan.manual.map((step) => [manualKey(step), step]));
  const byFingerprint = new Map(result.findings.map((finding) => [finding.fingerprint, finding]));
  for (const planned of plan.fixes) {
    // planFixes already gave these findings their steps, with the reason a path was refused.
    if (planned.reason === 'refused-path' || planned.reason === 'verification-failed') continue;
    for (const fingerprint of planned.findings) {
      const finding = byFingerprint.get(fingerprint);
      if (finding === undefined) continue;
      const step = manualStep(finding, finding.guidance ?? fallback(finding));
      if (step !== undefined) steps.set(manualKey(step), step);
    }
  }
  return sortedSteps(steps.values());
}
