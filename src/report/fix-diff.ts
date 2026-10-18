/**
 * Human-readable output of `agentcheckup fix`: the dry run (one block per fix with the unified
 * diff of what it changes, its effects and notes, then the manual steps and a verification
 * line) and the summary printed after `--write` or `-i`. Also the line diff that
 * `fix --format json` reports as hunks (src/report/fix-json.ts).
 *
 * Pure, like the other formatters: the CLI decides about color and passes a {@link Style}.
 *
 * Safety (docs/adr/0008-write-fixes-to-the-scanned-repository.md, "Output"):
 * - Every string from the scanned repository, each line of file content included, goes through
 *   `forTerminal`, and the whole output through `guardWorkflowCommands`: a context line such as
 *   ` ::stop-commands::x` would otherwise be a workflow command in a GitHub Actions log.
 * - Credentials are redacted before anything is shown, as `ghp_…(40 chars)`: the spans that a
 *   credential fix (mcp/literal-secret, or any fix with a rotation warning) replaces, wherever
 *   they appear, and anything mcp/literal-secret's detector matches.
 *
 * The diff:
 * - Lines are compared whole, with their line ending. Myers' O(ND) algorithm after trimming the
 *   common prefix and suffix; past {@link MAX_EDIT_COST} the differing middle is replaced as one
 *   block, which is still a correct diff, only a longer one. Within a change, deletions come
 *   before additions. The output depends only on the two texts.
 * - Hunks carry {@link DIFF_CONTEXT} lines of context; changes closer than twice that share a
 *   hunk. Headers follow GNU diff: `@@ -0,0 +1,3 @@` for a new file, a count of 1 is omitted.
 * - A last line without a line break is followed by `\ No newline at end of file`.
 * - CRLF: when the file uses CRLF throughout, before and after, line endings are left out of the
 *   comparison and the display, and the file header says `line endings: CRLF`. Otherwise a line
 *   that ends in CRLF shows `␍` (`^M` in ASCII mode) at its end, so a change of line ending is
 *   visible, and the header explains the mark. JSON hunk lines never include line endings.
 * - A change of encoding or byte order mark is a header line: `encoding: UTF-8 with BOM → UTF-8`.
 *
 * Fixes that need the user's words (`FixRun.awaitingInput`) change nothing until `fix -i` asks
 * for the words, so they have no diff: each is one `input` line next to the manual steps, and a
 * last line counts them. `fix --format json` lists them in `awaitingInput`.
 *
 * When findings need judgment (`FixRun.judgment`: what `agentcheckup tasks` would hand to a
 * coding agent), the dry run's verification line ends with `· 3 need judgment: agentcheckup
 * tasks`; without a verification line, the count is the last line.
 */
import { compareStrings } from '../core/compare.js';
import { formatInteger } from '../core/format.js';
import type { FileChange, FixClass } from '../core/types.js';
import type {
  AwaitingInput,
  DiffHunk,
  FileState,
  FixEffect,
  FixReport,
  FixSkipReason,
  FixVerification,
  ManualStep,
  PlannedFix,
} from '../fix/index.js';
import { CONTEXT_AGENTS, type ContextAgent } from '../platforms/load/types.js';
import { findSecret } from '../rules/mcp/secrets.js';
import { joinNames } from '../rules/shared/format.js';
import { AGENT_NAMES } from './context-view.js';
import { GATE_CLASS_ORDER } from './json.js';
import { forTerminal, guardWorkflowCommands } from './sanitize.js';
import { plainStyle, type Style } from './stylish.js';
import { truncate } from './text.js';

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** One version of a file: its decoded text and how it is (or will be) stored. */
export interface FileVersion {
  /**
   * Decoded text without the byte order mark, with the line endings that are on disk (before)
   * or will be written (after).
   */
  readonly text: string;
  readonly state: FileState;
}

/**
 * The combined change to one file across every planned or applied fix. `path` is where the file
 * is after the change; a rename's `from` is where it was.
 */
export type ChangedFile =
  | { readonly op: 'create'; readonly path: string; readonly after: FileVersion }
  | {
      readonly op: 'edit';
      readonly path: string;
      readonly before: FileVersion;
      readonly after: FileVersion;
    }
  | {
      readonly op: 'rename';
      readonly path: string;
      readonly from: string;
      readonly before: FileVersion;
      readonly after: FileVersion;
    };

/**
 * What one `agentcheckup fix` run did or would do: the input of the human output and of
 * `fix --format json`. Paths are relative to the scan root; `pathBase` is put in front of each
 * when shown, as in the scan report.
 */
