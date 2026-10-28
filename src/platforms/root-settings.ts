/**
 * Settings files a session reads from the repository: a value at a key path of one file, and
 * Claude Code's project settings of a directory. Shared by the agent file discovery (switches
 * that turn custom agents off), the Claude Code load plan and its subagents, and the model
 * settings of src/agents. Pure.
 */
import { isTable, type JsonPath, own, type SpannedDocument } from '../parse/json-access.js';
import type { LoadView } from './load/view.js';
import { joinPath } from './paths.js';

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
 * The Claude Code project settings a session started in `directory` reads from the repository:
 * its `.claude/settings.json`, then `.claude/settings.local.json`, which wins on a key
 * (SOURCES.claudeSettings). A file that does not parse is left out; user and managed settings are
 * never read.
 */
export function claudeProjectSettings(
  view: LoadView,
  directory: string,
): readonly SpannedDocument[] {
  const docs: SpannedDocument[] = [];
  for (const name of CLAUDE_PROJECT_SETTINGS) {
    const path = joinPath(directory, name);
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
