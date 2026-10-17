/**
 * Which hook events each platform fires, where hook handlers sit in its configuration files, and
 * whether a failing handler lets the action proceed. Shared by the hooks/* rules, the security
 * inventory and the load plans.
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

/**
 * GitHub Copilot, transcribed 2026-10-17 from the hooks reference (SOURCES.copilotHooksReference,
 * event table) and VS Code's hooks reference (SOURCES.vscodeHooksReference), which read the same
 * `.github/hooks/*.json` files. The CLI and the cloud agent take the camelCase names; a PascalCase
 * name selects the VS Code-compatible payload, and VS Code documents only PascalCase names.
 * `subagentStart` and `userPromptTransformed` have no documented PascalCase name; `SubagentStart`
 * is VS Code's.
 */
export const COPILOT_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'userPromptTransformed',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'permissionRequest',
  'notification',
  'preCompact',
  'subagentStart',
  'subagentStop',
  'agentStop',
  'errorOccurred',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'ErrorOccurred',
] as const;

/**
 * Devin Local (Devin Desktop's default agent, shared with Devin CLI), transcribed 2026-10-17 from
 * SOURCES.devinCliHooks and SOURCES.devinCliHookEvents. Cascade's snake_case events in the legacy
 * `.devin/hooks.json` are not modeled.
 */
export const DEVIN_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'Stop',
  'PostCompaction',
  'SessionStart',
  'SessionEnd',
] as const;

/**
 * Keys of the `hooks` table in Codex's `config.toml` that configure hooks rather than name events.
 * Codex reads `hooks.state` only from user and session layers, so it has no effect in a project
 * file (SOURCES.codexHookState).
 */
export const CODEX_TOML_CONFIG_KEYS: ReadonlySet<string> = new Set(['state']);

/** Platforms that run hooks from files in the repository. Devin Local is `windsurf`. */
export type HookPlatform = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'windsurf';

export const HOOK_EVENTS: Readonly<Record<HookPlatform, readonly string[]>> = {
  'claude-code': CLAUDE_EVENTS,
  codex: CODEX_EVENTS,
  cursor: CURSOR_EVENTS,
  gemini: GEMINI_EVENTS,
  copilot: COPILOT_EVENTS,
  windsurf: DEVIN_EVENTS,
};

/**
 * Every hook platform. hooks/unknown-event names the first platform in this order that fires an
 * event a file uses, so the four platforms modeled first keep their place.
 */
export const HOOK_PLATFORMS: readonly HookPlatform[] = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'windsurf',
];

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

/**
 * Where a file keeps its hook events:
 * - `hooks`: in the object under the top-level `"hooks"` key.
 * - `document`: the whole document is that object, as in Devin Local's `.devin/hooks.v1.json`
 *   ("no wrapper key needed", SOURCES.devinCliHooks). A file that has the wrapper anyway is read
 *   through it.
 */
export type HookRoot = 'hooks' | 'document';

export interface HookSource {
  readonly platform: HookPlatform;
  readonly root: HookRoot;
}

const HOOK_SOURCE_BY_KIND: Readonly<Partial<Record<ArtifactKind, HookSource>>> = {
  'claude-settings': { platform: 'claude-code', root: 'hooks' },
  'codex-hooks': { platform: 'codex', root: 'hooks' },
  'cursor-hooks': { platform: 'cursor', root: 'hooks' },
  'gemini-settings': { platform: 'gemini', root: 'hooks' },
  'copilot-hooks': { platform: 'copilot', root: 'hooks' },
  'copilot-settings': { platform: 'copilot', root: 'hooks' },
  'devin-config': { platform: 'windsurf', root: 'hooks' },
};

/** The `.devin/hooks*.json` file Devin Local reads. */
const DEVIN_HOOKS_FILE = 'hooks.v1.json';

/**
 * The platform that reads hooks from this file and where it keeps them. Of the two
 * `.devin/hooks*.json` files, Devin Local reads `hooks.v1.json`; `hooks.json` is Cascade's, whose
 * format is not modeled, so it has none.
 */
export function hookSourceOf(artifact: Pick<Artifact, 'kind' | 'path'>): HookSource | undefined {
  if (artifact.kind === 'devin-hooks') {
    const name = artifact.path.slice(artifact.path.lastIndexOf('/') + 1).toLowerCase();
    return name === DEVIN_HOOKS_FILE ? { platform: 'windsurf', root: 'document' } : undefined;
  }
  return HOOK_SOURCE_BY_KIND[artifact.kind];
}