export interface FixRun {
  readonly mode: FixReport['mode'];
  /** POSIX directory prefix for every path shown (see `ScanResult.pathBase`). */
  readonly pathBase?: string | undefined;
  /** Every selected fix, in plan order. */
  readonly fixes: readonly PlannedFix[];
  /** Every file the planned (dry run) or applied (write) fixes change, before and after. */
  readonly files: readonly ChangedFile[];
  readonly manual: readonly ManualStep[];
  readonly verification: FixVerification;
  /** Selected fixes that need the user's words, in plan order. Absent means none. */
  readonly awaitingInput?: readonly AwaitingInput[] | undefined;
  /**
   * Findings that `agentcheckup tasks` hands to an agent (src/tasks `judgmentCount`), for the
   * last line of the dry run. Absent means none.
   */
  readonly judgment?: number | undefined;
}

export interface FixDiffOptions {
  /** Color functions. Default {@link plainStyle}. */
  readonly style?: Style | undefined;
  /** ASCII-only decorations (`~` for `≈`, `->` for `→`, `^M` for `␍`, `...` for `…`). */
  readonly ascii?: boolean | undefined;
}

// ---------------------------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------------------------

/** Lines of context around each change, as in `diff -u` and `git diff`. */
export const DIFF_CONTEXT = 3;

/**
 * Edit distance past which the diff stops looking for the shortest edit script. Bounds time to
 * O((N + M) · MAX_EDIT_COST) and memory to O(MAX_EDIT_COST²). Fixes change a few lines.
 */
export const MAX_EDIT_COST = 1000;

/** The JSON and display form of the marker after a last line without a line break. */
export const NO_NEWLINE_MARKER = '\\ No newline at end of file';

interface Line {
  /** Without the line ending. */
  readonly text: string;
  /** Ends in CRLF. */
  readonly cr: boolean;
  /** Has a line ending; false only for a last line without one. */
  readonly eol: boolean;
}

type Mark = ' ' | '-' | '+';

interface Entry {
  readonly mark: Mark;
  readonly line: Line;
}

interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly entries: readonly Entry[];
}

/** Splits at LF, like DecodedText.lineStarts: a CR before the LF belongs to the line ending. */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (end === -1) {
      lines.push({ text: text.slice(start), cr: false, eol: false });
      break;
    }
    const cr = end > start && text.charCodeAt(end - 1) === 0x0d;
    lines.push({ text: text.slice(start, cr ? end - 1 : end), cr, eol: true });
    start = end + 1;
  }
  return lines;
}

function repeat(mark: Mark, count: number): Mark[] {
  return new Array<Mark>(count).fill(mark);
}

/**
 * The shortest edit script from `a` to `b` (Myers 1986), as marks: ` ` keeps a line of both,
 * `-` deletes the next line of `a`, `+` inserts the next line of `b`. Undefined past
 * {@link MAX_EDIT_COST}.
 */
function shortestEdit(a: readonly number[], b: readonly number[]): Mark[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is v before step d, for diagonals -d-1..d+1: index k + d + 1.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDIT_COST); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return undefined;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Mark[] {
  const marks: Mark[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] ?? new Int32Array(0);
    const at = (k: number): number => v[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      marks.push(' ');
      x--;
      y--;
    }
    if (d > 0) marks.push(down ? '+' : '-');
    x = previousX;
    y = previousY;
  }
  return marks.reverse();
}

/** Puts the deletions of each change before its additions, as unified diffs show them. */
function groupChanges(marks: readonly Mark[]): Mark[] {
  const out: Mark[] = [];
  let deletions = 0;
  let additions = 0;
  const flush = (): void => {
    out.push(...repeat('-', deletions), ...repeat('+', additions));
    deletions = 0;
    additions = 0;
  };
  for (const mark of marks) {
    if (mark === '-') deletions++;
    else if (mark === '+') additions++;
    else {
      flush();
      out.push(mark);
    }
  }
  flush();
  return out;
}

function editScript(a: readonly number[], b: readonly number[]): Mark[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMiddle = a.slice(prefix, a.length - suffix);
  const newMiddle = b.slice(prefix, b.length - suffix);
  const middle = (oldMiddle.length === 0 || newMiddle.length === 0
    ? undefined
    : shortestEdit(oldMiddle, newMiddle)) ?? [
    ...repeat('-', oldMiddle.length),
    ...repeat('+', newMiddle.length),
  ];
  return [...repeat(' ', prefix), ...groupChanges(middle), ...repeat(' ', suffix)];
}

