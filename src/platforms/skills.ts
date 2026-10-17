/**
 * Which platforms discover a SKILL.md at its location: skills directories, plugins and
 * marketplaces, and what Claude Code shows of a skill in its skill listing. Pure functions over
 * paths, `snapshot.paths` and parsed frontmatter.
 */
import { codePointLength } from '../core/measure.js';
import { dirnamePosix } from '../core/paths.js';
import type { Artifact, PlatformId, Snapshot } from '../core/types.js';
import type { FrontmatterResult } from '../parse/types.js';
import { pluginRootOf } from './location.js';

/** Platforms that read SKILL.md files (READERS.skill in src/platforms/classify.ts). */
export const SKILL_PLATFORMS = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'gemini',
] as const satisfies readonly PlatformId[];

/**
 * How deep below a skills root a platform looks for SKILL.md:
 * - `direct`: `<root>/<name>/SKILL.md` only (Claude Code; GitHub Copilot is assumed the same).
 * - `shallow`: also `<root>/SKILL.md` (Gemini CLI globs `SKILL.md` and `<name>/SKILL.md`; Cline
 *   reads a SKILL.md in the root and one in each folder of it).
 * - `recursive`: any depth (Codex and Cursor walk the root).
 */
export type SkillDepth = 'direct' | 'shallow' | 'recursive';

export interface SkillRoot {
  /** The two path segments that make up the root, e.g. `.claude/skills`. */
  readonly segment: string;
  readonly readers: readonly { readonly platform: PlatformId; readonly depth: SkillDepth }[];
}

/**
 * Project skill roots, verified 2026-10-14: Claude Code reads `.claude/skills`; Codex reads
 * `.agents/skills` and `.codex/skills`; Cursor reads `.agents`, `.cursor`, `.claude` and `.codex`
 * skills; GitHub Copilot reads `.github`, `.claude` and `.agents` skills; Gemini CLI reads
 * `.gemini/skills` and `.agents/skills`.
 *
 * Devin Local (`windsurf`), verified 2026-10-17, reads `<name>/SKILL.md` in `.devin/skills`,
 * `.windsurf/skills` and `.agents/skills` (SOURCES.devinCliSkills), and imports
 * `.claude/skills/**\/SKILL.md` and `.github/skills/**\/SKILL.md` (SOURCES.devinReadConfigFrom).
 * Cline reads `.clinerules`, `.cline`, `.claude` and `.agents` skills
 * (SOURCES.clinePathsSource, checked 2026-10-17).
 */
export const SKILL_ROOTS: readonly SkillRoot[] = [
  {
    segment: '.claude/skills',
    readers: [
      { platform: 'claude-code', depth: 'direct' },
      { platform: 'cursor', depth: 'recursive' },
      { platform: 'copilot', depth: 'direct' },
      { platform: 'windsurf', depth: 'recursive' },
      { platform: 'cline', depth: 'shallow' },
    ],
  },
  {
    segment: '.agents/skills',
    readers: [
      { platform: 'codex', depth: 'recursive' },
      { platform: 'cursor', depth: 'recursive' },
      { platform: 'copilot', depth: 'direct' },
      { platform: 'gemini', depth: 'shallow' },
      { platform: 'windsurf', depth: 'direct' },
      { platform: 'cline', depth: 'shallow' },
    ],
  },
  { segment: '.cursor/skills', readers: [{ platform: 'cursor', depth: 'recursive' }] },
  {
    segment: '.github/skills',
    readers: [
      { platform: 'copilot', depth: 'direct' },
      { platform: 'windsurf', depth: 'recursive' },
    ],
  },
  { segment: '.gemini/skills', readers: [{ platform: 'gemini', depth: 'shallow' }] },
  {
    segment: '.codex/skills',
    readers: [
      { platform: 'codex', depth: 'recursive' },
      { platform: 'cursor', depth: 'recursive' },
    ],
  },
  { segment: '.devin/skills', readers: [{ platform: 'windsurf', depth: 'direct' }] },
  { segment: '.windsurf/skills', readers: [{ platform: 'windsurf', depth: 'direct' }] },
  { segment: '.cline/skills', readers: [{ platform: 'cline', depth: 'shallow' }] },
  { segment: '.clinerules/skills', readers: [{ platform: 'cline', depth: 'shallow' }] },
];

/**
 * The project skills folders of Gemini CLI, relative to the working directory, in the order it
 * reads them; a skill in a later folder overrides one with the same name in an earlier folder.
 * Gemini CLI reads them only in the working directory, `SKILL.md` and `<name>/SKILL.md` in each
 * (skillManager.ts and skillLoader.ts at google-gemini/gemini-cli ed96fae).
 */
