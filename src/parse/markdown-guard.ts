/**
 * Keeps CommonMark parsing bounded on hostile input.
 *
 * micromark 4.0.3 (behind mdast-util-from-markdown) is super-linear on several inputs. Measured
 * on this codebase's dependencies (2026-10-14):
 * - Inline: delimiter resolution grows with the square of the delimiters in one paragraph.
 *   32 KiB of `*a_` takes 5.1 s; the same delimiters 10 characters apart take 51 ms.
 * - Containers: every list item that closes, and every lazy line, copies the whole document's
 *   event list (`EditMap.consume`). 64 KiB of `- - x` lines takes 30 s, of `> a` / `b`
 *   paragraphs 15 s, of nested lists 13 s. Setext underlines are similar (64 KiB: 26-68 s).
 * - Lazy continuation lines (paragraph text left of its container's content: `b` after `- a`,
 *   `> b` after `> > a`) each rescan the paragraph so far: `- a` followed by 8,191 lines of `b`
 *   (16 KiB) takes 0.6 s, and the time grows with the square of the line count.
 * - One line with 4,000 nested `- ` markers (8 KiB) takes 2.3 s, growing cubically.
 * - Even benign content costs about 35 µs per block and the heap grows to ~1 GB per MiB, so
 *   parsing 1 MiB of short paragraphs takes 5-12 s.
 *
 * A hostile repository could stall a CI scan for hours with one file, so before parsing we:
 * 1. Limit the analyzed window to `MAX_MARKDOWN_LENGTH` characters and `MAX_MARKDOWN_LINES`
 *    lines (agents read less: Codex truncates AGENTS.md at 32 KiB by default).
 * 2. Estimate container churn; above a budget, parse "flat" (lists, block quotes and setext
 *    headings disabled), which is linear.
 * 3. Cap nesting per line, and defuse the inline delimiters of the most expensive paragraphs.
 *
 * Every transformation replaces characters one for one, so offsets never move. The replacement
 * is U+00A0, which CommonMark treats as neither indentation nor a line ending.
 */
import type { Options } from 'mdast-util-from-markdown';
import type { MarkdownCost } from './types.js';

/** Characters of the text that `parseMarkdown` analyzes; the rest is not parsed. */
export const MAX_MARKDOWN_LENGTH = 128 * 1024;
/** Lines that `parseMarkdown` analyzes; the rest is not parsed. */
export const MAX_MARKDOWN_LINES = 8192;

/** Inline cost budget (see `runCost`): about 0.1-0.4 s at the worst constant measured. */
const INLINE_BUDGET = 2 ** 23;
/** Container cost budget (complex lines x lines): about half a second at ~7e-8 s per unit. */
const CONTAINER_BUDGET = 7_000_000;
/**
 * Lazy-line budget, in paragraph lines rescanned (see `plan`): about 0.07 s at the measured
 * ~1.8e-8 s per unit. A list item followed by a 100-line lazy paragraph costs about 5,000.
 */
const LAZY_BUDGET = 4_000_000;

/** The most one file may cost: what `guardMarkdown` allows without a lower budget. */
export const FILE_GUARD_BUDGET: MarkdownCost = {
  inline: INLINE_BUDGET,
  container: CONTAINER_BUDGET,
  lazy: LAZY_BUDGET,
};
/** Container markers (`>`, `-`, `+`, `*`, `1.`, `1)`) honored at the start of one line. */
const MAX_CONTAINERS = 32;
/** Leading indentation, in columns, beyond which whitespace is defused (bounds list nesting). */
const MAX_INDENT = 128;
const DEFUSED = 0xa0;

/** Flat mode disables the constructs whose cost is quadratic in the document size. */
export const FLAT_MODE: Options = {
  extensions: [{ disable: { null: ['list', 'blockQuote', 'setextUnderline'] } }],
};

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

/**
 * End (exclusive) of the prefix that `parseMarkdown` analyzes: the whole text when it is within
 * the limits, otherwise the start of the first line past them (or the length limit itself for a
 * giant single line, never splitting a surrogate pair). `maxLength` can lower the length limit
 * (a scan-wide budget), never raise it; 0 or less analyzes nothing.
 */
export function markdownWindowEnd(text: string, maxLength = MAX_MARKDOWN_LENGTH): number {
  const limit = Math.min(MAX_MARKDOWN_LENGTH, Math.max(0, Math.floor(maxLength) || 0));
  if (limit === 0) return 0;
  let lines = 0;
  for (let start = 0; start < text.length;) {
    const { next } = lineEnd(text, start);
    if (next > limit || lines >= MAX_MARKDOWN_LINES) {
      if (start > 0) return start;
      const high = text.charCodeAt(limit - 1);
      return high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
    }
    lines++;
    start = next;
  }
  return text.length;
}

