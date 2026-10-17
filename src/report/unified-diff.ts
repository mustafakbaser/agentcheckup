/**
 * The unified diff of a pull request (`git diff`, or GitHub's `application/vnd.github.diff`),
 * reduced to what review comments need: for each file of the head version, the ranges of lines
 * the diff shows on its `RIGHT` side. GitHub accepts a review comment only on those lines, and a
 * comment on several lines only within one hunk. Pure.
 *
 * The diff is untrusted input: the author of a pull request controls file names and every
 * content line.
 * - One pass over the text. Lines are found with `indexOf` and only header lines are copied, cut
 *   to a bounded length. The one regular expression is anchored and bounded.
 * - Content lines are counted, never read as headers: a hunk ends when the old and new line
 *   counts of its `@@ -a,b +c,d @@` header are used up, so a content line such as `+++ b/x` or
 *   `@@ -1 +1 @@` cannot start a file or a hunk. A hunk whose lines do not add up to its header
 *   is dropped.
 * - A file is named only by `+++ b/<path>`. A quoted path (git quotes names with unusual
 *   characters), `+++ /dev/null` (a deleted file), any other prefix, and a path that is longer
 *   than {@link MAX_DIFF_PATH_LENGTH} or not a plain relative path leave the file out. Binary
 *   files and renames without content changes have no hunks.
 * - At most {@link MAX_DIFF_HUNKS} hunks are kept; `truncated` says that more were ignored.
 * - CRLF line endings are accepted, and `\ No newline at end of file` counts as no line.
 *
 * Never throws.
 */

/** Largest diff the CLI reads, in bytes. */
export const MAX_DIFF_BYTES = 16 * 1024 * 1024;

/** Most hunks kept from one diff. */
export const MAX_DIFF_HUNKS = 100_000;

/** Longest path kept, in UTF-16 code units. A fix never writes a longer one. */
export const MAX_DIFF_PATH_LENGTH = 1024;

/** A 1-based, inclusive range of lines of the head version (the `RIGHT` side). */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface DiffRanges {
  /** The ranges of each file, by its path in the head version, in diff order. */
  readonly files: ReadonlyMap<string, readonly LineRange[]>;
  /** More than {@link MAX_DIFF_HUNKS} hunks: the rest were ignored. */
  readonly truncated: boolean;
}

/**
 * `@@ -a[,b] +c[,d] @@`. Matched against at most {@link HEADER_PREFIX} characters of the line;
 * the text after the second `@@` (a function name) is ignored.
 */
const HUNK_HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;
const HEADER_PREFIX = 64;

const SPACE = 0x20;
const PLUS = 0x2b;
const MINUS = 0x2d;
const BACKSLASH = 0x5c;
const CR = 0x0d;

/** The path of a `+++ ` line, or undefined when the file is left out. */
function headPath(text: string, start: number, end: number): string | undefined {
  const prefix = '+++ b/';
  // Room for the prefix, the longest path and a tab with a timestamp after it.
  if (end - start > prefix.length + MAX_DIFF_PATH_LENGTH + HEADER_PREFIX) return undefined;
  const line = text.slice(start, end);
  if (!line.startsWith(prefix)) return undefined;
  // git ends a name that contains a space with a tab; diff -u puts a timestamp after one. An
  // unquoted git path never contains a tab.
  const tab = line.indexOf('\t');
  const path = line.slice(prefix.length, tab === -1 ? line.length : tab);
  return plainPath(path) ? path : undefined;
}

/** A relative POSIX path without empty, `.` or `..` segments and without control characters. */
function plainPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_DIFF_PATH_LENGTH) return false;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A number from the hunk header; an absent count is 1. */
function count(value: string | undefined): number {
  return value === undefined ? 1 : Number(value);
}

/** Parses `text` as described in the module comment. */
export function parseUnifiedDiff(text: string): DiffRanges {
  const files = new Map<string, LineRange[]>();
  let kept = 0;
  let truncated = false;
  // The head path of the current file; undefined when it is left out.
  let path: string | undefined;
  // Inside a hunk: the old and new lines still to come, and the range it shows.
  let inHunk = false;
  let oldLeft = 0;
  let newLeft = 0;
  let range: LineRange | undefined;

  const finishHunk = (): void => {
    inHunk = false;
    if (range === undefined || path === undefined) return;
    if (kept >= MAX_DIFF_HUNKS) {
      truncated = true;
      return;
    }
    kept++;
    const ranges = files.get(path);
    if (ranges === undefined) files.set(path, [range]);
    else ranges.push(range);
  };

  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf('\n', position);
    const next = newline === -1 ? text.length : newline + 1;
    let end = newline === -1 ? text.length : newline;
    if (end > position && text.charCodeAt(end - 1) === CR) end--;
    const first = end > position ? text.charCodeAt(position) : SPACE;

    if (inHunk) {
      // An empty line is a context line whose space was stripped, as GNU patch reads it.
      if (first === SPACE) {
        oldLeft--;
        newLeft--;
      } else if (first === MINUS) {
        oldLeft--;
      } else if (first === PLUS) {
        newLeft--;
      } else if (first !== BACKSLASH) {
        // The hunk ended early: drop it and read this line as a header.
        inHunk = false;
        range = undefined;
      }
      if (inHunk) {
        if (oldLeft < 0 || newLeft < 0) {
          inHunk = false;
          range = undefined;
        } else if (oldLeft === 0 && newLeft === 0) {
          finishHunk();
        }
        position = next;
        continue;
      }
    }

    if (text.startsWith('diff ', position) || text.startsWith('--- ', position)) {
      path = undefined;
    } else if (text.startsWith('+++ ', position)) {
      path = headPath(text, position, end);
    } else if (text.startsWith('@@ ', position)) {
      const match = HUNK_HEADER.exec(text.slice(position, Math.min(end, position + HEADER_PREFIX)));
      if (match !== null) {
        oldLeft = count(match[2]);
        const start = Number(match[3]);
        newLeft = count(match[4]);
        range = newLeft > 0 && start > 0 ? { start, end: start + newLeft - 1 } : undefined;
        inHunk = true;
        if (oldLeft === 0 && newLeft === 0) finishHunk();
      }
    } else if (
      text.startsWith('Binary files ', position) ||
      text.startsWith('GIT binary patch', position)
    ) {
      path = undefined;
    }
    position = next;
  }
  return { files, truncated };
}

/** Whether lines `start` through `end` of `path` lie inside one range of `diff`. */
export function insideOneRange(
  diff: DiffRanges,
  path: string,
  start: number,
  end: number,
): boolean {
  return (diff.files.get(path) ?? []).some((range) => range.start <= start && end <= range.end);
}
