/**
 * VS Code's workspace settings, `.vscode/settings.json`, as far as they change what Copilot in
 * VS Code loads or approves: the `chat.*` loading switches and locations, and the terminal and
 * global auto-approval settings. Pure: it reads only the parsed document, which the engine
 * parses as JSONC, as VS Code reads its settings files (SOURCES.vscodeConfigurationParser).
 *
 * Scope: none of these settings declares a `scope` in VS Code's source but
 * `chat.tools.global.autoApprove`, which is `APPLICATION_MACHINE`, so a workspace value is not
 * applied; the others take the default window scope, which workspace settings may set, and are
 * `restricted`, applied only in a trusted workspace (SOURCES.vscodeChatSettingsSource,
 * SOURCES.vscodeTerminalSettingsSource). The AI settings reference states no scope per setting
 * (SOURCES.vscodeAiSettings).
 */
import { isObject, type JsonObject, type JsonPath, own } from '../parse/json-access.js';
import type { LoadView } from './load/view.js';
import { joinPath } from './paths.js';

/** Where VS Code reads a workspace folder's settings, relative to the folder. */
export const VSCODE_SETTINGS_FILE = '.vscode/settings.json';

/** A setting's value and the JSON path it was read at, for its line. */
export interface VscodeSettingValue {
  readonly value: unknown;
  readonly path: JsonPath;
}

/**
 * The value of a dotted setting such as `chat.useAgentsMdFile`. VS Code builds its value tree by
 * splitting each top-level key at its dots and reads nested objects as written
 * (`addToValueTree` and `getConfigurationValue` in configurationModels.ts), so the flat key, a
 * nested object, or a mix whose top-level key is a dotted prefix all set it. The flat key wins
 * over the others.
 */
export function vscodeSetting(root: unknown, key: string): VscodeSettingValue | undefined {
  if (!isObject(root)) return undefined;
  if (Object.hasOwn(root, key)) return { value: own(root, key), path: [key] };
  for (const top of Object.keys(root)) {
    if (!key.startsWith(`${top}.`)) continue;
    let value: unknown = own(root, top);
    const path: string[] = [top];
    for (const part of key.slice(top.length + 1).split('.')) {
      if (!isObject(value) || !Object.hasOwn(value, part)) {
        value = undefined;
        break;
      }
      value = own(value, part);
      path.push(part);
    }
    if (value !== undefined) return { value, path };
  }
  return undefined;
}

/** A boolean setting, or undefined when it is not set to a boolean. */
export function vscodeBoolean(root: unknown, key: string): boolean | undefined {
  const value = vscodeSetting(root, key)?.value;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The workspace settings of a VS Code session opened on `folder`: the top-level object of
 * `<folder>/.vscode/settings.json`, `undefined` when there is none, `unparsed` when it does not
 * parse.
 */
export function vscodeSettingsOf(
  view: Pick<LoadView, 'index' | 'json'>,
  folder: string,
): JsonObject | 'unparsed' | undefined {
  const artifact = view.index.get(joinPath(folder, VSCODE_SETTINGS_FILE));
  if (artifact?.kind !== 'vscode-settings') return undefined;
  const doc = view.json(artifact);
  if (!doc.ok) return 'unparsed';
  return isObject(doc.value) ? doc.value : undefined;
}

/**
 * One `chat.tools.terminal.autoApprove` rule that approves commands: a command or a `/regex/`
 * set to `true`, or to an object with `approve: true` ("Set a command to `true` to auto-approve
 * it", SOURCES.vscodeApprovals). Rules set to `false` or `null` only ask or unset.
 */
export interface TerminalApproval {
  readonly rule: string;
  readonly path: JsonPath;
  /** True for a regular expression that matches every command, such as `/.*\/`. */
  readonly broad: boolean;
}

export function terminalApprovals(root: unknown): TerminalApproval[] {
  const setting = vscodeSetting(root, 'chat.tools.terminal.autoApprove');
  if (setting === undefined || !isObject(setting.value)) return [];
  const rules = setting.value;
  const out: TerminalApproval[] = [];
  for (const rule of Object.keys(rules)) {
    const value = own(rules, rule);
    const approve = isObject(value) ? own(value, 'approve') === true : value === true;
    if (!approve) continue;
    out.push({ rule, path: [...setting.path, rule], broad: matchesEverything(rule) });
  }
  return out;
}

/** Regular expression bodies that match every command line. */
const MATCH_ALL: ReadonlySet<string> = new Set(['', '.*', '.+', '^', '$', '^.*', '.*$', '^.*$']);

/**
 * True for a `/regex/` rule (with optional flags) whose body matches any command, such as `/.*\/`
 * or `/^/i`. Read as text, never compiled.
 */
function matchesEverything(rule: string): boolean {
  if (!rule.startsWith('/')) return false;
  const end = rule.lastIndexOf('/');
  if (end <= 0) return false;
  const flags = rule.slice(end + 1);
  for (const flag of flags) if (!'dgimsuvy'.includes(flag)) return false;
  return MATCH_ALL.has(rule.slice(1, end));
}