function lineKey(line: Line, ignoreCr: boolean): string {
  if (!line.eol) return `${line.text}\u0000`;
  return line.cr && !ignoreCr ? `${line.text}\r\n` : `${line.text}\n`;
}

function entriesOf(before: string, after: string, ignoreCr: boolean): Entry[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ids = new Map<string, number>();
  const intern = (line: Line): number => {
    const key = lineKey(line, ignoreCr);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const marks = editScript(oldLines.map(intern), newLines.map(intern));
  const entries: Entry[] = [];
  let i = 0;
  let j = 0;
  for (const mark of marks) {
    if (mark === '-') {
      const line = oldLines[i++];
      if (line !== undefined) entries.push({ mark, line });
    } else {
      const line = newLines[j++];
      if (mark === ' ') i++;
      if (line !== undefined) entries.push({ mark, line });
    }
  }
  return entries;
}

function hunksOf(entries: readonly Entry[], context: number): Hunk[] {
  // Old and new lines before each entry, for the hunk headers.
  const oldBefore = [0];
  const newBefore = [0];
  for (const entry of entries) {
    oldBefore.push((oldBefore[oldBefore.length - 1] ?? 0) + (entry.mark === '+' ? 0 : 1));
    newBefore.push((newBefore[newBefore.length - 1] ?? 0) + (entry.mark === '-' ? 0 : 1));
  }
  const changes: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.mark !== ' ') changes.push(index);
  });

  const hunks: Hunk[] = [];
  let next = 0;
  while (next < changes.length) {
    const first = changes[next] ?? 0;
    let last = first;
    next++;
    while (next < changes.length && (changes[next] ?? 0) - last - 1 <= 2 * context) {
      last = changes[next] ?? last;
      next++;
    }
    const start = Math.max(0, first - context);
    const end = Math.min(entries.length, last + context + 1);
    const oldLines = (oldBefore[end] ?? 0) - (oldBefore[start] ?? 0);
    const newLines = (newBefore[end] ?? 0) - (newBefore[start] ?? 0);
    hunks.push({
      oldStart: (oldBefore[start] ?? 0) + (oldLines === 0 ? 0 : 1),
      oldLines,
      newStart: (newBefore[start] ?? 0) + (newLines === 0 ? 0 : 1),
      newLines,
      entries: entries.slice(start, end),
    });
  }
  return hunks;
}

function toDiffHunk(hunk: Hunk, redact: Redact): DiffHunk {
  const lines: string[] = [];
  for (const entry of hunk.entries) {
    lines.push(`${entry.mark}${redact(entry.line.text)}`);
    if (!entry.line.eol) lines.push(NO_NEWLINE_MARKER);
  }
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
  };
}

export interface DiffOptions {
  /** Compare and show lines without their CR, for files that use CRLF throughout. */
  readonly ignoreCr?: boolean | undefined;
  /** Lines of context. Default {@link DIFF_CONTEXT}. */
  readonly context?: number | undefined;
}

/**
 * The unified diff from `before` to `after` as hunks. Lines carry no line ending; nothing is
 * redacted or sanitized. Identical texts give no hunks.
 */
export function diffHunks(before: string, after: string, options: DiffOptions = {}): DiffHunk[] {
  const entries = entriesOf(before, after, options.ignoreCr === true);
  return hunksOf(entries, options.context ?? DIFF_CONTEXT).map((hunk) =>
    toDiffHunk(hunk, (text) => text),
  );
}

/** Whether a file uses CRLF throughout, before and after: then line endings are not shown. */
function uniformCrlf(file: ChangedFile): boolean {
  if (file.after.state.lineEnding !== 'crlf') return false;
  return file.op === 'create' || file.before.state.lineEnding === 'crlf';
}

function fileHunksOf(file: ChangedFile): Hunk[] {
  const before = file.op === 'create' ? '' : file.before.text;
  return hunksOf(entriesOf(before, file.after.text, uniformCrlf(file)), DIFF_CONTEXT);
}

