import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import {
  type Artifact,
  PLATFORM_IDS,
  type PlatformId,
  type Severity,
  type Span,
} from '../../core/types.js';
import { clineSkillSkip } from '../../platforms/cline-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { joinClauses, platformList, quote, quotePath, sentence } from '../shared/format.js';
import {
  type Impact,
  loadableSkills,
  normalizeName,
  resolveImpacts,
  skillDirectoryName,
  skillLocation,
  trimmedString,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

/** One path through which an agent finds a skill. */
interface Entry {
  readonly artifact: Artifact;
  readonly path: string;
  readonly name: string;
  readonly span: Span | undefined;
  /** The skills root the path is in, such as `apps/web/.claude/skills`. */
  readonly root: string;
}

/** Two skills of one name: the paths through which they meet, and the platforms that see both. */
interface Collision {
  /** `[later, first]` entries, one per pool. */
  readonly pairs: [Entry, Entry][];
  readonly platforms: Set<PlatformId>;
}

/** What a documented platform does with two skills of the same name. */
interface Consequence {
  readonly severity: Severity;
  readonly clause: (name: string) => string;
}

/** What each platform does with two skills of the same name, from its documentation or source. */
const CONSEQUENCES: Partial<Record<PlatformId, Consequence>> = {
  'claude-code': {
    severity: 'warn',
    clause: (name) => `Claude Code gives ${quote(`/${name}`)} to only one of them`,
  },
  codex: { severity: 'warn', clause: () => 'Codex lists both under the same name' },
  gemini: { severity: 'warn', clause: () => 'Gemini CLI loads only one of them' },
  copilot: { severity: 'warn', clause: () => 'GitHub Copilot requires names to be unique' },
  // The SDK keys skills by name in lower case; a later file replaces an earlier one.
  cline: { severity: 'warn', clause: () => 'Cline loads only one of them' },
};

/**
 * Platforms that read both skills but do not document what happens to two of one name. They
 * identify a skill by its directory, so they count only skills whose directories match too.
 */
const UNDOCUMENTED: ReadonlySet<PlatformId> = new Set(['cursor', 'windsurf']);

/** Platforms that need an explicit `name` and do not fall back to the directory name. */
const NEEDS_EXPLICIT_NAME: ReadonlySet<PlatformId> = new Set(['gemini', 'copilot']);

/**
 * Platforms that load a SKILL.md without frontmatter under its directory name: Claude Code and
 * Devin Local document it, the Cline SDK does it, and Cursor identifies a skill by its directory.
 * Codex and Gemini CLI skip such a skill, and GitHub Copilot needs an explicit `name`.
 */
const WITHOUT_FRONTMATTER: ReadonlySet<PlatformId> = new Set([
  'claude-code',
  'cursor',
  'windsurf',
  'cline',
]);

/** Platforms that compare names without regard to letter case. */
const CASE_INSENSITIVE: ReadonlySet<PlatformId> = new Set(['cline']);

/** `apps/web/.claude/skills` -> `apps/web`: the directory whose skills roots an agent merges. */
function ownerOf(root: string): string {
  return dirnamePosix(dirnamePosix(root));
}

/** The clauses and impacts for the platforms that read both skills, in PLATFORM_IDS order. */
function consequences(
  platforms: ReadonlySet<PlatformId>,
  name: string,
): { readonly clauses: string[]; readonly impacts: Impact[] } {
  const clauses: string[] = [];
  const impacts: Impact[] = [];
  const undocumented: PlatformId[] = [];
  for (const platform of PLATFORM_IDS) {
    if (!platforms.has(platform)) continue;
    const consequence = CONSEQUENCES[platform];
    if (consequence !== undefined) {
      clauses.push(consequence.clause(name));
      impacts.push({ platform, severity: consequence.severity });
    } else if (UNDOCUMENTED.has(platform)) {
      undocumented.push(platform);
      impacts.push({ platform, severity: 'info' });
    }
  }
  if (undocumented.length > 0) {
    const one = undocumented.length === 1;
    clauses.push(
      `${platformList(undocumented)} ${one ? 'reads' : 'read'} both and ${one ? 'does' : 'do'} not document which one the name reaches`,
    );
  }
  return { clauses, impacts };
}

export const duplicateNameRule = defineRule({
  meta: {
    id: 'skill/duplicate-name',
    title: 'Two skills that an agent reads together have the same name',
    rationale: `Agents identify a skill by its \`name\`, or by its directory name when \`name\` is missing. When two skills that an agent reads together share a name, Claude Code gives the \`/name\` command to only one of them, Codex lists both under the same name, Gemini CLI and Cline load only the last one they find, and GitHub Copilot requires names to be unique. Cursor and Devin Local identify a skill by its directory and do not document what happens to two skills of one name.

An agent reads skills together when they are in one of its skills directories, or in two of its skills directories of the same project: Cursor, GitHub Copilot, Devin Local and Cline read both \`.claude/skills\` and \`.agents/skills\`, so a skill copied into both is two skills of one name to them. Claude Code reads \`<root>/<name>/SKILL.md\`, Gemini CLI and Cline also \`<root>/SKILL.md\`, and Codex and Cursor search the whole tree. GitHub Copilot does not document a depth and is treated like Claude Code. A skill without frontmatter counts under its directory name for the agents that load it so: Claude Code, Cursor, Devin Local and Cline. A skill reached through several symlinks counts once, so a symlink from one skills directory to the other is not reported.

Rename one of the skills, or, when they are the same skill, keep one copy and link to it from the other skills directory.`,
    category: 'loading',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [
      SOURCES.claudeSkills,
      SOURCES.codexSkills,
      SKILL_SOURCES.geminiSkills,
      SKILL_SOURCES.geminiSkillManager,
      SKILL_SOURCES.copilotAddSkills,
      SOURCES.cursorSkills,
      SOURCES.devinCliSkillsCreate,
      SOURCES.clineConfigWatcherSource,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    /** Entries by platform, project directory and name, in scan order. */
    const pools = new Map<string, { readonly platform: PlatformId; readonly entries: Entry[] }>();
    for (const artifact of loadableSkills(context)) {
      const result = context.frontmatter(artifact);
      // Without frontmatter, the agents that load the skill name it after its directory.
      if (result.kind !== 'valid' && result.kind !== 'absent') continue;
      const frontmatter = result.kind === 'valid' ? result : undefined;
      const raw = trimmedString(frontmatter?.data.values['name']);
      const explicit = raw === undefined || raw === '' ? undefined : normalizeName(raw);
      const span = explicit === undefined ? undefined : frontmatter?.data.valueSpan('name');
      // Cline lists only a skill it can read.
      const clineReads = clineSkillSkip(artifact.decoded.text, result) === undefined;
      for (const path of [artifact.path, ...artifact.aliases]) {
        const location = skillLocation(path, artifact.caseMismatch !== undefined);
        if (location === undefined) continue;
        const directory = skillDirectoryName(path);
        const name = explicit ?? (directory === undefined ? undefined : normalizeName(directory));
        if (name === undefined || name === '') continue;
        const entry: Entry = { artifact, path, name, span, root: location.root };
        for (const platform of location.platforms) {
          if (explicit === undefined && NEEDS_EXPLICIT_NAME.has(platform)) continue;
          if (frontmatter === undefined && !WITHOUT_FRONTMATTER.has(platform)) continue;
          if (platform === 'cline' && !clineReads) continue;
          const parts = [platform, ownerOf(location.root)];
          parts.push(CASE_INSENSITIVE.has(platform) ? name.toLowerCase() : name);
          if (UNDOCUMENTED.has(platform)) parts.push(normalizeName(directory ?? ''));
          const key = parts.join('\u0000');
          const pool = pools.get(key) ?? { platform, entries: [] };
          pool.entries.push(entry);
          pools.set(key, pool);
        }
      }
    }

    // For each later skill, the first skill of each pool it shares, with the platforms of those
    // pools. A skill reached through several paths of one pool counts once.
    const collisions = new Map<Artifact, Map<Artifact, Collision>>();
    for (const { platform, entries } of pools.values()) {
      const first = entries[0];
      if (first === undefined) continue;
      const seen = new Set<Artifact>([first.artifact]);
      for (const entry of entries) {
        if (seen.has(entry.artifact)) continue;
        seen.add(entry.artifact);
        const byFirst = collisions.get(entry.artifact) ?? new Map<Artifact, Collision>();
        const collision = byFirst.get(first.artifact) ?? { pairs: [], platforms: new Set() };
        collision.pairs.push([entry, first]);
        collision.platforms.add(platform);
        byFirst.set(first.artifact, collision);
        collisions.set(entry.artifact, byFirst);
      }
    }

    for (const byFirst of collisions.values()) {
      for (const { pairs, platforms } of byFirst.values()) {
        // The paths to name: the skill's own path if it collides there, and a path of the other
        // skill in the same skills directory if there is one.
        const [entry, first] =
          pairs.find(([e, f]) => e.path === e.artifact.path && e.root === f.root) ??
          pairs.find(([e]) => e.path === e.artifact.path) ??
          pairs.find(([e, f]) => e.root === f.root) ??
          pairs[0] ??
          [];
        if (entry === undefined || first === undefined) continue;
        const { clauses, impacts } = consequences(platforms, entry.name);
        const resolved = resolveImpacts(context, entry.artifact, impacts);
        if (resolved === undefined) continue;
        const sameRoot = entry.root === first.root;
        const alias =
          entry.path === entry.artifact.path
            ? ''
            : sameRoot
              ? `, in the same skills directory as this skill's symlink ${quotePath(entry.path)}`
              : `, which the same agents read with this skill's symlink ${quotePath(entry.path)}`;
        const otherCase = entry.name === first.name ? '' : ` as ${quote(first.name)}`;
        context.report({
          artifact: entry.artifact,
          message: `Skill name ${quote(entry.name)} is also used by ${quotePath(first.path)}${otherCase}${alias}. ${sentence(joinClauses(clauses))}`,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(entry.span === undefined ? {} : { span: entry.span }),
          guidance: sameRoot
            ? `rename this skill or ${quotePath(first.path)}: change "name" and the skill directory to a name no other skill in ${quotePath(entry.root)} uses`
            : `if both are the same skill, keep one copy and make ${quotePath(dirnamePosix(entry.path))} a symlink to ${quotePath(dirnamePosix(first.path))}; otherwise rename one of them`,
          related: [
            {
              path: first.artifact.path,
              message: `Also named ${quote(first.name)}.`,
              ...(first.span === undefined ? {} : { span: first.span }),
            },
          ],
        });
      }
    }
  },
});
