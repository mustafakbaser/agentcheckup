/**
 * Markdown helpers shared by the Markdown formatters (scan report, baseline summary, context).
 * Untrusted text only ever reaches Markdown through {@link escaped}, which cuts it and runs
 * `forMarkdown`.
 */
import { formatInteger } from '../core/format.js';
import { ruleDocsUrl } from '../core/meta.js';
import { isSafeRuleId } from './feedback.js';
import { forMarkdown } from './sanitize.js';
import { truncate } from './text.js';

const UTF8 = new TextEncoder();

/**
 * Size of `text` in UTF-8 bytes, the unit of the Markdown budgets. GitHub limits a comment to
 * 65,536 characters, and the agentcheckup Action cuts one at 60,000 bytes; a character is at
 * least one byte, so a byte budget keeps both. CJK text is three bytes a character.
 */
export function utf8Length(text: string): number {
  return UTF8.encode(text).length;
}

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
 * Table rows up to `maxRows` and `maxBytes` of UTF-8 ({@link utf8Length}), whichever comes
 * first, plus how many were left out. Rows are only built while they fit, so a huge input costs
 * little.
 */
export function cappedRows<T>(
  items: readonly T[],
  render: (item: T) => string,
  maxRows: number,
  maxBytes: number,
): { readonly rows: string[]; readonly omitted: number } {
  const rows: string[] = [];
  let size = 0;
  for (const item of items.slice(0, Math.max(0, maxRows))) {
    const row = render(item);
    const bytes = utf8Length(row);
    if (size + bytes > maxBytes) break;
    rows.push(row);
    size += bytes + 1;
  }
  return { rows, omitted: items.length - rows.length };
}

/** `Showing 50 of 1,204 rows.` when rows were left out, else nothing. */
export function omittedNote(
  shown: number,
  total: number,
  noun: string,
  pluralForm = `${noun}s`,
): string[] {
  if (shown >= total) return [];
  return [`Showing ${shownOf(shown, total)} ${total === 1 ? noun : pluralForm}.`];
}

/** `50 of 1,204`: counts with thousands separators, as {@link formatInteger} writes them. */
export function shownOf(shown: number, total: number): string {
  return `${formatInteger(shown)} of ${formatInteger(total)}`;
}

/** Lines as separate paragraphs: a blank line between each, so Markdown keeps them apart. */
export function paragraphs(lines: readonly string[]): string[] {
  return lines.flatMap((line, index) => (index === 0 ? [line] : ['', line]));
}