export const GEMINI_SKILL_ROOTS = ['.gemini/skills', '.agents/skills'] as const;

export interface SkillLocation {
  /** The skills root directory, e.g. `apps/web/.claude/skills`. */
  readonly root: string;
  /** Path of SKILL.md relative to the root, e.g. `deploy/SKILL.md`. */
  readonly relative: string;
  /** Platforms that load SKILL.md from this path. */
  readonly platforms: ReadonlySet<PlatformId>;
}

function depthMatches(depth: SkillDepth, relative: string): boolean {
  const segments = relative.split('/').length;
  if (depth === 'direct') return segments === 2;
  if (depth === 'shallow') return segments <= 2;
  return true;
}

/**
 * The innermost known skills root that contains `path`, or undefined when the SKILL.md is not
 * below one (a skill collection, a plugin, an example). Matching is case-sensitive, like the
 * agents on Linux.
 */
export function skillLocation(path: string, caseMismatch = false): SkillLocation | undefined {
  let best: { root: SkillRoot; index: number } | undefined;
  for (const root of SKILL_ROOTS) {
    const needle = `${root.segment}/`;
    let index = path.lastIndexOf(needle);
    while (index > 0 && path.charAt(index - 1) !== '/') {
      index = path.lastIndexOf(needle, index - 1);
    }
    if (index === -1 || (best !== undefined && best.index >= index)) continue;
    best = { root, index };
  }
  if (best === undefined) return undefined;
  const rootPath = path.slice(0, best.index + best.root.segment.length);
  const relative = path.slice(rootPath.length + 1);
  const platforms = new Set<PlatformId>();
  for (const reader of best.root.readers) {
    // Codex discovers only the exact file name SKILL.md (discovery.rs).
    if (caseMismatch && reader.platform === 'codex') continue;
    if (depthMatches(reader.depth, relative)) platforms.add(reader.platform);
  }
  return { root: rootPath, relative, platforms };
}

/** What skill placement needs: the scan and the targeted platforms. A `LoadView` satisfies it. */
export interface SkillScope {
  readonly snapshot: Snapshot;
  readonly targets: ReadonlySet<PlatformId>;
}

/** Where a skill sits, as far as loading and distribution are concerned. */
export interface Placement {
  /** Platforms that load the skill where it is, over its path and symlink aliases. */
  readonly reach: ReadonlySet<PlatformId>;
  /**
   * True when the real file is neither in an agent's skills directory nor in a plugin: a skill of
   * a collection that gets installed, packaged or uploaded on its own. Only these are judged by
   * the validators and upload paths (skills-ref, the anthropics/skills packager, claude.ai).
   */
  readonly distributable: boolean;
  /** True when Claude Code loads the skill as a project skill from a `.claude/skills` directory. */
  readonly claudeProject: boolean;
}

const placements = new WeakMap<Artifact, Placement>();

/** Normalizes a name the way skills-ref compares names: trimmed, then NFKC. */
export function normalizeName(value: string): string {
  return value.trim().normalize('NFKC');
}

/** True when the file at `path` is named SKILL.md (in any letter case). */
function isSkillFile(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase() === 'skill.md';
}

/** Marketplace manifests: `<dir>/.<agent>-plugin/marketplace.json`. */
const MARKETPLACE_MANIFEST = /(?:^|\/)(\.[a-z0-9-]+-plugin)\/marketplace\.json$/;
const MARKETPLACE_PLATFORMS: Readonly<Record<string, PlatformId>> = {
  '.claude-plugin': 'claude-code',
  '.codex-plugin': 'codex',
  '.cursor-plugin': 'cursor',
};
const marketplaces = new WeakMap<Snapshot, ReadonlyMap<string, readonly PlatformId[]>>();

/** Directories that hold a marketplace manifest, with the agents those manifests serve. */
function marketplaceIndex(snapshot: Snapshot): ReadonlyMap<string, readonly PlatformId[]> {
  const cached = marketplaces.get(snapshot);
  if (cached !== undefined) return cached;
  const index = new Map<string, PlatformId[]>();
  for (const path of snapshot.paths) {
    const marker = MARKETPLACE_MANIFEST.exec(path)?.[1];
    if (marker === undefined) continue;
    const platform = MARKETPLACE_PLATFORMS[marker];
    const directory = dirnamePosix(dirnamePosix(path));
    const list = index.get(directory) ?? [];
    if (platform !== undefined && !list.includes(platform)) list.push(platform);
    index.set(directory, list);
  }
  marketplaces.set(snapshot, index);
  return index;
}

