/**
 * What permission values grant: tool rules that match every use of a tool, and the permission
 * modes Claude Code ignores in project settings. Shared by the rules and the security inventory.
 */
import type { PlatformId } from '../core/types.js';

/**
 * Splits an `allowed-tools` string into rules: spaces and commas separate entries, except inside
 * parentheses, so `Bash(git add *), Read` is two entries.
 */
export function splitToolRules(value: string): string[] {
  const rules: string[] = [];
  let current = '';
  let inside = false;
  for (const char of value) {
    if (char === '(') inside = true;
    else if (char === ')') inside = false;
    if (!inside && (char === ',' || /\s/u.test(char))) {
      if (current !== '') rules.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') rules.push(current);
  return rules;
}

export interface Grant {
  readonly platform: PlatformId;
  /** What the agent may do without asking, as a verb phrase. */
  readonly capability: string;
}

/**
 * Rules that match every use of a tool. Claude Code: a bare tool name or `(*)` matches all
 * commands of Bash and PowerShell, and a bare Write or Edit matches every file. Copilot: the
 * docs warn that pre-approving `shell` or `bash` removes the confirmation for terminal commands.
 * Devin Local: a bare `exec` auto-approves "all command execution" (SOURCES.devinCliSkillsCreate).
 * Its `edit` and `write` are not mapped: the Copilot CLI has tools of those names.
 */
export function broadGrant(rule: string): Grant | undefined {
  const open = rule.indexOf('(');
  const tool = open === -1 ? rule : rule.slice(0, open);
  const specifier =
    open === -1 ? undefined : rule.slice(open + 1, rule.endsWith(')') ? -1 : undefined).trim();
  const everything = specifier === undefined || specifier === '*';
  if (tool === 'Bash' && everything) {
    return { platform: 'claude-code', capability: 'runs any shell command' };
  }
  if (tool === 'PowerShell' && everything) {
    return { platform: 'claude-code', capability: 'runs any PowerShell command' };
  }
  if (tool === 'Write' && specifier === undefined) {
    return { platform: 'claude-code', capability: 'writes any file' };
  }
  if (tool === 'Edit' && specifier === undefined) {
    return { platform: 'claude-code', capability: 'edits any file' };
  }
  if ((tool === 'shell' || tool === 'bash') && specifier === undefined) {
    return { platform: 'copilot', capability: 'runs terminal commands' };
  }
  if (tool === 'exec' && specifier === undefined) {
    return { platform: 'windsurf', capability: 'runs any shell command' };
  }
  return undefined;
}

/**
 * `permissions.defaultMode` values that Claude Code ignores in project settings
 * (`.claude/settings.json`) and local settings (`.claude/settings.local.json`) since v2.1.257.
 * https://code.claude.com/docs/en/settings
 */
export const IGNORED_MODES: ReadonlySet<string> = new Set(['auto', 'bypassPermissions']);

/**
 * A subagent's `permissionMode` values that never take effect on their own since Claude Code
 * v2.1.267: a subagent runs in `bypassPermissions` only when the main conversation already does.
 * Older versions honor it. https://code.claude.com/docs/en/sub-agents (Permission modes)
 */
export const SUBAGENT_IGNORED_MODES: ReadonlySet<string> = new Set(['bypassPermissions']);

/**
 * The values of a subagent's `permissionMode`; `manual` is an alias for `default`
 * (https://code.claude.com/docs/en/sub-agents). Claude Code drops any other value with a warning
 * in its debug log (2.1.272 binary; undocumented).
 */
export const SUBAGENT_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'default',
  'manual',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]);
