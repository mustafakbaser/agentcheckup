/**
 * Load-plan contract: what one agent loads for one working directory. Loaders in this directory
 * build it from the same parsed artifacts the rules use, and reports render it. Pure data. See
 * docs/adr/0007-model-what-each-agent-loads.md.
 *
 * Paths are POSIX, relative to the scan root, never absolute (see src/core/types.ts). Plans
 * cover the repository only: managed, user, global and account scopes are listed in `hidden`,
 * never read (ADR 0003).
 */
import type { ArtifactKind, PlatformId, RuleSource } from '../../core/types.js';

/** Agents with a load model, in PLATFORM_IDS order. Other platforms are added one at a time. */
export const CONTEXT_AGENTS = [
  'claude-code',
  'codex',
  'cursor',
] as const satisfies readonly PlatformId[];
export type ContextAgent = (typeof CONTEXT_AGENTS)[number];

/**
 * What an entry is to the agent.
 * - `instructions`: an instruction file such as AGENTS.md, CLAUDE.md or .cursorrules.
 * - `import`: a file inlined through an `@path` import.
 * - `rule`: a scoped rule file such as `.claude/rules/*.md` or `.cursor/rules/*.mdc`.
 * - `skill`, `subagent`, `command`: one skill, subagent or slash command.
 * - `mcp-server`, `hook`: one MCP server or hook declared in a JSON config file.
 */
export type LoadRole =
  'instructions' | 'import' | 'rule' | 'skill' | 'subagent' | 'command' | 'mcp-server' | 'hook';

/**
 * When the agent adds an entry to the model's context.
 * - `startup`: in the prompt when the session starts.
 * - `on-path`: when the agent reads or edits a matching file. Covers nested CLAUDE.md files,
 *   rules with `paths` or `globs`, and nested skills folders. `LoadEntry.patterns` says which
 *   files.
 * - `model-selected`: when the model picks it from a description: a skill body, a Cursor rule
 *   with only a description, a subagent.
 * - `manual`: only when the user asks for it, with an `@`-mention or a `/command`.
 * - `on-approval`: after the user accepts a trust or approval prompt, as for `.mcp.json` servers
 *   and Codex hooks.
 */
export type LoadTrigger = 'startup' | 'on-path' | 'model-selected' | 'manual' | 'on-approval';

/**
 * How a claim about loading is backed.
 * - `documented`: the agent's official documentation states it.
 * - `source-code`: the agent's published source code shows it.
 * - `unverified`: neither source confirms it. Text and Markdown output mark it with "?".
 */
export type Certainty = 'documented' | 'source-code' | 'unverified';

/** Key into {@link ContextReport.sources}. Plans cite by key so each source is written once. */
export type SourceKey = string;

/**
 * Size of what the agent receives.
 * - `bytes`: size of the file on disk.
 * - `chars`: code points the agent receives after documented transforms, such as the Codex
 *   byte cut or Claude Code stripping block HTML comments.
 * - `tokens`: an estimate, `Math.ceil(chars / 4)`, shown with "≈". It is not a tokenizer
 *   count, and it never drives a finding or the score.
 */
export interface Size {
  readonly bytes: number;
  readonly chars: number;
  readonly tokens: number;
}

/** One thing the agent loads, or may load once its trigger fires. */
export interface LoadEntry {
  /**
   * `${role}:${path}`, or `${role}:${path}#${name}` when one file declares several items (MCP
   * servers, hooks). Unique within a plan.
   */
  readonly id: string;
  readonly role: LoadRole;
  readonly trigger: LoadTrigger;
  /** 1-based order in which the agent assembles startup context. Startup entries only. */
  readonly position?: number;
  /** The path as the agent reaches it. May be a symlink alias of `realPath`. */
  readonly path: string;
  readonly realPath: string;
  /** Skill, subagent, command, MCP server or hook name. */
  readonly name?: string;
  /** For imports: the files that led to this one, root instruction file first. */
  readonly via?: readonly string[];
  /** For `on-path` entries: the globs, or the directory whose files trigger loading. */
  readonly patterns?: readonly string[];
  /**
   * What this entry adds to context. For a skill, its listing text. Absent for MCP servers and
   * hooks.
   */
  readonly size?: Size;
  /** For a skill: the body, loaded only when the skill is used. */
  readonly deferred?: Size;
  /** Set when a limit cuts the file: the byte where the cut falls and its 1-based line. */
  readonly truncated?: { readonly atByte: number; readonly line: number };
  /** For MCP servers and hooks: the matching item's id in the security inventory. */
  readonly inventoryId?: string;
  readonly certainty: Certainty;
  readonly evidence: readonly SourceKey[];
}