// ---------------------------------------------------------------------------------------------
// Line structure
// ---------------------------------------------------------------------------------------------

const isSpaceOrTab = (code: number): boolean => code === 0x20 || code === 0x09;
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/**
 * Inline delimiters whose resolution is super-linear in their number per paragraph: emphasis
 * (`*`, `_`), labels (`[`, `]`), code spans (`` ` ``) and HTML/autolinks (`<`).
 */
function isHot(code: number): boolean {
  return (
    code === 0x2a ||
    code === 0x5f ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x60 ||
    code === 0x3c
  );
}

/**
 * End of the line starting at `start` (excluding its terminator) and the start of the next one.
 * Line terminators are LF, CRLF and a lone CR, as in micromark; with LF only, a lone-CR line in
 * blanked frontmatter would not look blank here and could be mistaken for content.
 */
function lineEnd(text: string, start: number): { end: number; next: number } {
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) return { end: i, next: i + 1 };
    if (code === 0x0d) return { end: i, next: text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1 };
  }
  return { end: text.length, next: text.length };
}

/**
 * Checks whether `[from, end)` is a thematic break made of `char` (`***`, `- - -`, `___`).
 * Returns -1 when it is, otherwise the offset where the check failed: later positions before
 * that offset fail too, which keeps `scanLine` linear on lines like `- - - - … x`.
 */
function thematicBreakFailure(text: string, from: number, end: number, char: number): number {
  let count = 0;
  for (let i = from; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === char) count++;
    else if (!isSpaceOrTab(code)) return i;
  }
  return count >= 3 ? -1 : end;
}

/** End of a container marker starting at `i` (`>`, bullet, ordered), or -1. */
function containerMarkerEnd(text: string, i: number, end: number): number {
  const code = text.charCodeAt(i);
  if (code === 0x3e) return i + 1;
  if (code === 0x2d || code === 0x2b || code === 0x2a) {
    return i + 1 === end || isSpaceOrTab(text.charCodeAt(i + 1)) ? i + 1 : -1;
  }
  let j = i;
  while (j < end && j - i < 10 && isDigit(text.charCodeAt(j))) j++;
  const delimiter = text.charCodeAt(j);
  if (j === i || j - i > 9 || (delimiter !== 0x2e && delimiter !== 0x29)) return -1;
  return j + 1 === end || isSpaceOrTab(text.charCodeAt(j + 1)) ? j + 1 : -1;
}

/** ` {0,3}(=+|-+)[ \t]*`: a setext underline if the previous line is paragraph text. */
function isSetextCandidate(text: string, start: number, end: number): boolean {
  let i = start;
  while (i < end && i - start < 4 && text.charCodeAt(i) === 0x20) i++;
  const char = text.charCodeAt(i);
  if (i - start > 3 || (char !== 0x3d && char !== 0x2d)) return false;
  while (i < end && text.charCodeAt(i) === char) i++;
  while (i < end && isSpaceOrTab(text.charCodeAt(i))) i++;
  return i === end;
}

interface LineScan {
  /** First offset after the structural prefix; hot delimiters are counted from here. */
  readonly bodyStart: number;
  readonly blank: boolean;
  /** Container markers in the prefix. */
  readonly markers: number;
  /** A list marker after two or more columns of indentation (a list nested by indentation). */
  readonly indentedMarker: boolean;
  /** The first marker is `>`. */
  readonly quote: boolean;
  /** The line has a list marker, which always starts a new list item. */
  readonly list: boolean;
  /** Column where the line's content starts, after indentation and container markers. */
  readonly column: number;
}

/**
 * Scans the structural prefix of a line: indentation, container markers, and a leading code
 * fence, thematic break or HTML block start. Those are never defused, so block structure and
 * code fences survive. Excess container markers, and indentation past `MAX_INDENT` that leads to
 * a container marker, are pushed to `defuse`.
 *
 * Deep indentation only costs anything when a marker follows it: that is how lists nest (1,000
 * lines of growing indentation take 14.5 s with `- x` after it, 80 ms with plain text, 28 ms as
 * indented code). Whitespace-only lines are never changed: blanked frontmatter is made of them,
 * and turning them into U+00A0 would create paragraphs.
 */
