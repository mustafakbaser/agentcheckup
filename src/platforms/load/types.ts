/**
 * Load-plan contract: what one agent loads for one working directory. Loaders in this directory
 * build it from the same parsed artifacts the rules use, and reports render it. Pure data. See
 * docs/adr/0007-model-what-each-agent-loads.md.
 *
 * Paths are POSIX, relative to the scan root, never absolute (see src/core/types.ts). Plans
 * cover the repository only: managed, user, global and account scopes are listed in `hidden`,
 * never read (ADR 0003).
 */
import type { ArtifactKind, FixClass, PlatformId, RuleSource } from '../../core/types.js';

/**
 * Every agent the load-plan contract names, in report order: PLATFORM_IDS order, with the
 * surfaces of one platform next to each other. Copilot loads different files on the CLI, in
 * VS Code and as the cloud agent on GitHub.com, so each surface is an agent of its own. Devin
 * Local, the default agent of Devin Desktop (formerly Windsurf), is `windsurf`.
 */
export const ALL_CONTEXT_AGENTS = [
  'claude-code',
  'codex',
  'cursor',
  'copilot-cli',
  'copilot-vscode',
  'copilot-cloud',
  'gemini',
  'windsurf',
  'cline',
] as const;
export type ContextAgent = (typeof ALL_CONTEXT_AGENTS)[number];

/**
 * The platform each agent belongs to: the id rules, findings and the configuration's `targets`
 * use. Several agents can share one platform, as the Copilot surfaces do.
 */
export const CONTEXT_PLATFORM: Readonly<Record<ContextAgent, PlatformId>> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  'copilot-cli': 'copilot',
  'copilot-vscode': 'copilot',
  'copilot-cloud': 'copilot',
  gemini: 'gemini',
  windsurf: 'windsurf',
  cline: 'cline',
};

/**
 * Whether each agent's loader is turned on: the one switch per agent. An agent that is off is
 * not planned anywhere: not by `context`, `--agent`, a scan with `--context`, the matrix, the
 * consistency check or the corpus harness.
 */
export const LOADER_ENABLED: Readonly<Record<ContextAgent, boolean>> = {
  'claude-code': true,
  codex: true,
  cursor: true,
  'copilot-cli': true,
  'copilot-vscode': true,
  'copilot-cloud': true,
  gemini: true,
  windsurf: true,
  cline: true,
};

/** Each agent's name in messages and reports. */
export const AGENT_NAMES: Readonly<Record<ContextAgent, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'copilot-cli': 'Copilot CLI',
  'copilot-vscode': 'Copilot in VS Code',
  'copilot-cloud': 'Copilot cloud agent',
  gemini: 'Gemini CLI',
  windsurf: 'Devin Local',
  cline: 'Cline',
};

/** Agents with a load model that is turned on ({@link LOADER_ENABLED}), in report order. */
export const CONTEXT_AGENTS: readonly ContextAgent[] = ALL_CONTEXT_AGENTS.filter(
  (agent) => LOADER_ENABLED[agent],
);

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
 * - `unknown`: the agent reads the file, but when is not documented, such as a Cursor rule whose
 *   frontmatter is not valid YAML. Always `unverified`.
 */
export type LoadTrigger =
  'startup' | 'on-path' | 'model-selected' | 'manual' | 'on-approval' | 'unknown';

/**
 * Triggers in assembly order: what is in the prompt first, then what can join later, then what
 * cannot be told. Plans sort entries without a position by this rank.
 */