/**
 * Why the agent does not load a file or item.
 * - `shadowed-by-claude-md`: Claude Code reads a CLAUDE file on the path instead of AGENTS.md.
 * - `shadowed-by-override`: Codex reads the AGENTS.override.md in the same directory instead of
 *   AGENTS.md.
 * - `over-byte-budget`: a byte limit was used up before this file, or the file exceeds one.
 * - `empty-override`: an empty AGENTS.override.md wins and leaves Codex with nothing here.
 * - `blank-file`: the file has no content, so the agent skips it.
 * - `not-mdc`: Cursor reads only `.mdc` files in `.cursor/rules`.
 * - `no-frontmatter`, `invalid-frontmatter`, `bom`, `no-description`: the agent requires valid
 *   frontmatter with a description and no byte order mark before it.
 * - `invalid-subagent`: the subagent definition fails the agent's validation.
 * - `import-unresolved`, `import-too-deep`, `import-outside-root`: an import is not followed.
 * - `url-without-type`: an MCP server has `url` but no `type`.
 * - `unknown-event`: a hook is registered for an event name the agent does not know.
 * - `invalid-json`: the config file is not valid JSON.
 * - `not-utf8`: the agent decodes the file as UTF-8 and gets garbled text.
 * - `case-mismatch`: the name matches only case-insensitively, so case-sensitive file systems
 *   miss it.
 * - `materialized-symlink`: a symlink checked out as a text file that holds the target path.
 * - `not-read`: the agent does not read the file here, and no rule reports it as a problem.
 */
export type SkipCode =
  | 'shadowed-by-claude-md'
  | 'shadowed-by-override'
  | 'over-byte-budget'
  | 'empty-override'
  | 'blank-file'
  | 'not-mdc'
  | 'no-frontmatter'
  | 'invalid-frontmatter'
  | 'bom'
  | 'no-description'
  | 'invalid-subagent'
  | 'import-unresolved'
  | 'import-too-deep'
  | 'import-outside-root'
  | 'url-without-type'
  | 'unknown-event'
  | 'invalid-json'
  | 'not-utf8'
  | 'case-mismatch'
  | 'materialized-symlink'
  | 'not-read';

/**
 * A file or item the agent would consider but skips. Named SkippedLoad because
 * src/core/types.ts already has SkippedEntry for files the walker did not read.
 */
export interface SkippedLoad {
  readonly id: string;
  readonly role: LoadRole;
  readonly path: string;
  readonly name?: string;
  readonly code: SkipCode;
  /** The loading rule whose finding reports this skip. Absent only for `not-read`. */
  readonly ruleId?: string;
  readonly certainty: Certainty;
  readonly evidence: readonly SourceKey[];
}

/**
 * A file the plan leaves out on purpose. Not a skip: the agent is not expected to load it.
 * - `below-start-dir`: below the working directory, where this agent does not look.
 * - `other-agent-plugin`: inside a plugin for another agent.
 * - `payload-folder`: a resource bundled with a skill, not configuration.
 * - `documentation`: a README or similar file kept next to configuration.
 */
export interface OutOfScope {
  readonly path: string;
  readonly because: 'below-start-dir' | 'other-agent-plugin' | 'payload-folder' | 'documentation';
}

/**
 * A setting the repository cannot show, stated so the reader can check it. Origin:
 * - `default`: the agent's documented default.
 * - `rule-option`: an agentcheckup rule option, such as `maxBytes` of instr/codex-size-budget.
 * - `repository`: read from a file in the repository.
 * - `flag`: a command-line flag, such as `--context-window`.
 */
