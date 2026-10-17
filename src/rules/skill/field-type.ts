import { codePointLength } from '../../core/measure.js';
import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix, Span } from '../../core/types.js';
import { yamlReplaceValue } from '../../fix/index.js';
import { codexRejectsMetadata } from '../../platforms/codex-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import {
  describeType,
  formatInteger,
  joinClauses,
  joinNames,
  quote,
  sentence,
} from '../shared/format.js';
import {
  type Impact,
  isDistributable,
  loadableSkills,
  reached,
  resolveImpacts,
  validFrontmatter,
  type ValidFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';
import { editable, type FixOrGuidance, fixFields } from './fixes.js';

const MAX_COMPATIBILITY = 500;
const MAX_LISTED_KEYS = 3;

const SPEC: Impact = { platform: 'claude-code', severity: 'warn', scope: 'distribution' };

interface Problem {
  readonly message: string;
  readonly impacts: readonly Impact[];
  /** A manual step. */
  readonly guidance: string;
  /** `allowed-tools` is a list of strings, which the fix can join. */
  readonly list?: true;
}

const WHITESPACE = /\s/u;

/**
 * Writes an `allowed-tools` list as the space-separated string the specification defines
 * (`review`): only when every item is text without whitespace, which a space-separated string
 * can hold, and no comment sits among the items.
 */
function allowedToolsString(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  guidance: string,
): FixOrGuidance {
  const value = frontmatter.data.values['allowed-tools'];
  if (!editable(artifact) || !Array.isArray(value) || value.length === 0) return { guidance };
  const items: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string' || item === '' || WHITESPACE.test(item)) return { guidance };
    items.push(item);
  }
  const change = yamlReplaceValue(artifact, frontmatter, 'allowed-tools', items.join(' '));
  if (change === undefined) return { guidance };
  const fix: Fix = {
    id: 'skill/field-type#allowed-tools-string',
    class: 'review',
    title: `Write "allowed-tools" as a space-separated string in ${artifact.path}`,
    changes: [change],
  };
  return { fix, guidance };
}

const isMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function metadataProblem(
  value: unknown,
  codex: boolean,
  distributable: boolean,
): Problem | undefined {
  if (value === null) return undefined; // skill/yaml-portability reports empty values
  if (!isMap(value)) {
    const scalar = codexRejectsMetadata(value);
    const clauses = [
      // Codex deserializes `metadata` into a struct and fails on anything but a mapping.
      ...(scalar && codex ? ['Codex cannot read the frontmatter and skips the skill'] : []),
      ...(distributable
        ? ['the Agent Skills specification requires a map of string keys to string values']
        : []),
    ];
    if (clauses.length === 0) return undefined;
    return {
      message: `\`metadata\` is ${describeType(value)}, not a map. ${sentence(joinClauses(clauses))}`,
      impacts: [
        SPEC,
        ...(scalar && codex ? [{ platform: 'codex', severity: 'error' } as const] : []),
      ],
      guidance: 'write "metadata" as indented "key: value" lines with text values',
    };
  }
  const offending = Object.keys(value).filter((key) => {
    const entry = value[key];
    return entry !== null && typeof entry !== 'string';
  });
  if (offending.length === 0) return undefined;
  const listed = offending
    .slice(0, MAX_LISTED_KEYS)
    .map((key) => `${quote(key)} is ${describeType(value[key])}`);
  if (offending.length > MAX_LISTED_KEYS) {
    listed.push(`${formatInteger(offending.length - MAX_LISTED_KEYS)} more are not text`);
  }
  const nested = offending.some((key) => typeof value[key] === 'object');
  const advice = nested
    ? 'Store nested data as text, or keep it outside `metadata`.'
    : `Quote ${offending.length === 1 ? 'it' : 'them'}.`;
  return {
    message: `In \`metadata\`, ${joinNames(listed)}, but the Agent Skills specification allows only text values. ${advice}`,
    impacts: [SPEC],
    guidance: nested
      ? 'store each nested value in "metadata" as one line of text, or move it out of "metadata"'
      : 'put the values in "metadata" in double quotes',
  };
}