/** The platform that reads hooks from this file. */
export function hookPlatformOf(
  artifact: Pick<Artifact, 'kind' | 'path'>,
): HookPlatform | undefined {
  return hookSourceOf(artifact)?.platform;
}

export interface HookEvent {
  readonly name: string;
  readonly path: JsonPath;
  readonly entries: unknown;
}

/**
 * Keys of the events object, except Gemini CLI's configuration keys: the top-level `hooks`
 * object, or with `root: 'document'` the document itself ({@link HookRoot}).
 */
export function hookEvents(
  doc: ParsedJson,
  platform: HookPlatform,
  root: HookRoot = 'hooks',
): HookEvent[] {
  const value = doc.value;
  if (!isObject(value)) return [];
  const wrapped = own(value, 'hooks');
  const hooks = root === 'document' && !isObject(wrapped) ? value : wrapped;
  if (!isObject(hooks)) return [];
  const base: JsonPath = hooks === value ? [] : ['hooks'];
  return Object.keys(hooks)
    .filter((name) => !(platform === 'gemini' && GEMINI_CONFIG_KEYS.has(name)))
    .map((name) => ({ name, path: [...base, name], entries: hooks[name] }));
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
  /** Where the file keeps its events ({@link hookSourceOf}). Default `hooks`. */
  readonly root?: HookRoot;
}

/** Platforms that list handlers directly under each event, without matcher groups. */
const FLAT_HANDLERS: ReadonlySet<HookPlatform> = new Set(['cursor', 'copilot']);

/**
 * Hook handlers in document order, for events the platform fires. Handlers under unknown event
 * names never run (hooks/unknown-event reports them), so rules about how a hook runs skip them.
 * Claude Code, Codex, Gemini CLI and Devin Local nest handlers as `hooks.<Event>[i].hooks[j]`;
 * Cursor and GitHub Copilot list them directly as `hooks.<event>[i]`, with any matcher on the
 * handler itself.
 */
export function hookHandlers(
  doc: ParsedJson,
  platform: HookPlatform,
  options: HookHandlerOptions = {},
): HookHandler[] {
  const fired = HOOK_EVENTS[platform];
  return eventHandlers(
    hookEvents(doc, platform, options.root).filter(
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
      if (FLAT_HANDLERS.has(platform)) {
        // Cursor and Copilot both read a handler without `type` as a command hook.
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
  copilot: new Set(['preToolUse', 'PreToolUse']),
  windsurf: new Set(['PreToolUse']),
};

/**
 * True when a crash or a failure to start (in all but Gemini CLI also a timeout) of this handler
 * lets the action proceed: Claude Code command and HTTP hooks without `"onFailure": "block"` that
 * are not async, Cursor command hooks without `"failClosed": true`, every Codex, Gemini CLI and
 * Devin Local command hook (SOURCES.devinCliHooks: only exit code 2 blocks), and GitHub Copilot
 * HTTP hooks. hooks/fails-open cites the sources.
 *
 * Copilot `preToolUse` command hooks fail closed: a crash or any non-zero exit denies the tool
 * call on the CLI and the cloud agent; only a timeout lets it proceed
 * (SOURCES.copilotHooksReference). Under the PascalCase name `PreToolUse` they fail open, because
 * VS Code, which reads the same files and documents only PascalCase names, continues after any
 * exit code but 2 (SOURCES.vscodeHooksReference). `event` is the event the handler is registered
 * for; only Copilot needs it.
 */
export function failsOpen(
  platform: HookPlatform,
  type: string | undefined,
  handler: JsonObject,
  event?: string,
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
    case 'copilot':
      return type === 'http' || (type === 'command' && event !== 'preToolUse');
    case 'codex':
    case 'gemini':
    case 'windsurf':
      return type === 'command';
  }
}

/** A tool-gating hook that lets the tool call proceed when it fails, as hooks/fails-open reports. */
export function gateFailsOpen(platform: HookPlatform, hook: HookHandler): boolean {
  return (
    TOOL_GATES[platform].has(hook.event) && failsOpen(platform, hook.type, hook.handler, hook.event)
  );
}
