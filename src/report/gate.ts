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
import { coversTree, parseIncomplete } from '../inventory/incomplete.js';
import { toJsonBaseline } from './json.js';
import { plural } from './text.js';

/** Only a `deny` or `ask` permission entry trips a class when it is removed. */
const CHANGE_LABELS: Readonly<Record<GateClass, Readonly<Record<GateHit['change'], string>>>> = {
  mcp: { added: 'New MCP server', changed: 'MCP server changed', removed: 'MCP server removed' },
  'mcp-unpinned': {
    added: 'New unpinned MCP server',
    changed: 'MCP server changed, not pinned',
    removed: 'MCP server removed',
  },
  permissions: {
    added: 'Permission widened',
    changed: 'Permission changed',
    removed: 'Permission widened',
  },
  hooks: { added: 'New hook', changed: 'Hook changed', removed: 'Hook removed' },
  env: { added: 'Env override', changed: 'Env override changed', removed: 'Env override removed' },
  unicode: { added: 'Hidden Unicode', changed: 'Hidden Unicode', removed: 'Hidden Unicode' },
  models: {
    added: 'New agent definition',
    changed: 'Agent definition changed',
    removed: 'Agent definition removed',
  },
};

/** Settings that trip the gate whenever they are set or changed: a mode may narrow, too. */
const SETTING_LABELS: Readonly<
  Record<NonNullable<GateHit['kind']>, Readonly<Record<GateHit['change'], string>>>
> = {
  mode: {
    added: 'Permission mode set',
    changed: 'Permission mode changed',
    removed: 'Permission mode removed',
  },
  agent: {
    added: 'Session agent set',
    changed: 'Session agent changed',
    removed: 'Session agent removed',
  },
  'model-setting': {
    added: 'Model setting set',
    changed: 'Model setting changed',
    removed: 'Model setting removed',
  },
  'not-analyzed': { added: 'Not analyzed', changed: 'Not analyzed', removed: 'Not analyzed' },
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
    // A unicode hit's id is a fingerprint; never merge it with an inventory item. One that a
    // file or directory the scan could not analyze trips has that entry as its id.
    const finding = hit.class === 'unicode' && hit.kind !== 'not-analyzed';
    const key = `${finding ? 'finding' : 'item'}\n${hit.id}`;
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  return [...groups.values()].flatMap((group) => {
    const [hit] = group;
    if (hit === undefined) return [];
    const label =
      hit.kind === undefined
        ? CHANGE_LABELS[hit.class][hit.change]
        : SETTING_LABELS[hit.kind][hit.change];
    const unpinned =
      hit.kind !== 'not-analyzed' &&
      hit.class === 'mcp' &&
      group.some((other) => other.class === 'mcp-unpinned');
    return [{ hit, label: unpinned ? `${label}, not pinned` : label, emphasis: unpinned }];
  });
}

/**
 * How a summary counts the rows: `2 security-relevant changes`, `1 model change`, or both, as in
 * `2 security-relevant changes and 1 model change`. `models` is not a security class.
 */
export function gateChangeCount(rows: readonly GateRow[]): string {
  const models = rows.filter((row) => row.hit.class === 'models').length;
  const security = rows.length - models;
  return [
    ...(security > 0 ? [plural(security, 'security-relevant change')] : []),
    ...(models > 0 ? [plural(models, 'model change')] : []),
  ].join(' and ');
}

/** What a summary says when no change trips the selected classes. */
export function noGateChanges(classes: readonly GateClass[]): string {
  const models = classes.includes('models');
  const security = classes.some((gate) => gate !== 'models');
  const what =
    models && security
      ? 'security-relevant or model changes'
      : models
        ? 'model changes'
        : 'security-relevant changes';
  return `No ${what} need review`;
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
  const definitions = result.agents?.definitions ?? [];
  const settings = result.agents?.settings ?? [];
  for (const item of [
    ...mcpServers,
    ...hooks,
    ...permissions,
    ...env,
    ...definitions,
    ...settings,
  ]) {
    if (!items.has(item.id)) items.set(item.id, { file: item.file, line: item.line });
  }
  const base = result.pathBase ?? '';
  return (hit) => {
    if (hit.kind === 'not-analyzed') {
      // A file the scan did not analyze, at its first line; a part of the tree has no place.
      const entry = parseIncomplete(hit.id);
      if (coversTree(entry)) return undefined;
      return { file: base === '' ? entry.path : `${base}/${entry.path}`, line: 1 };
    }
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
