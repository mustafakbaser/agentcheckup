/**
 * Markdown helpers shared by the Markdown formatters (scan report, baseline summary, context).
 * Untrusted text only ever reaches Markdown through {@link escaped}, which cuts it and runs
 * `forMarkdown`.
 */
import { ruleDocsUrl } from '../core/meta.js';
import { isSafeRuleId } from './feedback.js';
import { forMarkdown } from './sanitize.js';
import { plural, truncate } from './text.js';

/** Untrusted text as inline Markdown: cut to `max` code points, then escaped. */
export function escaped(value: string, max: number): string {
  return forMarkdown(truncate(value, max));
}

/** `` `rule/id` `` for known-safe ids, otherwise escaped text. */
export function ruleCode(ruleId: string, max: number): string {
  return isSafeRuleId(ruleId) ? `\`${ruleId}\`` : escaped(ruleId, max);
}

/** A link to the rule's documentation for known-safe ids, otherwise escaped text. */
export function ruleLink(ruleId: string, max: number): string {
  return isSafeRuleId(ruleId) ? `[\`${ruleId}\`](${ruleDocsUrl(ruleId)})` : escaped(ruleId, max);
}

/**
 * Table rows up to `maxRows` and `maxCharacters`, whichever comes first, plus how many were
 * left out. Rows are only built while they fit, so a huge input costs little.
 */
export function cappedRows<T>(
  items: readonly T[],
  render: (item: T) => string,
  maxRows: number,
  maxCharacters: number,
): { readonly rows: string[]; readonly omitted: number } {
  const rows: string[] = [];
  let size = 0;
  for (const item of items.slice(0, Math.max(0, maxRows))) {
    const row = render(item);
    if (size + row.length > maxCharacters) break;
    rows.push(row);
    size += row.length + 1;
  }
  return { rows, omitted: items.length - rows.length };
}

/** `Showing 3 of 10 rows.` when rows were left out, else nothing. */
export function omittedNote(
  shown: number,
  total: number,
  noun: string,
  pluralForm?: string,
): string[] {
  if (shown >= total) return [];
  return [`Showing ${shown} of ${plural(total, noun, pluralForm)}.`];
}

/** Lines as separate paragraphs: a blank line between each, so Markdown keeps them apart. */
export function paragraphs(lines: readonly string[]): string[] {
  return lines.flatMap((line, index) => (index === 0 ? [line] : ['', line]));
}
