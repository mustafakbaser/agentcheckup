/**
 * Which JSON parse failures an agent sees as broken files. Shared by json/invalid-syntax and the
 * load plans, so a plan skips a config file exactly when the rule reports it.
 */
import { JSON_ISSUE } from '../parse/json.js';
import type { ParseIssue } from '../parse/types.js';

/**
 * - `comment`, `trailing-comma`: not JSON; strict parsers reject the file.
 * - `limit`: a limit of agentcheckup's own parser, not a syntax error. Agents' `JSON.parse`
 *   accepts such files, so nothing can be said about their content.
 * - `other`: any other syntax error.
 */
export type JsonIssueKind = 'comment' | 'trailing-comma' | 'limit' | 'other';

/**
 * Limits of agentcheckup's own parser, not syntax errors: agents' `JSON.parse` accepts such files.
 * An unterminated comment (`unexpected-end-of-comment`) is a real error and stays `other`.
 */
const LIMIT_CODES: ReadonlySet<string> = new Set([
  JSON_ISSUE.tooLarge,
  JSON_ISSUE.tooDeep,
  'parse-failed',
]);

export function issueKind(issue: ParseIssue): JsonIssueKind {
  if (issue.code === JSON_ISSUE.comment) return 'comment';
  if (issue.code === JSON_ISSUE.trailingComma) return 'trailing-comma';
  if (LIMIT_CODES.has(issue.code)) return 'limit';
  return 'other';
}
