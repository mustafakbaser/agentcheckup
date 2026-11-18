/**
 * Plugins in a skills folder: a folder of a project's `.claude/skills/` with a
 * `.claude-plugin/plugin.json` loads as the plugin `<name>@skills-dir`, "with its own agents,
 * hooks, and MCP servers", once the workspace is trusted (SOURCES.claudeSkills, "Skill folder as
 * a plugin"). Claude Code reads the `.claude/skills/` of the session's primary working directory
 * and "doesn't search parent directories for plugins"; the manifest's `defaultEnabled` turns it
 * on unless a settings file sets `"<name>@skills-dir"` (SOURCES.claudePluginLoading). Shared by
 * the Claude Code load plan and the inventory. Pure.
 */
import { dirnamePosix, joinRelative, pathStatus } from '../core/paths.js';
import type { Snapshot } from '../core/types.js';
import { isTable, own, type SpannedDocument } from '../parse/json-access.js';
import { lastSetting } from './root-settings.js';

const MANIFEST = '.claude-plugin/plugin.json';
const SKILLS = '.claude/skills';
/** The hooks file Claude Code loads from every plugin (SOURCES.claudePlugins). */
export const PLUGIN_HOOKS_FILE = 'hooks/hooks.json';
/** The MCP file Claude Code loads from every plugin (SOURCES.claudePlugins). */
export const PLUGIN_MCP_FILE = '.mcp.json';
/**
 * The LSP file Claude Code loads from every plugin: "declare the server in `.lsp.json` at the
 * plugin root" (SOURCES.claudePluginComponents).
 */
export const PLUGIN_LSP_FILE = '.lsp.json';
/**
 * The plugin's executables: "Files in `bin/` at the plugin root are on the `PATH` of the Bash
 * tool's shell while the plugin is enabled" (SOURCES.claudePluginComponents).
 */
export const PLUGIN_BIN_DIR = 'bin';

/**
 * File name endings of a mod's hooks module: "Named `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`,
 * `.cts`, or `.tsx`" (SOURCES.claudeMods, "Files").
 */
const MODULE_EXTENSIONS: readonly string[] = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
];

const SKILLS_SEGMENT = '.claude/skills/';

/**
 * Whether `path` may be the hooks module of a mod in a skills-folder plugin, so the walk reads it
 * for the security inventory, which digests it: a file with a module ending below the plugin's
 * `hooks/` folder, where `hooks/hooks.json` names it relative to itself, as in
 * `"modules": ["./register.js"]` (SOURCES.claudeMods). A module elsewhere is not read, and the
 * inventory lists its `hooks.json` as not analyzed. Path-only, for the walker's filter.
 */
