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
import { dirnamePosix, normalizeRelative } from '../core/paths.js';
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

/** True when `path` is the file `name` in some directory: `name` itself, or ending in `/name`. */
export function isNamed(path: string, name: string): boolean {
  return path === name || path.endsWith(`/${name}`);
}

const settingsDirectories = new WeakMap<ReadonlyMap<string, Artifact>, readonly string[]>();

/**
 * Directories with a `.gemini/settings.json` in the scan, by any path that reaches the file, found
 * once per index.
 */
function settingsDirectoriesOf(index: ReadonlyMap<string, Artifact>): readonly string[] {
  let directories = settingsDirectories.get(index);
  if (directories === undefined) {
    const found = new Set<string>();
    for (const path of index.keys()) {
      if (!isNamed(path, GEMINI_SETTINGS_FILE)) continue;
      found.add(path.slice(0, Math.max(0, path.length - GEMINI_SETTINGS_FILE.length - 1)));
    }
    directories = [...found];
    settingsDirectories.set(index, directories);
  }
  return directories;
}

/**
 * The working directories whose settings name the file at `path` in `context.fileName`: the
 * file's own directory and those above it. A session started there reads the file, because it is
 * on the path from the project root or below the working directory. Sessions started deeper are
 * not counted.
 */
export function geminiNamingDirectories(view: GeminiSettingsView, path: string): string[] {
  const directory = dirnamePosix(path);
  return settingsDirectoriesOf(view.index).filter((cwd) => {
    if (!(cwd === '' || directory === cwd || directory.startsWith(`${cwd}/`))) return false;
    const files = geminiContextFileNames(view, cwd);
    return files.origin === 'repository' && files.names.some((name) => isNamed(path, name));
  });
}

/**
 * Whether a Gemini CLI session reads the file at `path` as a context file because the settings of
 * its directory or one above it name it ({@link geminiNamingDirectories}). `GEMINI.md` is read
 * without settings and is not covered here.
 */
export function geminiNamesFile(view: GeminiSettingsView, path: string): boolean {
  return geminiNamingDirectories(view, path).length > 0;
}

/**
 * Top-level keys of the settings format before Gemini CLI 0.3, with the nested key that took the
 * place of each. Gemini CLI up to 0.23 moved them when it loaded a settings file (`MIGRATION_MAP`
 * in packages/cli/src/config/settings.ts at v0.23.0); 0.24 removed that migration, and the
 * current loader keeps unknown top-level keys without reading them (`passthrough()` in
 * settings-validation.ts). Only keys whose nested place the current settings schema still has
 * are listed; `mcpServers`, `extensions` and `telemetry` kept their place, and `model` is now an
 * object.
 */
export const GEMINI_LEGACY_SETTINGS_KEYS: Readonly<Record<string, string>> = {
  accessibility: 'ui.accessibility',
  allowedTools: 'tools.allowed',
  allowMCPServers: 'mcp.allowed',
  autoConfigureMaxOldSpaceSize: 'advanced.autoConfigureMemory',
  bugCommand: 'advanced.bugCommand',
  chatCompression: 'model.compressionThreshold',
  checkpointing: 'general.checkpointing',
  contextFileName: 'context.fileName',
  coreTools: 'tools.core',
  customThemes: 'ui.customThemes',
  customWittyPhrases: 'ui.customWittyPhrases',
  debugKeystrokeLogging: 'general.debugKeystrokeLogging',
  dnsResolutionOrder: 'advanced.dnsResolutionOrder',
  enableInteractiveShell: 'tools.shell.enableInteractiveShell',
  enforcedAuthType: 'security.auth.enforcedType',
  excludedProjectEnvVars: 'advanced.excludedEnvVars',
  excludeMCPServers: 'mcp.excluded',
  excludeTools: 'tools.exclude',
  extensionManagement: 'experimental.extensionManagement',
  fileFiltering: 'context.fileFiltering',
  folderTrust: 'security.folderTrust.enabled',
  hasSeenIdeIntegrationNudge: 'ide.hasSeenNudge',
  hideBanner: 'ui.hideBanner',
  hideContextSummary: 'ui.hideContextSummary',
  hideCWD: 'ui.footer.hideCWD',
  hideFooter: 'ui.hideFooter',
  hideModelInfo: 'ui.footer.hideModelInfo',
  hideSandboxStatus: 'ui.footer.hideSandboxStatus',
  hideTips: 'ui.hideTips',
  hideWindowTitle: 'ui.hideWindowTitle',
  ideMode: 'ide.enabled',
  includeDirectories: 'context.includeDirectories',
  maxSessionTurns: 'model.maxSessionTurns',
  mcpServerCommand: 'mcp.serverCommand',
  memoryDiscoveryMaxDirs: 'context.discoveryMaxDirs',
  memoryImportFormat: 'context.importFormat',
  preferredEditor: 'general.preferredEditor',
  retryFetchErrors: 'general.retryFetchErrors',
  sandbox: 'tools.sandbox',
  selectedAuthType: 'security.auth.selectedType',
  shellInactivityTimeout: 'tools.shell.inactivityTimeout',
  shellPager: 'tools.shell.pager',
  shellShowColor: 'tools.shell.showColor',
  showCitations: 'ui.showCitations',
  showLineNumbers: 'ui.showLineNumbers',
  showMemoryUsage: 'ui.showMemoryUsage',
  showStatusInTitle: 'ui.showStatusInTitle',
  skipNextSpeakerCheck: 'model.skipNextSpeakerCheck',
  summarizeToolOutput: 'model.summarizeToolOutput',
  theme: 'ui.theme',
  toolCallCommand: 'tools.callCommand',
  toolDiscoveryCommand: 'tools.discoveryCommand',
  usageStatisticsEnabled: 'privacy.usageStatisticsEnabled',
  useExternalAuth: 'security.auth.useExternal',
  useRipgrep: 'tools.useRipgrep',
  vimMode: 'general.vimMode',
};