export interface Assumption {
  /** For example `codex.project_doc_max_bytes`. */
  readonly key: string;
  readonly value: string | number | boolean;
  readonly origin: 'default' | 'rule-option' | 'repository' | 'flag';
  readonly evidence: readonly SourceKey[];
}

/** A scope outside the repository that can add to the plan. Listed, never read. */
export interface HiddenScope {
  readonly scope: 'managed' | 'user' | 'global' | 'team' | 'account' | 'plugin';
  /** Display text such as `~/.claude/CLAUDE.md`. Never resolved against the real home directory. */
  readonly locations: readonly string[];
  readonly roles: readonly LoadRole[];
}

/**
 * How much of a documented limit the repository uses. Effect when the limit is crossed:
 * - `skips`: the agent skips the item.
 * - `truncates`: the agent drops everything past the limit.
 * - `shortens`: the agent shortens the text, such as long skill descriptions in the listing.
 * - `advice`: documented guidance; nothing is dropped.
 */
export interface LimitUsage {
  /** For example `codex.project_doc_max_bytes`. */
  readonly key: string;
  /**
   * `levels`: directory levels below a search root. `directories`: directories a search visits.
   */
  readonly unit:
    'bytes' | 'chars' | 'lines' | 'hops' | 'levels' | 'directories' | 'context-fraction';
  /** Null when the limit depends on the model's context window and none was given. */
  readonly limit: number | null;
  readonly used: number;
  /** What the usage is measured on: a path, or a group such as the Codex instruction chain. */
  readonly subject: string;
  readonly effect: 'skips' | 'truncates' | 'shortens' | 'advice';
  readonly evidence: readonly SourceKey[];
}

/** What one agent loads for a session started in `cwd`. */
export interface LoadPlan {
  readonly agent: ContextAgent;
  /** Working directory, relative to the scan root. `''` is the root. */
  readonly cwd: string;
  readonly entries: readonly LoadEntry[];
  readonly skipped: readonly SkippedLoad[];
  readonly outOfScope: readonly OutOfScope[];
  readonly assumptions: readonly Assumption[];
  readonly hidden: readonly HiddenScope[];
  readonly limits: readonly LimitUsage[];
  /** `startup`: context at session start. `onDemand`: the most other triggers can add. */
  readonly totals: { readonly startup: Size; readonly onDemand: Size };
  /**
   * Parts the loader could not analyze, so entries may be missing: `markdown-budget:<path>`
   * (the scan's Markdown budget ran out), `unparsed:.codex/config.toml` (TOML is not parsed),
   * `unread:<path>` (the walker did not read the file).
   */
  readonly incomplete: readonly string[];
}

/**
 * One cell of the file-by-agent matrix.
 * - `startup`, `on-path`, `model-selected`, `manual`: loaded with that trigger.
 * - `start-dir`: Codex loads it when the session starts in that directory or below it.
 * - `listed`: a skill in the listing; its body loads when the model picks it.
 * - `partial`: loaded, but a limit cuts it.
 * - `skipped`: the agent skips it; the plan's `skipped` list says why.
 * - `unknown`: the behavior is not documented, or the file could not be analyzed.
 * - `not-read`: the agent does not read this file (shown as "—" in text output).
 */
export type MatrixCell =
  | 'startup'
  | 'on-path'
  | 'start-dir'
  | 'listed'
  | 'model-selected'
  | 'manual'
  | 'partial'
  | 'skipped'
  | 'unknown'
  | 'not-read';

/** Load plans for one scan: the `context` field of a ScanResult. */
export interface ContextReport {
  readonly agents: readonly ContextAgent[];
  /** Every source cited by `evidence` in the plans. */
  readonly sources: Readonly<Record<SourceKey, RuleSource>>;
  readonly plans: readonly LoadPlan[];
  /** With `--matrix`. `cells[i]` is the state for `agents[i]`. */
  readonly matrix?: {
    readonly rows: readonly {
      readonly path: string;
      readonly kind: ArtifactKind;
      readonly cells: readonly MatrixCell[];
    }[];
  };
}
