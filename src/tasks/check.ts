/**
 * `agentcheckup tasks --check [ids…]`. Pure: no I/O.
 *
 * Without ids, every task of a new scan is open. With ids, a task is open while an unsuppressed
 * finding of its rule is in its file, or an error or warning of one of its guard rules is. Ids
 * are hashes, so each id is matched against the (rule, file) pairs of the new scan: the findings'
 * own pairs, and for each guard finding, the pair of every rule that it guards.
 */
import { compareStrings } from '../core/compare.js';
import type { Severity } from '../core/types.js';
import { groupFindings, type TaskScan, taskGroups, taskId } from './build.js';
import { guardRulesOf } from './templates.js';

export interface OpenReason {
  /** `finding`: the task's own rule. `guard`: one of its guard rules. */
  readonly kind: 'finding' | 'guard';
  readonly ruleId: string;
  readonly severity: Severity;
  /** Relative to the scanned directory. */
  readonly path: string;
  readonly line: number;
}

export interface TaskStatus {
  readonly id: string;
  /** Why the task is open, in report order; empty when it is done. */
  readonly open: readonly OpenReason[];
  /**
   * True when the id is not the task of any rule that ran and any file of the scan: its file was
   * deleted or renamed, or the id belongs to another repository or was mistyped. Ids are hashes,
   * so a scan cannot tell these apart; with no finding to keep it open, the task counts as done.
   */
  readonly notFound?: true;
}

/** The open tasks of a scan, as {@link buildTasks} orders paths: each with its first finding. */
export function openTasks(scan: TaskScan): TaskStatus[] {
  return taskGroups(scan)
    .sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.ruleId, b.ruleId))
    .map((group) => {
      const [first] = group.findings;
      return {
        id: taskId(group.ruleId, group.path),
        open:
          first === undefined
            ? []
            : [
                {
                  kind: 'finding',
                  ruleId: group.ruleId,
                  severity: first.severity,
                  path: group.path,
                  line: first.range.start.line,
                },
              ],
      };
    });
}

/** The status of each id in `ids`, in that order, without repeats. */
export function checkTasks(scan: TaskScan, ids: readonly string[]): TaskStatus[] {
  const wanted = new Map<string, OpenReason[]>(ids.map((id) => [id, []]));
  for (const group of groupFindings(scan.findings)) {
    const reasons = wanted.get(taskId(group.ruleId, group.path));
    const [first] = group.findings;
    if (reasons === undefined || first === undefined) continue;
    reasons.push({
      kind: 'finding',
      ruleId: group.ruleId,
      severity: first.severity,
      path: group.path,
      line: first.range.start.line,
    });
  }

  // Each guard rule, with the rules whose tasks it guards.
  const guarded = new Map<string, string[]>();
  for (const meta of scan.rules) {
    for (const guard of guardRulesOf(meta.id)) {
      const rules = guarded.get(guard) ?? [];
      rules.push(meta.id);
      guarded.set(guard, rules);
    }
  }
  for (const finding of scan.findings) {
    if (finding.suppressed !== undefined || finding.severity === 'info') continue;
    for (const ruleId of guarded.get(finding.ruleId) ?? []) {
      // A finding of the task's own rule is already a reason.
      if (ruleId === finding.ruleId) continue;
      wanted.get(taskId(ruleId, finding.path))?.push({
        kind: 'guard',
        ruleId: finding.ruleId,
        severity: finding.severity,
        path: finding.path,
        line: finding.range.start.line,
      });
    }
  }
  const unmatched = [...wanted].filter(([, open]) => open.length === 0).map(([id]) => id);
  const known = knownIds(scan, new Set(unmatched));
  return [...wanted].map(([id, open]) =>
    open.length > 0 || known.has(id) ? { id, open } : { id, open, notFound: true },
  );
}

/**
 * Which of `ids` are the task of a rule that ran and a file of the scan, for each file the rules
 * that apply to its kind; a finding's own rule and file always count.
 */
function knownIds(scan: TaskScan, ids: ReadonlySet<string>): Set<string> {
  const known = new Set<string>();
  if (ids.size === 0) return known;
  const consider = (ruleId: string, path: string): void => {
    const id = taskId(ruleId, path);
    if (ids.has(id)) known.add(id);
  };
  for (const finding of scan.findings) consider(finding.ruleId, finding.path);
  for (const [path, artifact] of scan.analysis.index) {
    for (const meta of scan.rules) {
      if (meta.appliesTo.includes(artifact.kind)) consider(meta.id, path);
    }
    if (known.size === ids.size) break;
  }
  return known;
}