function compatibilityProblem(value: unknown): Problem | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') {
    return {
      message: `\`compatibility\` is ${describeType(value)}, not text. The skills-ref validator and the anthropics/skills packager reject it.`,
      impacts: [SPEC],
      guidance: 'write "compatibility" as one line of text, in double quotes',
    };
  }
  const length = codePointLength(value.trim());
  if (length <= MAX_COMPATIBILITY) return undefined;
  return {
    message: `\`compatibility\` is ${formatInteger(length)} characters, over the ${MAX_COMPATIBILITY} that the Agent Skills specification and Claude Code allow, so the skills-ref validator and the anthropics/skills packager reject it.`,
    impacts: [SPEC],
    guidance: `shorten "compatibility" to ${MAX_COMPATIBILITY} characters or fewer`,
  };
}

function allowedToolsProblem(value: unknown): Problem | undefined {
  if (value === null || typeof value === 'string') return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return {
      message:
        '`allowed-tools` is a YAML list. Claude Code accepts one, but the Agent Skills specification defines a space-separated string.',
      impacts: [SPEC],
      guidance:
        'write "allowed-tools" as one line of tool names separated by spaces, or keep the list if only Claude Code loads the skill',
      list: true,
    };
  }
  return {
    message: `\`allowed-tools\` is ${describeType(value)}, not a space-separated string of tool names.`,
    impacts: [SPEC],
    guidance: 'write "allowed-tools" as one line of tool names separated by spaces',
  };
}

function licenseProblem(value: unknown): Problem | undefined {
  if (value === null || typeof value === 'string') return undefined;
  return {
    message: `\`license\` is ${describeType(value)}, not text. The Agent Skills specification expects a license name or the name of a bundled license file.`,
    impacts: [SPEC],
    guidance: 'write "license" as text: a license name or the name of a bundled license file',
  };
}

export const fieldTypeRule = defineRule({
  meta: {
    id: 'skill/field-type',
    title: 'Skill frontmatter field has the wrong type or length',
    rationale: `The Agent Skills specification gives each optional field a type: \`metadata\` maps string keys to string values, \`compatibility\` is text of up to 500 characters, \`allowed-tools\` is a space-separated string, and \`license\` is text. Codex cannot read frontmatter whose \`metadata\` is text, a number or a boolean, and skips the skill. The skills-ref validator and the anthropics/skills packager reject a \`compatibility\` that is not text or is longer than 500 characters. Claude Code also accepts a YAML list for \`allowed-tools\`, but the specification defines a space-separated string.

Use the types from the specification, and quote values that YAML would read as numbers or booleans.`,
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex'],
    sources: [
      SOURCES.agentSkillsSpec,
      SOURCES.claudeSkills,
      SKILL_SOURCES.codexSkillParser,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.anthropicsSkillValidator,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Writes an `allowed-tools` list as a space-separated string when no tool rule contains a space. Other types are left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { data } = frontmatter;
      const distributable = isDistributable(context, artifact);
      const codex = reached(context, artifact, ['codex']).length > 0;
      const checks: [string, (value: unknown) => Problem | undefined][] = [
        ['metadata', (value) => metadataProblem(value, codex, distributable)],
        ['compatibility', compatibilityProblem],
        ['allowed-tools', allowedToolsProblem],
        ['license', licenseProblem],
      ];
      for (const [key, test] of checks) {
        if (!data.keys.includes(key)) continue;
        const problem = test(data.values[key]);
        if (problem === undefined) continue;
        const resolved = resolveImpacts(context, artifact, problem.impacts);
        if (resolved === undefined) continue;
        const span: Span | undefined = data.valueSpan(key) ?? data.keySpan(key);
        context.report({
          artifact,
          message: problem.message,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
          ...fixFields(
            problem.list === true
              ? allowedToolsString(artifact, frontmatter, problem.guidance)
              : { guidance: problem.guidance },
          ),
        });
      }
    }
  },
});
