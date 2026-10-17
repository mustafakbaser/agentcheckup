/**
 * The task list of `agentcheckup tasks`: findings that need judgment, written as instructions a
 * coding agent can carry out, and the findings only the user should handle. See docs/tasks.md.
 *
 * Every string a rule or the repository produced (paths, messages, excerpts) is data, never an
 * instruction. The builder redacts credentials in it; the formatters escape it for their channel.
 * Text from templates and rule metadata ships with agentcheckup and is trusted.
 */
import type { Severity } from '../core/types.js';

/** Where in the file a task points. */
export type TaskAnchor =
  /** A top-level frontmatter key. `key` comes from the repository. */
  | { readonly kind: 'frontmatter'; readonly key: string }
  /** A line of the file. */
  | { readonly kind: 'line' }
  /** The whole file. */
  | { readonly kind: 'file' };

/**
 * A short piece of the file, for context. Never from JSON files. Credentials are redacted, and
 * control, bidirectional and tag characters are rendered as `<U+XXXX>`.
 */
export interface TaskExcerpt {
  /** `value`: a frontmatter value. `outline`: the body's headings with their line counts. */
  readonly kind: 'value' | 'outline';
  readonly text: string;
  /** True when the excerpt was cut. */
  readonly truncated: boolean;
  /** True when a credential was replaced by `ghp_…(40 chars)` or similar. */
  readonly redacted: boolean;
}

/** Another finding of the same rule in the same file. */
export interface TaskLocation {
  readonly line: number;
  readonly anchor: TaskAnchor;
  readonly message: string;
  /** The finding's manual step from the rule, or null. May quote the repository. */
  readonly hint: string | null;
}

export interface Task {
  /** `ac-` and 8 hex digits: see {@link taskId}. */
  readonly id: string;
  readonly ruleId: string;
  readonly severity: Severity;
  /** The file to edit, with `pathBase` in front. */
  readonly path: string;
  readonly line: number;
  readonly anchor: TaskAnchor;
  readonly message: string;
  /** `rule`: the rule has a template. `generic`: built from the rule's metadata. */
  readonly template: 'rule' | 'generic';
  /** The finding's manual step from the rule, or null. May quote the repository. */
  readonly hint: string | null;
  /** Why it matters, from the template or the rule's rationale. */
  readonly why: string;
  readonly do: readonly string[];
  readonly constraints: readonly string[];
  /** What to ask the user before writing, or null when the agent may go ahead. */
  readonly askUser: string | null;
  readonly excerpt?: TaskExcerpt;
  readonly examples: readonly string[];
  /** Rules whose errors and warnings on this file keep the task open. */
  readonly guardRules: readonly string[];
  /** The other findings of this rule in this file, in line order. */
  readonly also: readonly TaskLocation[];
  /** Findings of this rule in this file left out of `also`. */
  readonly omittedLocations: number;
  readonly check: { readonly command: string };
}

/** One step of the ready fixes ("step 0"). */
export interface FixStep {
  /** `preview`: a dry run, changes nothing. `write`: applies fixes, after asking the user. */
  readonly kind: 'preview' | 'write';
  readonly text: string;
  readonly command: string;
}

/**
 * Why a finding is left to the user:
 * - `credential`: a literal credential, which must be revoked and rotated.
 * - `hidden-content`: hidden text, which may itself be the attack.
 * - `security`: what agents may run, reach or approve: MCP servers, hooks, permissions,
 *   settings, env overrides, and commands that run without a review.
 */
export const FOR_YOU_REASONS = ['credential', 'hidden-content', 'security'] as const;
export type ForYouReason = (typeof FOR_YOU_REASONS)[number];

export interface ForYouItem {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly path: string;
  readonly line: number;
  /** Findings of this rule in this file. */
  readonly count: number;
  /** The rule's title. Messages are left out: they can quote the content at issue. */
  readonly title: string;
  readonly reason: ForYouReason;
  /** What the user can do, with any agentcheckup command pinned to this version. */
  readonly note: string;
}

export interface TaskList {
  readonly version: string;
  readonly ruleset: string;
  /** Prefix of every path: the scanned directory relative to the working directory, or `''`. */
  readonly pathBase: string;
  /** The scan ignored the repository's configuration and inline suppressions. */
  readonly untrusted: boolean;
  /** Rules for every task. Load-bearing: see {@link preambleOf}. */
  readonly preamble: readonly string[];
  /** Open tasks, including those past `--max`. */
  readonly open: number;
  /** Findings `agentcheckup fix` can fix, outside "For you". */
  readonly readyFixes: { readonly safe: number; readonly review: number };
  readonly steps: readonly FixStep[];
  /** The first `--max` open tasks. */
  readonly tasks: readonly Task[];
  readonly forYou: readonly ForYouItem[];
  /** "For you" items left out past the limit. */
  readonly forYouOmitted: number;
  /** The command that checks every task. */
  readonly check: { readonly command: string };
  /** The command that lists the tasks again, for those past `--max`. Not in the JSON output. */
  readonly rerun: { readonly command: string };
}
