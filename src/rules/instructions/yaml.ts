import type { ParseIssue } from '../../parse/types.js';

/**
 * Parse issues that come from agentcheck's own safety limits rather than from YAML syntax. An
 * agent's parser may accept such a block, so rules must not claim the agent rejects it.
 */
const PARSER_LIMIT_CODES: ReadonlySet<string> = new Set([
  'too-large',
  'excessive-aliases',
  'too-deep',
  'parse-failed',
]);

/**
 * Mistakes that strict YAML rejects but agents' frontmatter readers are known or likely to accept:
 * an unquoted `: ` inside a value (`description: Use when: deploying`), which Claude Code is
 * reported to load and Codex repairs, and unquoted values that start with `*` (`globs: *.ts`),
 * which Cursor's own editor writes and YAML reads as aliases.
 */
const TOLERATED_CODES: ReadonlySet<string> = new Set([
  'block-as-implicit-key',
  'multiline-implicit-key',
  'unresolved-alias',
  'unexpected-token',
]);

export interface SyntaxErrorOptions {
  /** Return nothing when any issue is a mistake that lenient frontmatter readers accept. */
  readonly tolerateCommonMistakes?: boolean;
}

/** The first issue that any YAML parser would reject, or undefined when there is none. */
export function yamlSyntaxError(
  errors: readonly ParseIssue[],
  options: SyntaxErrorOptions = {},
): ParseIssue | undefined {
  const first = errors[0];
  if (first === undefined || PARSER_LIMIT_CODES.has(first.code)) return undefined;
  if (
    options.tolerateCommonMistakes === true &&
    errors.some((error) => TOLERATED_CODES.has(error.code))
  ) {
    return undefined;
  }
  return first;
}

/** Describes a YAML value's type for messages: `a number`, `a list`, ... */
export function describeValue(value: unknown): string {
  if (value === null) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  return 'a mapping';
}

/** The issue message without a trailing period, for embedding in a sentence. */
export function issueDetail(issue: ParseIssue): string {
  const message = issue.message.trim();
  return message.endsWith('.') ? message.slice(0, -1) : message;
}
