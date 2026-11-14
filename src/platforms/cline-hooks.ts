/**
 * Which files Cline runs as hooks, shared by the walker (which reads them so the inventory can
 * digest their content), the security inventory and the Cline load plan. Read at the released
 * versions, VS Code extension v4.1.26 and CLI v3.0.74 (src/platforms/sources.ts).
 *
 * A hook file is a script named after the event it runs on. The two surfaces find them
 * differently:
 * - The CLI, through the SDK (SOURCES.clineHookFileSource): a file directly in
 *   `<workspace>/.clinerules/hooks/` or `<workspace>/.cline/hooks/` whose name, without one of
 *   the extensions in {@link CLI_EXTENSIONS} and in any letter case, is an event of
 *   {@link CLINE_HOOK_EVENTS}. It runs every event but `PreCompact`, which the SDK maps to no
 *   event (`HOOK_CONFIG_FILE_EVENT_MAP`). It runs the file by its shebang, else by its extension,
 *   else with bash (SOURCES.clineHookRunnerSource). A symbolic link is not a file to it.
 * - The VS Code extension (SOURCES.clineVscodeHooksSource): `<workspace>/.clinerules/hooks/<Event>`
 *   with no extension, when it is executable, on macOS and Linux, and `<Event>.ps1` on Windows.
 *   It runs `TaskStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskComplete` and
 *   `TaskCancel` (SOURCES.clineVscodeHookEventsSource). It does not read `.cline/hooks/`.
 *
 * Both let the action go ahead when a hook fails or times out.
 */
import { dirnamePosix } from '../core/paths.js';
import { clinePlace } from './cline-rules.js';
import { basename } from './paths.js';

/** The hook file names of the SDK (`HookConfigFileName`), in its order. */
export const CLINE_HOOK_EVENTS = [
  'TaskStart',
  'TaskResume',
  'TaskCancel',
  'TaskComplete',
  'TaskError',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'SessionShutdown',
] as const;
export type ClineHookEvent = (typeof CLINE_HOOK_EVENTS)[number];

/** Extensions the CLI accepts on a hook file, lowercase; `''` is none. */
const CLI_EXTENSIONS: ReadonlySet<string> = new Set([
  '',
  '.sh',
  '.bash',
  '.zsh',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.py',
  '.ps1',
]);

/** Events the VS Code extension runs hook files for. */
const VSCODE_EVENTS: ReadonlySet<ClineHookEvent> = new Set<ClineHookEvent>([
  'TaskStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'TaskComplete',
  'TaskCancel',
]);

const EVENT_BY_LOWER: ReadonlyMap<string, ClineHookEvent> = new Map(
  CLINE_HOOK_EVENTS.map((event) => [event.toLowerCase(), event]),
);

export interface ClineHookFile {
  readonly event: ClineHookEvent;
  /** True when the CLI runs the file. */
  readonly cli: boolean;
  /**
   * How the VS Code extension reaches the file: `unix` for `<Event>` on macOS and Linux, when it
   * is executable; `windows` for `<Event>.ps1`. Absent when the extension does not look for it.
   */
  readonly vscode?: 'unix' | 'windows';
  /** True when the extension runs hooks for the event, whether or not it looks for this file. */
  readonly vscodeEvent: boolean;
  /** True when either surface runs the file. */
  readonly runs: boolean;
}

/** Node's `path.extname` of a file name: from the last dot that does not start the name. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * The event the CLI reads from a file name: `toHookConfigFileName` in hook-file-config.ts. It
 * strips the extension only when it is written in lowercase, as `path.basename(name, ext)` does
 * with the lowercased extension.
 */
function cliEvent(name: string): ClineHookEvent | undefined {
  const extension = extensionOf(name).toLowerCase();
  if (!CLI_EXTENSIONS.has(extension)) return undefined;
  const stem =
    extension !== '' && name.endsWith(extension) && name !== extension
      ? name.slice(0, name.length - extension.length)
      : name;
  return EVENT_BY_LOWER.get(stem.trim().toLowerCase());
}

/** The event the VS Code extension reads from a file name, and on which systems. */
function vscodeEvent(
  name: string,
): { readonly event: ClineHookEvent; readonly os: 'unix' | 'windows' } | undefined {
  const windows = name.endsWith('.ps1');
  const stem = windows ? name.slice(0, -'.ps1'.length) : name;
  const event = EVENT_BY_LOWER.get(stem.toLowerCase());
  return event === stem ? { event, os: windows ? 'windows' : 'unix' } : undefined;
}

/**
 * What the file at `path` (root-relative POSIX) is to Cline as a hook, or undefined when no
 * surface would take it for one. Hook folders belong to the directory that holds `.clinerules`
 * or `.cline`, as the other folders of `clinePlace` do.
 */
export function clineHookFile(path: string): ClineHookFile | undefined {
  const place = clinePlace(path);
  if (place?.role !== 'hook') return undefined;
  const folder = dirnamePosix(path);
  const expected = `${place.root === '' ? '' : `${place.root}/`}${place.folder}/hooks`;
  // Only files directly in the hooks folder, whose name says `hooks` as the source spells it.
  if (folder !== expected) return undefined;
  const name = basename(path);
  const clinerules = place.folder === '.clinerules';
  const sdkFolder = clinerules || place.folder === '.cline';
  const cli = sdkFolder ? cliEvent(name) : undefined;
  const vscode = clinerules ? vscodeEvent(name) : undefined;
  const event = vscode?.event ?? cli;
  if (event === undefined) return undefined;
  const cliRuns = cli !== undefined && cli !== 'PreCompact';
  const vscodeRuns = vscode !== undefined && VSCODE_EVENTS.has(event);
  return {
    event,
    cli: cliRuns,
    ...(vscode === undefined ? {} : { vscode: vscode.os }),
    vscodeEvent: VSCODE_EVENTS.has(event),
    runs: cliRuns || vscodeRuns,
  };
}

/** Cheap pre-filter for the walker: could a file with this path be a Cline hook file? */
export function mayBeClineHookFile(path: string): boolean {
  return path.includes('hooks/') && clineHookFile(path) !== undefined;
}