/** The hunks of one changed file as `fix --format json` reports them: redacted, no line endings. */
export function changedFileHunks(file: ChangedFile, redact: Redact): DiffHunk[] {
  return fileHunksOf(file).map((hunk) => toDiffHunk(hunk, redact));
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/** A function that redacts credentials in one string. */
export type Redact = (text: string) => string;

/** The rule whose fixes replace a literal credential. */
export const LITERAL_SECRET_RULE = 'mcp/literal-secret';

/** Characters of a credential kept in front of the ellipsis, for credentials of 16 or more. */
const SECRET_PREFIX = 4;
const MIN_PREFIXED_SECRET = 16;
/** Spans shorter than this are not redacted by value: they would match ordinary text. */
const MIN_SECRET_VALUE = 8;
/** Detector matches redacted per string; more than this many credentials in one line is absurd. */
const MAX_DETECTED = 1000;

/** True for a fix that handles a credential: never shown unredacted, never suggested in a PR. */
export function isSecretFix(planned: Pick<PlannedFix, 'ruleId' | 'fix'>): boolean {
  return planned.ruleId === LITERAL_SECRET_RULE || planned.fix.warning !== undefined;
}

function redacted(token: string, ellipsis: string): string {
  const prefix = token.length >= MIN_PREFIXED_SECRET ? token.slice(0, SECRET_PREFIX) : '';
  return `${prefix}${ellipsis}(${formatInteger(token.length)} chars)`;
}

/**
 * `text` with credentials replaced by their first four characters and their length,
 * `ghp_…(40 chars)`: every occurrence of each of `values` (longest first), then everything
 * mcp/literal-secret's detector matches.
 */
export function redactCredentials(
  text: string,
  values: readonly string[] = [],
  ellipsis = '…',
): string {
  let rest = text;
  for (const value of values) {
    if (value.length >= MIN_SECRET_VALUE && rest.includes(value)) {
      const replacement = redacted(value, ellipsis);
      rest = rest.replaceAll(value, () => replacement);
    }
  }
  let out = '';
  for (let found = 0; found < MAX_DETECTED; found++) {
    const match = findSecret(rest);
    if (match === undefined) break;
    const end = match.start + match.length;
    out += `${rest.slice(0, match.start)}${redacted(rest.slice(match.start, end), ellipsis)}`;
    rest = rest.slice(end);
  }
  return out + rest;
}

function touchedPaths(change: FileChange): string[] {
  return change.kind === 'rename' ? [change.from, change.to] : [change.path];
}

/**
 * The spans that credential fixes replace, read from the text before the change, longest
 * first. Offsets of a fix's edits index the file as that fix found it; for the credential
 * fixes, which make one edit per file, that is the scanned text.
 */
function secretValues(run: Pick<FixRun, 'fixes' | 'files'>): string[] {
  const texts = new Map<string, string>();
  for (const file of run.files) {
    if (file.op === 'create') continue;
    texts.set(file.path, file.before.text);
    if (file.op === 'rename') texts.set(file.from, file.before.text);
  }
  const values = new Set<string>();
  for (const planned of run.fixes) {
    if (!isSecretFix(planned)) continue;
    for (const change of planned.fix.changes) {
      if (change.kind !== 'edit') continue;
      const text = texts.get(change.path);
      if (text === undefined) continue;
      for (const edit of change.edits) {
        const value = text.slice(edit.offset, edit.offset + edit.length);
        if (value.length >= MIN_SECRET_VALUE) values.add(value);
      }
    }
  }
  return [...values].sort((a, b) => b.length - a.length || compareStrings(a, b));
}

/** The redaction for everything a run shows. */
export function runRedactor(run: Pick<FixRun, 'fixes' | 'files'>, ellipsis = '…'): Redact {
  const values = secretValues(run);
  return (text) => redactCredentials(text, values, ellipsis);
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

interface Symbols {
  readonly approx: string;
  readonly arrow: string;
  readonly dot: string;
  readonly cr: string;
  readonly more: string;
}

const UNICODE_SYMBOLS: Symbols = { approx: '≈', arrow: '→', dot: '·', cr: '␍', more: '…' };
const ASCII_SYMBOLS: Symbols = { approx: '~', arrow: '->', dot: '-', cr: '^M', more: '...' };

/** One line of file content is cut after this many code points. */
const MAX_LINE_LENGTH = 1000;
/** Titles, notes, guidance and messages are cut after this many code points. */
const MAX_TEXT_LENGTH = 500;
const MAX_PATH_LENGTH = 300;
/** Width of the class column: `review` and two spaces. */
const CLASS_WIDTH = 8;

interface Context {
  readonly style: Style;
  readonly symbols: Symbols;
  readonly ascii: boolean;
  readonly redact: Redact;
  readonly base: string;
}

function contextOf(run: FixRun, options: FixDiffOptions): Context {
  const ascii = options.ascii === true;
  const symbols = ascii ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
  return {
    style: options.style ?? plainStyle,
    symbols,
    ascii,
    redact: runRedactor(run, symbols.more),
    base: normalizedBase(run.pathBase),
  };
}

/** `pathBase` without a trailing slash; `''` for none. */
export function normalizedBase(pathBase: string | undefined): string {
  if (pathBase === undefined || pathBase === '.') return '';
  return pathBase.endsWith('/') ? pathBase.slice(0, -1) : pathBase;
}

/** `path` with the base in front, as `rebaseResult` does it. */
export function withBase(base: string, path: string): string {
  if (base === '') return path;
  return path === '' ? base : `${base}/${path}`;
}

/** Redacted, cut and sanitized single-line text. */
function clean(text: string, context: Context, max = MAX_TEXT_LENGTH): string {
  return forTerminal(truncate(context.redact(text), max, context.symbols.more), {
    ascii: context.ascii,
  });
}

function cleanPath(path: string, context: Context): string {
  return clean(withBase(context.base, path), context, MAX_PATH_LENGTH);
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatInteger(value)} ${value === 1 ? singular : plural}`;
}

function classLabel(name: FixClass | 'manual' | 'input', style: Style): string {
  const pad = ' '.repeat(Math.max(1, CLASS_WIDTH - name.length));
  if (name === 'safe') return `${style.green(name)}${pad}`;
  if (name === 'review') return `${style.yellow(name)}${pad}`;
  if (name === 'input') return `${style.blue(name)}${pad}`;
  return `${style.gray(name)}${pad}`;
}

function encodingLabel(state: FileState): string {
  const names: Readonly<Record<FileState['encoding'], string>> = {
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16LE',
    'utf-16be': 'UTF-16BE',
  };
  return state.bom ? `${names[state.encoding]} with BOM` : names[state.encoding];
}

function hunkRange(start: number, lines: number): string {
  return lines === 1 ? `${start}` : `${start},${lines}`;
}

function hunkLines(hunk: Hunk, showCr: boolean, context: Context): string[] {
  const { style, symbols } = context;
  const lines = [
    style.blue(
      `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
    ),
  ];
  for (const entry of hunk.entries) {
    const cr = showCr && entry.line.cr ? symbols.cr : '';
    const text = `${entry.mark}${clean(entry.line.text, context, MAX_LINE_LENGTH)}${cr}`;
    if (entry.mark === '+') lines.push(style.green(text));
    else if (entry.mark === '-') lines.push(style.red(text));
    else lines.push(text);
    if (!entry.line.eol) lines.push(style.dim(NO_NEWLINE_MARKER));
  }
  return lines;
}

