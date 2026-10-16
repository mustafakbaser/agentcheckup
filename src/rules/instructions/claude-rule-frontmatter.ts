import { RULESET_VERSION } from '../../core/meta.js';
import type {
  Artifact,
  FileChange,
  ReportDescriptor,
  RuleContext,
  Span,
} from '../../core/types.js';
import { quoteYaml, replaceSpan, safeCopiedText, yamlSetScalar } from '../../fix/edits.js';
import { hasLineBreak, lineStartBefore } from '../../fix/text.js';
import type { FrontmatterData, FrontmatterResult } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote } from '../shared/format.js';
import { byHand, editBlocker } from './fixes.js';
import { describeValue, issueDetail, yamlSyntaxError } from './yaml.js';

const RULE_ID = 'instr/claude-rule-frontmatter';

/** Scoping keys of other tools (Cursor `globs`, Copilot `applyTo`) that Claude Code ignores. */
const FOREIGN_SCOPING_KEYS: ReadonlySet<string> = new Set(['globs', 'applyTo']);

/** Longest glob pattern a fix rewrites, in code points. */
const MAX_PATTERN_LENGTH = 1000;

type Context = Pick<RuleContext<undefined>, 'report'>;
type Repair = Pick<ReportDescriptor, 'fix' | 'guidance'>;
type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;

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

/** `pattern` with a backslash before every `[` that {@link unclosedBracket} reports. */
export function escapeUnclosedBrackets(pattern: string): string {
  const lastClose = pattern.lastIndexOf(']');
  let out = pattern.slice(0, lastClose + 1);
  for (let i = lastClose + 1; i < pattern.length; i++) {
    if (pattern.charCodeAt(i) === 0x5b && pattern.charCodeAt(i - 1) !== 0x5c) out += '\\';
    out += pattern.charAt(i);
  }
  return out;
}

/**
 * The patterns of a comma-separated string, as Cursor's `globs` and Copilot's `applyTo` write
 * them: split at commas outside braces (`src/*.{ts,tsx}` is one pattern) and trimmed. Undefined
 * when the braces do not balance, a pattern is empty or too long, or a pattern holds control or
 * invisible characters.
 */
export function splitPatterns(value: string): string[] | undefined {
  const patterns: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x7b) depth++;
    else if (code === 0x7d && --depth < 0) return undefined;
    else if (i === value.length || (code === 0x2c && depth === 0)) {
      const pattern = value.slice(start, i).trim();
      if (safeCopiedText(pattern, MAX_PATTERN_LENGTH) !== pattern) return undefined;
      patterns.push(pattern);
      start = i + 1;
    }
  }
  return depth === 0 ? patterns : undefined;
}

/** A YAML list of `items`, written in the style of the `raw` list it replaces. */
function listText(
  artifact: Artifact,
  span: Span,
  raw: string,
  items: readonly string[],
): string | undefined {
  const quoted = items.map((item) => quoteYaml(item));
  if (raw.startsWith('[')) return `[${quoted.join(', ')}]`;
  if (!raw.startsWith('-')) return undefined;
  const { text } = artifact.decoded;
  const indent = text.slice(lineStartBefore(text, span.offset), span.offset);
  if (indent.trim() !== '') return undefined;
  return quoted.map((item) => `- ${item}`).join(`\n${indent}`);
}

/**
 * Escapes the unclosed `[` in the `paths` value. A string keeps its quote style through
 * yamlSetScalar; a list is written again, every item quoted where YAML needs it, unless it holds
 * a comment the rewrite would drop.
 */
function escapeFix(artifact: Artifact, frontmatter: ValidFrontmatter): Repair {
  const blocker = editBlocker(artifact);
  if (blocker !== undefined)
    return { guidance: byHand('write "\\[" for a literal bracket', blocker) };
  const { data } = frontmatter;
  const value = data.values['paths'];
  let change: FileChange | undefined;
  if (typeof value === 'string') {
    change = yamlSetScalar(artifact, frontmatter, 'paths', escapeUnclosedBrackets(value));
  } else if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const span = data.valueSpan('paths');
    const raw =
      span === undefined ? '' : artifact.decoded.text.slice(span.offset, span.offset + span.length);
    const strings = items.filter((item): item is string => typeof item === 'string');
    const list =
      span === undefined || raw.includes('#') || strings.length !== items.length
        ? undefined
        : listText(artifact, span, raw, strings.map(escapeUnclosedBrackets));
    if (span !== undefined && list !== undefined) change = replaceSpan(artifact, span, list);
  }
  if (change === undefined) return {};
  return {
    fix: {
      id: `${RULE_ID}#escape-bracket`,
      class: 'review',
      title: `Escape the unclosed "[" in the "paths" of ${artifact.path}`,
      changes: [change],
      notes: ['The pattern then matches a literal "[" in file names.'],
    },
  };
}

