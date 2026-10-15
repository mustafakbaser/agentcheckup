/**
 * Which hook events each platform fires, and where hook handlers sit in its configuration file.
 */
import type { Artifact, ArtifactKind } from '../core/types.js';
import {
  isObject,
  type JsonObject,
  type JsonPath,
  own,
  type ParsedJson,
} from '../parse/json-access.js';

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/*
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

/**
 * Claude Code hook events Cursor runs from Claude Code settings files, and the Cursor event each
 * one becomes. https://cursor.com/docs/reference/third-party-hooks ("Hook Step Mapping"),
 * transcribed 2026-10-15. Events missing here have no documented mapping.
 */
export const CURSOR_EVENT_FOR_CLAUDE: Readonly<Record<string, string>> = {
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  UserPromptSubmit: 'beforeSubmitPrompt',
  Stop: 'stop',
  SubagentStop: 'subagentStop',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  PreCompact: 'preCompact',
};

/** Claude Code events the same page lists as not supported by Cursor. */
export const CURSOR_UNSUPPORTED_CLAUDE_EVENTS: ReadonlySet<string> = new Set([
  'Notification',
  'PermissionRequest',
]);

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

const HOOK_PLATFORM_BY_KIND: Readonly<Partial<Record<ArtifactKind, HookPlatform>>> = {
  'claude-settings': 'claude-code',
  'codex-hooks': 'codex',
  'cursor-hooks': 'cursor',
  'gemini-settings': 'gemini',
};

/** The platform that reads hooks from this kind of file. */
export function hookPlatformOf(artifact: Artifact): HookPlatform | undefined {
  return HOOK_PLATFORM_BY_KIND[artifact.kind];
}

export interface HookEvent {
  readonly name: string;
  readonly path: JsonPath;
  readonly entries: unknown;
}

/** Keys of the top-level `hooks` object, except Gemini CLI's configuration keys. */
export function hookEvents(doc: ParsedJson, platform: HookPlatform): HookEvent[] {
  const root = doc.value;
  if (!isObject(root)) return [];
  const hooks = own(root, 'hooks');
  if (!isObject(hooks)) return [];
  return Object.keys(hooks)
    .filter((name) => !(platform === 'gemini' && GEMINI_CONFIG_KEYS.has(name)))
    .map((name) => ({ name, path: ['hooks', name], entries: hooks[name] }));
}

export interface HookHandler {
  readonly event: string;
  /** False when the platform does not fire `event`, so the handler never runs. */
  readonly known: boolean;
  /**
   * The object that holds the matcher: the `{ "matcher", "hooks" }` group in Claude Code, Codex
   * and Gemini CLI, the handler itself in Cursor.
   */
  readonly group: JsonObject;
  readonly handler: JsonObject;
  /** Path of the handler object. */
  readonly path: JsonPath;
  /** `type`, with Cursor's default of "command" applied. */
  readonly type: string | undefined;
}

export interface HookHandlerOptions {
  /**
   * Also list handlers under event names the platform does not fire, with `known: false`. The
   * security inventory lists them; rules about how a hook runs leave them out. Default false.
   */
  readonly includeUnknown?: boolean;
}

/**
 * Hook handlers in document order, for events the platform fires. Handlers under unknown event
 * names never run (hooks/unknown-event reports them), so rules about how a hook runs skip them.
 * Claude Code, Codex and Gemini CLI nest handlers as `hooks.<Event>[i].hooks[j]`; Cursor lists
 * them directly as `hooks.<event>[i]`.
 */
export function hookHandlers(
  doc: ParsedJson,
  platform: HookPlatform,
  options: HookHandlerOptions = {},
): HookHandler[] {
  const fired = HOOK_EVENTS[platform];
  return eventHandlers(
    hookEvents(doc, platform).filter(
      (event) => options.includeUnknown === true || fired.includes(event.name),
    ),
    platform,
  );
}

/**
 * The handlers declared under `events`, in order, whether or not the platform fires those events.
 * Same shapes as {@link hookHandlers}; `known` tells whether the platform fires the event.
 */
export function eventHandlers(events: readonly HookEvent[], platform: HookPlatform): HookHandler[] {
  const fired = HOOK_EVENTS[platform];
  const out: HookHandler[] = [];
  for (const event of events) {
    const known = fired.includes(event.name);
    if (!Array.isArray(event.entries)) continue;
    event.entries.forEach((entry: unknown, i) => {
      if (!isObject(entry)) return;
      if (platform === 'cursor') {
        const type = own(entry, 'type');
        out.push({
          event: event.name,
          known,
          group: entry,
          handler: entry,
          path: [...event.path, i],
          type: typeof type === 'string' ? type : 'command',
        });
        return;
      }
      const inner = own(entry, 'hooks');
      if (!Array.isArray(inner)) return;
      inner.forEach((handler: unknown, j) => {
        if (!isObject(handler)) return;
        const type = own(handler, 'type');
        out.push({
          event: event.name,
          known,
          group: entry,
          handler,
          path: [...event.path, i, 'hooks', j],
          type: typeof type === 'string' ? type : undefined,
        });
      });
    });
  }
  return out;
}

/** Keys Codex allows at the top level of `.codex/hooks.json`. */
const CODEX_TOP_LEVEL: ReadonlySet<string> = new Set(['description', 'hooks']);

/**
 * Codex event names at the top level of a `.codex/hooks.json`, outside `"hooks"`, in document
 * order. Codex allows only `description` and `hooks` there, so any of these makes it skip the
 * whole file (codex-rs/config/src/hook_config.rs).
 */
export function codexMisplacedEvents(doc: ParsedJson): HookEvent[] {
  const root = doc.value;
  if (!isObject(root)) return [];
  const known: readonly string[] = CODEX_EVENTS;
  return Object.keys(root)
    .filter((key) => !CODEX_TOP_LEVEL.has(key) && known.includes(key))
    .map((name) => ({ name, path: [name], entries: root[name] }));
}

// ---------------------------------------------------------------------------------------------
// Failure behavior
// ---------------------------------------------------------------------------------------------

/** Events whose hooks can stop a tool call before it runs. */
export const TOOL_GATES: Readonly<Record<HookPlatform, ReadonlySet<string>>> = {
  'claude-code': new Set(['PreToolUse']),
  codex: new Set(['PreToolUse']),
  cursor: new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']),
  gemini: new Set(['BeforeTool']),
};

/**
 * True when a crash or a failure to start (in all but Gemini CLI also a timeout) of this handler
 * lets the action proceed: Claude Code command and HTTP hooks without `"onFailure": "block"` that
 * are not async, Cursor command hooks without `"failClosed": true`, and every Codex and Gemini
 * CLI command hook. hooks/fails-open cites the sources.
 */
export function failsOpen(
  platform: HookPlatform,
  type: string | undefined,
  handler: JsonObject,
): boolean {
  switch (platform) {
    case 'claude-code':
      return (
        (type === 'command' || type === 'http') &&
        own(handler, 'onFailure') !== 'block' &&
        own(handler, 'async') !== true &&
        own(handler, 'asyncRewake') !== true
      );
    case 'cursor':
      return type === 'command' && own(handler, 'failClosed') !== true;
    case 'codex':
    case 'gemini':
      return type === 'command';
  }
}

/** A tool-gating hook that lets the tool call proceed when it fails, as hooks/fails-open reports. */
export function gateFailsOpen(platform: HookPlatform, hook: HookHandler): boolean {
  return TOOL_GATES[platform].has(hook.event) && failsOpen(platform, hook.type, hook.handler);
}