/** One file's unified diff with its headers. */
function fileLines(file: ChangedFile, context: Context): string[] {
  const { style } = context;
  const hunks = fileHunksOf(file);
  const lines: string[] = [];
  const header = (text: string): void => {
    lines.push(style.bold(text));
  };

  if (file.op === 'rename') {
    header(`rename from ${cleanPath(file.from, context)}`);
    header(`rename to ${cleanPath(file.path, context)}`);
  }
  if (file.op !== 'create') {
    const before = encodingLabel(file.before.state);
    const after = encodingLabel(file.after.state);
    if (before !== after) header(`encoding: ${before} ${context.symbols.arrow} ${after}`);
  } else if (encodingLabel(file.after.state) !== 'UTF-8') {
    header(`encoding: ${encodingLabel(file.after.state)}`);
  }
  const uniform = uniformCrlf(file);
  const showsCr = !uniform && hunks.some((hunk) => hunk.entries.some((entry) => entry.line.cr));
  if (uniform) header('line endings: CRLF');
  else if (showsCr) header(`line endings: ${context.symbols.cr} marks CRLF`);

  if (hunks.length === 0 && file.op === 'rename') return lines;
  const from =
    file.op === 'create'
      ? '/dev/null'
      : `a/${cleanPath(file.op === 'rename' ? file.from : file.path, context)}`;
  header(`--- ${from}`);
  header(`+++ b/${cleanPath(file.path, context)}`);
  for (const hunk of hunks) lines.push(...hunkLines(hunk, showsCr, context));
  return lines;
}

function effectText(effect: FixEffect, context: Context): string {
  const { approx, arrow } = context.symbols;
  switch (effect.kind) {
    case 'tokens': {
      const cwd = withBase(context.base, effect.cwd);
      const where = cwd === '' ? '' : ` in ${clean(cwd, context, MAX_PATH_LENGTH)}`;
      return `${AGENT_NAMES[effect.agent]}${where} session start ${approx}${formatInteger(effect.before)} ${arrow} ${approx}${formatInteger(effect.after)} tokens`;
    }
    case 'gate':
      return `${clean(effect.summary, context)} (gate class ${effect.class})`;
  }
}

