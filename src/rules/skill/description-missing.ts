import { editableFile } from '../../core/directive-fixes.js';
import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix, PlatformId } from '../../core/types.js';
import { yamlInsertKey, yamlSetScalar } from '../../fix/index.js';
import { clineSkillSkip } from '../../platforms/cline-skills.js';
import { descriptionState } from '../../platforms/codex-skills.js';
import { geminiSkipReasons } from '../../platforms/gemini-skills.js';
import { firstBodyLine } from '../../platforms/skills.js';
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
  cannotReadFrontmatter,
  type Impact,
  impactsOn,
  isDistributable,
  loadableSkills,
  OPENING_DELIMITER,
  reached,
  resolveImpacts,
  validFrontmatter,
  type ValidFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';
import {
  COPIED_NOTE,
  copiedDescription,
  editable,
  type FixOrGuidance,
  fixFields,
} from './fixes.js';

export { firstBodyLine } from '../../platforms/skills.js';

const WRITE_DESCRIPTION = 'add a "description" that says what the skill does and when to use it';
const WRITE_TEXT =
  'write "description" as one line of text that says what the skill does and when to use it';

/**
 * A fix that needs the user's words (`#type`): `fix -i` asks for the description, prefilled with
 * `initial`, and writes it double-quoted in place of the value or as a new key after `name`.
 * Undefined for a file `fix -i` cannot write an answer into: reached through a symlink, linked
 * from another path, or not decoded cleanly.
 */
function typeDescription(artifact: Artifact, initial: string | undefined): Fix | undefined {
  if (!editableFile(artifact)) return undefined;
  return {
    id: 'skill/description-missing#type',
    class: 'review',
    title: `Write "description" in ${artifact.path}`,
    changes: [],
    input: {
      field: 'skill-description',
      question: 'Write a description that says what the skill does and when to use it?',
      label: 'a description of what the skill does and when to use it',
      ...(initial === undefined ? {} : { initial }),
      target: { kind: 'frontmatter', path: artifact.path, key: 'description' },
    },
  };
}

/**
 * Copies the first line of the body into a missing or empty `description` (`review`): the text
 * Claude Code already uses when the key is omitted, for the author to reword. `fix -i` also
 * offers typing it ({@link typeDescription}), prefilled with that line. When no line can be
 * copied or the copy cannot be written in place, typing it is the fix. A manual step for a file
 * reached through a symlink, or one that cannot take typed words either.
 */
function copyDescription(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  state: 'missing' | 'empty',
): FixOrGuidance {
  const manual = { guidance: WRITE_DESCRIPTION };
  if (!editable(artifact)) return manual;
  const description = copiedDescription(artifact.decoded.text.slice(frontmatter.bodyOffset));
  const typed = (initial: string | undefined): FixOrGuidance => {
    const fix = typeDescription(artifact, initial);
    return fix === undefined ? manual : { fix, guidance: WRITE_DESCRIPTION };
  };
  if (description === undefined) return typed(undefined);
  const { data } = frontmatter;
  const change =
    state === 'empty'
      ? yamlSetScalar(artifact, frontmatter, 'description', description, { style: 'double' })
      : yamlInsertKey(artifact, frontmatter, 'description', description, {
          style: 'double',
          position: data.keys.includes('name') ? { after: 'name' } : 'last',
        });
  // An empty block scalar, for example: typing the description replaces the value whole.
  if (change === undefined) return typed(description);
  const alternative = typeDescription(artifact, description);
  const fix: Fix = {
    id: 'skill/description-missing#copy-body',
    class: 'review',
    title: `Set "description" to the first line of the body in ${artifact.path}`,
    changes: [change],
    notes: [COPIED_NOTE],
    ...(alternative === undefined ? {} : { alternatives: [alternative] }),
  };
  return { fix, guidance: WRITE_DESCRIPTION };
}

export const descriptionMissingRule = defineRule({
  meta: {
    id: 'skill/description-missing',
    title: 'Skill description is missing or empty',
    rationale: `Agents decide when to use a skill by matching the request against its \`description\`. Codex skips a skill whose description is missing or empty, and Gemini CLI skips one without the key. Codex also skips one whose \`description\` is a list or a mapping, and Cline one whose \`description\` is not text, even a number or a boolean. When the key is omitted, Claude Code uses the first non-empty line of the body instead, so a heading such as \`# Deploy\` becomes the text Claude matches requests against; its documentation does not cover an empty value. The Agent Skills specification, Cursor, GitHub Copilot and the Claude API require the field.

Add a \`description\` that says what the skill does and when to use it.`,
    category: 'loading',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'cline'],
    sources: [
      SKILL_SOURCES.codexSkillParser,
      SKILL_SOURCES.geminiSkillLoader,
      SOURCES.clineInstructionLoaderSource,
      SOURCES.claudeSkills,
      SOURCES.agentSkillsSpec,
      SOURCES.skillsRefValidator,
      SOURCES.cursorSkills,
      SKILL_SOURCES.copilotAddSkills,
      SOURCES.claudeApiSkills,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      input: 'some',
      summary:
        'Copies the first line of the body, which Claude Code uses when `description` is omitted, into `description` for you to reword. `agentcheckup fix -i` also offers typing the description instead; when no line can be copied, or the value is not text, typing it is the fix and needs your words.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { data } = frontmatter;
      const state = descriptionState(data);
      // Cline drops a skill whose `description` is set and is not text, numbers and booleans
      // included, unless it dropped the skill for an earlier reason.
      const cline =
        context.targets.has('cline') &&
        reached(context, artifact, ['cline']).length > 0 &&
        clineSkillSkip(artifact.decoded.text, frontmatter) === 'description-type';
      const present = data.keys.includes('description');
      const value = data.values['description'];
      if (state === 'text') {
        // A number or a boolean, which every other agent reads as text.
        if (!cline) continue;
        const only = resolveImpacts(context, artifact, [{ platform: 'cline', severity: 'error' }]);
        if (only === undefined) continue;
        const fix = typeDescription(artifact, undefined);
        context.report({
          artifact,
          message: `\`description\` is ${describeType(value)}, not text. ${sentence(cannotReadFrontmatter(['cline']))}`,
          severity: only.severity,
          platforms: only.platforms,
          span: data.keySpan('description') ?? OPENING_DELIMITER,
          ...fixFields(
            fix === undefined ? { guidance: WRITE_TEXT } : { fix, guidance: WRITE_TEXT },
          ),
        });
        continue;
      }

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
      let repair: FixOrGuidance;
      if (state === 'not-text') {
        const fix = typeDescription(artifact, undefined);
        repair = fix === undefined ? { guidance: WRITE_TEXT } : { fix, guidance: WRITE_TEXT };
        lead = `\`description\` is ${describeType(value)}, not text.`;
        const skipping: PlatformId[] = [
          ...(codex ? ['codex' as const] : []),
          ...(cline ? ['cline' as const] : []),
        ];
        if (skipping.length > 0) clauses.push(cannotReadFrontmatter(skipping));
        impacts.push(...impactsOn(skipping, 'error'));
        if (distributable) clauses.push('the skills-ref validator rejects it');
      } else if (state === 'missing') {
        lead = 'The frontmatter has no `description`.';
        repair = copyDescription(artifact, frontmatter, state);
        const geminiSkips = geminiSkipReasons(frontmatter, artifact.decoded).includes(
          'no-description',
        );
        const skipping = reached(context, artifact, geminiSkips ? ['codex', 'gemini'] : ['codex']);
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
        repair = copyDescription(artifact, frontmatter, state);
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
        ...fixFields(repair),
      });
    }
  },
});
