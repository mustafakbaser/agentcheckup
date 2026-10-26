/**
 * Shared types of `agentcheckup fix`: what the user selected, what the planner decided, what each
 * fix does to the agents, and the `--format json` output (schemas/fix.schema.json).
 *
 * Pure like src/core: the planner (plan.ts), the in-memory applier (apply.ts) and the
 * verification rounds (verify.ts) take a Snapshot and return data. Only src/io/write-fix.ts
 * writes to disk. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 *
 * Paths are POSIX and relative to the scan root, never absolute (see src/core/types.ts).
 */
import type { GateHit, SecurityGateClass } from '../core/baseline-types.js';
import type { DecodedText, Finding, Fix, FixClass, FixInput, Severity } from '../core/types.js';
import type { ContextAgent } from '../platforms/load/types.js';

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/**
 * Which fixes to plan.
 *
 * Suppressed findings are never fixed, whatever the selection. Findings whose fix is not selected
 * stay in the scan and count as remaining.
 */
export interface FixSelection {
  /**
   * Classes to plan. A dry run and `-i` plan both; `--write` plans `safe`; `--write --review`
   * plans both.
   */
  readonly classes: ReadonlySet<FixClass>;
  /**
   * Only fixes of these rules (`--rule a,b`). Absent means every rule. The CLI rejects unknown
   * ids before planning.
   */
  readonly ruleIds?: ReadonlySet<string>;
  /**
   * Whether mcp/literal-secret fixes may be planned: true only when the rule was named in
   * `--rule` or its fix was accepted in `-i`. Never true for pull request suggestions.
   */
  readonly literalSecret: boolean;
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

/**
 * What applying a fix changes for the agents, measured by planning the fixed copy again and
 * comparing it with the scan.
 * - `tokens`: an agent's startup context changes size (estimated tokens, as in load plans).
 * - `gate`: the fix adds or changes an inventory item a security gate class flags, such as an MCP
 *   server it activates. A fix with a gate effect is never `safe`: verification demotes it to
 *   `review`. A changed agent definition or model setting (class `models`) is not an effect.
 */
export type FixEffect =
  | {
      readonly kind: 'tokens';
      readonly agent: ContextAgent;
      /** Working directory of the plan, relative to the scan root. `''` is the root. */
      readonly cwd: string;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly kind: 'gate';
      readonly class: SecurityGateClass;
      /** The inventory item id; for `unicode`, the finding's fingerprint. */
      readonly id: string;
      readonly change: GateHit['change'];
      /** One line, as in the `--gate` summary. */
      readonly summary: string;
    };

/** Whether a fix is still to apply, was applied, or was left out. */
export type FixStatus = 'planned' | 'applied' | 'skipped';

/**
 * Why a selected fix was not applied. Every reason except `declined` makes `agentcheckup fix`
 * exit 1.
 * - `conflict`: it overlaps a fix that won (see {@link Conflict}); running fix again applies it.
 * - `changed-since-scan`: the file's bytes or identity differ from what the walk read.
 * - `refused-path`: the target failed confinement, such as a symlinked parent, a reserved
 *   Windows name, or a create or rename target that exists.
 * - `verification-failed`: on the in-memory copy, a finding it should resolve is still there,
 *   or a new error or warning appeared.
 * - `limit`: past a bound of ADR 0008 (rounds, fixes per run, bytes per written file).
 * - `write-failed`: writing failed and the fix's completed steps were rolled back.
 * - `declined`: not accepted in `-i`.
 */
export type FixSkipReason =
  | 'conflict'
  | 'changed-since-scan'
  | 'refused-path'
  | 'verification-failed'
  | 'limit'
  | 'write-failed'
  | 'declined';

interface FixDecision {
  readonly fix: Fix;
  /** The rule whose findings carry the fix. */
  readonly ruleId: string;
  /**
   * Fingerprints of the findings the fix resolves. Identical fixes on several findings merge
   * into one planned fix.
   */
  readonly findings: readonly string[];
  /** Filled in by verification; empty before it. */
  readonly effects: readonly FixEffect[];
}

/** A selected fix and what became of it. `reason` is present exactly when it was skipped. */
export type PlannedFix =
  | (FixDecision & { readonly status: 'planned' | 'applied'; readonly reason?: never })
  | (FixDecision & { readonly status: 'skipped'; readonly reason: FixSkipReason });

/**
 * Two fixes that cannot both apply in one round. Identical edits are merged, not conflicts.
 * - `overlapping-edits`: edits to one file overlap.
 * - `same-offset-inserts`: two insertions at one offset, whose order would be a guess.
 * - `same-target`: two creates or renames to one path.
 * - `renamed-source`: one fix edits or renames a path that another renames.
 *
 * The winner is the `safe` fix before the `review` one, then the higher severity, then the
 * lower rule id, then the lower offset. The loser is skipped with reason `conflict`.
 */
export interface Conflict {
  readonly kind: 'overlapping-edits' | 'same-offset-inserts' | 'same-target' | 'renamed-source';
  /** The path both fixes change. */
  readonly path: string;
  readonly winner: PlannedFix;
  readonly loser: PlannedFix;
}

/** A finding the tool leaves to the user: no selected fix, but a `guidance` line. */
export interface ManualStep {
  readonly ruleId: string;
  readonly path: string;
  /** 1-based line of the finding. */
  readonly line: number;
  readonly guidance: string;
}

/**
 * A selected fix that needs the user's words ({@link Fix.input}). The planner never plans it and
 * `--write` never applies it: `agentcheckup fix -i` asks for the words, completes it
 * (src/fix/input.ts) and plans the completed fix in its place.
 */
export interface AwaitingInput {
  readonly fix: Fix & { readonly input: FixInput };
  /** The rule whose findings carry the fix. */
  readonly ruleId: string;
  /** Fingerprints of the findings that carry it, as for a {@link PlannedFix}. */
  readonly findings: readonly string[];
  /** Path of its first finding in report order. */
  readonly path: string;
  /** 1-based line of that finding. */
  readonly line: number;
}

/** The selected fixes of one round, in an order that depends only on the scan. */
export interface FixPlan {
  readonly fixes: readonly PlannedFix[];
  readonly conflicts: readonly Conflict[];
  readonly manual: readonly ManualStep[];
  /** Selected fixes that need the user's words, in report order of their first finding. */
  readonly awaitingInput: readonly AwaitingInput[];
}

/**
 * The scan of the fixed copy against the scan before. New errors and warnings are matched by
 * rule and path (mapped through renames) as a multiset; fingerprints change with the edits.
 */
export interface FixVerification {
  /** Findings that were present before and are gone. */
  readonly resolved: number;
  /** Unsuppressed findings still present. */
  readonly remaining: number;
  /** New findings. Only `info` is allowed: a new error or warning fails the fix. */
  readonly introduced: readonly Finding[];
}

// ---------------------------------------------------------------------------------------------
// `agentcheckup fix --format json`, described by schemas/fix.schema.json
// ---------------------------------------------------------------------------------------------

/** Encoding, byte order mark and line endings of a file, and the SHA-256 of its bytes. */
export interface FileState {
  /** Lowercase hex SHA-256 of the bytes on disk (before) or to be written (after). */
  readonly sha256: string;
  readonly encoding: DecodedText['encoding'];
  readonly bom: boolean;
  readonly lineEnding: DecodedText['lineEnding'];
}

/**
 * One hunk of a unified diff. Each line starts with ` `, `+`, `-` or `\` (no newline at end of
 * file) and has no line ending. Credential values are redacted.
 */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/**
 * The combined change to one file across every applied or planned fix.
 * - `edit`: the file keeps its path. An encoding change is an edit whose `before` and `after`
 *   differ in `encoding` or `bom`.
 * - `create`: a new file. No `before`.
 * - `rename`: moved from `from`, possibly with edits.
 */
export interface FileReport {
  readonly path: string;
  readonly op: 'edit' | 'create' | 'rename';
  readonly from?: string;
  readonly before?: FileState;
  readonly after: FileState;
  readonly hunks: readonly DiffHunk[];
}

interface FixReportDecision {
  /** {@link Fix.id}: `<rule id>#<variant>`. Not unique; `findings` tells fixes apart. */
  readonly id: string;
  readonly ruleId: string;
  readonly class: FixClass;
  readonly title: string;
  readonly effects: readonly FixEffect[];
  /** Fingerprints of the findings in the scan before fixing. */
  readonly findings: readonly string[];
  readonly notes?: readonly string[];
  readonly warning?: string;
}

/** One fix in the JSON output. */
export type FixReportEntry =
  | (FixReportDecision & { readonly status: 'planned' | 'applied'; readonly reason?: never })
  | (FixReportDecision & { readonly status: 'skipped'; readonly reason: FixSkipReason });

/** A fix that needs the user's words, in the JSON output. */
export interface FixReportInput {
  /** {@link Fix.id}. */
  readonly id: string;
  readonly ruleId: string;
  readonly class: FixClass;
  readonly title: string;
  /** Fingerprints of the findings in the scan before fixing. */
  readonly findings: readonly string[];
  /** Where its first finding is. */
  readonly path: string;
  readonly line: number;
  /** {@link Fix.input}, with `pathBase` in front of the target's path. */
  readonly input: FixInput;
  readonly notes?: readonly string[];
}

/** A finding the re-scan found that the scan before did not have. */
export interface IntroducedFinding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

/** Output of `agentcheckup fix --format json`. */
export interface FixReport {
  readonly schemaVersion: 1;
  readonly tool: { readonly name: string; readonly version: string };
  readonly ruleset: string;
  /** `dry-run` changes nothing; `write` and `interactive` write the applied fixes. */
  readonly mode: 'dry-run' | 'write' | 'interactive';
  /** The prefix added to every path, as in the scan report. Absent or `''` when there is none. */
  readonly pathBase?: string;
  readonly fixes: readonly FixReportEntry[];
  /** Selected fixes that need the user's words: only `-i` applies them. Absent when none. */
  readonly awaitingInput?: readonly FixReportInput[];
  readonly files: readonly FileReport[];
  readonly manual: readonly ManualStep[];
  /**
   * The in-memory re-scan for a dry run, the scan of the written files for `write` and
   * `interactive`.
   */
  readonly verification: {
    readonly resolved: number;
    readonly remaining: number;
    readonly introduced: readonly IntroducedFinding[];
  };
}

// ---------------------------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------------------------

export { applyPlan, editedText, FixApplyError } from './apply.js';
export {
  createFile,
  insertLine,
  type InsertLineOptions,
  jsonInsertProperty,
  type JsonInsertOptions,
  type JsonPath,
  jsonRemoveProperty,
  type JsonRemoveOptions,
  jsonRenameKey,
  jsonReplaceValue,
  type JsonValue,
  MAX_COPIED_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  moveFrontmatterToTop,
  prependFrontmatter,
  quoteJson,
  quoteYaml,
  reencode,
  renameFile,
  replaceSpan,
  safeCopiedText,
  skillSlug,
  type YamlEntry,
  yamlInsertKey,
  type YamlInsertOptions,
  type YamlPosition,
  yamlRenameKey,
  type YamlReplaceOptions,
  yamlReplaceScalar,
  yamlReplaceValue,
  type YamlScalar,
  yamlSetScalar,
  type YamlStyle,
  type YamlValueOptions,
} from './edits.js';
export {
  checkInputShape,
  completeInput,
  INPUT_LIMITS,
  type InputCompletion,
  type InputParses,
  type InputVerification,
  UNSAFE_VALUE,
  verifyCompletedInput,
} from './input.js';
export { MAX_FIX_PATH_LENGTH, pathProblem } from './paths.js';
export {
  type FixCandidate,
  fixKey,
  leftSteps,
  LITERAL_SECRET_RULE,
  MAX_FIXES,
  needsInput,
  planFixes,
  type PlanOptions,
} from './plan.js';
export {
  type FileDiff,
  type FixRun,
  fixRounds,
  type FixScanOptions,
  MAX_ROUNDS,
  MAX_WRITTEN_FILE_BYTES,
} from './verify.js';
