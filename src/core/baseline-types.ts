/**
 * Comparison of a scan with a baseline report (`--baseline`). Pure data. See
 * docs/adr/0007-model-what-each-agent-loads.md.
 *
 * Paths are compared after removing each report's `pathBase`. Removals never trip the gate.
 */
import type { ContextAgent } from '../platforms/load/types.js';

export interface BaselineDiff {
  /**
   * The baseline report's tool and rule set versions. When `sameRuleset` is false, findings
   * from rules the baseline did not run count as new.
   */
  readonly against: {
    readonly version: string;
    readonly ruleset: string;
    readonly sameRuleset: boolean;
  };
  /**
   * Findings match by fingerprint, as a multiset. Unmatched current findings are new; unmatched
   * baseline findings are resolved.
   */
  readonly findings: {
    readonly new: number;
    readonly unchanged: number;
    readonly resolved: readonly {
      readonly ruleId: string;
      readonly path: string;
      readonly fingerprint: string;
    }[];
  };
  /** Inventory items by id. An item changed when its digest differs. */
  readonly inventory: ItemDiff;
  /** Only for (agent, cwd) pairs present in both reports. */
  readonly context: readonly PlanDelta[];
  readonly gate: { readonly classes: readonly GateClass[]; readonly hits: readonly GateHit[] };
}

/** Ids added, removed and changed between the baseline and the current scan. */
export interface ItemDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** `fields` names the properties that differ. */
  readonly changed: readonly { readonly id: string; readonly fields: readonly string[] }[];
}

/**
 * Change in one load plan. An entry changed when its trigger, `size.chars`, `truncated` or
 * certainty differs; a position-only change shows only in JSON output.
 */
export interface PlanDelta {
  readonly agent: ContextAgent;
  readonly cwd: string;
  readonly entries: ItemDiff;
  readonly skipped: ItemDiff;
  readonly startupTokens: { readonly before: number; readonly after: number };
  /** `before` or `after` is null when that report has no usage for the limit. */
  readonly limits: readonly {
    readonly key: string;
    readonly subject: string;
    readonly before: number | null;
    readonly after: number | null;
    readonly limit: number | null;
  }[];
}

/**
 * Kinds of security-relevant change that `--gate` turns into exit code 1.
 * - `mcp`: an MCP server added or changed, or a new MCP config file that could not be parsed.
 * - `mcp-unpinned`: an added or changed MCP server whose pin is not `exact`, `digest` or
 *   `local`.
 * - `permissions`: a broad or auto-approving permission added, or `defaultMode` changed.
 * - `hooks`: a hook added or changed.
 * - `env`: an environment override of a class other than `other` added or changed.
 * - `unicode`: a new risk/hidden-unicode finding.
 */
export type GateClass = 'mcp' | 'mcp-unpinned' | 'permissions' | 'hooks' | 'env' | 'unicode';

/** One change that trips the gate. */
export interface GateHit {
  readonly class: GateClass;
  /** The inventory item id; for `unicode`, the finding's fingerprint. */
  readonly id: string;
  readonly change: 'added' | 'changed';
  /** One line for the pull request summary. */
  readonly summary: string;
}
