import { RULESET_VERSION } from '../../core/meta.js';
import { descriptionState } from '../../platforms/codex-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import {
  describeType,
  joinClauses,
  joinNames,
  platformName,
  platformsDo,
  quote,
  sentence,
} from '../shared/format.js';
import {
  type Impact,
  impactsOn,
  isDistributable,
  loadableSkills,
  OPENING_DELIMITER,
  reached,
  resolveImpacts,
  SKILL_PLATFORMS,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

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

export const descriptionMissingRule = defineRule({
  meta: {
    id: 'skill/description-missing',
    title: 'Skill description is missing or empty',
    rationale: `Agents decide when to use a skill by matching the request against its \`description\`. Codex skips a skill whose description is missing or empty, and Gemini CLI skips one without the key. When the key is omitted, Claude Code uses the first non-empty line of the body instead, so a heading such as \`# Deploy\` becomes the text Claude matches requests against; its documentation does not cover an empty value. The Agent Skills specification, Cursor, GitHub Copilot and the Claude API require the field.

Add a \`description\` that says what the skill does and when to use it.`,
    category: 'loading',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SKILL_SOURCES.codexSkillParser,
      SKILL_SOURCES.geminiSkillLoader,
      SOURCES.claudeSkills,
      SOURCES.agentSkillsSpec,
      SOURCES.skillsRefValidator,
      SOURCES.cursorSkills,
      SKILL_SOURCES.copilotAddSkills,
      SOURCES.claudeApiSkills,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { data } = frontmatter;
      const state = descriptionState(data);
      if (state === 'text') continue;
      const present = data.keys.includes('description');
      const value = data.values['description'];

      const requiring = reached(context, artifact, ['cursor', 'copilot']);
      const distributable = isDistributable(context, artifact);
      const requiringNames = [
        ...requiring.map(platformName),
        ...(distributable ? ['claude.ai upload'] : []),
      ];
      const verb = requiringNames.length === 1 ? 'requires' : 'require';
      const requirement = (what: string): string | undefined =>
        requiringNames.length === 0 ? undefined : `${joinNames(requiringNames)} ${verb} ${what}`;
      const codex = reached(context, artifact, ['codex']).length > 0;
      const gemini = reached(context, artifact, ['gemini']).length > 0;
      const claude = reached(context, artifact, ['claude-code']).length > 0;
      const fallback = firstBodyLine(artifact.decoded.text.slice(frontmatter.bodyOffset));
      const claudeClause =
        fallback === undefined
          ? 'Claude Code finds no line in the body to use instead'
          : `Claude Code uses the first non-empty line of the body instead (${quote(fallback)})`;

      const impacts: Impact[] = [
        ...requiring.map((platform) => ({ platform, severity: 'warn' }) as const),
        { platform: 'claude-code', severity: 'warn', scope: 'distribution' },
      ];
      const clauses: (string | undefined)[] = [];
      let lead: string;
      if (state === 'not-text') {
        lead = `\`description\` is ${describeType(value)}, not text.`;
        if (codex) {
          clauses.push('Codex cannot read the frontmatter and skips the skill');
          impacts.push({ platform: 'codex', severity: 'error' });
        }
        if (distributable) clauses.push('the skills-ref validator rejects it');
      } else if (state === 'missing') {
        lead = 'The frontmatter has no `description`.';
        const skipping = reached(context, artifact, ['codex', 'gemini']);
        clauses.push(platformsDo(skipping, ['skips', 'skip'], 'the skill'));
        impacts.push(...impactsOn(skipping, 'error'));
        if (claude) {
          clauses.push(claudeClause);
          impacts.push({ platform: 'claude-code', severity: 'warn' });
        }
        clauses.push(requirement('the field'));
      } else {
        // Claude Code documents its fallback only for an omitted description, so an empty one
        // claims nothing for Claude Code (as in skill/name-missing).
        lead = '`description` is empty.';
        if (codex) clauses.push('Codex skips the skill');
        if (gemini) clauses.push('Gemini CLI loads it with no description');
        clauses.push(requirement('a value'));
        if (codex) impacts.push({ platform: 'codex', severity: 'error' });
        if (gemini) impacts.push({ platform: 'gemini', severity: 'warn' });
      }
      const consequences = clauses.filter((clause) => clause !== undefined);
      const message =
        consequences.length === 0 ? lead : `${lead} ${sentence(joinClauses(consequences))}`;
      const resolved = resolveImpacts(context, artifact, impacts);
      if (resolved === undefined) continue;
      context.report({
        artifact,
        message,
        severity: resolved.severity,
        platforms: resolved.platforms,
        span: (present ? data.keySpan('description') : undefined) ?? OPENING_DELIMITER,
      });
    }
  },
});