/**
 * Agents of a plugin that a marketplace declares without its own plugin.json: a SKILL.md at
 * `<plugin>/skills/<name>/SKILL.md` below a directory with a marketplace manifest. Claude Code
 * marketplaces may define a plugin inline, so the plugin directory then has no manifest.
 */
function marketplacePluginReaders(
  snapshot: Snapshot,
  path: string,
): readonly PlatformId[] | undefined {
  const parts = path.split('/');
  if (parts.length < 4 || parts[parts.length - 3] !== 'skills') return undefined;
  const plugin = parts.slice(0, -3).join('/');
  const index = marketplaceIndex(snapshot);
  for (let directory = plugin; ; directory = dirnamePosix(directory)) {
    const platforms = index.get(directory);
    if (platforms !== undefined) return platforms;
    if (directory === '') return undefined;
  }
}

/** The agents of the plugin `path` belongs to, or undefined outside every plugin. */
export function pluginReaders(snapshot: Snapshot, path: string): readonly PlatformId[] | undefined {
  return pluginRootOf(snapshot, path)?.platforms ?? marketplacePluginReaders(snapshot, path);
}

/**
 * Platforms that load SKILL.md from `path`: the readers of its skills directory, else the
 * agents of the plugin it belongs to, else every platform.
 */
export function readersAt(snapshot: Snapshot, path: string, caseMismatch = false): Set<PlatformId> {
  const location = skillLocation(path, caseMismatch);
  if (location !== undefined) return new Set(location.platforms);
  // In a plugin, the plugin's agents load its skills. Unknown plugin kinds add no reader.
  const plugin = pluginReaders(snapshot, path);
  if (plugin !== undefined) {
    return new Set(SKILL_PLATFORMS.filter((platform) => plugin.includes(platform)));
  }
  // Outside every skills directory and plugin: installed elsewhere, by any agent.
  return new Set(SKILL_PLATFORMS);
}

export function placement(scope: SkillScope, artifact: Artifact): Placement {
  const cached = placements.get(artifact);
  if (cached !== undefined) return cached;
  const caseMismatch = artifact.caseMismatch !== undefined;
  const reach = new Set<PlatformId>();
  let claudeProject = false;
  for (const path of [artifact.path, ...artifact.aliases]) {
    for (const platform of readersAt(scope.snapshot, path, caseMismatch)) reach.add(platform);
    const location = skillLocation(path, caseMismatch);
    if (
      location?.root.endsWith('.claude/skills') === true &&
      location.platforms.has('claude-code')
    ) {
      claudeProject = true;
    }
  }
  const real = artifact.realPath;
  // A symlinked SKILL.md whose real file has another name (an agent or rule file) is not a skill
  // directory anyone can package or upload.
  const distributable =
    isSkillFile(real) &&
    skillLocation(real, caseMismatch) === undefined &&
    pluginReaders(scope.snapshot, real) === undefined;
  const result = { reach, distributable, claudeProject };
  placements.set(artifact, result);
  return result;
}

/** True when the skill sits in a plugin rather than in an agent's skills directory. */
export function inPlugin(scope: SkillScope, artifact: Artifact): boolean {
  return (
    skillLocation(artifact.path, artifact.caseMismatch !== undefined) === undefined &&
    pluginReaders(scope.snapshot, artifact.path) !== undefined
  );
}

/** Platforms that load this skill where it is. */
export function skillReach(scope: SkillScope, artifact: Artifact): ReadonlySet<PlatformId> {
  return placement(scope, artifact).reach;
}

/**
 * The agents that load a skill. For a skill whose real SKILL.md sits in a plugin, the plugin's
 * marker agents stand in for the real path, and every alias in an agent's skills directory or
 * another plugin adds the agents that read it there. An alias in a plain folder adds none: no
 * agent loads it there. Any other skill: every agent that loads it (`Placement.reach`).
 */