function scanLine(text: string, start: number, end: number, defuse: number[]): LineScan {
  let i = start;
  let column = 0;
  let markers = 0;
  let indentedMarker = false;
  let quote = false;
  let list = false;
  /** Start of the current whitespace run's part past `MAX_INDENT`, or -1. */
  let deepFrom = -1;
  /** Per break character, the offset before which a thematic break check is known to fail. */
  const noBreakBefore = new Map<number, number>();
  const result = (bodyStart: number, blank = false): LineScan => ({
    bodyStart,
    blank,
    markers,
    indentedMarker,
    quote,
    list,
    column,
  });
  while (i < end) {
    const code = text.charCodeAt(i);
    if (isSpaceOrTab(code)) {
      if (column >= MAX_INDENT && deepFrom === -1) deepFrom = i;
      column = code === 0x09 ? column + 4 - (column % 4) : column + 1;
      i++;
      continue;
    }
    if ((code === 0x2a || code === 0x2d || code === 0x5f) && i >= (noBreakBefore.get(code) ?? 0)) {
      const failure = thematicBreakFailure(text, i, end, code);
      if (failure === -1) return result(end);
      noBreakBefore.set(code, failure);
    }
    const markerEnd = containerMarkerEnd(text, i, end);
    if (markerEnd === -1) break;
    if (deepFrom !== -1) {
      for (let k = deepFrom; k < i; k++) defuse.push(k);
      deepFrom = -1;
    }
    markers++;
    if (markers === 1) quote = code === 0x3e;
    if (code !== 0x3e) list = true;
    if (code !== 0x3e && column >= 2) indentedMarker = true;
    if (markers > MAX_CONTAINERS) defuse.push(markerEnd - 1);
    column += markerEnd - i;
    i = markerEnd;
  }
  if (i >= end) return result(end, markers === 0);
  const first = text.charCodeAt(i);
  if (first === 0x60 || first === 0x7e) {
    let fenceEnd = i;
    while (fenceEnd < end && text.charCodeAt(fenceEnd) === first) fenceEnd++;
    return result(fenceEnd - i >= 3 ? fenceEnd : i);
  }
  return result(first === 0x3c ? i + 1 : i);
}

// ---------------------------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------------------------

/** A run of non-blank lines. A CommonMark paragraph never spans a blank line. */
interface Run {
  readonly start: number;
  end: number;
  /** Hot delimiters outside protected line prefixes. */
  hot: number;
  /** Backtick runs per length: an unmatched code-span opener scans to the end of the paragraph. */
  readonly backticks: Map<number, number>;
}

function countHot(text: string, from: number, end: number, run: Run): void {
  for (let i = from; i < end; i++) {
    const code = text.charCodeAt(i);
    if (!isHot(code)) continue;
    run.hot++;
    if (code !== 0x60 || text.charCodeAt(i - 1) === 0x60) continue;
    let length = 1;
    while (text.charCodeAt(i + length) === 0x60) length++;
    run.backticks.set(length, (run.backticks.get(length) ?? 0) + 1);
  }
}

/**
 * Estimated inline work for a run. Delimiter resolution grows with hot³ / length: quadratic in
 * the count and linear in the density (`*a_` back to back costs 100x more than the same
 * delimiters 10 characters apart). Every unmatched code-span opener scans to the end of the
 * paragraph; matched pairs are cheap, so only odd counts per length are charged.
 */
function runCost(run: Run): number {
  const length = Math.max(1, run.end - run.start);
  let unmatched = 0;
  for (const count of run.backticks.values()) unmatched += count % 2;
  return (run.hot * run.hot * run.hot) / length + unmatched * length;
}

interface Plan {
  readonly runs: Run[];
  /** Offsets to replace regardless of mode (excess nesting). */
  readonly defuse: number[];
  /** Lines changed by the per-line caps. */
  readonly cappedLines: number;
  /** Lines whose container structure makes micromark copy its event list. */
  readonly complexLines: number;
  /** Paragraph lines rescanned by lazy continuation lines. */
  readonly lazyCost: number;
  readonly lines: number;
}

/** One linear pass over the lines: runs, nesting defusals and the container cost inputs. */
function plan(text: string): Plan {
  const runs: Run[] = [];
  const defuse: number[] = [];
  let run: Run | undefined;
  let previousQuote = false;
  let complexLines = 0;
  let cappedLines = 0;
  let lazyCost = 0;
  /** Content column of the run's latest line with a container marker, or -1. */
  let containerColumn = -1;
  let runLines = 0;
  let lines = 0;
  for (let start = 0; start < text.length;) {
    const { end, next } = lineEnd(text, start);
    const defused = defuse.length;
    const line = scanLine(text, start, end, defuse);
    if (defuse.length > defused) cappedLines++;
    lines++;
    if (line.blank) {
      run = undefined;
      previousQuote = false;
      containerColumn = -1;
      runLines = 0;
    } else {
      // A line whose content starts left of the latest container's content, and that starts no
      // new list item, is a lazy continuation: `b` after `- a`, `> b` after `> > a`, `  b` after
      // `- - a`. micromark rescans the paragraph so far for each one, and keeps treating the
      // following lines the same way, so a lazy line does not move the reference column.
      runLines++;
      if (!line.list && containerColumn >= 0 && line.column < containerColumn) {
        lazyCost += runLines;
      } else if (line.markers > 0) {
        containerColumn = line.column;
      }
      // Nested markers, lists nested by indentation, a block quote opening after other content,
      // and setext underlines all trigger whole-document work in micromark.
      if (line.markers > 1) complexLines += line.markers - 1;
      if (line.indentedMarker) complexLines++;
      if (line.quote && !previousQuote) complexLines++;
      if (run !== undefined && isSetextCandidate(text, start, end)) complexLines++;
      previousQuote = line.quote;
      if (run === undefined) {
        run = { start, end, hot: 0, backticks: new Map() };
        runs.push(run);
      }
      run.end = end;
      countHot(text, line.bodyStart, end, run);
    }
    start = next;
  }
  return { runs, defuse, cappedLines, complexLines, lazyCost, lines };
}

