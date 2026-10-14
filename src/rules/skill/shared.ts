/**
 * Helpers shared by the skill rules. Pure functions over the parsed views; no raw-text parsing.
 */
import { dirnamePosix } from '../../core/paths.js';
import {
  type Artifact,
  PLATFORM_IDS,
  type PlatformId,
  type RuleContext,
  type Severity,
  type Snapshot,
  type Span,
} from '../../core/types.js';
import type { FrontmatterResult } from '../../parse/types.js';
import { isBundledSkill, pluginRootOf } from '../../platforms/location.js';

/** Platforms that read SKILL.md files (READERS.skill in src/platforms/classify.ts). */
export const SKILL_PLATFORMS = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'gemini',
] as const satisfies readonly PlatformId[];

/** The six top-level fields of the Agent Skills specification. */
export const SPEC_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

export type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;

/** The parsed frontmatter when it is valid YAML, otherwise undefined. */
export function validFrontmatter<Options>(
  context: RuleContext<Options>,
  artifact: Artifact,
): ValidFrontmatter | undefined {
  const result = context.frontmatter(artifact);
  return result.kind === 'valid' ? result : undefined;
}

/**
 * Where the skill body starts. Agents treat everything as body when they find no closed
 * frontmatter block, so only `valid` and `invalid` blocks are skipped.
 */
export function bodyOffset(result: FrontmatterResult): number {
  return result.kind === 'valid' || result.kind === 'invalid' ? result.bodyOffset : 0;
}

/** The skill directory: the directory that contains SKILL.md, '' at the scan root. */
export function skillDirectory(path: string): string {
  return dirnamePosix(path);
}

/** Base name of the skill directory, or undefined when SKILL.md sits at the scan root. */
export function skillDirectoryName(path: string): string | undefined {
  const directory = dirnamePosix(path);
  if (directory === '') return undefined;
  return directory.slice(directory.lastIndexOf('/') + 1);
}

/** Span of the opening `---` delimiter, used for findings about a field that is absent. */
export const OPENING_DELIMITER: Span = { offset: 0, length: 3 };

/** A frontmatter value as written: trimmed text for strings, undefined otherwise. */
export function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** Normalizes a name the way skills-ref compares names: trimmed, then NFKC. */
export function normalizeName(value: string): string {
  return value.trim().normalize('NFKC');
}

// ---------------------------------------------------------------------------------------------
// Which platforms discover a skill at its location
// ---------------------------------------------------------------------------------------------

/**
 * How deep below a skills root a platform looks for SKILL.md:
 * - `direct`: `<root>/<name>/SKILL.md` only (Claude Code; GitHub Copilot is assumed the same).
 * - `shallow`: also `<root>/SKILL.md` (Gemini CLI globs `SKILL.md` and `<name>/SKILL.md`).
 * - `recursive`: any depth (Codex and Cursor walk the root).
 */
type Depth = 'direct' | 'shallow' | 'recursive';

interface SkillRoot {
  /** The two path segments that make up the root, e.g. `.claude/skills`. */
  readonly segment: string;
  readonly readers: readonly { readonly platform: PlatformId; readonly depth: Depth }[];
}

/**
 * Project skill roots, verified 2026-10-14: Claude Code reads `.claude/skills`; Codex reads
 * `.agents/skills` and `.codex/skills`; Cursor reads `.agents`, `.cursor`, `.claude` and `.codex`
 * skills; GitHub Copilot reads `.github`, `.claude` and `.agents` skills; Gemini CLI reads
 * `.gemini/skills` and `.agents/skills`.
 */
const SKILL_ROOTS: readonly SkillRoot[] = [
  {
    segment: '.claude/skills',
    readers: [
      { platform: 'claude-code', depth: 'direct' },
      { platform: 'cursor', depth: 'recursive' },
      { platform: 'copilot', depth: 'direct' },
    ],
  },
  {
    segment: '.agents/skills',
    readers: [
      { platform: 'codex', depth: 'recursive' },
      { platform: 'cursor', depth: 'recursive' },
      { platform: 'copilot', depth: 'direct' },
      { platform: 'gemini', depth: 'shallow' },
    ],
  },
  { segment: '.cursor/skills', readers: [{ platform: 'cursor', depth: 'recursive' }] },
  { segment: '.github/skills', readers: [{ platform: 'copilot', depth: 'direct' }] },
  { segment: '.gemini/skills', readers: [{ platform: 'gemini', depth: 'shallow' }] },
  {
    segment: '.codex/skills',
    readers: [
      { platform: 'codex', depth: 'recursive' },
      { platform: 'cursor', depth: 'recursive' },
    ],
  },
];

