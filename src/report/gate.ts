/**
 * Gate hits as reviewers see them: one row per changed item, labeled. An unpinned MCP server
 * added with `--gate mcp,mcp-unpinned` trips two classes; it is still one change to review.
 * Shared by the Markdown summary and the terminal output so both count the same.
 */
import type { BaselineDiff, GateClass, GateHit } from '../core/baseline-types.js';
import { toJsonBaseline } from './json.js';

const CHANGE_LABELS: Readonly<Record<GateClass, Readonly<Record<GateHit['change'], string>>>> = {
  mcp: { added: 'New MCP server', changed: 'MCP server changed' },
  'mcp-unpinned': { added: 'New unpinned MCP server', changed: 'MCP server changed, not pinned' },
  permissions: { added: 'Permission widened', changed: 'Permission changed' },
  hooks: { added: 'New hook', changed: 'Hook changed' },
  env: { added: 'Env override', changed: 'Env override changed' },
  unicode: { added: 'Hidden Unicode', changed: 'Hidden Unicode' },
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
    const label = CHANGE_LABELS[hit.class][hit.change];
    const unpinned = hit.class === 'mcp' && group.some((other) => other.class === 'mcp-unpinned');
    return [{ hit, label: unpinned ? `${label}, not pinned` : label, emphasis: unpinned }];
  });
}
