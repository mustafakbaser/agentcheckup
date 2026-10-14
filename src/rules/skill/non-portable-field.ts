import { RULESET_VERSION } from '../../core/meta.js';
import type { PlatformId } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, joinNames, platformList, quote } from '../shared/format.js';
import {
  audience,
  type Impact,
  loadableSkills,
  placement,
  resolveImpacts,
  SKILL_PLATFORMS,
  SPEC_FIELDS,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

/**
 * Fields outside the Agent Skills spec that a platform documents, checked 2026-10-14:
 * Claude Code (code.claude.com/docs/en/skills), Cursor (cursor.com/docs/skills) and
 * GitHub Copilot in VS Code (code.visualstudio.com/docs/agent-customization/agent-skills).
 */
const EXTENSION_FIELDS: Readonly<Record<string, readonly PlatformId[]>> = {
  when_to_use: ['claude-code'],
  'argument-hint': ['claude-code', 'copilot'],
  arguments: ['claude-code'],
  'disable-model-invocation': ['claude-code', 'cursor', 'copilot'],
  'user-invocable': ['claude-code', 'copilot'],
  'disallowed-tools': ['claude-code'],
  model: ['claude-code'],
  effort: ['claude-code'],
  context: ['claude-code', 'copilot'],
  agent: ['claude-code'],
  background: ['claude-code'],
  hooks: ['claude-code'],
  paths: ['claude-code', 'cursor'],
  shell: ['claude-code'],
  icon: ['cursor'],
  color: ['cursor'],
  globs: ['cursor'],
};

const REJECTED = 'claude.ai upload, the Claude API and the skills-ref validator reject the skill';

const MAX_LISTED = 3;

/** One finding for all non-portable keys of a skill that is uploaded or installed on its own. */
function uploadMessage(keys: readonly string[]): string {
  const first = keys[0] ?? '';
  if (keys.length === 1) {
    const readers = Object.hasOwn(EXTENSION_FIELDS, first) ? EXTENSION_FIELDS[first] : undefined;
    return readers === undefined
      ? `${quote(first)} is not an Agent Skills field, so ${REJECTED}. Move it under \`metadata\`.`
      : `${quote(first)} is not an Agent Skills field: ${platformList(readers)} ${readers.length === 1 ? 'reads' : 'read'} it, but ${REJECTED}.`;
  }
  const listed = keys.slice(0, MAX_LISTED).map((key) => quote(key));
  const rest = keys.length - listed.length;
  const named =
    rest > 0 ? `${listed.join(', ')} and ${formatInteger(rest)} more` : joinNames(listed);
  const unknown = keys.some((key) => !Object.hasOwn(EXTENSION_FIELDS, key));
  return `${named} are not Agent Skills fields, so ${REJECTED}.${unknown ? ' Move your own keys under `metadata`.' : ''}`;
}

/**
 * The finding for one key of a skill in an agent's skills directory or a plugin, or undefined.
 * Only the agents that load the skill there count, and only where more than one agent loads it:
 * a field that some of them document and others do not makes them treat the skill differently.
 * Fields that none of them document, unknown ones included, are ignored alike and not reported.
 */
function agentFinding(
  key: string,
  reach: ReadonlySet<PlatformId>,
): { readonly message: string; readonly impacts: readonly Impact[] } | undefined {
  const readers = Object.hasOwn(EXTENSION_FIELDS, key) ? EXTENSION_FIELDS[key] : undefined;
  if (readers === undefined) return undefined;
  const here = SKILL_PLATFORMS.filter((platform) => reach.has(platform));
  if (here.length < 2) return undefined;
  const reading = here.filter((platform) => readers.includes(platform));
  const notReading = here.filter((platform) => !readers.includes(platform));
  // When no agent here documents the field, they all ignore it alike, as with an unknown field.
  if (reading.length === 0 || notReading.length === 0) return undefined;
  return {
    message: `${quote(key)} is a documented skill field in ${platformList(reading)} but not in ${platformList(notReading)}, so the agents that load this skill treat it differently.`,
    impacts: notReading.map((platform) => ({ platform, severity: 'warn' })),
  };
}

export const nonPortableFieldRule = defineRule({
  meta: {
    id: 'skill/non-portable-field',
    title: 'Skill frontmatter uses a field outside the Agent Skills specification',
    rationale: `The Agent Skills specification defines six frontmatter fields: \`name\`, \`description\`, \`license\`, \`compatibility\`, \`metadata\` and \`allowed-tools\`. Claude Code reads its own extensions, such as \`when_to_use\`, and ignores unknown fields, but claude.ai upload, the Claude API and the anthropics/skills packager fail with a hard error on any other field, and the skills-ref validator rejects it too. Cursor documents \`paths\`, \`disable-model-invocation\`, \`icon\`, \`color\` and \`globs\`, and GitHub Copilot in VS Code documents \`argument-hint\`, \`user-invocable\`, \`disable-model-invocation\` and \`context\`.

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
    ],
    since: RULESET_VERSION,
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

      if (distributable) {
        const resolved = resolveImpacts(context, artifact, [
          { platform: 'claude-code', severity: 'warn', scope: 'distribution' },
        ]);
        if (resolved === undefined) continue;
        const span = data.keySpan(keys[0] ?? '');
        context.report({
          artifact,
          message: uploadMessage(keys),
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
        });
        continue;
      }

      for (const key of keys) {
        const found = agentFinding(key, reach);
        if (found === undefined) continue;
        const resolved = resolveImpacts(context, artifact, found.impacts);
        if (resolved === undefined) continue;
        const span = data.keySpan(key);
        context.report({
          artifact,
          message: found.message,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
        });
      }
    }
  },
});
