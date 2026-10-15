/**
 * Helpers shared by the skill rules. Pure functions over the parsed views; no raw-text parsing.
 * Where a skill sits and who loads it lives in src/platforms/skills.ts and is re-exported here.
 */
import { dirnamePosix } from '../../core/paths.js';
import {
  type Artifact,
  PLATFORM_IDS,
  type PlatformId,
  type RuleContext,
  type Severity,
  type Span,
} from '../../core/types.js';
import type { FrontmatterResult } from '../../parse/types.js';
import { isBundledSkill } from '../../platforms/location.js';
import { inPayloadFolder } from '../../platforms/paths.js';
import { placement, type SkillScope } from '../../platforms/skills.js';

export { inPayloadFolder } from '../../platforms/paths.js';
export {
  audience,
  bodyOffset,
  inPlugin,
  normalizeName,
  placement,
  readersAt,
  SKILL_PLATFORMS,
  skillLocation,
  skillReach,
} from '../../platforms/skills.js';
export type { Placement, SkillLocation, SkillScope } from '../../platforms/skills.js';

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
