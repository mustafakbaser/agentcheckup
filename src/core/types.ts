/**
 * Core data model. Everything in src/core, src/parse, src/platforms, src/rules and src/report is
 * pure: it receives bytes and returns data. File access lives in src/io only.
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

/** Every file kind agentcheck understands. See src/platforms/classify.ts for the path patterns. */
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
  | 'depth-limit';

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
  /** Candidate config files that were read. Sorted by path (code point order). */
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
  readonly fixable?: 'safe' | 'suggestion';
}

export interface TextEdit {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

export interface Fix {
  readonly description: string;
  readonly safety: 'safe' | 'suggestion';
  readonly edits: readonly TextEdit[];
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
  readonly fix?: Fix;
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
  readonly fix?: Fix;
  readonly suppressed?: Suppression;
}

export interface RuleFailure {
  readonly ruleId: string;
  readonly message: string;
}
