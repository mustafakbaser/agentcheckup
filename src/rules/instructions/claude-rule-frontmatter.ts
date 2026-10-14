import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, RuleContext, Span } from '../../core/types.js';
import type { FrontmatterData } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote } from '../shared/format.js';
import { describeValue, issueDetail, yamlSyntaxError } from './yaml.js';

/** Scoping keys of other tools (Cursor `globs`, Copilot `applyTo`) that Claude Code ignores. */
const FOREIGN_SCOPING_KEYS: ReadonlySet<string> = new Set(['globs', 'applyTo']);

type Context = Pick<RuleContext<undefined>, 'report'>;

/**
 * Index of the first `[` that cannot start a bracket expression because no `]` follows it, or
 * -1. A `[` preceded by a backslash is escaped. Linear time.
 */
export function unclosedBracket(pattern: string): number {
  const lastClose = pattern.lastIndexOf(']');
  for (let i = lastClose + 1; i < pattern.length; i++) {
    if (pattern.charCodeAt(i) === 0x5b && pattern.charCodeAt(i - 1) !== 0x5c) return i;
  }
  return -1;
}

/** The span of `pattern` inside the `paths` value, or the whole value when it is not found. */
function patternSpan(artifact: Artifact, valueSpan: Span, pattern: string): Span {
  const source = artifact.decoded.text.slice(valueSpan.offset, valueSpan.offset + valueSpan.length);
  const index = source.indexOf(pattern);
  return index === -1 ? valueSpan : { offset: valueSpan.offset + index, length: pattern.length };
}

function checkPattern(context: Context, artifact: Artifact, span: Span, pattern: string): void {
  if (unclosedBracket(pattern) === -1) return;
  context.report({
    artifact,
    span: patternSpan(artifact, span, pattern),
    message: `Pattern ${quote(pattern)} has a "[" with no closing "]", so Claude Code treats it as invalid and it matches no files. Write "\\[" for a literal bracket.`,
  });
}

function checkPaths(context: Context, artifact: Artifact, data: FrontmatterData): void {
  const value = data.values['paths'];
  const span = data.valueSpan('paths') ?? data.keySpan('paths');
  if (span === undefined) return;
  // What Claude Code does with an empty or mistyped `paths` is not documented, so these are info.
  if (value === null) {
    context.report({
      artifact,
      span,
      severity: 'info',
      message:
        '"paths" has no value. List the glob patterns this rule applies to, or remove the field.',
    });
    return;
  }
  if (typeof value === 'string') {
    checkPattern(context, artifact, span, value);
    return;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const index = items.findIndex((item) => typeof item !== 'string');
    if (index !== -1) {
      context.report({
        artifact,
        span,
        severity: 'info',
        message: `Item ${formatInteger(index + 1)} of "paths" is ${describeValue(items[index])}, not a glob pattern. Write each pattern as a quoted string, such as "src/**/*.ts".`,
      });
      return;
    }
    for (const item of items) checkPattern(context, artifact, span, String(item));
    return;
  }
  context.report({
    artifact,
    span,
    severity: 'info',
    message: `"paths" is ${describeValue(value)}, but Claude Code reads it only as a glob pattern or a list of glob patterns.`,
  });
}

function checkKeys(context: Context, artifact: Artifact, data: FrontmatterData): void {
  const unknown = data.keys.filter((key) => key !== 'paths');
  if (unknown.length === 0) return;
  const hasPaths = data.keys.includes('paths');
  const scoping = hasPaths ? undefined : unknown.find((key) => FOREIGN_SCOPING_KEYS.has(key));
  if (scoping !== undefined) {
    context.report({
      artifact,
      span: data.keySpan(scoping) ?? { offset: 0, length: 3 },
      message: `Claude Code ignores ${quote(scoping)} in rule frontmatter, so this rule loads in every session instead of only for matching files. Rename the field to "paths".`,
    });
  }
  const ignored = unknown.filter((key) => key !== scoping);
  const first = ignored[0];
  if (first === undefined) return;
  context.report({
    artifact,
    severity: 'info',
    span: data.keySpan(first) ?? { offset: 0, length: 3 },
    message: `Claude Code ignores ${ignored
      .slice(0, 5)
      .map((key) => quote(key, 40))
      .join(
        ', ',
      )}${ignored.length > 5 ? ' and more' : ''} in rule frontmatter; it reads only "paths".`,
  });
}

export const claudeRuleFrontmatterRule = defineRule({
  meta: {
    id: 'instr/claude-rule-frontmatter',
    title: 'Claude Code rule frontmatter is invalid or ignored',
    rationale: [
      "Claude Code reads one field from the frontmatter of a `.claude/rules/` file: `paths`, a YAML list of glob patterns or a comma-separated string. A rule without `paths` loads in every session. If the YAML does not parse, Claude Code ignores the frontmatter and loads the rule in every session too. Other fields, including Cursor's `globs` and GitHub Copilot's `applyTo`, are ignored without an error.",
      "In a pattern, `[` starts a bracket expression. A pattern with a `[` and no closing `]` is invalid and matches no files; the rule's other patterns keep working. Invalid YAML in a rule that has no `paths` is reported as information, and so is a `paths` value that is empty or not a pattern or list of patterns, because the documentation does not say what Claude Code does with it.",
      'Rename `globs` or `applyTo` to `paths`, fix the YAML, and escape a literal bracket as `\\[`.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['claude-rule'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeMemory],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const frontmatter = context.frontmatter(artifact);
      if (frontmatter.kind === 'invalid') {
        const error = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
        if (error === undefined) continue;
        const block = artifact.decoded.text.slice(
          frontmatter.span.offset,
          frontmatter.span.offset + frontmatter.span.length,
        );
        const scoped = block.includes('paths');
        context.report({
          artifact,
          span: error.span,
          ...(scoped ? {} : { severity: 'info' as const }),
          message: `The frontmatter is not valid YAML (${issueDetail(error)}), so Claude Code ignores it and loads this rule in every session${scoped ? ' instead of only for the files in "paths"' : ''}.`,
        });
        continue;
      }
      if (frontmatter.kind !== 'valid') continue;
      const { data } = frontmatter;
      if (data.keys.includes('paths')) checkPaths(context, artifact, data);
      checkKeys(context, artifact, data);
    }
  },
});
