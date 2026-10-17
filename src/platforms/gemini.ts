/**
 * Which context files Gemini CLI reads, shared by the rules (through ./readers.ts), the import
 * graph and the Gemini CLI load plans.
 *
 * Gemini CLI reads the workspace settings of the working directory, `<cwd>/.gemini/settings.json`
 * (SOURCES.geminiSettingsSource). When they set `context.fileName`, a string or a list of
 * strings, it passes the value to `setGeminiMdFilename`; otherwise it resets the names to
 * `GEMINI.md` (SOURCES.geminiCliConfigSource). `setGeminiMdFilename` trims each name, drops empty
 * ones, normalizes the path and adds the names in front of the ones it already holds, which at
 * startup is `GEMINI.md`, so `GEMINI.md` stays a context file name (SOURCES.geminiMemoryToolSource).
 * The legacy top-level `contextFileName` is not read anywhere.
 */
import { normalizeRelative } from '../core/paths.js';
import type { Artifact, ParseServices } from '../core/types.js';
import { isObject, own } from '../parse/json-access.js';
import { joinPath } from './paths.js';

/** The context file name Gemini CLI uses when the settings name none (`DEFAULT_CONTEXT_FILENAME`). */
export const GEMINI_DEFAULT_CONTEXT_FILE = 'GEMINI.md';

/** Where Gemini CLI keeps workspace settings, relative to the working directory. */
export const GEMINI_SETTINGS_FILE = '.gemini/settings.json';

export interface GeminiContextFiles {
  /** Context file names in Gemini CLI's order: those from `context.fileName`, then `GEMINI.md`. */
  readonly names: readonly string[];
  /** `repository` when the working directory's settings set `context.fileName`, else `default`. */
  readonly origin: 'repository' | 'default';
  /** The settings file the names were read from, when the scan has it. */
  readonly settings?: string;
}

/** What a context file name lookup reads: artifacts by path and their JSON. */
export type GeminiSettingsView = Pick<ParseServices, 'json'> & {
  readonly index: ReadonlyMap<string, Artifact>;
};

const DEFAULT: GeminiContextFiles = { names: [GEMINI_DEFAULT_CONTEXT_FILE], origin: 'default' };

/**
 * The names `setGeminiMdFilename` adds for a `context.fileName` value, in order and without
 * repeats: trimmed, non-empty, normalized. A name that climbs out of the directory is left out;
 * Gemini CLI rejects path traversal there. Undefined when the value names nothing that Gemini CLI
 * would set (absent, empty text, or not text).
 */
function namesOf(value: unknown): string[] | undefined {
  // Gemini CLI tests the value for truth: an empty string resets the names to the default.
  if (value === undefined || value === null || value === '') return undefined;
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
  if (items === undefined) return undefined;
  const names: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '') continue;
    const normalized = normalizeRelative(trimmed);
    if (normalized === undefined || normalized === '' || trimmed.startsWith('/')) continue;
    if (!names.includes(normalized)) names.push(normalized);
  }
  return names;
}

/**
 * The context file names of a Gemini CLI session started in `cwd` (root-relative, `''` for the
 * scan root): `context.fileName` from `<cwd>/.gemini/settings.json`, then `GEMINI.md`. Settings
 * that do not parse stop Gemini CLI at startup (json/invalid-syntax); they count as unset here.
 */
export function geminiContextFileNames(view: GeminiSettingsView, cwd: string): GeminiContextFiles {
  const path = joinPath(cwd, GEMINI_SETTINGS_FILE);
  const artifact = view.index.get(path);
  if (artifact?.kind !== 'gemini-settings') return DEFAULT;
  const doc = view.json(artifact);
  if (!doc.ok || !isObject(doc.value)) return { ...DEFAULT, settings: artifact.path };
  const context = own(doc.value, 'context');
  const names = isObject(context) ? namesOf(own(context, 'fileName')) : undefined;
  if (names === undefined) return { ...DEFAULT, settings: artifact.path };
  return {
    names: names.includes(GEMINI_DEFAULT_CONTEXT_FILE)
      ? names
      : [...names, GEMINI_DEFAULT_CONTEXT_FILE],
    origin: 'repository',
    settings: artifact.path,
  };
}
