/**
 * Skill frontmatter fields outside the Agent Skills specification that an agent documents: who
 * reads each one, and what removing it changes. skill/non-portable-field reports these fields,
 * and its `#remove` fix prints the change as a note.
 *
 * Checked 2026-10-17 against the frontmatter references of Claude Code
 * (code.claude.com/docs/en/skills), Cursor (cursor.com/docs/skills), GitHub Copilot in VS Code
 * (code.visualstudio.com/docs/agent-customization/agent-skills) and Devin Local
 * (docs.devin.ai/cli/extensibility/skills/creating-skills, again 2026-10-30), which
 * skill/non-portable-field cites.
 * Cline documents only `name` and `description` (docs.cline.bot/customization/skills). Each note
 * states the default the agents fall back to.
 */
import type { PlatformId } from '../../core/types.js';

/** One documented extension field. */
export interface FieldEffect {
  /** The agents whose documentation lists the field. */
  readonly readers: readonly PlatformId[];
  /**
   * False when removing the field widens what the model may do: it may then load the skill on
   * its own, call tools the skill withholds, or run without the hooks that guard its tool calls.
   * Such a field is never removed by a fix.
   */
  readonly removable: boolean;
  /** One sentence: what the agents do without the field. */
  readonly withoutIt: string;
}

export const FIELD_EFFECTS: Readonly<Record<string, FieldEffect>> = {
  when_to_use: {
    readers: ['claude-code'],
    removable: true,
    withoutIt: 'Without "when_to_use", Claude Code matches requests against the description alone.',
  },
  'argument-hint': {
    readers: ['claude-code', 'copilot', 'windsurf'],
    removable: true,
    withoutIt:
      'Without "argument-hint", Claude Code, GitHub Copilot and Devin Local show no hint for the arguments when the skill is typed as a / command.',
  },
  arguments: {
    readers: ['claude-code'],
    removable: true,
    withoutIt:
      'Without "arguments", Claude Code no longer replaces the named $name placeholders in the skill with its arguments.',
  },
  'disable-model-invocation': {
    readers: ['claude-code', 'cursor', 'copilot'],
    removable: false,
    withoutIt:
      'Without "disable-model-invocation", Claude Code, Cursor and GitHub Copilot may load the skill on their own.',
  },
  'user-invocable': {
    readers: ['claude-code', 'copilot'],
    removable: true,
    withoutIt:
      'Without "user-invocable", Claude Code and GitHub Copilot list the skill in the / menu and run it when a user types its command.',
  },
  'disallowed-tools': {
    readers: ['claude-code'],
    removable: false,
    withoutIt:
      'Without "disallowed-tools", Claude Code lets the model call the tools this skill withholds.',
  },
  model: {
    readers: ['claude-code', 'windsurf'],
    removable: true,
    withoutIt:
      'Without "model", Claude Code and Devin Local run the skill with the session\'s model.',
  },
  effort: {
    readers: ['claude-code'],
    removable: true,
    withoutIt: 'Without "effort", Claude Code runs the skill at the session\'s effort level.',
  },
  context: {
    readers: ['claude-code', 'copilot'],
    removable: true,
    withoutIt:
      'Without "context", Claude Code and GitHub Copilot run the skill in the main conversation instead of a forked subagent.',
  },
  agent: {
    readers: ['claude-code', 'windsurf'],
    // Devin Local applies the tool restrictions of the named subagent profile.
    removable: false,
    withoutIt:
      'Without "agent", Claude Code runs the skill in the general-purpose subagent when it forks, and Devin Local runs it without the tool restrictions of the named subagent profile.',
  },
  background: {
    readers: ['claude-code'],
    removable: true,
    withoutIt:
      'Without "background", Claude Code runs a forked skill in the background instead of waiting for its result.',
  },
  hooks: {
    readers: ['claude-code'],
    removable: false,
    withoutIt:
      'Without "hooks", Claude Code no longer registers the hooks this skill defines, and hooks can block tool calls.',
  },
  paths: {
    readers: ['claude-code', 'cursor'],
    removable: true,
    withoutIt:
      'Without "paths", Claude Code and Cursor apply the skill to every file, not only to files that match its patterns.',
  },
  shell: {
    readers: ['claude-code'],
    removable: true,
    withoutIt: 'Without "shell", Claude Code runs the skill\'s ! commands with bash.',
  },
  icon: {
    readers: ['cursor'],
    removable: true,
    withoutIt: 'Without "icon", Cursor shows the default lightning icon on the skill\'s badge.',
  },
  color: {
    readers: ['cursor'],
    removable: true,
    withoutIt: 'Without "color", Cursor shows the skill\'s badge in the default color.',
  },
  globs: {
    readers: ['cursor'],
    removable: true,
    withoutIt:
      'Without "globs", Cursor applies the skill to every file unless "paths" limits it; Cursor reads "globs" only as a fallback for "paths".',
  },
  triggers: {
    readers: ['windsurf'],
    // The default, `[user, model]`, lets the model invoke the skill on its own.
    removable: false,
    withoutIt:
      'Without "triggers", Devin Local lets the model invoke the skill on its own as well as the user.',
  },
  permissions: {
    readers: ['windsurf'],
    // `deny` is how Devin Local blocks a tool for an inline skill.
    removable: false,
    withoutIt:
      'Without "permissions", Devin Local no longer blocks the tools and scopes this skill denies, and asks only as the session\'s permissions say.',
  },
  subagent: {
    readers: ['windsurf'],
    // An inline skill gets its own `allowed-tools` and `permissions`, a subagent its profile's.
    removable: false,
    withoutIt:
      'Without "subagent", Devin Local runs the skill inline, where its "allowed-tools" are auto-approved, instead of as a subagent.',
  },
};

/** The documented extension field `key`, or undefined for a field no agent documents. */
export function fieldEffect(key: string): FieldEffect | undefined {
  return Object.hasOwn(FIELD_EFFECTS, key) ? FIELD_EFFECTS[key] : undefined;
}
