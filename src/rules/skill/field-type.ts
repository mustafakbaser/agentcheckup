import { codePointLength } from '../../core/measure.js';
import { RULESET_VERSION } from '../../core/meta.js';
import type { Span } from '../../core/types.js';
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
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

const MAX_COMPATIBILITY = 500;
const MAX_LISTED_KEYS = 3;

const SPEC: Impact = { platform: 'claude-code', severity: 'warn', scope: 'distribution' };

interface Problem {
  readonly message: string;
  readonly impacts: readonly Impact[];
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
    const scalar = !Array.isArray(value);
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
  };
}

function compatibilityProblem(value: unknown): Problem | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') {
    return {
      message: `\`compatibility\` is ${describeType(value)}, not text. The skills-ref validator and the anthropics/skills packager reject it.`,
      impacts: [SPEC],
    };
  }
  const length = codePointLength(value.trim());
  if (length <= MAX_COMPATIBILITY) return undefined;
  return {
    message: `\`compatibility\` is ${formatInteger(length)} characters, over the ${MAX_COMPATIBILITY} that the Agent Skills specification and Claude Code allow, so the skills-ref validator and the anthropics/skills packager reject it.`,
    impacts: [SPEC],
  };
}

function allowedToolsProblem(value: unknown): Problem | undefined {
  if (value === null || typeof value === 'string') return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return {
      message:
        '`allowed-tools` is a YAML list. Claude Code accepts one, but the Agent Skills specification defines a space-separated string.',
      impacts: [SPEC],
    };
  }
  return {
    message: `\`allowed-tools\` is ${describeType(value)}, not a space-separated string of tool names.`,
    impacts: [SPEC],
  };
}

function licenseProblem(value: unknown): Problem | undefined {
  if (value === null || typeof value === 'string') return undefined;
  return {
    message: `\`license\` is ${describeType(value)}, not text. The Agent Skills specification expects a license name or the name of a bundled license file.`,
    impacts: [SPEC],
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
        });
      }
    }
  },
});
