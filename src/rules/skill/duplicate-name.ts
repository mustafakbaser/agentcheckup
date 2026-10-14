import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, PlatformId, Span } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { joinClauses, quote, quotePath, sentence } from '../shared/format.js';
import {
  type Impact,
  loadableSkills,
  normalizeName,
  resolveImpacts,
  skillDirectoryName,
  skillLocation,
  trimmedString,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

interface Entry {
  readonly artifact: Artifact;
  readonly path: string;
  readonly name: string;
  readonly platforms: ReadonlySet<PlatformId>;
  readonly span: Span | undefined;
}

/** What each platform does with two skills of the same name, from its documentation. */
const CONSEQUENCES: Partial<Record<PlatformId, (name: string) => string>> = {
  'claude-code': (name) => `Claude Code gives ${quote(`/${name}`)} to only one of them`,
  codex: () => 'Codex lists both under the same name',
  gemini: () => 'Gemini CLI loads only one of them',
  copilot: () => 'GitHub Copilot requires names to be unique',
};

/** Platforms that need an explicit `name` and do not fall back to the directory name. */
const NEEDS_EXPLICIT_NAME: ReadonlySet<PlatformId> = new Set(['gemini', 'copilot']);

export const duplicateNameRule = defineRule({
  meta: {
    id: 'skill/duplicate-name',
    title: 'Two skills in one skills directory have the same name',
    rationale: `Agents identify a skill by its \`name\`, or by its directory name when \`name\` is missing. When two skills in the same skills directory share a name, Claude Code gives the \`/name\` command to only one of them, Codex lists both under the same name, Gemini CLI loads only the last one it finds, and GitHub Copilot requires names to be unique.

Only skills that an agent finds in the same skills directory are compared: Claude Code reads \`<root>/<name>/SKILL.md\`, Gemini CLI also \`<root>/SKILL.md\`, and Codex searches the whole tree. GitHub Copilot does not document a depth and is treated like Claude Code. A skill reached through several symlinks counts once.

Rename one of the skills.`,
    category: 'loading',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex', 'copilot', 'gemini'],
    sources: [
      SOURCES.claudeSkills,
      SOURCES.codexSkills,
      SKILL_SOURCES.geminiSkills,
      SKILL_SOURCES.geminiSkillManager,
      SKILL_SOURCES.copilotAddSkills,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    const groups = new Map<string, Entry[]>();
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const raw = trimmedString(frontmatter.data.values['name']);
      const explicit = raw === undefined || raw === '' ? undefined : normalizeName(raw);
      const span = explicit === undefined ? undefined : frontmatter.data.valueSpan('name');
      for (const path of [artifact.path, ...artifact.aliases]) {
        const location = skillLocation(path, artifact.caseMismatch !== undefined);
        if (location === undefined) continue;
        const directory = skillDirectoryName(path);
        const name = explicit ?? (directory === undefined ? undefined : normalizeName(directory));
        if (name === undefined || name === '') continue;
        const platforms = new Set(
          [...location.platforms].filter(
            (platform) => explicit !== undefined || !NEEDS_EXPLICIT_NAME.has(platform),
          ),
        );
        const key = `${location.root}\u0000${name}`;
        const group = groups.get(key) ?? [];
        group.push({ artifact, path, name, platforms, span });
        groups.set(key, group);
      }
    }

    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) continue;
      const reported = new Set<Artifact>([first.artifact]);
      for (const entry of group) {
        if (reported.has(entry.artifact)) continue;
        reported.add(entry.artifact);
        const shared = [...entry.platforms].filter((platform) => first.platforms.has(platform));
        const clauses: string[] = [];
        const impacts: Impact[] = [];
        for (const platform of shared) {
          const consequence = CONSEQUENCES[platform];
          if (consequence === undefined) continue;
          clauses.push(consequence(entry.name));
          impacts.push({ platform, severity: 'warn' });
        }
        const resolved = resolveImpacts(context, entry.artifact, impacts);
        if (resolved === undefined) continue;
        context.report({
          artifact: entry.artifact,
          message: `Skill name ${quote(entry.name)} is also used by ${quotePath(first.path)}${entry.path === entry.artifact.path ? '' : `, in the same skills directory as this skill's symlink ${quotePath(entry.path)}`}. ${sentence(joinClauses(clauses))}`,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(entry.span === undefined ? {} : { span: entry.span }),
          related: [
            {
              path: first.artifact.path,
              message: `Also named ${quote(entry.name)}.`,
              ...(first.span === undefined ? {} : { span: first.span }),
            },
          ],
        });
      }
    }
  },
});
