/**
 * Settings files a session reads from the repository: a value at a key path of one file, and
 * the Claude Code project settings of a session. Shared by the agent file discovery (switches
 * that turn custom agents off), the Claude Code and Copilot load plans, Claude Code's subagents,
 * the model settings of src/agents, and the inventory (hooks the settings turn off). Pure.
 */
import type { Snapshot } from '../core/types.js';
import { isTable, type JsonPath, own, type SpannedDocument } from '../parse/json-access.js';
import type { Certainty } from './load/types.js';
import type { LoadView } from './load/view.js';
import { joinPath, nearestGitRoot } from './paths.js';

/** The text of a switch's value, lowercase, for a string, number or boolean. */
function switchText(value: unknown): string | undefined {
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  return typeof text === 'string' ? text.trim().toLowerCase() : undefined;
}

/** `1`, `true`, `yes` or `on`, in any case: how Claude Code reads an environment switch. */
export function isTruthy(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(switchText(value) ?? '');
}

/** `0`, `false`, `no` or `off`, in any case: a switch set the other way. */
export function isFalsy(value: unknown): boolean {
  return ['0', 'false', 'no', 'off'].includes(switchText(value) ?? '');
}

/** The value at `path` in `doc`, or undefined. */
export function settingAt(doc: SpannedDocument, path: JsonPath): unknown {
  let value: unknown = doc.value;
  for (const segment of path) {
    if (!isTable(value) || typeof segment !== 'string') return undefined;
    value = own(value, segment);
  }
  return value;
}

/** Claude Code's project settings files in a directory, the shared one first. */
export const CLAUDE_PROJECT_SETTINGS: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
];

/**
 * One Claude Code project settings file a session reads:
 * - `shared`: `.claude/settings.json` of the working directory;
 * - `legacy`: `.claude/settings.local.json` of the working directory, below the repository root,
 *   where versions before v2.1.211 kept the local file;
 * - `local`: `.claude/settings.local.json` of the repository root.
 */
export interface ClaudeSettingsFile {
  readonly path: string;
  readonly role: 'shared' | 'legacy' | 'local';
}

/**
 * The Claude Code project settings files a session started in `cwd` reads, lowest precedence
 * first, so that the last file setting a key wins:
 * - the working directory's `.claude/settings.json`, with no parent-directory fallback
 *   (SOURCES.claudePermissions, SOURCES.claudeSettings, "reads the shared `.claude/settings.json`
 *   from the session's primary working directory");
 * - when the working directory is below the repository root, its `.claude/settings.local.json`,
 *   which Claude Code "still reads ... alongside the root file; where both set the same key, the
 *   root's value applies" (SOURCES.claudeSettings);
 * - the repository root's `.claude/settings.local.json`, read "even when you start Claude Code in
 *   a subdirectory" (SOURCES.claudePermissions).
 *
 * The repository root is the nearest directory with `.git` at or above `cwd`, else the scan root.
 * Where Claude Code keeps the local file next to `.claude/settings.json` instead (on Windows, a
 * root that is the home directory or not owned by the user) is not modeled: plans say so in the
 * `claude-code.os` assumption.
 */
export function claudeSettingsFiles(
  snapshot: Snapshot,
  cwd: string,
): readonly ClaudeSettingsFile[] {
  const root = nearestGitRoot(snapshot, cwd) ?? '';
  const [shared = '', local = ''] = CLAUDE_PROJECT_SETTINGS;
  return [
    { path: joinPath(cwd, shared), role: 'shared' },
    ...(root === cwd ? [] : [{ path: joinPath(cwd, local), role: 'legacy' } as const]),
    { path: joinPath(root, local), role: 'local' },
  ];
}

/**
 * The Claude Code project settings a session started in `cwd` reads from the repository, lowest
 * precedence first ({@link claudeSettingsFiles}). A file that does not parse is left out; user and
 * managed settings are never read.
 */
export function claudeProjectSettings(view: LoadView, cwd: string): readonly SpannedDocument[] {
  const docs: SpannedDocument[] = [];
  for (const { path } of claudeSettingsFiles(view.snapshot, cwd)) {
    const artifact = view.index.get(path);
    if (artifact?.kind !== 'claude-settings' || artifact.path !== path) continue;
    const doc = view.json(artifact);
    if (doc.ok) docs.push(doc);
  }
  return docs;
}

/** The value at `path` in the last of `docs` that sets it, or undefined. */
export function lastSetting(docs: readonly SpannedDocument[], path: JsonPath): unknown {
  let value: unknown;
  for (const doc of docs) {
    const set = settingAt(doc, path);
    if (set !== undefined) value = set;
  }
  return value;
}

/**
 * Whether `disableAllHooks: true` in the Claude Code project settings a session started in `cwd`
 * reads, the last file that sets it winning, turns off the project, local and plugin hooks
 * (SOURCES.claudeSettingsReference). Managed settings, which are not visible, can still run their
 * own hooks.
 */
export function claudeHooksOff(view: LoadView, cwd: string): boolean {
  return lastSetting(claudeProjectSettings(view, cwd), ['disableAllHooks']) === true;
}

/** The Copilot CLI's repository settings files at the repository root, the shared one first. */
export const COPILOT_CLI_SETTINGS: readonly string[] = [
  '.github/copilot/settings.json',
  '.github/copilot/settings.local.json',
];

/**
 * Whether the Copilot CLI skips "every hook from every source" because `disableAllHooks: true` is
 * at the top level of the repository's settings (SOURCES.copilotHooksReference). The CLI reads it
 * in its own settings files (`copilot`, {@link COPILOT_CLI_SETTINGS} in order, the local file
 * winning) and in Claude Code's project settings (`claude`, SOURCES.copilotCliConfigDir). Which of
 * the two pairs wins, and the order within Claude Code's, are not documented: a value set both
 * ways makes the result unverified. Undefined when neither turns hooks off.
 */
export function copilotCliHooksOff(
  copilot: readonly SpannedDocument[],
  claude: readonly SpannedDocument[],
): Certainty | undefined {
  const values = (docs: readonly SpannedDocument[]): boolean[] =>
    docs.flatMap((doc) => {
      const value = settingAt(doc, ['disableAllHooks']);
      return typeof value === 'boolean' ? [value] : [];
    });
  const copilotValues = values(copilot);
  const claudeValues = values(claude);
  const copilotValue = copilotValues.at(-1);
  const claudeValue = claudeValues.at(-1);
  if (copilotValue !== true && claudeValue !== true) return undefined;
  const conflict =
    copilotValue === false || claudeValue === false || new Set(claudeValues).size > 1;
  return conflict ? 'unverified' : 'documented';
}

/**
 * The value at `path` in the root's `file` (`.codex/config.toml` is TOML, the others JSON), with
 * the dotted key; undefined when the file is not at that path, does not parse, or lacks the key.
 */
export function rootSetting(
  view: LoadView,
  file: string,
  path: JsonPath,
): { readonly value: unknown; readonly key: string } | undefined {
  const artifact = view.index.get(file);
  if (artifact?.path !== file) return undefined;
  const doc = artifact.kind === 'codex-config' ? view.toml(artifact) : view.json(artifact);
  if (!doc.ok) return undefined;
  const value = settingAt(doc, path);
  return value === undefined ? undefined : { value, key: path.join('.') };
}
