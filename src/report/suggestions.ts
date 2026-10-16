/**
 * Pull request review comments with suggested changes for safe fixes, for the GitHub Action
 * (docs/research fix design, section 5; docs/adr/0008-write-fixes-to-the-scanned-repository.md).
 * Pure: the Action fetches the pull request's diff and posts the comments.
 *
 * A fix becomes a suggestion only when all of these hold:
 * - it is planned and `safe`;
 * - it is one edit in one file (one `edit` change with one text edit);
 * - it is not a credential fix (mcp/literal-secret, or a fix with a rotation warning), and no
 *   line it touches or writes holds a credential the detector recognizes;
 * - every line it changes lies inside one diff hunk of the pull request, so GitHub can anchor the
 *   comment;
 * - the replacement lines contain no control, bidirectional, tag or other invisible character
 *   (anything the output sanitizers would escape), no CR, and change the line count only by
 *   whole lines.
 *
 * Two suggestions on overlapping lines of one file would conflict once one is committed, so only
 * the first in plan order is kept. At most {@link MAX_SUGGESTIONS} comments are returned.
 *
 * The body starts with {@link SUGGESTION_MARKER}, so the Action can find and dismiss comments of
 * earlier runs. Everything outside the fence goes through `forMarkdown`; the fence is longer than
 * the longest run of backticks in the suggested lines, so no line can close it.
 */
import { ruleDocsUrl } from '../core/meta.js';
import type { TextEdit } from '../core/types.js';
import type { PlannedFix } from '../fix/index.js';
import { findSecret } from '../rules/mcp/secrets.js';
import { isSecretFix } from './fix-diff.js';
import { forMarkdown, forTerminal } from './sanitize.js';
import { truncate } from './text.js';

/** First line of every suggestion comment. Matches nothing a user would write by accident. */
export const SUGGESTION_MARKER = '<!-- agentcheckup:suggestion -->';

/** Comments returned per call: a review with more is noise. */
export const MAX_SUGGESTIONS = 50;

/** A 1-based, inclusive range of lines of the pull request's head version (`RIGHT` side). */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface SuggestionInput {
  /** The planned fixes, in plan order (`FixPlan.fixes`). */
  readonly fixes: readonly PlannedFix[];
  /**
   * Decoded text (byte order mark removed) of the files the fixes edit, as scanned: the pull
   * request's head. Keyed by the paths the fixes use.
   */
  readonly texts: ReadonlyMap<string, string>;
  /** The pull request's diff hunks per path, as line ranges of the head version. */
  readonly hunks: ReadonlyMap<string, readonly LineRange[]>;
}

/**
 * A review comment as GitHub's "create a review" API takes it (`comments[]`): a single line, or
 * `start_line` through `line`, on the head side of the diff.
 */
export interface ReviewComment {
  readonly path: string;
  readonly body: string;
  readonly side: 'RIGHT';
  readonly line: number;
  readonly start_line?: number;
  readonly start_side?: 'RIGHT';
}

/** True for a comment body this module wrote. */
export function isSuggestionComment(body: string): boolean {
  return body.startsWith(SUGGESTION_MARKER);
}

/** Rule ids safe to put into a URL: `<family>/<kebab-name>`. */
const SAFE_RULE_ID = /^[a-z][a-z0-9]*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface Replacement {
  /** First and last replaced line, 1-based. */
  readonly start: number;
  readonly end: number;
  /** The replaced lines as they are, joined with LF, without the final line ending. */
  readonly original: string;
  /** The suggested lines; empty to delete the replaced lines. */
  readonly lines: readonly string[];
}

function countLineBreaks(text: string, from: number, to: number): number {
  let breaks = 0;
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) {
    breaks++;
  }
  return breaks;
}

/**
 * The whole lines an edit touches and what they become. Undefined when the change cannot be
 * written as whole lines of the head version: an insertion after the last line break, a change
 * that joins a line with the next, or one that adds or removes the final line break.
 */
