/**
 * Hook event names each platform fires, transcribed 2026-10-14. Matching is case-sensitive on
 * every platform. Re-transcribe when the sources change.
 */
/** https://code.claude.com/docs/en/hooks (hook lifecycle table). */
export const CLAUDE_EVENTS = [
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
] as const;

/**
 * https://learn.chatgpt.com/docs/hooks and codex-rs/hooks/src/lib.rs (`HOOK_EVENT_NAMES`), with
 * serde `rename` per field in codex-rs/config/src/hook_config.rs.
 */
export const CODEX_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;

/** https://cursor.com/docs/hooks (agent, Tab and app lifecycle hooks). */
export const CURSOR_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'beforeSubmitPrompt',
  'preCompact',
  'stop',
  'afterAgentResponse',
  'afterAgentThought',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
] as const;

/**
 * https://geminicli.com/docs/hooks/reference and packages/core/src/hooks/types.ts
 * (`HookEventName`).
 */
export const GEMINI_EVENTS = [
  'BeforeTool',
  'AfterTool',
  'BeforeAgent',
  'Notification',
  'AfterAgent',
  'SessionStart',
  'SessionEnd',
  'PreCompress',
  'BeforeModel',
  'AfterModel',
  'BeforeToolSelection',
] as const;

/** Keys of Gemini CLI's `hooks` object that configure hooks rather than name events. */
export const GEMINI_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'disabled',
  'notifications',
]);

export type HookPlatform = 'claude-code' | 'codex' | 'cursor' | 'gemini';

export const HOOK_EVENTS: Readonly<Record<HookPlatform, readonly string[]>> = {
  'claude-code': CLAUDE_EVENTS,
  codex: CODEX_EVENTS,
  cursor: CURSOR_EVENTS,
  gemini: GEMINI_EVENTS,
};

export const HOOK_PLATFORMS: readonly HookPlatform[] = ['claude-code', 'codex', 'cursor', 'gemini'];
