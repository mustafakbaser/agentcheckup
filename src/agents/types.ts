/**
 * Agent definitions: the custom agents and subagents a repository defines, which agents read each
 * file, and the models they run with as far as the repository can tell. Pure data. See
 * docs/adr/0013-list-agent-definitions-and-their-models.md.
 *
 * Like the security inventory, the list does not depend on the working directory: a definition
 * is listed for each agent that reads its file from the repository root. What only a user or an
 * organization sets (user settings, managed allowlists, the model a call passes) is never read;
 * the command lists it as not visible.
 */
import type { Certainty, ContextAgent, SourceKey } from '../platforms/load/types.js';

/**
 * How a model value is written, as the agent that reads the file documents its values:
 * - `inherit`: the parent session's model.
 * - `alias`: a short name the agent resolves, such as Claude Code's `sonnet`.
 * - `id`: a model id, such as `claude-sonnet-5-5` or `gpt-6.1-sol`.
 * - `name`: a display name, as GitHub Copilot in VS Code takes them (`Claude Sonnet 4.5`).
 * - `not-documented`: none of the forms the agent documents, such as `Claude Sonnet 4` for
 *   Claude Code or a Claude alias for Cursor.
 */
export type ModelForm = 'inherit' | 'alias' | 'id' | 'name' | 'not-documented';

export interface ModelValue {
  /** As written: a list where the agent takes one, as Copilot does. */
  readonly value: string | readonly string[];
  readonly form: ModelForm;
  /** 1-based line of the value. */
  readonly line: number;
}

/**
 * The model a definition runs with, as far as the repository says:
 * - `definition`: its own `model`;
 * - `setting`: a repository setting for subagents, such as `CLAUDE_CODE_SUBAGENT_MODEL` or
 *   Codex's `agents.default_subagent_model`;
 * - `session`: the session's model from a repository setting, when the definition inherits it;
 * - `not-visible`: chosen where agentcheckup cannot look, such as the user's model.
 */
export interface EffectiveModel {
  readonly value?: string | readonly string[];
  readonly source: 'definition' | 'setting' | 'session' | 'not-visible';
  /** The repository file of a `setting` or `session` value. */
  readonly file?: string;
  /**
   * The setting that makes the agent ignore the definition's own model, when it has one: Claude
   * Code's `env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, or a Gemini CLI per-agent override.
   */
  readonly overridden?: { readonly key: string; readonly file: string };
}

/**
 * What the agent does with the file:
 * - `loads`: the agent lists the definition;
 * - `skipped`: the agent drops it, for `reason`;
 * - `shadowed`: another definition with the same name wins;
 * - `unknown`: whether it loads is not documented.
 */
export type DefinitionStatus = 'loads' | 'skipped' | 'shadowed' | 'unknown';

/** One definition as one agent reads it. */
export interface AgentDefinition {
  /**
   * `agent:<file>@<agent>`: a file read by several agents gives one definition each. A role a
   * `.codex/config.toml` declares without an agent file is `agent:<file>#<name>@codex`.
   */
  readonly id: string;
  readonly file: string;
  /** 1-based line of the name, or 1. */
  readonly line: number;
  readonly agent: ContextAgent;
  /** The name the agent knows it by, such as Copilot CLI's `team--reviewer`. */
  readonly name?: string;
  readonly status: DefinitionStatus;
  /** Why the agent skips it, may not load it, or shadows it. Trusted text without paths. */
  readonly reason?: string;
  /** For `shadowed`: the file of the definition that wins. */
  readonly shadowedBy?: string;
  readonly model?: ModelValue;
  readonly effective: EffectiveModel;
  /** Reasoning effort, as written. */
  readonly effort?: { readonly value: string; readonly line: number };
  /** `inherited`: every tool of the parent; `listed`: the tools the file names; `read-only`. */
  readonly tools: 'inherited' | 'listed' | 'read-only';
  /** Claude Code's `permissionMode`, as written. */
  readonly permissionMode?: string;
  readonly certainty: Certainty;
  readonly evidence: readonly SourceKey[];
  /** Hash of the fields above but `line`; the same id with another digest: the item changed. */
  readonly digest: string;
}

/**
 * A repository setting that picks a model or an effort for an agent's sessions or subagents:
 * Claude Code's `model`, `env.ANTHROPIC_MODEL`, `env.ANTHROPIC_DEFAULT_MODEL`,
 * `env.CLAUDE_CODE_SUBAGENT_MODEL`, `availableModels`, `effortLevel` and the
 * `env.ANTHROPIC_DEFAULT_*_MODEL` an alias resolves to; Codex's `model`, `model_reasoning_effort`
 * and `agents.default_subagent_*`; Gemini CLI's `model.name` and per-agent overrides; GitHub
 * Copilot's `model` and `effortLevel`.
 */
export interface ModelSetting {
  /** `model:<file>#<key>`. */
  readonly id: string;
  readonly agent: ContextAgent;
  readonly file: string;
  readonly line: number;
  readonly key: string;
  /** As written, with credentials removed; a list joined with `, `. */
  readonly value: string;
  /**
   * What it sets: the session's model or effort, the subagents', the models allowed, or what an
   * alias such as `sonnet` resolves to.
   */
  readonly applies: 'session' | 'subagents' | 'allowed' | 'alias';
  /** For `env.CLAUDE_CODE_SUBAGENT_MODEL`: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on. */
  readonly forced?: boolean;
  readonly digest: string;
}

export interface AgentsReport {
  /** Sorted by id. */
  readonly definitions: readonly AgentDefinition[];
  /** Sorted by id. */
  readonly settings: readonly ModelSetting[];
}
