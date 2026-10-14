import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, RuleContext } from '../../core/types.js';
import type { FrontmatterData } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { quote } from '../shared/format.js';
import { MAX_FINDINGS_PER_FILE } from '../instructions/helpers.js';
import { describeValue } from '../instructions/yaml.js';
import { SOURCES } from '../sources.js';

const KNOWN_FIELDS: ReadonlySet<string> = new Set(['description', 'globs', 'alwaysApply']);

/** Fields other tools use for the same purpose, and common misspellings. */
const SUGGESTIONS: Readonly<Record<string, string>> = {
  glob: 'globs',
  paths: 'globs',
  applyTo: 'globs',
  always_apply: 'alwaysApply',
  alwaysapply: 'alwaysApply',
  'always-apply': 'alwaysApply',
};

type Context = Pick<RuleContext<undefined>, 'report'>;

function checkFields(context: Context, artifact: Artifact, data: FrontmatterData): void {
  for (const key of data.keys
    .filter((name) => !KNOWN_FIELDS.has(name))
    .slice(0, MAX_FINDINGS_PER_FILE)) {
    const suggestion = Object.hasOwn(SUGGESTIONS, key) ? SUGGESTIONS[key] : undefined;
    // Extra metadata keys are harmless; a misspelled or foreign activation key changes when the
    // rule applies.
    context.report({
      artifact,
      span: data.keySpan(key) ?? { offset: 0, length: 3 },
      ...(suggestion === undefined ? { severity: 'info' as const } : {}),
      message:
        suggestion === undefined
          ? `Cursor ignores ${quote(key)}; rule frontmatter supports only "description", "globs" and "alwaysApply".`
          : `Cursor ignores ${quote(key)}, so it does not change when this rule applies. Use "${suggestion}" instead.`,
    });
  }

  const { values } = data;
  const alwaysApply = values['alwaysApply'];
  if (alwaysApply !== undefined && alwaysApply !== null && typeof alwaysApply !== 'boolean') {
    context.report({
      artifact,
      span: data.valueSpan('alwaysApply') ?? { offset: 0, length: 3 },
      message: `"alwaysApply" is ${describeValue(alwaysApply)}${typeof alwaysApply === 'string' ? ` (${quote(alwaysApply)})` : ''}, not the boolean true or false that Cursor expects.`,
    });
  }

  const description = values['description'];
  if (description !== undefined && description !== null && typeof description !== 'string') {
    context.report({
      artifact,
      span: data.valueSpan('description') ?? { offset: 0, length: 3 },
      message: `"description" is ${describeValue(description)}, not text.`,
    });
  }

  const globs = values['globs'];
  if (globs === undefined || globs === null || typeof globs === 'string') return;
  const span = data.valueSpan('globs') ?? { offset: 0, length: 3 };
  if (Array.isArray(globs) && globs.every((item) => typeof item === 'string')) {
    context.report({
      artifact,
      span,
      severity: 'info',
      message:
        '"globs" is a YAML list. Cursor documents "globs" only as one comma-separated string, such as "src/**/*.ts, test/**/*.ts".',
    });
    return;
  }
  context.report({
    artifact,
    span,
    message: `"globs" is ${describeValue(globs)}, not a comma-separated string of glob patterns.`,
  });
}

export const ruleFrontmatterRule = defineRule({
  meta: {
    id: 'cursor/rule-frontmatter',
    title: 'Cursor rule frontmatter field is unknown or has the wrong type',
    rationale: [
      'Three frontmatter fields configure a Cursor rule: `description` (text), `globs` (comma-separated glob patterns) and `alwaysApply` (`true` or `false`). Together they decide whether the rule is always included, attached to matching files, picked by the agent from its description, or included only when @-mentioned. A quoted `"true"` is not a boolean, and a field with another name does nothing. When that name is another tool\'s scoping field, such as `paths` or `applyTo`, the rule does not apply when you expect.',
      'A `globs` YAML list is not documented and other unknown fields are harmless, so both are information only. Unquoted globs such as `globs: *.ts` are not valid YAML, and how Cursor reads them is not documented, so agentcheck checks only frontmatter that parses as YAML.',
      'Rename the field to `description`, `globs` or `alwaysApply`, and write `alwaysApply: true` without quotes.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['cursor-rule'],
    platforms: ['cursor'],
    sources: [SOURCES.cursorRules],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      // Cursor accepts frontmatter that is not valid YAML: its own editor writes unquoted globs
      // such as `globs: *.ts, **/*.tsx`, which YAML reads as aliases. How it reads such blocks is
      // not documented, so only frontmatter that parses as YAML is checked.
      const frontmatter = context.frontmatter(artifact);
      if (frontmatter.kind === 'valid') checkFields(context, artifact, frontmatter.data);
    }
  },
});
