import { RULESET_VERSION } from '../../core/meta.js';
import { bomHidesFrontmatter } from '../../platforms/codex-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { joinClauses, platformsDo, sentence } from '../shared/format.js';
import {
  impactsOn,
  isDistributable,
  loadableSkills,
  OPENING_DELIMITER,
  reached,
  resolveImpacts,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

export const frontmatterBomRule = defineRule({
  meta: {
    id: 'skill/frontmatter-bom',
    title: 'Skill file starts with a byte order mark',
    rationale: `A UTF-8 byte order mark (U+FEFF) is invisible in most editors, but it is the first character of the file. Codex decodes SKILL.md without removing it and compares the trimmed first line with \`---\`; Rust's \`trim()\` keeps U+FEFF, so Codex finds no frontmatter and skips the skill. Gemini CLI matches \`^---\` against the raw text and skips the skill too. The skills-ref validator and the anthropics/skills packager require the file to start with \`---\` and reject it.

Save SKILL.md as UTF-8 without a byte order mark.`,
    category: 'loading',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex', 'gemini'],
    sources: [
      SKILL_SOURCES.codexReadFileText,
      SKILL_SOURCES.codexSkillParser,
      SKILL_SOURCES.unicodeWhiteSpace,
      SKILL_SOURCES.geminiSkillLoader,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.anthropicsSkillValidator,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const { decoded } = artifact;
      if (!decoded.hasBom || decoded.encoding !== 'utf-8') continue;
      // Only a delimited block is lost to the mark; without one, skill/frontmatter-missing reports.
      if (!bomHidesFrontmatter(decoded, context.frontmatter(artifact))) continue;
      const skipping = reached(context, artifact, ['codex', 'gemini']);
      const resolved = resolveImpacts(context, artifact, [
        ...impactsOn(skipping, 'error'),
        { platform: 'claude-code', severity: 'warn', scope: 'distribution' },
      ]);
      if (resolved === undefined) continue;
      const clauses = [
        platformsDo(
          skipping,
          [
            'does not recognize the frontmatter and skips',
            'do not recognize the frontmatter and skip',
          ],
          'the skill',
        ),
        isDistributable(context, artifact)
          ? 'the skills-ref validator and the anthropics/skills packager reject it'
          : undefined,
      ].filter((clause) => clause !== undefined);
      context.report({
        artifact,
        message: `SKILL.md starts with an invisible UTF-8 byte order mark (U+FEFF) before \`---\`. ${sentence(joinClauses(clauses))}`,
        severity: resolved.severity,
        platforms: resolved.platforms,
        span: OPENING_DELIMITER,
      });
    }
  },
});