/**
 * Runs to defuse, most expensive first, until the remaining cost fits `budget`, and the cost that
 * remains.
 */
function selectRuns(
  runs: readonly Run[],
  budget: number,
): { readonly selected: Run[]; readonly remaining: number } {
  const costs = new Map(runs.map((run) => [run, runCost(run)]));
  let total = 0;
  for (const cost of costs.values()) total += cost;
  if (total <= budget) return { selected: [], remaining: total };
  const byCost = [...runs].sort(
    (a, b) => (costs.get(b) ?? 0) - (costs.get(a) ?? 0) || a.start - b.start,
  );
  const selected: Run[] = [];
  for (const run of byCost) {
    const cost = costs.get(run) ?? 0;
    // Runs that cost nothing come last; rounding must not make them look worth defusing.
    if (total <= budget || cost <= 0) break;
    selected.push(run);
    total -= cost;
  }
  return { selected, remaining: Math.max(0, total) };
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export interface GuardedSource {
  /** Same length as the input; only defused characters differ. */
  readonly source: string;
  /** Parse with `FLAT_MODE`: container or lazy-line cost is over budget. */
  readonly flat: boolean;
  /** Runs of non-blank lines (paragraphs) whose inline delimiters were defused. */
  readonly defusedParagraphs: number;
  /** Lines changed by the per-line caps (container markers, indentation before a marker). */
  readonly cappedLines: number;
  /** What parsing `source` is estimated to cost, after flat mode and defusing. */
  readonly cost: MarkdownCost;
}

/** `budget` per unit, never above {@link FILE_GUARD_BUDGET} and never below 0. */
function fileBudget(budget: MarkdownCost): MarkdownCost {
  const lower = (value: number, limit: number): number =>
    Math.max(0, Math.min(limit, Number.isNaN(value) ? 0 : value));
  return {
    inline: lower(budget.inline, INLINE_BUDGET),
    container: lower(budget.container, CONTAINER_BUDGET),
    lazy: lower(budget.lazy, LAZY_BUDGET),
  };
}

/**
 * Prepares `text` (already windowed, frontmatter already blanked) for micromark. Returns the
 * input string itself when nothing needs defusing, which is the common case. `budget` can lower
 * the cost allowed in each unit (what is left of a scan-wide budget), never raise it: at 0, any
 * container or lazy-line cost makes the parse flat and every paragraph with inline cost is
 * defused, so what is left costs time linear in the text.
 */
export function guardMarkdown(
  text: string,
  budget: MarkdownCost = FILE_GUARD_BUDGET,
): GuardedSource {
  const { runs, defuse, cappedLines, complexLines, lazyCost, lines } = plan(text);
  const allowed = fileBudget(budget);
  const containerCost = complexLines * lines;
  const flat = containerCost > allowed.container || lazyCost > allowed.lazy;
  const { selected, remaining } = selectRuns(runs, allowed.inline);
  // micromark's preprocessor drops a leading U+FEFF, which would shift every offset by one. The
  // decoder strips one BOM; a second one (or U+FEFF after a UTF-16 BOM) reaches us as text.
  // Replacing it loses nothing, so it does not count as a limit.
  if (text.charCodeAt(0) === 0xfeff) defuse.push(0);
  const cost: MarkdownCost = {
    inline: remaining,
    container: flat ? 0 : containerCost,
    lazy: flat ? 0 : lazyCost,
  };
  const result = { flat, defusedParagraphs: selected.length, cappedLines, cost };
  if (selected.length === 0 && defuse.length === 0) return { source: text, ...result };

  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  for (const offset of defuse) units[offset] = DEFUSED;
  for (const run of selected) {
    for (let start = run.start; start < run.end;) {
      const { end, next } = lineEnd(text, start);
      const { bodyStart } = scanLine(text, start, end, []);
      for (let i = bodyStart; i < end; i++) {
        if (isHot(text.charCodeAt(i))) units[i] = DEFUSED;
      }
      start = next;
    }
  }
  let source = '';
  for (let i = 0; i < units.length; i += 4096) {
    source += String.fromCharCode(...units.subarray(i, i + 4096));
  }
  return { source, ...result };
}
