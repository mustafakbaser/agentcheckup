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
    /**
     * Ids of rules this scan ran that are newer than the baseline's rule set, sorted. Their
     * findings count as new because the baseline could not have reported them; reports label
     * them "new rule". Empty when both reports use the same rule set.
     */
    readonly newRules: readonly string[];
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
  /**
   * Agent definitions and model settings by id (src/agents). Absent in comparisons made before
   * agentcheckup listed them.
   */
  readonly agents?: ItemDiff;
  /** Only for (agent, cwd) pairs present in both reports. */
  readonly context: readonly PlanDelta[];
  readonly gate: { readonly classes: readonly GateClass[]; readonly hits: readonly GateHit[] };
}

/** One subagent's own context in ≈tokens, before and after. `name` is the latest one known. */
export interface CallDelta {
  readonly id: string;
  readonly name?: string;
  readonly before: number | null;
  readonly after: number | null;
  /** With `after` null: the scan still lists the subagent, but cannot measure its call. */
  readonly unmeasured?: true;
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
  /**
   * Subagents whose own context, what a call starts with in ≈tokens, differs: `before` is null
   * for one the baseline does not have, `after` for one the scan no longer lists. Sorted by id.
   */
  readonly calls: readonly CallDelta[];
  /** `before` or `after` is null when that report has no usage for the limit. */
  readonly limits: readonly {
    readonly key: string;
    readonly subject: string;
    /** The usage's label, from the current scan, else from the baseline. */
    readonly label?: string;
    readonly before: number | null;
    readonly after: number | null;
    readonly limit: number | null;
  }[];
}

/**
 * Kinds of change that `--gate` turns into exit code 1.
 * - `mcp`: an MCP server added or changed, or a new MCP config file that could not be parsed.
 * - `mcp-unpinned`: an added or changed MCP server whose pin is not `exact`, `digest` or
 *   `local`.
 * - `permissions`: an entry that lets an agent do more without asking added or changed: any
 *   `permissions.allow` or `additionalDirectories` entry, a skill's `allowed-tools`,
 *   `enabledMcpjsonServers`, `enableAllProjectMcpServers` or Gemini `trust` set to true, or
 *   `defaultMode` set or changed. Never `deny` or `ask` entries.
 * - `hooks`: a hook added or changed.
 * - `env`: an environment override of a class other than `other` added or changed.
 * - `unicode`: a new risk/hidden-unicode finding.
 * - `models`: an agent definition added or changed, or a model setting set or changed. Not a
 *   security class: `--gate security` leaves it out.
 */
export type GateClass =
  'mcp' | 'mcp-unpinned' | 'permissions' | 'hooks' | 'env' | 'unicode' | 'models';

/** The classes `--gate security` selects, and the ones that demote a fix to `review`. */
export type SecurityGateClass = Exclude<GateClass, 'models'>;

/** One change that trips the gate. */
export interface GateHit {
  readonly class: GateClass;
  /** The inventory item id; for `unicode`, the finding's fingerprint. */
  readonly id: string;
  readonly change: 'added' | 'changed';
  /** One line for the pull request summary. */
  readonly summary: string;
  /**
   * A setting that trips the gate whenever it is set or changed, whether or not it lets the agent
   * do more: `mode` for a permission mode (`permissions.defaultMode`, a subagent's
   * `permissionMode`), `agent` for the subagent every Claude Code session starts as, and
   * `model-setting` for a repository setting that picks a model (class `models`).
   */
  readonly kind?: 'mode' | 'agent' | 'model-setting';
}
