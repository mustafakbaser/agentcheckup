import { codePointLength } from '../../core/measure.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger } from '../shared/format.js';
import {
  type Impact,
  isDistributable,
  loadableSkills,
  reached,
  resolveImpacts,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

/** Agent Skills spec and Claude API limit for `description`, enforced on upload. */
const MAX_DESCRIPTION = 1024;
/** Claude Code cuts the combined description and when_to_use text in the skill listing. */
const LISTING_CAP = 1536;

/** Text of a scalar the way the listing shows it: numbers and booleans as written. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export const descriptionTooLongRule = defineRule({
  meta: {
    id: 'skill/description-too-long',
    title: 'Skill description exceeds the upload or Claude Code listing limit',
    rationale: `The Agent Skills specification and the Claude API limit \`description\` to 1,024 characters. The skills-ref validator, the anthropics/skills packager and claude.ai upload reject a longer one, so this limit is checked only for skills that are installed or uploaded on their own. Claude Code appends \`when_to_use\` to the description in its skill listing and cuts the combined text at 1,536 characters, so Claude does not see the rest when it chooses a skill.

Put the key use case first and move details into the body.`,
    category: 'budget',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code'],
    sources: [
      SOURCES.agentSkillsSpec,
      SOURCES.claudeApiSkills,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.anthropicsSkillValidator,
      SOURCES.claudeSkills,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { data } = frontmatter;
      const description = data.values['description'];
      if (typeof description !== 'string') continue;
      const length = codePointLength(description.trim());
      const whenToUse = scalarText(data.values['when_to_use']);
      // Counted without any separator Claude Code may add, so the cut is never overstated.
      const combined = length + (whenToUse === undefined ? 0 : codePointLength(whenToUse));
      const cut = reached(context, artifact, ['claude-code']).length > 0 && combined > LISTING_CAP;
      const overLimit = length > MAX_DESCRIPTION && isDistributable(context, artifact);
      if (!overLimit && !cut) continue;

      const impacts: Impact[] = [
        ...(overLimit
          ? [{ platform: 'claude-code', severity: 'error', scope: 'distribution' } as const]
          : []),
        ...(cut ? [{ platform: 'claude-code', severity: 'warn' } as const] : []),
      ];
      const resolved = resolveImpacts(context, artifact, impacts);
      if (resolved === undefined) continue;
      const total = formatInteger(combined);
      const cap = formatInteger(LISTING_CAP);
      let message: string;
      if (overLimit) {
        message = `The description is ${formatInteger(length)} characters, over the ${formatInteger(MAX_DESCRIPTION)} that the Agent Skills specification allows, so the skills-ref validator and claude.ai upload reject the skill.${cut ? ` Claude Code also cuts its skill listing entry at ${cap} characters.` : ''}`;
      } else if (whenToUse === undefined || length > LISTING_CAP) {
        message = `The description is ${formatInteger(length)} characters, but Claude Code cuts the skill listing entry at ${cap}, so Claude does not see the end of the description when it chooses a skill.`;
      } else {
        message = `\`description\` and \`when_to_use\` together are ${total} characters, but Claude Code cuts the skill listing entry at ${cap}, so Claude does not see the end of \`when_to_use\` when it chooses a skill.`;
      }
      const span =
        !overLimit && whenToUse !== undefined && length <= LISTING_CAP
          ? data.valueSpan('when_to_use')
          : data.valueSpan('description');
      context.report({
        artifact,
        message,
        severity: resolved.severity,
        platforms: resolved.platforms,
        ...(span === undefined ? {} : { span }),
      });
    }
  },
});