function replacement(text: string, edit: TextEdit): Replacement | undefined {
  const end = edit.offset + edit.length;
  if (!Number.isInteger(edit.offset) || !Number.isInteger(edit.length)) return undefined;
  if (edit.offset < 0 || edit.length < 0 || end > text.length) return undefined;
  const regionStart = edit.offset === 0 ? 0 : text.lastIndexOf('\n', edit.offset - 1) + 1;
  if (regionStart === text.length) return undefined;
  const last = edit.length > 0 ? end - 1 : edit.offset;
  const lineBreak = text.indexOf('\n', last);
  const regionEnd = lineBreak === -1 ? text.length : lineBreak + 1;
  const original = text.slice(regionStart, regionEnd);
  const replaced = `${text.slice(regionStart, edit.offset)}${edit.text}${text.slice(end, regionEnd)}`;
  const terminated = original.endsWith('\n');

  let body: string;
  if (terminated) {
    if (replaced !== '' && !replaced.endsWith('\n')) return undefined;
    body = replaced.slice(0, -1);
  } else {
    if (replaced === '' || replaced.endsWith('\n')) return undefined;
    body = replaced;
  }
  const kept = terminated ? original.slice(0, -1) : original;
  if (replaced === original) return undefined;

  const start = countLineBreaks(text, 0, regionStart) + 1;
  return {
    start,
    end: start + countLineBreaks(kept, 0, kept.length),
    original: kept,
    lines: replaced === '' ? [] : body.split('\n'),
  };
}

/** A line any output sanitizer leaves alone: no control, bidi, tag or invisible character, no CR. */
function isPlainLine(line: string): boolean {
  return forTerminal(line) === line;
}

function insideOneHunk(
  ranges: readonly LineRange[] | undefined,
  start: number,
  end: number,
): boolean {
  return (ranges ?? []).some(
    (range) =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 1 &&
      range.start <= start &&
      end <= range.end,
  );
}

function longestBacktickRun(lines: readonly string[]): number {
  let longest = 0;
  for (const line of lines) {
    let run = 0;
    for (const char of line) {
      run = char === '`' ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  return longest;
}

/** A code fence that none of `lines` can close: longer than any backtick run in them. */
export function fenceFor(lines: readonly string[]): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(lines) + 1));
}

/** Titles and notes are cut after this many code points. */
const MAX_TEXT_LENGTH = 500;

/** Untrusted text as literal, single-line Markdown. */
function text(value: string): string {
  return forMarkdown(truncate(value, MAX_TEXT_LENGTH));
}

function ruleLabel(ruleId: string): string {
  const text = forMarkdown(ruleId);
  return SAFE_RULE_ID.test(ruleId) ? `[${text}](${ruleDocsUrl(ruleId)})` : text;
}

function commentBody(planned: PlannedFix, lines: readonly string[]): string {
  const fence = fenceFor(lines);
  const notes = (planned.fix.notes ?? []).map((note) => `Note: ${text(note)}`);
  return [
    SUGGESTION_MARKER,
    `**agentcheckup** safe fix for ${ruleLabel(planned.ruleId)}: ${text(planned.fix.title)}`,
    ...notes,
    '',
    `${fence}suggestion`,
    ...lines,
    fence,
    '',
  ].join('\n');
}

interface Candidate {
  readonly path: string;
  readonly replacement: Replacement;
  readonly planned: PlannedFix;
}

function candidate(planned: PlannedFix, input: SuggestionInput): Candidate | undefined {
  if (planned.status !== 'planned' || planned.fix.class !== 'safe' || isSecretFix(planned)) {
    return undefined;
  }
  const [change, ...moreChanges] = planned.fix.changes;
  if (change?.kind !== 'edit' || moreChanges.length > 0) return undefined;
  const [edit, ...moreEdits] = change.edits;
  if (edit === undefined || moreEdits.length > 0) return undefined;
  const text = input.texts.get(change.path);
  if (text === undefined) return undefined;
  const found = replacement(text, edit);
  if (found === undefined) return undefined;
  if (!insideOneHunk(input.hunks.get(change.path), found.start, found.end)) return undefined;
  if (!found.lines.every(isPlainLine)) return undefined;
  if (
    findSecret(found.original) !== undefined ||
    found.lines.some((line) => findSecret(line) !== undefined)
  ) {
    return undefined;
  }
  return { path: change.path, replacement: found, planned };
}

/**
 * Review comments with a `suggestion` block for each fix that qualifies (see the module
 * comment), in plan order.
 */
export function suggestionComments(input: SuggestionInput): ReviewComment[] {
  const comments: ReviewComment[] = [];
  const taken = new Map<string, { start: number; end: number }[]>();
  for (const planned of input.fixes) {
    if (comments.length === MAX_SUGGESTIONS) break;
    const found = candidate(planned, input);
    if (found === undefined) continue;
    const { start, end, lines } = found.replacement;
    const ranges = taken.get(found.path) ?? [];
    if (ranges.some((range) => range.start <= end && start <= range.end)) continue;
    taken.set(found.path, [...ranges, { start, end }]);
    const body = commentBody(found.planned, lines);
    comments.push(
      start === end
        ? { path: found.path, body, side: 'RIGHT', line: end }
        : {
            path: found.path,
            body,
            side: 'RIGHT',
            line: end,
            start_line: start,
            start_side: 'RIGHT',
          },
    );
  }
  return comments;
}
