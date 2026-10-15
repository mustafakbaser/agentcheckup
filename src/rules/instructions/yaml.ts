import type { ParseIssue } from '../../parse/types.js';

export { yamlSyntaxError } from '../../platforms/yaml.js';
export type { SyntaxErrorOptions } from '../../platforms/yaml.js';

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
