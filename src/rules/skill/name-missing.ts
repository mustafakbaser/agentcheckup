import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import {
  joinClauses,
  joinNames,
  platformName,
  platformsDo,
  quote,
  sentence,
} from '../shared/format.js';
import {
  type Impact,
  isDistributable,
  loadableSkills,
  OPENING_DELIMITER,
  reached,
  resolveImpacts,
  skillDirectoryName,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

export const nameMissingRule = defineRule({
  meta: {
    id: 'skill/name-missing',
    title: 'Skill name is missing or empty',
    rationale: `The Agent Skills specification, Cursor, GitHub Copilot and the Claude API require a \`name\` field. Gemini CLI skips a SKILL.md whose frontmatter has no \`name\`, and loads a skill whose \`name\` is empty under an empty name. Claude Code and Codex fall back to the directory name, so the skill works there but not in the agents that require the field.

Add \`name\` with the directory name, in lowercase letters, digits and hyphens.`,
    category: 'portability',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'cursor', 'copilot', 'gemini'],
    sources: [
      SOURCES.agentSkillsSpec,
      SOURCES.cursorSkills,
      SKILL_SOURCES.copilotAddSkills,
      SOURCES.claudeApiSkills,
      SKILL_SOURCES.geminiSkillLoader,
      SOURCES.claudeSkills,
      SKILL_SOURCES.codexSkillLoader,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { data } = frontmatter;
      const present = data.keys.includes('name');
      const value = data.values['name'];
      const empty = value === null || (typeof value === 'string' && value.trim() === '');
      if (present && !empty) continue;

      const requiring = reached(context, artifact, ['cursor', 'copilot']);
      const gemini = reached(context, artifact, ['gemini']).length > 0;
      // Codex treats an empty name as missing; Claude Code documents only the missing case.
      const fallbacks = reached(context, artifact, present ? ['codex'] : ['claude-code', 'codex']);
      const impacts: Impact[] = [
        ...requiring.map((platform) => ({ platform, severity: 'warn' }) as const),
        { platform: 'claude-code', severity: 'warn', scope: 'distribution' },
        ...(gemini ? [{ platform: 'gemini', severity: present ? 'warn' : 'error' } as const] : []),
      ];
      const resolved = resolveImpacts(context, artifact, impacts);
      if (resolved === undefined) continue;

      const upload = isDistributable(context, artifact) ? ['claude.ai upload'] : [];
      const requiringNames = [...requiring.map(platformName), ...upload];
      const directory = skillDirectoryName(artifact.path);
      const fallbackName =
        directory === undefined ? 'the directory name' : `the directory name ${quote(directory)}`;
      const clauses = [
        gemini
          ? present
            ? 'Gemini CLI loads the skill without a usable name'
            : 'Gemini CLI skips the skill'
          : undefined,
        platformsDo(fallbacks, ['uses', 'use'], fallbackName),
        requiringNames.length === 0
          ? undefined
          : `${joinNames(requiringNames)} ${requiringNames.length === 1 ? 'requires' : 'require'} ${present ? 'a value' : 'the field'}`,
      ].filter((clause) => clause !== undefined);
      const lead = present ? '`name` is empty.' : 'The frontmatter has no `name`.';
      context.report({
        artifact,
        message: clauses.length === 0 ? lead : `${lead} ${sentence(joinClauses(clauses))}`,
        severity: resolved.severity,
        platforms: resolved.platforms,
        span: (present ? data.keySpan('name') : undefined) ?? OPENING_DELIMITER,
      });
    }
  },
});
