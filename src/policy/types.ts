/**
 * Organization policy (`--policy <file>`): what a policy file says, and what checking a scan
 * against it reports. Pure data. See docs/research design section 1; the decision is ADR 0011.
 *
 * Violations are not findings: they have no rule id and no suppressible fingerprint, never count
 * toward the score, and neither the repository's configuration nor inline directives can name
 * them.
 */
import type { HookPlatform } from '../platforms/hooks.js';
import type { ContextAgent } from '../platforms/load/types.js';

/** Settings a policy can forbid, in documentation order. A closed list: a typo is an error. */
export const FORBID_NAMES = [
  'bypass-permissions',
  'auto-approve-project-mcp',
  'mcp-auto-approve',
  'broad-shell',
  'broad-write',
  'gemini-trust',
  'additional-directories',
  'env-endpoint',
  'env-tls',
  'env-code-exec',
] as const;
export type ForbidName = (typeof FORBID_NAMES)[number];

export const POLICY_MODES = ['enforce', 'audit'] as const;
/** `enforce` fails the run on violations; `audit` reports them and never fails. */
export type PolicyMode = (typeof POLICY_MODES)[number];

export const EXISTING_MODES = ['report', 'fail'] as const;
/**
 * With a baseline: `report` fails only on new violations, `fail` on every violation. Without a
 * baseline every violation counts.
 */
export type ExistingMode = (typeof EXISTING_MODES)[number];

/**
 * One `mcp.allow` entry, normalized:
 * - `npm`: `npm:<name>[@<exact version>]`, scoped names included.
 * - `pypi`: `pypi:<name>[==<exact version>]`, the name normalized as PEP 503 does.
 * - `oci`: `oci:<image>[@sha256:<digest>]`, the image with Docker's defaults applied
 *   (`docker.io/library/` for an official image).
 * - `origin`: `scheme://host[:port]`; `*.` before the host matches any host below it, on a label
 *   boundary. `port` is `''` for the scheme's default port.
 */
export type AllowEntry =
  | {
      readonly kind: 'npm';
      readonly text: string;
      readonly name: string;
      readonly version?: string;
    }
  | {
      readonly kind: 'pypi';
      readonly text: string;
      readonly name: string;
      readonly version?: string;
    }
  | {
      readonly kind: 'oci';
      readonly text: string;
      readonly image: string;
      readonly digest?: string;
    }
  | {
      readonly kind: 'origin';
      readonly text: string;
      readonly scheme: string;
      /** Lower case. For a wildcard, the part after `*.`. */
      readonly host: string;
      readonly port: string;
      readonly wildcard: boolean;
    };

/** One `hooks.require` entry: a hook that must be configured. Presence only. */
export interface HookRequirement {
  readonly agent: HookPlatform;
  readonly event: string;
  /** Must equal the hook's matcher when set. */
  readonly matcher?: string;
  /** A repository path, normalized; must equal the script the hook runs when set. */
  readonly script?: string;
  /** Must equal the hook's command line when set. */
  readonly command?: string;
}

/** A policy file after validation, with defaults applied. */
export interface Policy {
  readonly name: string;
  /**
   * Lowercase hex SHA-256 of the policy document in canonical JSON: object keys sorted by code
   * point, no whitespace. The same policy gives the same digest however it is formatted.
   */
  readonly sha256: string;
  readonly mode: PolicyMode;
  readonly existing: ExistingMode;
  readonly mcp: {
    /** Absent: no allowlist check. Present, even empty: only listed servers pass. */
    readonly allow?: readonly AllowEntry[];
    /** Allow servers that run a script from the repository. Default false. */
    readonly allowLocal: boolean;
    /** Require an exact version, a digest or a repository script. Default false. */
    readonly requirePin: boolean;
  };
  readonly forbid: readonly ForbidName[];
  /** Tool names, as written. */
  readonly denyTools: readonly string[];
  /** Program names, lower case. */
  readonly denyCommands: readonly string[];
  readonly requireHooks: readonly HookRequirement[];
  /** Per agent, the most startup tokens any of its load plans may have. */
  readonly budgets: readonly { readonly agent: ContextAgent; readonly startupTokens: number }[];
}

export const POLICY_CHECKS = [
  'mcp-not-allowed',
  'mcp-unpinned',
  'forbidden-setting',
  'denied-tool',
  'hook-missing',
  'startup-budget',
  'unanalyzed-config',
] as const;
/** The checks, in report order. */
export type PolicyCheck = (typeof POLICY_CHECKS)[number];

/**
 * One violation.
 *
 * `id` is the identity a baseline comparison matches: the check, the subject (an inventory item
 * id, an `incomplete` entry, a hook requirement or an agent) and, for inventory items, the item's
 * digest, so changing an item that already violates the policy makes a new violation. Ids are
 * relative to the scan root, like finding fingerprints: they never carry `pathBase`.
 *
 * `entry` names what the violation is about:
 * - `mcp-not-allowed`, `mcp-unpinned`: the server in allowlist form (`npm:<name>`,
 *   `pypi:<name>`, `oci:<image>`, an origin), `local:<path>` for a repository script, or
 *   `unknown` when the command cannot be read.
 * - `forbidden-setting`: the `forbid` name.
 * - `denied-tool`: the `denyTools` and `denyCommands` values the grant violates, comma-separated.
 * - `hook-missing`: the requirement, such as `claude-code PreToolUse matcher "Bash"`.
 * - `startup-budget`: the agent.
 * - `unanalyzed-config`: the inventory's `incomplete` entry.
 *
 * `message` keeps repository text raw (quoted and length-bounded, as finding messages do);
 * reporters sanitize it for their channel.
 */
export interface PolicyViolation {
  readonly id: string;
  readonly check: PolicyCheck;
  readonly entry: string;
  /** The file, as the scan reports paths (with its `pathBase`). */
  readonly path?: string;
  readonly line?: number;
  readonly agent?: ContextAgent;
  readonly message: string;
  /** Set when a baseline was given. */
  readonly baseline?: 'new' | 'unchanged';
  /** True when this violation fails the run. */
  readonly fails: boolean;
}

/** A remark on the whole policy run, such as audit mode or a baseline without load plans. */
export interface PolicyNote {
  readonly id: string;
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
}

/** The `policy` field of a report. */
export interface PolicyReport {
  readonly name: string;
  readonly sha256: string;
  readonly mode: PolicyMode;
  /** True when the policy file lies inside the scanned directory, so a change can edit it. */
  readonly insideScanRoot: boolean;
  /** How many of the checks the policy turns on. */
  readonly checks: number;
  /** Sorted by check, then path, line and id. */
  readonly violations: readonly PolicyViolation[];
  readonly notes: readonly PolicyNote[];
}
