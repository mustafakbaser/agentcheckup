import type { PlatformId, Snapshot } from '../core/types.js';

/**
 * Where a file lives, in terms agents care about. Many false positives in real repositories come
 * from judging a file as if an agent loaded it from where it sits, when it is really part of a
 * plugin, a resource bundled inside a skill, or a skill's reference material.
 *
 * Everything here derives from `snapshot.paths`, so it works the same for a disk walk, an
 * in-memory snapshot and the corpus harness. Results are cached per snapshot.
 */

/**
 * Plugin manifest directories, `<root>/.<agent>-plugin/plugin.json`. Unknown agents (the corpus
 * has `.qoder-plugin`, `.kimi-plugin`, ...) still mark a plugin root; they add no known reader.
 * Sources: Claude Code plugins reference (https://code.claude.com/docs/en/plugins-reference) and
 * the plugin layouts observed across the corpus in corpus/REPORT.md.
 */
const PLUGIN_MARKER_PLATFORMS: Readonly<Record<string, PlatformId>> = {
  '.claude-plugin': 'claude-code',
  '.codex-plugin': 'codex',
  '.cursor-plugin': 'cursor',
  '.devin-plugin': 'windsurf',
};

const PLUGIN_MANIFEST = /(?:^|\/)(\.[a-z0-9-]+-plugin)\/plugin\.json$/;

export interface PluginRoot {
  /** Directory containing the plugin manifest directories ('' for the scan root). */
  readonly root: string;
  /** Manifest directory names found there, e.g. `.claude-plugin`, sorted. */
  readonly markers: readonly string[];
  /** Agents among those markers that agentcheckup models, sorted. */
  readonly platforms: readonly PlatformId[];
}

interface LocationIndex {
  readonly plugins: ReadonlyMap<string, PluginRoot>;
  readonly skillDirectories: ReadonlySet<string>;
}

const cache = new WeakMap<Snapshot, LocationIndex>();

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function index(snapshot: Snapshot): LocationIndex {
  const cached = cache.get(snapshot);
  if (cached) return cached;

  const markers = new Map<string, Set<string>>();
  const skillDirectories = new Set<string>();
  for (const path of snapshot.paths) {
    if (path.endsWith('/')) continue;
    const match = PLUGIN_MANIFEST.exec(path);
    if (match?.[1] !== undefined) {
      const root = directoryOf(directoryOf(path));
      const set = markers.get(root) ?? new Set<string>();
      set.add(match[1]);
      markers.set(root, set);
    }
    if (path === 'SKILL.md' || path.endsWith('/SKILL.md')) skillDirectories.add(directoryOf(path));
  }

  const plugins = new Map<string, PluginRoot>();
  for (const [root, set] of markers) {
    const sorted = [...set].sort();
    const platforms = sorted
      .map((marker) => PLUGIN_MARKER_PLATFORMS[marker])
      .filter((platform): platform is PlatformId => platform !== undefined)
      .sort();
    plugins.set(root, { root, markers: sorted, platforms });
  }

  const result = { plugins, skillDirectories };
  cache.set(snapshot, result);
  return result;
}

/** Directories from `directory` up to the scan root (''), nearest first. */
function* upFrom(directory: string): Generator<string> {
  let current = directory;
  for (;;) {
    yield current;
    if (current === '') return;
    current = directoryOf(current);
  }
}

/** The nearest plugin root at or above the file's directory, if any. */
export function pluginRootOf(snapshot: Snapshot, path: string): PluginRoot | undefined {
  const { plugins } = index(snapshot);
  for (const directory of upFrom(directoryOf(path))) {
    const plugin = plugins.get(directory);
    if (plugin) return plugin;
  }
  return undefined;
}

/**
 * The nearest directory at or above `path`'s directory that contains a `SKILL.md`, i.e. the
 * skill this file belongs to. For a SKILL.md itself, that is its own directory.
 */
export function skillDirectoryOf(snapshot: Snapshot, path: string): string | undefined {
  const { skillDirectories } = index(snapshot);
  for (const directory of upFrom(directoryOf(path))) {
    if (skillDirectories.has(directory)) return directory;
  }
  return undefined;
}

/**
 * True for a SKILL.md that sits inside another skill's directory, such as an example or template
 * under `assets/`. Agents discover skills only directly under their skills roots, so these are
 * resources of the outer skill, not skills of their own.
 */
export function isBundledSkill(snapshot: Snapshot, skillPath: string): boolean {
  const own = directoryOf(skillPath);
  if (own === '') return false;
  const { skillDirectories } = index(snapshot);
  for (const directory of upFrom(directoryOf(own))) {
    if (skillDirectories.has(directory)) return true;
  }
  return false;
}
