/**
 * Which platforms read a file, once the repository's own settings are applied. `READERS` in
 * ./classify.ts gives the platforms that read each kind of file by default; two settings change
 * that per repository:
 *
 * - Gemini CLI reads every context file name that `context.fileName` in `.gemini/settings.json`
 *   names, such as AGENTS.md, besides GEMINI.md (./gemini.ts).
 * - Devin Local stops importing another agent's files when `read_config_from` in
 *   `.devin/config.json` turns that source off (./windsurf-rules.ts).
 *
 * Rules use this through `targetedReaders` (src/rules/instructions/helpers.ts); loaders apply the
 * same helpers for their working directory. Pure.
 */
import { compareStrings } from '../core/compare.js';
import { dirnamePosix } from '../core/paths.js';
import type { Artifact, ParseServices, PlatformId } from '../core/types.js';
import { GEMINI_SETTINGS_FILE, geminiNamesFile } from './gemini.js';
import { MARKDOWN_KINDS } from './kinds.js';
import { DEVIN_CONFIG_FILE, devinReadConfigFor, devinSourceOf } from './windsurf-rules.js';

/** What the reader lookup reads: every artifact, by path, and their JSON. */
export interface ReadersView extends Pick<ParseServices, 'json'> {
  readonly artifacts: readonly Artifact[];
  readonly index: ReadonlyMap<string, Artifact>;
}

interface Settings {
  /** The scan has a `.gemini/settings.json`. */
  readonly gemini: boolean;
  /** The scan has a `.devin/config.json`. */
  readonly devin: boolean;
}

const settingsCache = new WeakMap<readonly Artifact[], Settings>();

/** Which of the two settings files the scan has, found once per artifact list. */
function settingsOf(artifacts: readonly Artifact[]): Settings {
  let settings = settingsCache.get(artifacts);
  if (settings === undefined) {
    const isAt = (artifact: Artifact, file: string): boolean =>
      artifact.path === file || artifact.path.endsWith(`/${file}`);
    settings = {
      gemini: artifacts.some(
        (artifact) => artifact.kind === 'gemini-settings' && isAt(artifact, GEMINI_SETTINGS_FILE),
      ),
      devin: artifacts.some(
        (artifact) => artifact.kind === 'devin-config' && isAt(artifact, DEVIN_CONFIG_FILE),
      ),
    };
    settingsCache.set(artifacts, settings);
  }
  return settings;
}

/**
 * Whether a Gemini CLI session reads `artifact` as a context file because the settings of its
 * working directory name it. Sessions started in the file's directory or above it read it (the
 * file is on the path from the project root, or below the working directory), so the settings of
 * each of those directories count. Every path that reaches the file counts.
 */
function geminiNames(view: ReadersView, artifact: Artifact): boolean {
  if (!MARKDOWN_KINDS.has(artifact.kind)) return false;
  return [artifact.path, ...artifact.aliases].some((path) => geminiNamesFile(view, path));
}

/** Whether Devin Local's `read_config_from` turns off the source that would import `artifact`. */
function devinTurnsOff(view: ReadersView, artifact: Artifact): boolean {
  const source = devinSourceOf(artifact);
  if (source === undefined) return false;
  return !devinReadConfigFor(view, dirnamePosix(artifact.path)).enabled[source];
}

/**
 * The platforms that read `artifact` in this repository: its default readers, plus Gemini CLI
 * when a `context.fileName` names the file, minus Devin Local (`windsurf`) when
 * `read_config_from` turns the file's source off. Sorted like `READERS`, by platform id.
 */
export function effectiveReaders(view: ReadersView, artifact: Artifact): readonly PlatformId[] {
  const settings = settingsOf(view.artifacts);
  if (!settings.gemini && !settings.devin) return artifact.readers;
  let readers: readonly PlatformId[] = artifact.readers;
  if (settings.gemini && !readers.includes('gemini') && geminiNames(view, artifact)) {
    readers = [...readers, 'gemini' as const].sort(compareStrings);
  }
  if (settings.devin && readers.includes('windsurf') && devinTurnsOff(view, artifact)) {
    readers = readers.filter((platform) => platform !== 'windsurf');
  }
  return readers;
}