function checkPattern(
  context: Context,
  artifact: Artifact,
  span: Span,
  pattern: string,
  repair: () => Repair,
): void {
  if (unclosedBracket(pattern) === -1) return;
  context.report({
    artifact,
    span: patternSpan(artifact, span, pattern),
    message: `Pattern ${quote(pattern)} has a "[" with no closing "]", so Claude Code treats it as invalid and it matches no files. Write "\\[" for a literal bracket.`,
    ...repair(),
  });
}

/** The span of `pattern` inside the `paths` value, or the whole value when it is not found. */
function patternSpan(artifact: Artifact, valueSpan: Span, pattern: string): Span {
  const source = artifact.decoded.text.slice(valueSpan.offset, valueSpan.offset + valueSpan.length);
  const index = source.indexOf(pattern);
  return index === -1 ? valueSpan : { offset: valueSpan.offset + index, length: pattern.length };
}

function checkPaths(context: Context, artifact: Artifact, frontmatter: ValidFrontmatter): void {
  const { data } = frontmatter;
  const value = data.values['paths'];
  const span = data.valueSpan('paths') ?? data.keySpan('paths');
  if (span === undefined) return;
  // One fix escapes every unclosed bracket of the value, for each finding it has.
  let repair: Repair | undefined;
  const escape = (): Repair => (repair ??= escapeFix(artifact, frontmatter));
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
    checkPattern(context, artifact, span, value, escape);
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
    for (const item of items) checkPattern(context, artifact, span, String(item), escape);
    return;
  }
  context.report({
    artifact,
    span,
    severity: 'info',
    message: `"paths" is ${describeValue(value)}, but Claude Code reads it only as a glob pattern or a list of glob patterns.`,
    guidance: 'write "paths" as a list of glob patterns, such as - "src/**/*.ts"',
  });
}

/**
 * Renames Cursor's `globs` or Copilot's `applyTo` to `paths`. A comma-separated string becomes a
 * YAML list, as Claude Code's documentation writes `paths`; a list keeps its items.
 */
function renameFix(artifact: Artifact, data: FrontmatterData, key: string): Repair {
  const blocker = editBlocker(artifact);
  if (blocker !== undefined) return { guidance: byHand(`rename "${key}" to "paths"`, blocker) };
  const keySpan = data.keySpan(key);
  const value = data.values[key];
  if (keySpan === undefined) return {};
  const title = `Rename "${key}" to "paths" in ${artifact.path}`;
  const notes = [
    'Claude Code then loads this rule only when it works with files that match these patterns, instead of in every session.',
  ];
  const renameKey = (): Repair => ({
    fix: {
      id: `${RULE_ID}#paths`,
      class: 'review',
      title,
      changes: [replaceSpan(artifact, keySpan, 'paths')],
      notes,
    },
  });
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.length > 0 && items.every((item) => typeof item === 'string') ? renameKey() : {};
  }
  if (typeof value !== 'string') return {};
  const patterns = splitPatterns(value);
  if (patterns === undefined || patterns.length === 0) return {};
  if (patterns.length === 1) return renameKey();

  // `globs: a, b` becomes `paths:` and one `- "a"` line per pattern.
  const { text } = artifact.decoded;
  const valueSpan = data.valueSpan(key);
  if (valueSpan === undefined) return {};
  const keyEnd = keySpan.offset + keySpan.length;
  const between = text.slice(keyEnd, valueSpan.offset);
  const raw = text.slice(valueSpan.offset, valueSpan.offset + valueSpan.length);
  const indent = text.slice(lineStartBefore(text, keySpan.offset), keySpan.offset);
  if (
    between.trim() !== ':' ||
    hasLineBreak(between) ||
    hasLineBreak(raw) ||
    indent.trim() !== ''
  ) {
    return {};
  }
  const lines = patterns.map((pattern) => `\n${indent}  - ${quoteYaml(pattern)}`).join('');
  return {
    fix: {
      id: `${RULE_ID}#paths`,
      class: 'review',
      title: `${title} and list its ${formatInteger(patterns.length)} patterns`,
      changes: [
        replaceSpan(
          artifact,
          { offset: keySpan.offset, length: valueSpan.offset + valueSpan.length - keySpan.offset },
          `paths:${lines}`,
        ),
      ],
      notes,
    },
  };
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
      ...renameFix(artifact, data, scoping),
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
    id: RULE_ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Renames "globs" or "applyTo" to "paths", turning a comma-separated string into a list, and escapes an unclosed "[" as "\\[". Invalid YAML is left to you.',
    },
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
          guidance:
            'correct the YAML; write each glob pattern as a quoted string, such as "src/**/*.ts", because a pattern that starts with "*" or "{" is not plain YAML',
        });
        continue;
      }
      if (frontmatter.kind !== 'valid') continue;
      const { data } = frontmatter;
      if (data.keys.includes('paths')) checkPaths(context, artifact, frontmatter);
      checkKeys(context, artifact, data);
    }
  },
});