export interface SkillLocation {
  /** The skills root directory, e.g. `apps/web/.claude/skills`. */
  readonly root: string;
  /** Path of SKILL.md relative to the root, e.g. `deploy/SKILL.md`. */
  readonly relative: string;
  /** Platforms that load SKILL.md from this path. */
  readonly platforms: ReadonlySet<PlatformId>;
}

function depthMatches(depth: Depth, relative: string): boolean {
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

/** What the skill rules need from a RuleContext: the scan and the targeted platforms. */
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
function pluginReaders(snapshot: Snapshot, path: string): readonly PlatformId[] | undefined {
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
 * Folder names whose contents are payload for other projects or test input, not skills of this
 * repository. Same list as the instructions family (src/rules/instructions/helpers.ts).
 */
const PAYLOAD_FOLDERS: ReadonlySet<string> = new Set([
  'assets',
  'example',
  'examples',
  'sample',
  'samples',
  'fixture',
  'fixtures',
  '__fixtures__',
  'testdata',
  'scaffold',
  'scaffolds',
]);

/**
 * True when a directory on `path` (not the file name) is a template, example, sample, fixture,
 * test-data, scaffold or assets folder. A SKILL.md there is copied into other projects or used
 * as test input, so judging it where it sits is wrong.
 */
export function inPayloadFolder(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  segments.pop();
  return segments.some((segment) => segment.includes('template') || PAYLOAD_FOLDERS.has(segment));
}

/**
 * The skills the rules judge: every SKILL.md except one bundled inside another skill's
 * directory, which is a resource of that skill, and one in a template, example or fixture
 * folder, which is payload for other projects.
 */
export function loadableSkills<Options>(context: RuleContext<Options>): Artifact[] {
  return context.artifacts.filter(
    (artifact) =>
      !isBundledSkill(context.snapshot, artifact.path) && !inPayloadFolder(artifact.path),
  );
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

// ---------------------------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------------------------

/** One platform's consequence for a finding. */
export interface Impact {
  readonly platform: PlatformId;
  readonly severity: Severity;
  /**
   * `agent` (default): what the agent does when it loads the skill from this location.
   * `distribution`: what happens when the skill is validated, packaged or uploaded (skills-ref,
   * the anthropics/skills packager, claude.ai and the Claude API). Applies only to distributable
   * skills, and is attributed to `claude-code`.
   */
  readonly scope?: 'agent' | 'distribution';
}

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, error: 2 };

export interface Resolved {
  readonly severity: Severity;
  /** Affected platforms the user targets, in PLATFORM_IDS order. */
  readonly platforms: readonly PlatformId[];
}

/**
 * Keeps the impacts that apply: on a targeted platform; for agent impacts, on a platform that
 * loads the skill from its location; for distribution impacts, only for a distributable skill.
 * The finding's severity is the worst remaining impact. Returns undefined when nothing applies:
 * the finding is not reported.
 */
export function resolveImpacts(
  scope: SkillScope,
  artifact: Artifact,
  impacts: readonly Impact[],
): Resolved | undefined {
  const { reach, distributable } = placement(scope, artifact);
  let severity: Severity | undefined;
  const affected = new Set<PlatformId>();
  for (const impact of impacts) {
    if (!scope.targets.has(impact.platform)) continue;
    if (impact.scope === 'distribution' ? !distributable : !reach.has(impact.platform)) continue;
    affected.add(impact.platform);
    if (severity === undefined || RANK[impact.severity] > RANK[severity]) {
      severity = impact.severity;
    }
  }
  if (severity === undefined) return undefined;
  return { severity, platforms: PLATFORM_IDS.filter((platform) => affected.has(platform)) };
}

/** The platforms in `platforms` that load the skill from its location, in the given order. */
export function reached(
  scope: SkillScope,
  artifact: Artifact,
  platforms: readonly PlatformId[],
): PlatformId[] {
  const { reach } = placement(scope, artifact);
  return platforms.filter((platform) => reach.has(platform));
}

/** True when validators and upload paths apply to this skill (see Placement.distributable). */
export function isDistributable(scope: SkillScope, artifact: Artifact): boolean {
  return placement(scope, artifact).distributable;
}

/** The same severity on every listed platform. */
export function impactsOn(
  platforms: readonly PlatformId[],
  severity: Severity,
  scope: Impact['scope'] = 'agent',
): Impact[] {
  return platforms.map((platform) => ({ platform, severity, scope }));
}