/** An agent's estimated startup tokens in one directory, before and after. */
interface TokenChange {
  readonly agent: ContextAgent;
  readonly cwd: string;
  readonly before: number;
  readonly after: number;
}

/**
 * One line per change that agents share: `Cursor, Copilot CLI and Devin Local session start ≈27
 * → ≈30 tokens`. Agents with the same directory and the same totals before and after are named
 * together, in the order of `changes`; with nine agents, one change is often the same for most.
 */
function tokenLines(changes: readonly TokenChange[], context: Context): string[] {
  const { approx, arrow } = context.symbols;
  const groups = new Map<string, TokenChange[]>();
  for (const change of changes) {
    const key = `${change.cwd}\n${String(change.before)}\n${String(change.after)}`;
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return [...groups.values()].flatMap((group) => {
    const [first] = group;
    if (first === undefined) return [];
    const cwd = withBase(context.base, first.cwd);
    const where = cwd === '' ? '' : ` in ${clean(cwd, context, MAX_PATH_LENGTH)}`;
    const names = joinNames(group.map((change) => AGENT_NAMES[change.agent]));
    return [
      `${names}${where} session start ${approx}${formatInteger(first.before)} ${arrow} ${approx}${formatInteger(first.after)} tokens`,
    ];
  });
}

/** Why a selected fix was not applied, as a clause. */
export const SKIP_REASON_TEXT: Readonly<Record<FixSkipReason, string>> = {
  conflict: 'it overlaps a fix that goes first; run agentcheckup fix again',
  'changed-since-scan': 'the file changed since the scan',
  'refused-path': 'the target path failed the safety checks',
  'verification-failed': 'a re-scan showed it does not resolve its finding or adds a problem',
  limit: 'past a limit of this run',
  'write-failed': 'writing failed, and its changes were rolled back',
  declined: 'declined',
};

function banner(warning: string, context: Context): string {
  return context.style.bold(context.style.red(`!! ${clean(warning, context)}`));
}

function fixHeader(planned: PlannedFix, context: Context): string {
  return `${classLabel(planned.fix.class, context.style)}${clean(planned.ruleId, context)}  ${context.style.bold(clean(planned.fix.title, context))}`;
}

interface Claim {
  /** Index into `FixRun.files`. */
  readonly file: number;
  /** The first fix that changes the file: its diff is shown here. */
  readonly first: boolean;
}

/**
 * The files each fix changes, in the order of its changes. A file appears with its diff under
 * the first fix that changes it and is named under later ones. Files no fix claims (none, when
 * the planner and the applier agree) are returned too, so that every change is shown.
 */
function claimFiles(run: FixRun): { claims: Claim[][]; unclaimed: number[] } {
  const byPath = new Map<string, number[]>();
  const add = (path: string, index: number): void => {
    byPath.set(path, [...(byPath.get(path) ?? []), index]);
  };
  run.files.forEach((file, index) => {
    add(file.path, index);
    if (file.op === 'rename') add(file.from, index);
  });
  const seen = new Set<number>();
  const claims = run.fixes.map((planned) => {
    if (planned.status === 'skipped') return [];
    const files: number[] = [];
    for (const change of planned.fix.changes) {
      for (const path of touchedPaths(change)) {
        for (const index of byPath.get(path) ?? []) {
          if (!files.includes(index)) files.push(index);
        }
      }
    }
    return files.map((file): Claim => {
      const first = !seen.has(file);
      seen.add(file);
      return { file, first };
    });
  });
  const unclaimed = run.files.map((_, index) => index).filter((index) => !seen.has(index));
  return { claims, unclaimed };
}

function fixBlock(
  planned: PlannedFix,
  claims: readonly Claim[],
  run: FixRun,
  context: Context,
): string[] {
  const { style } = context;
  const lines: string[] = [];
  const warning = planned.fix.warning;
  if (warning !== undefined) lines.push(banner(warning, context));
  lines.push(fixHeader(planned, context));
  if (planned.status === 'skipped') {
    lines.push(`  ${style.yellow('skipped')}: ${SKIP_REASON_TEXT[planned.reason]}`);
  } else {
    for (const claim of claims) {
      const file = run.files[claim.file];
      if (file === undefined) continue;
      if (claim.first) lines.push(...fileLines(file, context));
      else lines.push(style.dim(`  ${cleanPath(file.path, context)}: see the diff above`));
    }
    const effects = sortedEffects(planned.effects);
    const tokens = effects.filter((effect) => effect.kind === 'tokens');
    for (const line of tokenLines(tokens, context))
      lines.push(`  ${style.gray('effect:')} ${line}`);
    for (const effect of effects) {
      if (effect.kind === 'gate')
        lines.push(`  ${style.gray('effect:')} ${effectText(effect, context)}`);
    }
  }
  for (const note of planned.fix.notes ?? []) {
    lines.push(`  ${style.gray('note:')} ${clean(note, context)}`);
  }
  if (warning !== undefined) lines.push(banner(warning, context));
  return lines;
}

function agentRank(agent: ContextAgent): number {
  return CONTEXT_AGENTS.indexOf(agent);
}

/** Token effects by agent and directory, then gate effects by class and item. */
export function sortedEffects(effects: readonly FixEffect[]): FixEffect[] {
  const rank = (effect: FixEffect): number =>
    effect.kind === 'tokens'
      ? agentRank(effect.agent)
      : CONTEXT_AGENTS.length + 1 + GATE_CLASS_ORDER[effect.class];
  const key = (effect: FixEffect): string =>
    effect.kind === 'tokens' ? effect.cwd : `${effect.id}\n${effect.change}\n${effect.summary}`;
  return [...effects].sort((a, b) => rank(a) - rank(b) || compareStrings(key(a), key(b)));
}

function manualLine(step: ManualStep, context: Context): string {
  return `${classLabel('manual', context.style)}${clean(step.ruleId, context)}  ${cleanPath(step.path, context)}:${step.line}  ${clean(step.guidance, context)}`;
}

/** The command that asks for the words of the fixes awaiting input. */
const INPUT_COMMAND = 'agentcheckup fix -i';

function inputLine(entry: AwaitingInput, context: Context): string {
  return `${classLabel('input', context.style)}${clean(entry.ruleId, context)}  ${cleanPath(entry.path, context)}:${entry.line}  needs your words: ${clean(entry.fix.input.label, context)} (${INPUT_COMMAND})`;
}

/** `2 fixes need your words: …`, or nothing when no fix awaits input. */
function inputCount(entries: readonly AwaitingInput[]): string[] {
  const n = entries.length;
  if (n === 0) return [];
  const verb = n === 1 ? 'needs' : 'need';
  return [
    `${count(n, 'fix', 'fixes')} ${verb} your words: run ${INPUT_COMMAND} to answer ${n === 1 ? 'it' : 'them'}.`,
  ];
}

function introducedLines(verification: FixVerification, context: Context): string[] {
  return [...verification.introduced]
    .sort(
      (a, b) =>
        compareStrings(a.path, b.path) ||
        a.range.start.line - b.range.start.line ||
        compareStrings(a.ruleId, b.ruleId),
    )
    .map(
      (finding) =>
        `  new ${finding.severity === 'warn' ? 'warning' : finding.severity}  ${cleanPath(finding.path, context)}:${finding.range.start.line}  ${clean(finding.ruleId, context)}  ${clean(finding.message, context)}`,
    );
}

function verificationCounts(verification: FixVerification): string {
  return `${count(verification.resolved, 'finding')} resolved, ${formatInteger(verification.introduced.length)} new, ${formatInteger(verification.remaining)} left`;
}

/** The command that writes the findings that need judgment as tasks for a coding agent. */
const TASKS_COMMAND = 'agentcheckup tasks';

/** `3 need judgment: agentcheckup tasks`, or nothing when no finding needs judgment. */
function judgmentText(judgment: number | undefined, subject: boolean): string | undefined {
  if (judgment === undefined || judgment <= 0) return undefined;
  const what = subject ? count(judgment, 'finding') : formatInteger(judgment);
  return `${what} ${judgment === 1 ? 'needs' : 'need'} judgment: ${TASKS_COMMAND}`;
}

function finish(lines: readonly string[]): string {
  return `${guardWorkflowCommands(lines.join('\n'))}\n`;
}

/**
 * The dry run: per fix its class, rule and title, the unified diff of each file it changes, its
 * effects and notes, framed by its warning if it has one; then the manual steps and the
 * verification line. A file changed by several fixes is shown under the first of them.
 */
export function formatFixDiff(run: FixRun, options: FixDiffOptions = {}): string {
  const context = contextOf(run, options);
  const lines: string[] = [];
  const { claims, unclaimed } = claimFiles(run);

  run.fixes.forEach((planned, fix) => {
    if (lines.length > 0) lines.push('');
    lines.push(...fixBlock(planned, claims[fix] ?? [], run, context));
  });
  if (unclaimed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(context.style.bold('Other changes'));
    for (const index of unclaimed) {
      const file = run.files[index];
      if (file !== undefined) lines.push(...fileLines(file, context));
    }
  }

  const planned = run.fixes.some((fix) => fix.status !== 'skipped') || run.files.length > 0;
  const inputs = run.awaitingInput ?? [];
  if (lines.length > 0) lines.push('');
  if (!planned && run.fixes.length === 0 && inputs.length === 0) lines.push('Nothing to fix.');
  for (const entry of inputs) lines.push(inputLine(entry, context));
  for (const step of run.manual) lines.push(manualLine(step, context));
  if (planned) {
    const lead = run.mode === 'dry-run' ? 'Verified on an in-memory copy' : 'Re-scanned';
    const judgment = judgmentText(run.judgment, false);
    lines.push(
      judgment === undefined
        ? `${lead}: ${verificationCounts(run.verification)}.`
        : `${lead}: ${verificationCounts(run.verification)} ${context.symbols.dot} ${judgment}`,
    );
    lines.push(...introducedLines(run.verification, context));
  }
  lines.push(...inputCount(inputs));
  const judgment = planned ? undefined : judgmentText(run.judgment, true);
  if (judgment !== undefined) lines.push(judgment);
  return finish(lines);
}

/** Startup token changes summed per agent and directory over the applied fixes. */
interface TokenTotal {
  readonly agent: ContextAgent;
  readonly cwd: string;
  readonly before: number;
  after: number;
}

function tokenTotals(fixes: readonly PlannedFix[]): TokenTotal[] {
  const totals = new Map<string, TokenTotal>();
  for (const planned of fixes) {
    for (const effect of planned.effects) {
      if (effect.kind !== 'tokens') continue;
      const key = `${effect.agent}\n${effect.cwd}`;
      const total = totals.get(key);
      if (total === undefined) {
        totals.set(key, {
          agent: effect.agent,
          cwd: effect.cwd,
          before: effect.before,
          after: effect.after,
        });
      } else {
        total.after += effect.after - effect.before;
      }
    }
  }
  return [...totals.values()].sort(
    (a, b) => agentRank(a.agent) - agentRank(b.agent) || compareStrings(a.cwd, b.cwd),
  );
}

/**
 * The summary after `--write` or `-i`: what was applied and the re-scan, the effects per agent,
 * what was not applied and why, the fixes that need the user's words, the steps left to the user,
 * and where to review the changes. Warnings of applied fixes frame the summary.
 */
export function formatFixSummary(run: FixRun, options: FixDiffOptions = {}): string {
  const context = contextOf(run, options);
  const { style } = context;
  const applied = run.fixes.filter((fix) => fix.status === 'applied');
  const skipped = run.fixes.filter(
    (fix): fix is Extract<PlannedFix, { status: 'skipped' }> => fix.status === 'skipped',
  );
  const warnings = [
    ...new Set(applied.flatMap((fix) => (fix.fix.warning === undefined ? [] : [fix.fix.warning]))),
  ];
  const lines: string[] = warnings.map((warning) => banner(warning, context));

  if (applied.length === 0) {
    lines.push('No fixes applied.');
  } else {
    lines.push(
      `Applied ${count(applied.length, 'fix', 'fixes')} to ${count(run.files.length, 'file')}. Re-scanned: ${verificationCounts(run.verification)}.`,
    );
    for (const line of tokenLines(tokenTotals(applied), context)) lines.push(`  ${line}`);
    const gates = sortedEffects(applied.flatMap((fix) => fix.effects)).filter(
      (effect) => effect.kind === 'gate',
    );
    for (const effect of gates) lines.push(`  ${effectText(effect, context)}`);
    lines.push(...introducedLines(run.verification, context));
  }

  if (skipped.length > 0) {
    lines.push(`${style.yellow('Not applied:')} ${count(skipped.length, 'fix', 'fixes')}`);
    for (const fix of skipped) {
      lines.push(`  ${fixHeader(fix, context)}: ${SKIP_REASON_TEXT[fix.reason]}`);
    }
  }
  const inputs = run.awaitingInput ?? [];
  for (const entry of inputs) lines.push(inputLine(entry, context));
  lines.push(...inputCount(inputs));
  run.manual.forEach((step, index) => {
    const lead = index === 0 ? 'Left: ' : '      ';
    lines.push(
      `${lead}${cleanPath(step.path, context)}:${step.line} ${clean(step.ruleId, context)} (${clean(step.guidance, context)})`,
    );
  });
  if (applied.length > 0) lines.push('Review the changes with git status and git diff.');
  lines.push(...warnings.map((warning) => banner(warning, context)));
  return finish(lines);
}