export function audience(scope: SkillScope, artifact: Artifact): ReadonlySet<PlatformId> {
  const real = artifact.realPath;
  const caseMismatch = artifact.caseMismatch !== undefined;
  // Only a real SKILL.md is a skill of the plugin; an agent or command file that a symlink
  // exposes as SKILL.md is loaded only where the symlinks are.
  const plugin =
    isSkillFile(real) && skillLocation(real, caseMismatch) === undefined
      ? pluginReaders(scope.snapshot, real)
      : undefined;
  if (plugin === undefined) return placement(scope, artifact).reach;
  const result = new Set<PlatformId>(
    SKILL_PLATFORMS.filter((platform) => plugin.includes(platform)),
  );
  for (const path of [artifact.path, ...artifact.aliases]) {
    if (path === real) continue;
    const located =
      skillLocation(path, caseMismatch) !== undefined ||
      pluginReaders(scope.snapshot, path) !== undefined;
    if (!located) continue;
    for (const platform of readersAt(scope.snapshot, path, caseMismatch)) result.add(platform);
  }
  return result;
}

/**
 * Where the skill body starts. Agents treat everything as body when they find no closed
 * frontmatter block, so only `valid` and `invalid` blocks are skipped.
 */
export function bodyOffset(result: FrontmatterResult): number {
  return result.kind === 'valid' || result.kind === 'invalid' ? result.bodyOffset : 0;
}

// ---------------------------------------------------------------------------------------------
// Claude Code skill listing
// ---------------------------------------------------------------------------------------------

/**
 * Claude Code cuts the combined `description` and `when_to_use` text of each skill in its skill
 * listing at this many characters (`skillListingMaxDescChars`, code.claude.com/docs/en/skills).
 */
export const CLAUDE_LISTING_MAX_CHARS = 1536;

/** Text of a scalar the way the listing shows it: numbers and booleans as written. */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * The description Claude Code uses when the frontmatter has none: the first non-empty line of
 * the body (code.claude.com/docs/en/skills, frontmatter reference).
 */
export function firstBodyLine(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

/** The first `max` code points of `text`. */
export function cutCodePoints(text: string, max: number): string {
  let count = 0;
  let index = 0;
  for (const char of text) {
    if (count === max) return text.slice(0, index);
    count++;
    index += char.length;
  }
  return text;
}

/** What Claude Code lists for one skill, before the model picks it. */
export interface ClaudeSkillListing {
  /** `name` from the frontmatter, else the skill's directory name. */
  readonly name: string;
  /**
   * Where the description comes from:
   * - `frontmatter`: the `description` field.
   * - `body`: no `description` field, so the first non-empty line of the body.
   * - `none`: the frontmatter is not valid YAML, so Claude Code reads no fields.
   */
  readonly source: 'frontmatter' | 'body' | 'none';
  /** `description` followed by `when_to_use`, before the cut. */
  readonly text: string;
  /** Code points of `text`, counted without any separator Claude Code may add. */
  readonly length: number;
  /** `text` cut at {@link CLAUDE_LISTING_MAX_CHARS} code points. */
  readonly shown: string;
  /** Offset of the body in the decoded text: what Claude Code loads when the skill is used. */
  readonly bodyOffset: number;
}

/**
 * The listing entry of a SKILL.md as Claude Code builds it (code.claude.com/docs/en/skills):
 * frontmatter is read only when `---` is the first line; `name` defaults to the directory name
 * and `description` to the first non-empty body line; YAML that does not parse leaves the skill
 * with no fields. A block without a closing delimiter, or in another format, is read as body.
 * The description is counted the way skill/description-too-long counts it.
 */
export function claudeSkillListing(
  path: string,
  text: string,
  frontmatter: FrontmatterResult,
): ClaudeSkillListing {
  const directory = dirnamePosix(path);
  let name = directory.slice(directory.lastIndexOf('/') + 1);
  let source: ClaudeSkillListing['source'] = 'body';
  let description = '';
  let whenToUse: string | undefined;
  let bodyOffset = 0;
  if (frontmatter.kind === 'valid') {
    const { data } = frontmatter;
    bodyOffset = frontmatter.bodyOffset;
    const declared = data.values['name'];
    if (typeof declared === 'string' && declared.trim() !== '') name = declared.trim();
    if (data.keys.includes('description')) {
      source = 'frontmatter';
      description = scalarText(data.values['description']) ?? '';
    } else {
      description = firstBodyLine(text.slice(bodyOffset)) ?? '';
    }
    whenToUse = scalarText(data.values['when_to_use']);
  } else if (frontmatter.kind === 'invalid') {
    bodyOffset = frontmatter.bodyOffset;
    source = 'none';
  } else {
    description = firstBodyLine(text) ?? '';
  }
  const combined = description + (whenToUse ?? '');
  return {
    name,
    source,
    text: combined,
    length: codePointLength(combined),
    shown: cutCodePoints(combined, CLAUDE_LISTING_MAX_CHARS),
    bodyOffset,
  };
}
