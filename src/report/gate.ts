/**
 * Baseline comparisons as reviewers see them, shared by the formatters so all of them count
 * the same.
 *
 * Gate hits: one row per changed item, labeled. An unpinned MCP server added with
 * `--gate mcp,mcp-unpinned` trips two classes; it is still one change to review.
 *
 * New rules: findings of rules newer than the baseline's rule set are new, but the baseline
 * could not have reported them. Formatters label them "new rule" so they are not mistaken for
 * regressions.
 */
import type { BaselineDiff, GateClass, GateHit } from '../core/baseline-types.js';
import type { ScanResult } from '../core/engine.js';
import type { Finding } from '../core/types.js';
import { toJsonBaseline } from './json.js';

const CHANGE_LABELS: Readonly<Record<GateClass, Readonly<Record<GateHit['change'], string>>>> = {
  mcp: { added: 'New MCP server', changed: 'MCP server changed' },
  'mcp-unpinned': { added: 'New unpinned MCP server', changed: 'MCP server changed, not pinned' },
  permissions: { added: 'Permission widened', changed: 'Permission changed' },
  hooks: { added: 'New hook', changed: 'Hook changed' },
  env: { added: 'Env override', changed: 'Env override changed' },
  unicode: { added: 'Hidden Unicode', changed: 'Hidden Unicode' },
};

/** A permission mode trips the gate whenever it is set or changed: it may narrow, too. */
const MODE_LABELS: Readonly<Record<GateHit['change'], string>> = {
  added: 'Permission mode set',
  changed: 'Permission mode changed',
};

export interface GateRow {
  /** The first hit for the item in canonical order: its class, id and summary describe it. */
  readonly hit: GateHit;
  /** Trusted text, such as `New MCP server, not pinned`. */
  readonly label: string;
  /** True when the label names an extra problem (an unpinned server) worth emphasis. */
  readonly emphasis: boolean;
}

/** One row per item that trips the gate, in canonical order. */
export function gateRows(diff: BaselineDiff): GateRow[] {
  const groups = new Map<string, GateHit[]>();
  for (const hit of toJsonBaseline(diff).gate.hits) {
    // A unicode hit's id is a fingerprint; never merge it with an inventory item.
    const key = `${hit.class === 'unicode' ? 'finding' : 'item'}\n${hit.id}`;
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  return [...groups.values()].flatMap((group) => {
    const [hit] = group;
    if (hit === undefined) return [];
    const label =
      hit.kind === 'mode' ? MODE_LABELS[hit.change] : CHANGE_LABELS[hit.class][hit.change];
    const unpinned = hit.class === 'mcp' && group.some((other) => other.class === 'mcp-unpinned');
    return [{ hit, label: unpinned ? `${label}, not pinned` : label, emphasis: unpinned }];
  });
}

/** Where a gate hit is declared: the file and line of its inventory item, or of its finding. */
export interface GateLocation {
  readonly file: string;
  readonly line: number;
}

/** A function that finds where each hit of `result` is declared, when the report knows. */
export function gateLocations(result: ScanResult): (hit: GateHit) => GateLocation | undefined {
  const items = new Map<string, GateLocation>();
  const { mcpServers, hooks, permissions, env } = result.inventory;
  for (const item of [...mcpServers, ...hooks, ...permissions, ...env]) {
    if (!items.has(item.id)) items.set(item.id, { file: item.file, line: item.line });
  }
  return (hit) => {
    if (hit.class !== 'unicode') return items.get(hit.id);
    const finding = result.findings.find((candidate) => candidate.fingerprint === hit.id);
    return finding === undefined
      ? undefined
      : { file: finding.path, line: finding.range.start.line };
  };
}

/** Ids of the rules newer than the baseline's rule set; empty without a baseline. */
export function newRuleSet(result: Pick<ScanResult, 'baseline'>): ReadonlySet<string> {
  return new Set(result.baseline?.against.newRules ?? []);
}

/** True for a new finding of a rule the baseline's rule set did not have. */
export function isNewRuleFinding(finding: Finding, newRules: ReadonlySet<string>): boolean {
  return finding.baseline === 'new' && newRules.has(finding.ruleId);
}

/** New, unsuppressed findings of rules the baseline did not have. */
export function newRuleFindings(result: Pick<ScanResult, 'baseline' | 'findings'>): number {
  const rules = newRuleSet(result);
  if (rules.size === 0) return 0;
  return result.findings.filter(
    (finding) => !finding.suppressed && isNewRuleFinding(finding, rules),
  ).length;
}
