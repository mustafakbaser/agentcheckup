import { RULESET_VERSION } from '../../core/meta.js';
import { positionAt } from '../../core/text.js';
import type { Artifact, FileChange, Fix, PlatformId } from '../../core/types.js';
import { yamlMoveUnderMapping, yamlRemoveKey } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, joinNames, platformList, quote } from '../shared/format.js';
import { fieldEffect } from './field-effects.js';
import { editable } from './fixes.js';
import {
  audience,
  type Impact,
  loadableSkills,
  placement,
  resolveImpacts,
  SKILL_PLATFORMS,
  SPEC_FIELDS,
  validFrontmatter,
  type ValidFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

const RULE_ID = 'skill/non-portable-field';

const REJECTED = 'claude.ai upload, the Claude API and the skills-ref validator reject the skill';

const MAX_LISTED = 3;

/** `"a"`, `"a" and "b"`, or `"a", "b", "c" and 2 more`. */
function namedKeys(keys: readonly string[]): string {
  const listed = keys.slice(0, MAX_LISTED).map((key) => quote(key));
  const rest = keys.length - listed.length;
  return rest > 0 ? `${listed.join(', ')} and ${formatInteger(rest)} more` : joinNames(listed);
}

/** What the non-portable keys of a skill uploaded or installed on its own break, without advice. */
function uploadProblem(keys: readonly string[]): string {
  const first = keys[0] ?? '';
  if (keys.length === 1) {
    const readers = fieldEffect(first)?.readers;
    return readers === undefined
      ? `${quote(first)} is not an Agent Skills field, so ${REJECTED}.`
      : `${quote(first)} is not an Agent Skills field: ${platformList(readers)} ${readers.length === 1 ? 'reads' : 'read'} it, but ${REJECTED}.`;
  }
  return `${namedKeys(keys)} are not Agent Skills fields, so ${REJECTED}.`;
}

/** One finding for all non-portable keys of a skill that is uploaded or installed on its own. */
function uploadMessage(keys: readonly string[]): string {
  const problem = uploadProblem(keys);
  if (keys.every((key) => fieldEffect(key) !== undefined)) return problem;
  return keys.length === 1
    ? `${problem} Move it under \`metadata\`.`
    : `${problem} Move your own keys under \`metadata\`.`;
}

interface AgentFinding {
  readonly message: string;
  /** The message without its consequence, for the question of `#keep`. */
  readonly problem: string;
  readonly impacts: readonly Impact[];
}

/**
 * The finding for one key of a skill in an agent's skills directory or a plugin, or undefined.
 * Only the agents that load the skill there count, and only where more than one agent loads it:
 * a field that some of them document and others do not makes them treat the skill differently.
 * Fields that none of them document, unknown ones included, are ignored alike and not reported.
 */
function agentFinding(key: string, reach: ReadonlySet<PlatformId>): AgentFinding | undefined {
  const readers = fieldEffect(key)?.readers;
  if (readers === undefined) return undefined;
  const here = SKILL_PLATFORMS.filter((platform) => reach.has(platform));
  if (here.length < 2) return undefined;
  const reading = here.filter((platform) => readers.includes(platform));
  const notReading = here.filter((platform) => !readers.includes(platform));
  // When no agent here documents the field, they all ignore it alike, as with an unknown field.
  if (reading.length === 0 || notReading.length === 0) return undefined;
  const problem = `${quote(key)} is a documented skill field in ${platformList(reading)} but not in ${platformList(notReading)}`;
  return {
    message: `${problem}, so the agents that load this skill treat it differently.`,
    problem: `${problem}.`,
    impacts: notReading.map((platform) => ({ platform, severity: 'warn' })),
  };
}

// ---------------------------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------------------------

/**
 * `#keep` (input): asks why the fields stay and writes the answer as an
 * `agentcheckup-disable-next-line` comment before `line`, the line of the finding. Notes say why
 * a field whose removal widens what the model may do has no `#remove`.
 */
function keepFix(
  artifact: Artifact,
  line: number,
  keys: readonly string[],
  problem: string,
  alternatives: readonly Fix[] = [],
): Fix {
  const named = namedKeys(keys);
  const notes = keys.flatMap((key) => {
    const effect = fieldEffect(key);
    return effect === undefined || effect.removable
      ? []
      : [`${effect.withoutIt} So agentcheckup does not offer to remove it.`];
  });
  return {
    id: `${RULE_ID}#keep`,
    class: 'review',
    title: `Keep ${named} in ${artifact.path} and record why`,
    changes: [],
    input: {
      field: 'suppression-reason',
      question: `${problem} Keep ${keys.length === 1 ? 'it' : 'them'} and record why?`,
      label: `a reason to keep ${named}`,
      target: { kind: 'directive', path: artifact.path, line, ruleId: RULE_ID },
    },
    ...(notes.length === 0 ? {} : { notes }),
    ...(alternatives.length === 0 ? {} : { alternatives }),
  };
}

const METADATA_NOTE =
  'No agent reads unknown top-level keys, but your own tooling might: have it read them under "metadata".';
const TEXT_NOTE =
  'Each moved value is written as quoted text, and a list as its items joined with ", ".';

/**
 * `#metadata` (review): moves `keys`, none of which an agent documents, under `metadata` as
 * double-quoted text. Undefined when the builder refuses: a value that is not a scalar or a list
 * of scalars without commas, a comment on the moved lines, an anchor, alias or tag, a `metadata`
 * that is not a block mapping, or a key it already has.
 */
function metadataFix(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  keys: readonly string[],
): Fix | undefined {
  const change = yamlMoveUnderMapping(artifact, frontmatter, keys, 'metadata');
  if (change === undefined) return undefined;
  const { values } = frontmatter.data;
  const converted = keys.some((key) => typeof values[key] !== 'string');
  return {
    id: `${RULE_ID}#metadata`,
    class: 'review',
    title: `Move ${namedKeys(keys)} under "metadata" in ${artifact.path}`,
    changes: [change],
    notes: converted ? [METADATA_NOTE, TEXT_NOTE] : [METADATA_NOTE],
  };
}

/**
 * `#remove` (review, offered only as an alternative of `#keep`): removes `keys`, every one a
 * documented field whose removal does not widen what the model may do, each with a note on what
 * the agents do without it. Undefined when one of them is not such a field or the builder
 * refuses to remove it.
 */
function removeFix(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  keys: readonly string[],
): Fix | undefined {
  const notes: string[] = [];
  for (const key of keys) {
    const effect = fieldEffect(key);
    if (effect?.removable !== true) return undefined;
    notes.push(effect.withoutIt);
  }
  const { data } = frontmatter;
  // The last entry first: removing an entry leaves the text before it as it was, so each change,
  // built on the scanned text, still fits after the ones before it in the fix.
  const lastFirst = [...keys].sort(
    (a, b) => (data.keySpan(b)?.offset ?? 0) - (data.keySpan(a)?.offset ?? 0),
  );
  const changes: FileChange[] = [];
  for (const key of lastFirst) {
    const change = yamlRemoveKey(artifact, frontmatter, key);
    if (change === undefined) return undefined;
    changes.push(change);
  }
  return {
    id: `${RULE_ID}#remove`,
    class: 'review',
    title: `Remove ${namedKeys(keys)} from ${artifact.path}`,
    changes,
    notes,
  };
}

/**
 * The fix for a skill uploaded or installed on its own: `#metadata` when no agent documents its
 * keys, with `#keep` as the alternative; otherwise `#keep`, with `#remove` as the alternative
 * when every key is a documented field it may remove.
 */
function uploadFix(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  keys: readonly string[],
  line: number,
): Fix {
  const problem = uploadProblem(keys);
  const documented = keys.filter((key) => fieldEffect(key) !== undefined);
  if (documented.length === 0) {
    const moved = metadataFix(artifact, frontmatter, keys);
    const keep = keepFix(artifact, line, keys, problem);
    return moved === undefined ? keep : { ...moved, alternatives: [keep] };
  }
  const removed =
    documented.length === keys.length ? removeFix(artifact, frontmatter, keys) : undefined;
  return keepFix(artifact, line, keys, problem, removed === undefined ? [] : [removed]);
}

export const nonPortableFieldRule = defineRule({
  meta: {
    id: RULE_ID,
    title: 'Skill frontmatter uses a field outside the Agent Skills specification',
    rationale: `The Agent Skills specification defines six frontmatter fields: \`name\`, \`description\`, \`license\`, \`compatibility\`, \`metadata\` and \`allowed-tools\`. Claude Code reads its own extensions, such as \`when_to_use\`, and ignores unknown fields, but claude.ai upload, the Claude API and the anthropics/skills packager fail with a hard error on any other field, and the skills-ref validator rejects it too. Cursor documents \`paths\`, \`disable-model-invocation\`, \`icon\`, \`color\` and \`globs\`, GitHub Copilot in VS Code documents \`argument-hint\`, \`user-invocable\`, \`disable-model-invocation\` and \`context\`, Devin Local documents \`argument-hint\`, \`model\` and \`agent\` among others, and Cline documents none.

For a skill that is installed or uploaded on its own, all such fields are reported together. For a skill in an agent's skills directory or a plugin, a documented extension field is reported only when some of the agents that load the skill there document it and others do not. Fields that none of them document, including unknown fields, are ignored by all of them alike and are not reported there.

Keep extension fields in skills that only their agents load, and move your own data under \`metadata\`.`,
    category: 'portability',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SOURCES.claudeSkills,
      SOURCES.agentSkillsSpec,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.anthropicsSkillValidator,
      SOURCES.cursorSkills,
      SKILL_SOURCES.vscodeSkills,
      SOURCES.devinCliSkillsCreate,
      SOURCES.clineSkills,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      input: 'some',
      summary:
        'Moves keys that no agent documents under `metadata`, as quoted text, in a skill uploaded or installed on its own. `fix -i` can instead record why the fields stay, as a suppression with your reason, or remove agent-specific fields that do not restrict the model.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { distributable } = placement(context, artifact);
      const reach = audience(context, artifact);
      const { data } = frontmatter;
      const keys = data.keys.filter((key) => !SPEC_FIELDS.has(key));
      if (keys.length === 0) continue;
      const fixable = editable(artifact);

      if (distributable) {
        const resolved = resolveImpacts(context, artifact, [
          { platform: 'claude-code', severity: 'warn', scope: 'distribution' },
        ]);
        if (resolved === undefined) continue;
        const span = data.keySpan(keys[0] ?? '');
        const fix =
          span === undefined || !fixable
            ? undefined
            : uploadFix(
                artifact,
                frontmatter,
                keys,
                positionAt(artifact.decoded, span.offset).line,
              );
        context.report({
          artifact,
          message: uploadMessage(keys),
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
          ...(fix === undefined ? {} : { fix }),
          guidance:
            'move your own keys under "metadata", and remove agent-specific fields from the copy you upload or publish',
        });
        continue;
      }

      for (const key of keys) {
        const found = agentFinding(key, reach);
        if (found === undefined) continue;
        const resolved = resolveImpacts(context, artifact, found.impacts);
        if (resolved === undefined) continue;
        const span = data.keySpan(key);
        // Some agents that load the skill here read the field and others ignore it. Only the
        // author knows which behavior is meant, so the fix only records why the field stays.
        const fix =
          span === undefined || !fixable
            ? undefined
            : keepFix(
                artifact,
                positionAt(artifact.decoded, span.offset).line,
                [key],
                found.problem,
              );
        context.report({
          artifact,
          message: found.message,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
          ...(fix === undefined ? {} : { fix }),
          guidance: `remove ${quote(key)} if the agents that ignore it should behave the same, or keep it and accept the difference`,
        });
      }
    }
  },
});