export const TRIGGER_RANK: Readonly<Record<LoadTrigger, number>> = {
  startup: 0,
  'on-path': 1,
  'model-selected': 2,
  manual: 3,
  'on-approval': 4,
  unknown: 5,
};

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
 * - `wrong-location`: the file is not in a location where the agent reads files of its kind,
 *   such as Copilot instructions outside `.github/`.
 * - `no-apply-to`: a path-specific instructions file without a valid `applyTo`, which the
 *   Copilot cloud agent never applies.
 * - `shadowed-by-preferred`: the agent reads a file it prefers for the same purpose instead,
 *   such as `.devin/global_rules.md` over `.windsurf/global_rules.md`.
 * - `disabled`: a setting in the repository turns the file or item off, such as Devin's
 *   `read_config_from` or `enabled = false` on a Codex MCP server.
 * - `never-active`: the file's own settings keep it from ever applying, such as a Cline rule
 *   with `paths: []`.
 * - `invalid-toml`: the config file is not valid TOML.
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
  | 'wrong-location'
  | 'no-apply-to'
  | 'shadowed-by-preferred'
  | 'disabled'
  | 'never-active'
  | 'invalid-toml'
  | 'not-read';

/**
 * How the fix that removes a skip is applied: its class (`safe`, `review`), or `input` when it
 * needs the user's words first (`Fix.input`), which only `agentcheckup fix -i` asks for. Not a
 * FixClass: a fix that needs words still has a class, which says how much trust the completed
 * fix needs.
 */
export type SkipFix = FixClass | 'input';

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
  /**
   * The rule whose finding reports this skip: an unsuppressed finding of it on `path` lists the
   * agent. Absent for `not-read`, and where no rule reports the skip, such as a CLAUDE.md over
   * Claude Code's 4 MiB limit or an import in a template folder the rules leave alone.
   * src/platforms/load/consistency.ts lists every case.
   */
  readonly ruleId?: string;
  /**
   * What the agent would receive if it loaded the file, so a report can say what the skip
   * costs. Absent when the loader cannot tell, as for MCP servers and hooks.
   */
  readonly size?: Size;
  /**
   * How the fix on the finding with the same `ruleId` and `path` is applied, set when plans are
   * assembled. Absent when no unsuppressed finding of that rule carries a fix.
   */
  readonly fix?: SkipFix;
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
 *
 * `key` and `subject` identify a usage within a plan; `--baseline` matches usages by them.
 */
export interface LimitUsage {
  /** For example `codex.project_doc_max_bytes`. */
  readonly key: string;
  /**
   * `levels`: directory levels below a search root. `directories`: directories a search visits.
   * `tokens`: the estimate of `Size.tokens`, for a limit the agent sets in tokens.
   */
  readonly unit:
    'bytes' | 'chars' | 'lines' | 'hops' | 'levels' | 'directories' | 'context-fraction' | 'tokens';
  /** Null when the limit depends on the model's context window and none was given. */
  readonly limit: number | null;
  readonly used: number;
  /**
   * What the usage is measured on, always a path relative to the scan root (`''` is the root),
   * so a rebase can prefix it like any other path: a file, a directory, or, for a group of
   * files, the working directory the group is computed for (Codex's AGENTS.md chain and the
   * skills listing of a session started there). `label` names such a group.
   */
  readonly subject: string;
  /**
   * Words for a subject that stands for a group rather than one file, such as `AGENTS.md chain`
   * or `skills listing`. Display text only: never a path, never rebased, not part of the
   * identity.
   */
  readonly label?: string;
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
   * (the scan's Markdown budget ran out), `unparsed:<path>` (a parser limit, or UTF-16 text),
   * `unread:<path>` (the walker did not read the file), `fallback:<path>` (a Codex
   * `project_doc_fallback_filenames` file, which plans do not follow).
   */
  readonly incomplete: readonly string[];
  /**
   * How many files the plan leaves out because the configuration's `ignore` matches them: files
   * it would otherwise list as entries, skips, out of scope or incomplete. The agent may still
   * load them; agentcheckup was told not to look. Absent when none. See `withoutIgnored` in
   * ./index.ts.
   */
  readonly ignored?: number;
}

/**
 * One cell of the file-by-agent matrix.
 * - `startup`, `on-path`, `model-selected`, `manual`: loaded with that trigger. MCP servers and
 *   hooks the agent asks about first (`on-approval`) are `startup`: they start with the session.
 * - `start-dir`: the agent loads it only when the session starts in that directory or below it,
 *   as Codex does with a nested AGENTS.md.
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
