/**
 * Settings at the repository root: a value at a key path of a root settings file, as a session
 * started at the root reads it. Shared by the agent file discovery (switches that turn custom
 * agents off) and the model settings of src/agents. Pure.
 */
import { isTable, type JsonPath, own, type SpannedDocument } from '../parse/json-access.js';
import type { LoadView } from './load/view.js';

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