export function mayBePluginModule(path: string): boolean {
  const lower = path.toLowerCase();
  if (!MODULE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return false;
  const inner = lower.lastIndexOf(`/${SKILLS_SEGMENT}`);
  const start = inner >= 0 ? inner + 1 : lower.startsWith(SKILLS_SEGMENT) ? 0 : -1;
  if (start < 0) return false;
  const rest = lower.slice(start + SKILLS_SEGMENT.length);
  const slash = rest.indexOf('/');
  return slash > 0 && rest.startsWith('hooks/', slash + 1);
}

export interface SkillsDirPlugin {
  /** The directory whose `.claude/skills/` holds the plugin; `''` is the scan root. */
  readonly owner: string;
  /** The plugin's folder, such as `.claude/skills/deploy`. */
  readonly folder: string;
  /** Its `.claude-plugin/plugin.json`. */
  readonly manifest: string;
}

/** The skills-dir plugin of a `<owner>/.claude/skills/<folder>/.claude-plugin/plugin.json`. */
export function skillsDirPlugin(manifest: string): SkillsDirPlugin | undefined {
  if (manifest !== MANIFEST && !manifest.endsWith(`/${MANIFEST}`)) return undefined;
  const folder = dirnamePosix(dirnamePosix(manifest));
  const skills = dirnamePosix(folder);
  if (folder === '' || (skills !== SKILLS && !skills.endsWith(`/${SKILLS}`))) return undefined;
  const owner = skills === SKILLS ? '' : skills.slice(0, -`/${SKILLS}`.length);
  return { owner, folder, manifest };
}

/**
 * The skills-dir plugin a file in a plugin folder belongs to, such as its `hooks/hooks.json` or
 * `.mcp.json` (`relative`): the folder must have a manifest.
 */
export function skillsDirPluginOf(
  snapshot: Snapshot,
  path: string,
  relative: string,
): SkillsDirPlugin | undefined {
  if (!path.endsWith(`/${relative}`)) return undefined;
  const folder = path.slice(0, -relative.length - 1);
  const manifest = `${folder}/${MANIFEST}`;
  return pathStatus(snapshot, manifest) === 'exists' ? skillsDirPlugin(manifest) : undefined;
}

/**
 * The skills-dir plugin whose `skills/` folder holds the skill at `path`, a
 * `<owner>/.claude/skills/<folder>/skills/<name>/SKILL.md` next to a plugin manifest. Claude Code
 * loads a plugin's skills, namespaced "as `/plugin-name:skill-name`" (SOURCES.claudeSkills,
 * "Resolve skills that share a name"; SOURCES.claudePluginManifest, the `skills/` folder).
 */
export function skillsDirPluginSkill(
  snapshot: Snapshot,
  path: string,
): SkillsDirPlugin | undefined {
  if (path !== 'SKILL.md' && !path.endsWith('/SKILL.md')) return undefined;
  const skills = dirnamePosix(dirnamePosix(path));
  if (!skills.endsWith('/skills')) return undefined;
  const folder = dirnamePosix(skills);
  const manifest = `${folder}/${MANIFEST}`;
  const plugin = skillsDirPlugin(manifest);
  return plugin !== undefined && pathStatus(snapshot, manifest) === 'exists' ? plugin : undefined;
}

/**
 * The skills-dir plugin whose folder holds `path` at any depth, such as a workflow in its
 * `workflows/` folder: "Place the script in a `workflows/` directory at the plugin root"
 * (SOURCES.claudeWorkflows). The folder must have a manifest.
 */
export function skillsDirPluginHolding(
  snapshot: Snapshot,
  path: string,
): SkillsDirPlugin | undefined {
  const inner = path.lastIndexOf(`/${SKILLS_SEGMENT}`);
  const start = inner >= 0 ? inner + 1 : path.startsWith(SKILLS_SEGMENT) ? 0 : -1;
  if (start < 0) return undefined;
  const slash = path.indexOf('/', start + SKILLS_SEGMENT.length);
  if (slash < 0) return undefined;
  const manifest = `${path.slice(0, slash)}/${MANIFEST}`;
  return pathStatus(snapshot, manifest) === 'exists' ? skillsDirPlugin(manifest) : undefined;
}

/** The plugin's `name`, or undefined when the manifest has none. */
export function pluginName(doc: SpannedDocument): string | undefined {
  const name = isTable(doc.value) ? own(doc.value, 'name') : undefined;
  return typeof name === 'string' && name.trim() !== '' ? name : undefined;
}

/**
 * Whether the plugin is on: `enabledPlugins."<name>@skills-dir"` when the settings the session
 * reads set it to true or false, else the manifest's `defaultEnabled`, true by default
 * (SOURCES.claudePluginLoading, SOURCES.claudePlugins). User and managed settings may decide
 * otherwise; they are not visible.
 */
export function pluginEnabled(
  doc: SpannedDocument,
  name: string | undefined,
  settings: readonly SpannedDocument[],
): boolean {
  if (name !== undefined) {
    const set = lastSetting(settings, ['enabledPlugins', `${name}@skills-dir`]);
    if (typeof set === 'boolean') return set;
  }
  const fallback = isTable(doc.value) ? own(doc.value, 'defaultEnabled') : undefined;
  return fallback !== false;
}

/**
 * A path a manifest key names, as Claude Code takes it from a repository plugin:
 * - `file`: a file inside the plugin folder;
 * - `bundle`: an MCP bundle (`.mcpb`, `.dxt`) or a URL, which Claude Code skips for a
 *   repository plugin ("Declare them inline or in a `.mcp.json` inside the plugin directory");
 * - `outside`: a path that leaves the plugin folder, also skipped.
 */
export type PluginPath =
  | { readonly kind: 'file'; readonly value: string; readonly path: string }
  | { readonly kind: 'bundle' | 'outside'; readonly value: string };

/**
 * The paths that the manifest's `key` names, a string or the strings of an array, in order. Inline
 * objects are not paths: `mcpServers` in ./mcp.ts and the hook walker in ./hooks.ts read those.
 */
export function pluginPaths(doc: SpannedDocument, key: string, folder: string): PluginPath[] {
  const value = isTable(doc.value) ? own(doc.value, key) : undefined;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const out: PluginPath[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const lower = item.trim().toLowerCase();
    if (
      lower.endsWith('.mcpb') ||
      lower.endsWith('.dxt') ||
      lower.startsWith('https://') ||
      lower.startsWith('http://')
    ) {
      out.push({ kind: 'bundle', value: item });
      continue;
    }
    const path = item.startsWith('/') ? undefined : joinRelative(folder, item);
    if (path?.startsWith(`${folder}/`) !== true) {
      out.push({ kind: 'outside', value: item });
      continue;
    }
    out.push({ kind: 'file', value: item, path });
  }
  return out;
}

/**
 * The files in the plugin folder that the manifest's `key` names and the scan does not read, in
 * order, leaving out missing files, the plugin's `.mcp.json` and `.lsp.json` and, for `hooks`, its
 * `hooks/hooks.json`, which Claude Code loads anyway ("Loaded together with `hooks/hooks.json`",
 * SOURCES.claudePlugins). Their servers and hooks load with the plugin, so the load plan and the
 * inventory are incomplete.
 */
export function unreadPluginFiles(
  snapshot: Snapshot,
  doc: SpannedDocument,
  key: 'mcpServers' | 'hooks' | 'lspServers',
  folder: string,
): string[] {
  const read = new Set([`${folder}/${PLUGIN_MCP_FILE}`, `${folder}/${PLUGIN_LSP_FILE}`]);
  if (key === 'hooks') read.add(`${folder}/${PLUGIN_HOOKS_FILE}`);
  return pluginPaths(doc, key, folder).flatMap((item) =>
    item.kind === 'file' && !read.has(item.path) && pathStatus(snapshot, item.path) !== 'missing'
      ? [item.path]
      : [],
  );
}
