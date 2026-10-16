/**
 * Core data model. Everything in src/core, src/parse, src/platforms, src/inventory, src/rules and
 * src/report is pure: it receives bytes and returns data. File access lives in src/io only.
 *
 * Positions follow one convention everywhere:
 * - `offset` is a 0-based index into the decoded text (BOM removed), in UTF-16 code units.
 * - `line` and `column` are 1-based; `column` counts UTF-16 code units (SARIF `utf16CodeUnits`).
 * - Paths are POSIX, relative to the scan root, never absolute, never containing `..`.
 */
import type { FrontmatterResult, JsonDocument, MarkdownDocument } from '../parse/types.js';

export const PLATFORM_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'gemini',
  'windsurf',
  'cline',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const SEVERITIES = ['info', 'warn', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * What goes wrong when a rule fires.
 * - `loading`: an agent skips, ignores or mis-routes the file or part of it.
 * - `budget`: size limits, truncation, or context cost.
 * - `portability`: works on one agent, breaks or behaves differently on another.
 * - `correctness`: broken references, invalid values, malformed structure.
 * - `risk`: security signals. Never awards points; can only lower or cap the score.
 * - `clarity`: advice. Always `info`, never scored.
 */
export const CATEGORIES = [
  'loading',
  'budget',
  'portability',
  'correctness',
  'risk',
  'clarity',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Every file kind agentcheckup understands. See src/platforms/classify.ts for the path patterns. */
export const ARTIFACT_KINDS = [
  'agents-md',
  'agents-override-md',
  'claude-md',
  'claude-local-md',
  'claude-rule',
  'claude-agent',
  'claude-command',
  'claude-settings',
  'claude-plugin-manifest',
  'skill',
  'cursor-rule',
  'cursor-rule-md',
  'cursor-legacy-rules',
  'cursor-hooks',
  'cursor-mcp',
  'copilot-instructions',
  'copilot-path-instructions',
  'gemini-md',
  'gemini-settings',
  'mcp-json',
  'codex-hooks',
  'windsurf-rule',
  'windsurf-legacy-rules',
  'cline-rule',
  'imported-file',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Position {
  /** 1-based. */
  readonly line: number;
  /** 1-based, UTF-16 code units. */
  readonly column: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** A span inside an artifact's decoded text. */
export interface Span {
  readonly offset: number;
  readonly length: number;
}

// ---------------------------------------------------------------------------------------------
// Input: what src/io hands to the engine
// ---------------------------------------------------------------------------------------------

export interface SourceFile {
  /** POSIX path relative to the scan root, as agents reach it (possibly through symlinks). */
  readonly path: string;
  readonly bytes: Uint8Array;
  /**
   * Present when the file was reached through a symlink: either `path` itself is a symlink, or
   * one of its parent directories is. The root-relative POSIX path of the real file. Lets the
   * engine treat an alias and its real file as one artifact instead of reporting both.
   */
  readonly symlinkTarget?: string;
  /**
   * True for a file read only because an instruction file imports it (`@README.md` in
   * CLAUDE.md): it is not agent configuration itself, but the agent loads it. Unless the
   * classifier recognizes its path, it becomes an artifact of kind `imported-file`.
   */
  readonly imported?: boolean;
  /**
   * Which file the walker read and what it held, so that `agentcheckup fix --write` can refuse
   * a file that was swapped or changed since the scan
   * (docs/adr/0008-write-fixes-to-the-scanned-repository.md). Set by src/io for files on disk;
   * absent for in-memory snapshots. The writer edits only files that have one. Internal: never
   * part of a report.
   */
  readonly identity?: SourceIdentity;
}

/**
 * Identity of the regular file the walker read. `dev` and `ino` are bigints, as in
 * `FileIdentity` of src/io/safe-read.ts: as JS numbers, Windows' 64-bit file IDs lose
 * precision. `sha256` is the lowercase hex SHA-256 of `SourceFile.bytes`.
 *
 * `bigint` values make `JSON.stringify` throw, so an identity cannot leak into JSON output
 * unnoticed: reports are rebuilt field by field (src/report/json.ts) and never include it.
 */
export interface SourceIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly sha256: string;
}

export type SymlinkProblem = 'outside-root' | 'broken' | 'not-a-regular-file';

export interface UnresolvedSymlink {
  readonly path: string;
  /** The link text as stored on disk, after control-character sanitizing by the walker. */
  readonly target: string;
  readonly problem: SymlinkProblem;
}

export type SkipReason =
  | 'too-large'
  | 'binary'
  | 'special-file'
  | 'unreadable'
  | 'file-limit'
  | 'byte-limit'
  | 'depth-limit'
  /** An imported file past the import pass's file count or total byte cap (see src/io/imports.ts). */
  | 'import-limit';

export interface SkippedEntry {
  readonly path: string;
  readonly reason: SkipReason;
  readonly size?: number;
}

/**
 * Everything the engine knows about the scanned tree. Built by src/io, or in memory by tests,
 * a browser playground, or an editor extension.
 */
export interface Snapshot {
  /**
   * Candidate config files that were read, and the files they import that were read for them
   * (`imported`). Sorted by path (code point order).
   */
  readonly files: readonly SourceFile[];
  /**
   * Every file and directory path seen during the walk, including ones that were not read.
   * Directories end with `/`. Used for existence checks (imports, links, scripts).
   */
  readonly paths: ReadonlySet<string>;
  /**
   * Directories (trailing `/`) that exist but whose contents were not listed: hard-excluded
   * (`node_modules/`), ignored by `.gitignore`, past the depth limit, unreadable, or symlinks
   * pointing outside the root. Anything below them is "unknown", never "missing".
   */
  readonly opaqueDirectories: ReadonlySet<string>;
  /** Files that exist but were excluded by `.gitignore`. They are "present", just not read. */
  readonly ignoredFiles: ReadonlySet<string>;
  /**
   * Agent configuration that a `.gitignore` matches but that was scanned anyway, because the
   * repository is untrusted and its `.gitignore` must not hide what agents load: files the
   * classifier recognizes (in `paths`, and in `files` when read) and agent configuration
   * directories (trailing `/`, in `paths`) that were listed although ignored. None of them is in
   * `ignoredFiles`. Absent or empty when the walk let `.gitignore` hide them (trusted mode).
   */
  readonly gitignoredConfig?: ReadonlySet<string>;
  /**
   * True only when every `.gitignore` the walk encountered was fully applied. False with
   * `--no-gitignore`; when any `.gitignore` was not applied or only partly (too large, over a rule
   * budget, unreadable, a symlink or special file, patterns dropped as too costly to match); or
   * when the match budget ran out mid-walk. Rules that infer "this file is not gitignored" from
   * its presence must check this first.
   */
  readonly gitignoreApplied: boolean;
  readonly unresolvedSymlinks: readonly UnresolvedSymlink[];
  readonly skipped: readonly SkippedEntry[];
}

// ---------------------------------------------------------------------------------------------
// Artifacts: classified, decoded files
// ---------------------------------------------------------------------------------------------

export type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none';

export interface DecodedText {
  /** Decoded content with any BOM removed. */
  readonly text: string;
  readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  readonly hasBom: boolean;
  /** True when the bytes were not valid in `encoding` and U+FFFD replacements were inserted. */
  readonly hadDecodeErrors: boolean;
  readonly lineEnding: LineEnding;
  /** Offsets where each line starts. `lineStarts[0] === 0`. */
  readonly lineStarts: readonly number[];
}

export interface Artifact {
  readonly path: string;
  /**
   * The real file's path: `file.symlinkTarget` when the file was reached through a symlink,
   * otherwise `path`. Two artifacts with the same realPath are the same bytes on disk, for
   * example `CLAUDE.md` and `AGENTS.md` both linking to one shared file.
   */
  readonly realPath: string;
  readonly kind: ArtifactKind;
  readonly file: SourceFile;
  readonly decoded: DecodedText;
  /** Platforms that read this kind of file. */
  readonly readers: readonly PlatformId[];
  /**
   * Other paths that reach this same file through symlinks (e.g. `.claude/skills/x/SKILL.md`
   * when the real file is `.agents/skills/x/SKILL.md`). The artifact is linted once, at its
   * real path.
   */
  readonly aliases: readonly string[];
  /**
   * Set when the file matches a known name only case-insensitively (e.g. `Agents.md`).
   * Such files load on case-insensitive filesystems (macOS, Windows) but not on Linux.
   */
  readonly caseMismatch?: { readonly expected: string };
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export type SourceStatus = 'verified' | 'unverified';

/** Evidence for a rule: the documentation or source code that defines the behavior. */
export interface RuleSource {
  readonly title: string;
  readonly url: string;
  /** ISO date when the behavior was last checked against this source. */
  readonly checked: string;
  readonly status: SourceStatus;
}

export interface RuleMeta {
  /** Stable, never reused. Format: `<family>/<kebab-name>`. */
  readonly id: string;
  /** One sentence describing the problem, sentence case, no trailing period. */
  readonly title: string;
  /** Why it matters: the concrete platform behavior. Markdown. */
  readonly rationale: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly appliesTo: readonly ArtifactKind[];
  /** Platforms whose documented behavior this rule models. The rule runs only if one is targeted. */
  readonly platforms: readonly PlatformId[];
  readonly sources: readonly [RuleSource, ...RuleSource[]];
  /** Rule set version that introduced the rule. */
  readonly since: string;
  /**
   * Present when the rule can attach a fix to its findings: every class its fixes may have, and
   * one sentence on what the fix does. Rendered in the rule docs and by `explain`.
   */
  readonly fix?: { readonly classes: readonly FixClass[]; readonly summary: string };
}

// ---------------------------------------------------------------------------------------------
// Fixes. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
// ---------------------------------------------------------------------------------------------

/**
 * How much trust a fix needs.
 * - `safe`: deterministic, one correct form, keeps the author's prose, passes a re-scan with no
 *   new error or warning, and never adds or changes an inventory item a gate class flags.
 *   Applied by `agentcheckup fix --write`.
 * - `review`: anything else the tool can write. Applied only with `--write --review` or when
 *   accepted in `-i`.
 *
 * There is no `manual` class: a finding the tool cannot fix has no Fix, only `guidance`.
 */
export type FixClass = 'safe' | 'review';

/**
 * Replaces `length` code units at `offset` with `text`. Offsets and lengths index the decoded
 * text (BOM removed) in UTF-16 code units, as {@link Span} does; the writer re-encodes with the
 * file's encoding, BOM and line endings.
 */
export interface TextEdit {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

/**
 * One change a fix makes to one file. Paths are POSIX and relative to the scan root, like every
 * other path.
 * - `edit`: text edits to an existing file. Offsets index its text as it is before this change
 *   (after earlier changes of the same fix); the edits of one change do not overlap.
 * - `create`: a new file with `text`. The path must not exist.
 * - `rename`: moves a file, never a directory. Never overwrites: `to` must not exist.
 * - `encoding`: re-encodes the whole file as UTF-8 without a byte order mark, keeping its line
 *   endings.
 */
export type FileChange =
  | { readonly kind: 'edit'; readonly path: string; readonly edits: readonly TextEdit[] }
  | { readonly kind: 'create'; readonly path: string; readonly text: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'encoding'; readonly path: string; readonly to: 'utf-8'; readonly bom: false };

/** A repair a rule attaches to one finding. Rules only describe it; src/fix plans and applies. */
export interface Fix {
  /** `${ruleId}#${variant}`. Stable across runs, so `-i` answers and tests can name it. */
  readonly id: string;
  readonly class: FixClass;
  /** One line for the diff header and prompts, such as `Add "@AGENTS.md" as line 1 of CLAUDE.md`. */
  readonly title: string;
  /** Applied in order. A change after a rename names the file by its new path. */
  readonly changes: readonly FileChange[];
  /** Effects or caveats to print with the diff. */
  readonly notes?: readonly string[];
  /** A banner printed before and after the fix, such as the credential rotation warning. */
  readonly warning?: string;
  /** Other ways to fix the same finding, offered only by `agentcheckup fix -i`. */
  readonly alternatives?: readonly Fix[];
}

export interface RelatedLocation {
  readonly path: string;
  readonly message: string;
  readonly span?: Span;
}

export interface ReportDescriptor {
  readonly artifact: Artifact;
  readonly message: string;
  /** Overrides the rule's default severity for this finding (e.g. tiered limits). */
  readonly severity?: Severity;
  /** Omit to point at the whole file (reported at line 1, column 1). */
  readonly span?: Span;
  readonly related?: readonly RelatedLocation[];
  /** Platforms affected by this specific finding. Defaults to the rule's platforms. */
  readonly platforms?: readonly PlatformId[];
  /** A fix for this finding. Its class must be one of `meta.fix.classes`. */
  readonly fix?: Fix;
  /**
   * A manual step the message does not already state, such as `create docs/setup.md or correct
   * the path`. One line. Shown when there is no fix, or next to one.
   */
  readonly guidance?: string;
}

/**
 * Parsed views of an artifact, computed lazily and cached per artifact. Rules must use these
 * instead of parsing themselves, so every rule sees the same, hardened parse.
 */
export interface ParseServices {
  frontmatter(artifact: Artifact): FrontmatterResult;
  markdown(artifact: Artifact): MarkdownDocument;
  json(artifact: Artifact): JsonDocument;
}

export interface RuleContext<Options> extends ParseServices {
  readonly options: Options;
  /** Platforms the user targets (all supported platforms by default). */
  readonly targets: ReadonlySet<PlatformId>;
  /** Artifacts whose kind is in `meta.appliesTo`, sorted by path. */
  readonly artifacts: readonly Artifact[];
  /** All artifacts in the scan, for cross-file rules. */
  readonly allArtifacts: readonly Artifact[];
  readonly snapshot: Snapshot;
  report(descriptor: ReportDescriptor): void;
}

export interface Rule<Options = undefined> {
  readonly meta: RuleMeta;
  readonly defaultOptions: Options;
  check(context: RuleContext<Options>): void;
}

/** A rule with its options type erased, for registries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- options are validated per rule
export type AnyRule = Rule<any>;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export interface Suppression {
  readonly kind: 'inline' | 'config';
  readonly reason: string;
}

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly message: string;
  readonly path: string;
  readonly range: Range;
  readonly related: readonly {
    readonly path: string;
    readonly message: string;
    readonly range?: Range;
  }[];
  readonly platforms: readonly PlatformId[];
  /** Stable across line shifts: hash of rule, path and the normalized source excerpt. */
  readonly fingerprint: string;
  /** From the rule's report. `agentcheckup fix` never applies it to a suppressed finding. */
  readonly fix?: Fix;
  /** A manual step from the rule's report (see {@link ReportDescriptor.guidance}). */
  readonly guidance?: string;
  readonly suppressed?: Suppression;
  /**
   * Set when the scan ran with `--baseline`. `new` when no baseline finding is left to match its
   * fingerprint, otherwise `unchanged`.
   */
  readonly baseline?: 'new' | 'unchanged';
}

export interface RuleFailure {
  readonly ruleId: string;
  readonly message: string;
}
