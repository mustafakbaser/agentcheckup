/**
 * How agents' lenient frontmatter readers treat YAML that a strict parser rejects. Shared by the
 * rules that report invalid frontmatter and the loaders that decide what such a file loads as.
 */
import type { ParseIssue } from '../parse/types.js';

/**
 * Parse issues that come from agentcheckup's own safety limits rather than from YAML syntax. An
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

/**
 * True when the block failed at one of agentcheckup's own safety limits: an agent's parser may
 * read it, and agentcheckup cannot tell what it declares.
 */
export function hitParserLimit(errors: readonly ParseIssue[]): boolean {
  const first = errors[0];
  return first !== undefined && PARSER_LIMIT_CODES.has(first.code);
}

/** The first issue that any YAML parser would reject, or undefined when there is none. */
export function yamlSyntaxError(
  errors: readonly ParseIssue[],
  options: SyntaxErrorOptions = {},
): ParseIssue | undefined {
  const first = errors[0];
  if (first === undefined || hitParserLimit(errors)) return undefined;
  if (
    options.tolerateCommonMistakes === true &&
    errors.some((error) => TOLERATED_CODES.has(error.code))
  ) {
    return undefined;
  }
  return first;
}
