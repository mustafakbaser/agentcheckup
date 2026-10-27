/**
 * Terminal output for load plans (`agentcheckup context`): per plan, what the agent reads at
 * session start with sizes, its MCP servers and hooks, what loads on demand, what it skips and
 * why, and what could not be analyzed. Then the file-by-agent matrix when the report has one.
 *
 * Pure, like the other formatters: the CLI decides about color and passes a {@link Style}.
 * Every string from the scanned repository goes through `forTerminal`, and the whole output
 * through `guardWorkflowCommands`, because paths start some lines.
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import type { ContextReport, MatrixCell, Size } from '../platforms/load/types.js';
import {
  contextView,
  EMPTY_MATRIX_NOTE,
  EMPTY_PLAN_NOTE,
  fixableNote,
  ignoredNote,
  MATRIX_CELL_LABELS,
  MATRIX_CELL_LETTERS,
  MATRIX_LEGEND,
  type MatrixColumn,
  matrixView,
  type MatrixView,
  notShownNote,
  type Part,
  type PlanView,
  type StartupRow,
} from './context-view.js';
import { INPUT_FIX_LABEL } from './feedback.js';
import { forTerminal, guardWorkflowCommands } from './sanitize.js';
import { plainStyle, type Style } from './stylish.js';
import { displayWidth, plural, truncate } from './text.js';

export interface ContextTextOptions {
  /** Color functions. Default {@link plainStyle}. */
  readonly style?: Style | undefined;
  /** ASCII-only decorations (`~` for `≈`, `->` for `→`, `-` for `—`). */
  readonly ascii?: boolean | undefined;
}

interface Symbols {
  readonly approx: string;
  readonly dot: string;
  readonly tree: string;
  readonly arrow: string;
  readonly into: string;
  readonly divide: string;
  readonly notRead: string;
  readonly more: string;
}

const UNICODE_SYMBOLS: Symbols = {
  approx: '≈',
  dot: '·',
  tree: '└',
  arrow: '→',
  into: '›',
  divide: '÷',
  notRead: '—',
  more: '…',
};

const ASCII_SYMBOLS: Symbols = {
  approx: '~',
  dot: '-',
  tree: '`-',
  arrow: '->',
  into: '>',
  divide: '/',
  notRead: '-',
  more: '...',
};

/** Untrusted paths and text longer than this (code points) are cut. */
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;
/**
 * Cells wider than this do not push the next column of the other rows to the right: the rest
 * of their row goes on the next line, under that column.
 */
const MAX_ALIGNED_WIDTH = 60;
/** The assumption and hidden-scope lines wrap at this width. */
const LINE_WIDTH = 100;
/** Not-read files listed per plan before `… and N more`. */
const MAX_NOT_READ = 5;
const GAP = '  ';
const MATRIX_GAP = '   ';
/**
 * A matrix with more columns than this shows one letter per cell under a two-row header of short,
 * grouped agent labels, with a key underneath: nine agents with full labels need about 175
 * characters. Decided by the column count alone, so the output does not depend on the terminal.
 */
const MAX_FULL_LABEL_COLUMNS = 4;
/** The compact matrix fits this width when its paths do: its path column shrinks to fit. */
const COMPACT_MATRIX_WIDTH = 80;
/** The compact matrix's path column is never wider than this. */
const MAX_COMPACT_PATH_WIDTH = 40;
/** Between the path column and the cells of the compact matrix. */
const COMPACT_PATH_GAP = '  ';
/** Between the cells of the compact matrix. */
const COMPACT_GAP = ' ';

interface Context {
  readonly style: Style;
  readonly symbols: Symbols;
  readonly ascii: boolean;
}

/** Sanitized single-line text. TAB becomes a space so columns stay aligned. */
function clean(text: string, context: Context, max = MAX_TEXT_LENGTH): string {
  return forTerminal(truncate(text, max, context.symbols.more), {
    ascii: context.ascii,
  }).replaceAll('\t', ' ');
}

function cleanPath(path: string, context: Context): string {
  return clean(path, context, MAX_PATH_LENGTH);
}

/** Width that aligns a column: the widest cell up to MAX_ALIGNED_WIDTH, at least `minimum`. */
function columnWidth(cells: readonly string[], minimum = 0): number {
  return Math.max(
    minimum,
    ...cells.map(displayWidth).filter((width) => width <= MAX_ALIGNED_WIDTH),
  );
}

function padding(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * An indented row: `left` padded to `width`, then `right`. When `left` is wider, `right` goes
 * on the next line, under its column.
 */
function columns(left: string, width: number, right: string): string[] {
  if (displayWidth(left) <= width) return [`  ${left}${padding(left, width)}${GAP}${right}`];
  return [`  ${left}`, `  ${' '.repeat(width)}${GAP}${right}`];
}

/**
 * `lead` and sanitized `items` separated by commas, wrapped before an item that would pass
 * LINE_WIDTH. Continuation lines are indented by two spaces.
 */
function wrapItems(lead: string, items: readonly string[]): string[] {
  const lines: string[] = [];
  let line = lead;
  let empty = true;
  items.forEach((item, index) => {
    const piece = index < items.length - 1 ? `${item},` : item;
    const next = empty ? `${line}${piece}` : `${line} ${piece}`;
    if (!empty && displayWidth(next) > LINE_WIDTH) {
      lines.push(line);
      line = `  ${piece}`;
    } else {
      line = next;
    }
    empty = false;
  });
  lines.push(line);
  return lines;
}

function sizeText(size: Size, context: Context): string {
  return `${formatInteger(size.bytes)} bytes ${context.symbols.approx} ${formatInteger(size.tokens)}`;
}

function partsText(parts: readonly Part[], context: Context): string {
  return parts
    .map((part, index) => {
      const text = clean(part.text, context);
      const shown = part.arrow === true ? `${context.symbols.arrow} ${text}` : text;
      const separator = index === 0 ? '' : part.attach === true ? ' ' : GAP;
      return `${separator}${part.warn === true ? context.style.yellow(shown) : shown}`;
    })
    .join('');
}

function startupLabel(row: StartupRow, context: Context): string {
  const { symbols } = context;
  if (row.kind === 'skills') {
    return `Skills listing (${plural(row.skills ?? 0, 'skill')}, metadata)`;
  }
  if (row.kind === 'subagents') {
    return `Subagents listing (${plural(row.subagents ?? 0, 'subagent')}, names and descriptions)`;
  }
  let label =
    row.kind === 'import'
      ? `${'  '.repeat(row.depth)}${symbols.tree} @${cleanPath(row.path, context)}`
      : cleanPath(row.path, context);
  if (row.realPath !== undefined) label += ` ${symbols.arrow} ${cleanPath(row.realPath, context)}`;
  if (row.truncated !== undefined) {
    label += ` (cut at byte ${formatInteger(row.truncated.atByte)}, line ${formatInteger(row.truncated.line)})`;
  }
  return label;
}

function renderStartup(view: PlanView, context: Context): string[] {
  const { style, symbols } = context;
  const title = 'At session start';
  if (view.startup.length === 0) {
    return [`${style.bold(title)}: no files`, ...renderServices(view, context)];
  }
  const tokensTitle = `${symbols.approx}tokens`;
  const rows = view.startup.map((row) => ({
    position: `${row.position ?? ''}${row.unverified ? '?' : ''}`,
    label: startupLabel(row, context),
    truncated: row.truncated !== undefined,
    bytes: row.size === undefined ? '' : formatInteger(row.size.bytes),
    tokens: row.size === undefined ? '' : formatInteger(row.size.tokens),
  }));
  const totalBytes = formatInteger(view.total.bytes);
  const totalTokens = `${symbols.approx} ${formatInteger(view.total.tokens)}`;

  const positionWidth = Math.max(1, ...rows.map((row) => row.position.length));
  const lead = 2 + positionWidth + GAP.length;
  const labelWidth = Math.max(
    columnWidth(
      rows.map((row) => row.label),
      'Total'.length,
    ),
    title.length - lead,
  );
  const bytesWidth = Math.max(
    'bytes'.length,
    totalBytes.length,
    ...rows.map((r) => r.bytes.length),
  );
  const tokensWidth = Math.max(
    tokensTitle.length,
    totalTokens.length,
    ...rows.map((row) => row.tokens.length),
  );
  const numbers = (bytes: string, tokens: string): string =>
    `${GAP}${bytes.padStart(bytesWidth)}${GAP}${tokens.padStart(tokensWidth)}`;

  const lines = [
    `${style.bold(title)}${' '.repeat(lead + labelWidth - title.length)}` +
      style.dim(numbers('bytes', tokensTitle)),
  ];
  for (const row of rows) {
    const label = row.truncated ? style.yellow(row.label) : row.label;
    const position = `  ${row.position.padStart(positionWidth)}${GAP}`;
    const sizes = numbers(row.bytes, row.tokens);
    if (displayWidth(row.label) <= labelWidth) {
      lines.push(`${position}${label}${padding(row.label, labelWidth)}${sizes}`);
    } else {
      // Too wide for the column: the numbers go on the next line, under their headings.
      lines.push(`${position}${label}`, `${' '.repeat(lead + labelWidth)}${sizes}`);
    }
  }
  lines.push(
    style.bold(
      `${' '.repeat(lead)}${'Total'.padStart(labelWidth)}${numbers(totalBytes, totalTokens)}`,
    ),
  );
  return [...lines, ...renderServices(view, context)];
}

/** MCP servers and hooks, grouped by how they start, under the startup table. */
function renderServices(view: PlanView, context: Context): string[] {
  const groups = view.services.map((row) => `${row.group}:`);
  const groupWidth = columnWidth(groups);
  return view.services.map((row, index) => {
    const group = groups[index] ?? '';
    const label = index > 0 && groups[index - 1] === group ? '' : group;
    const unverified = row.unverified ? ' ?' : '';
    return `  ${label}${padding(label, groupWidth)}${GAP}${partsText(row.parts, context)}${unverified}`;
  });
}

function renderOnDemand(view: PlanView, context: Context): string[] {
  if (view.onDemand.length === 0) return [];
  const rows = view.onDemand.map((row) => {
    const size =
      row.size === undefined
        ? undefined
        : `${row.body ? 'body ' : ''}${sizeText(row.size, context)}`;
    const importer =
      row.importedBy === undefined ? '' : `, imported by ${cleanPath(row.importedBy, context)}`;
    const when = `${clean(row.when, context)}${importer}${row.unverified ? ' ?' : ''}`;
    return {
      path: cleanPath(row.path, context),
      detail: size === undefined ? when : `${size}, ${when}`,
    };
  });
  const pathWidth = columnWidth(rows.map((row) => row.path));
  return [
    context.style.bold('On demand'),
    ...rows.flatMap((row) => columns(row.path, pathWidth, row.detail)),
  ];
}

function renderSkipped(view: PlanView, context: Context): string[] {
  const { style, symbols } = context;
  const lines: string[] = [];
  if (view.skipped.length > 0) {
    const rows = view.skipped.map((row) => ({
      where:
        row.name === undefined
          ? cleanPath(row.path, context)
          : `${cleanPath(row.path, context)} ${symbols.into} ${clean(row.name, context)}`,
      reason: `${clean(row.reason, context)}${row.unverified ? ' ?' : ''}`,
      rule: row.ruleId === undefined ? '' : clean(row.ruleId, context),
      fix: row.fix,
    }));
    const whereWidth = columnWidth(rows.map((row) => row.where));
    const reasonWidth = columnWidth(rows.map((row) => row.reason));
    const ruleWidth = columnWidth(rows.map((row) => row.rule));
    lines.push(style.bold('Skipped'));
    for (const row of rows) {
      // Each column is padded only when something follows it, so no row ends in blanks.
      let detail = row.reason;
      if (row.rule !== '' || row.fix !== undefined) {
        detail += `${padding(row.reason, reasonWidth)}${GAP}${style.gray(row.rule)}`;
      }
      if (row.fix !== undefined) {
        const tag =
          row.fix === 'input'
            ? style.blue(INPUT_FIX_LABEL)
            : (row.fix === 'safe' ? style.green : style.yellow)(`fix: ${row.fix}`);
        detail += `${padding(row.rule, ruleWidth)}${GAP}${tag}`;
      }
      lines.push(...columns(row.where, whereWidth, detail));
    }
  }
  return lines;
}

/** Files the agent does not read at all: one line, not a problem. */
function renderNotRead(view: PlanView, context: Context): string[] {
  if (view.notRead.length === 0) return [];
  const { symbols } = context;
  const names = view.notRead.map((entry) =>
    entry.name === undefined
      ? cleanPath(entry.path, context)
      : `${cleanPath(entry.path, context)} ${symbols.into} ${clean(entry.name, context)}`,
  );
  const hidden = names.length - MAX_NOT_READ;
  const shown = names.slice(0, MAX_NOT_READ).join(', ');
  const more = hidden > 0 ? `, ${symbols.more} and ${hidden} more` : '';
  return [context.style.dim(`Not read by ${view.agentName}: ${shown}${more}`)];
}

function renderIncomplete(view: PlanView, context: Context): string[] {
  if (view.incomplete.length === 0) return [];
  const rows = view.incomplete.map((row) => ({
    subject: cleanPath(row.subject, context),
    reason: clean(row.reason, context),
  }));
  const width = columnWidth(rows.map((row) => row.subject));
  return [
    context.style.bold(context.style.yellow('Incomplete')),
    ...rows.flatMap((row) => columns(row.subject, width, row.reason)),
  ];
}

/** How many files the configuration's `ignore` left out: one line, like "Not read by". */
function renderIgnored(view: PlanView, context: Context): string[] {
  const note = ignoredNote(view);
  if (note === undefined) return [];
  return [context.style.dim(`Ignored by configuration: ${note}`)];
}

function renderPlan(view: PlanView, context: Context): string[][] {
  const { style, symbols } = context;
  const where = view.cwd === '' ? './' : cleanPath(view.cwd, context);
  const title = style.bold(`${view.agentName} context ${symbols.dot} ${where}`);
  if (view.empty) return [[`${title}: ${EMPTY_PLAN_NOTE}`]];
  const header = [title];
  if (view.assumptions.length > 0) {
    const items = view.assumptions.map((text) => clean(text, context));
    header.push(...wrapItems('Assumes ', items).map((line) => style.dim(line)));
  }
  // Scopes in a few words; the JSON and Markdown output list every location.
  const hidden = view.hidden.flatMap((scope) => scope.summary.map((text) => clean(text, context)));
  if (hidden.length > 0) {
    header.push(...wrapItems('Not visible: ', hidden).map((line) => style.dim(line)));
  }
  return [
    header,
    renderStartup(view, context),
    renderOnDemand(view, context),
    renderSkipped(view, context),
    renderNotRead(view, context),
    renderIncomplete(view, context),
    renderIgnored(view, context),
  ].filter((block) => block.length > 0);
}

function paintCell(cell: MatrixCell, text: string, style: Style): string {
  switch (cell) {
    case 'startup':
      return style.green(text);
    case 'partial':
    case 'skipped':
      return style.yellow(text);
    case 'unknown':
    case 'not-read':
      return style.dim(text);
    case 'on-path':
    case 'start-dir':
    case 'listed':
    case 'model-selected':
    case 'manual':
      return text;
  }
}

/**
 * The matrix, then a key to the states it shows; no blocks without a matrix, and one line for a
 * matrix without rows. Columns of agents that read none of the files are left out, and a line
 * under the rows names those agents.
 */
function renderMatrix(view: MatrixView | undefined, context: Context): string[][] {
  if (view === undefined) return [];
  if (view.rows.length === 0) return [[EMPTY_MATRIX_NOTE]];
  const compact = view.columns.length > MAX_FULL_LABEL_COLUMNS;
  const lines = compact ? compactMatrix(view, context) : fullMatrix(view, context);
  const note = notShownNote(view);
  if (note !== undefined) lines.push(context.style.dim(note));
  const used = new Set(view.rows.flatMap((row) => row.cells));
  const key = matrixKey(used, compact, context);
  return key.length === 0 ? [lines] : [lines, key];
}

/** A cell's text from `labels`, with the formatter's own dash for `not-read`. */
function cellText(
  cell: MatrixCell,
  labels: Readonly<Record<MatrixCell, string>>,
  context: Context,
): string {
  return cell === 'not-read' ? context.symbols.notRead : labels[cell];
}

/** Cells padded to `widths` by the width of their plain text, joined by `gap`; the last is not padded. */
function joinCells(
  widths: readonly number[],
  gap: string,
): (painted: readonly string[], plain: readonly string[]) => string {
  return (painted, plain) =>
    painted
      .map((cell, index) =>
        index === painted.length - 1
          ? cell
          : `${cell}${padding(plain[index] ?? '', widths[index] ?? 0)}`,
      )
      .join(gap);
}

/** The path, then the cells; a path wider than its column gets a line of its own. */
function matrixRows(
  view: MatrixView,
  context: Context,
  layout: {
    readonly pathWidth: number;
    readonly gap: string;
    readonly widths: readonly number[];
    readonly cellGap: string;
    readonly labels: Readonly<Record<MatrixCell, string>>;
  },
): string[] {
  const { pathWidth, gap, labels } = layout;
  const cells = joinCells(layout.widths, layout.cellGap);
  const lines: string[] = [];
  for (const row of view.rows) {
    const path = cleanPath(row.path, context);
    const plain = row.cells.map((cell) => cellText(cell, labels, context));
    const painted = row.cells.map((cell, index) =>
      paintCell(cell, plain[index] ?? '', context.style),
    );
    const states = cells(painted, plain);
    if (displayWidth(path) <= pathWidth) {
      lines.push(`${path}${padding(path, pathWidth)}${gap}${states}`);
    } else {
      lines.push(path, `${' '.repeat(pathWidth)}${gap}${states}`);
    }
  }
  return lines;
}

const MATRIX_TITLE = 'Files by agent';

/** Full agent names over full state labels, for a few columns. */
function fullMatrix(view: MatrixView, context: Context): string[] {
  const { style } = context;
  const names = view.columns.map((column) => column.name);
  const pathWidth = columnWidth(
    view.rows.map((row) => cleanPath(row.path, context)),
    MATRIX_TITLE.length,
  );
  const widths = names.map((name, index) =>
    Math.max(
      displayWidth(name),
      ...view.rows.map((row) => {
        const cell = row.cells[index];
        return cell === undefined ? 0 : displayWidth(cellText(cell, MATRIX_CELL_LABELS, context));
      }),
    ),
  );
  const header =
    `${style.bold(MATRIX_TITLE)}${padding(MATRIX_TITLE, pathWidth)}${MATRIX_GAP}` +
    joinCells(widths, MATRIX_GAP)(names.map(style.bold), names);
  return [
    header,
    ...matrixRows(view, context, {
      pathWidth,
      gap: MATRIX_GAP,
      widths,
      cellGap: MATRIX_GAP,
      labels: MATRIX_CELL_LABELS,
    }),
  ];
}

/** Consecutive columns of one group, such as the Copilot surfaces, with their widths. */
interface ColumnGroup {
  readonly label: string;
  readonly columns: MatrixColumn[];
  readonly widths: number[];
}

function spanOf(widths: readonly number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * COMPACT_GAP.length;
}

/**
 * The columns grouped under their group labels. A column is as wide as its surface label, or as
 * its group label when it is the only column of its group; a group label wider than its columns
 * widens the last of them.
 */
function columnGroups(columns: readonly MatrixColumn[]): ColumnGroup[] {
  const groups: ColumnGroup[] = [];
  for (const column of columns) {
    const last = groups.at(-1);
    if (last?.label === column.group) last.columns.push(column);
    else groups.push({ label: column.group, columns: [column], widths: [] });
  }
  for (const group of groups) {
    for (const column of group.columns) {
      const own = column.surface ?? (group.columns.length === 1 ? group.label : '');
      group.widths.push(Math.max(1, displayWidth(own)));
    }
    const extra = displayWidth(group.label) - spanOf(group.widths);
    const last = group.widths.length - 1;
    if (extra > 0) group.widths[last] = (group.widths[last] ?? 1) + extra;
  }
  return groups;
}

/**
 * One letter per cell under short agent labels: the group on the first header row and the
 * surface (Copilot's CLI, VSC and Cloud) on the second. The path column shrinks so that all nine
 * agents fit in 80 characters; a longer path gets a line of its own.
 */
function compactMatrix(view: MatrixView, context: Context): string[] {
  const { style } = context;
  const groups = columnGroups(view.columns);
  const widths = groups.flatMap((group) => group.widths);
  const paths = view.rows.map((row) => cleanPath(row.path, context));
  const pathWidth = Math.max(
    MATRIX_TITLE.length,
    Math.min(
      MAX_COMPACT_PATH_WIDTH,
      COMPACT_MATRIX_WIDTH - COMPACT_PATH_GAP.length - spanOf(widths),
      Math.max(0, ...paths.map(displayWidth)),
    ),
  );
  const first = groups.map(
    (group) => `${style.bold(group.label)}${padding(group.label, spanOf(group.widths))}`,
  );
  const second = groups.flatMap((group) =>
    group.columns.map((column, index) => {
      const surface = column.surface ?? '';
      return `${style.bold(surface)}${padding(surface, group.widths[index] ?? 0)}`;
    }),
  );
  const lines = [
    `${style.bold(MATRIX_TITLE)}${padding(MATRIX_TITLE, pathWidth)}${COMPACT_PATH_GAP}` +
      first.join(COMPACT_GAP),
  ];
  if (view.columns.some((column) => column.surface !== undefined)) {
    lines.push(`${' '.repeat(pathWidth)}${COMPACT_PATH_GAP}${second.join(COMPACT_GAP)}`);
  }
  lines.push(
    ...matrixRows(view, context, {
      pathWidth,
      gap: COMPACT_PATH_GAP,
      widths,
      cellGap: COMPACT_GAP,
      labels: MATRIX_CELL_LETTERS,
    }),
  );
  return lines;
}

/**
 * What the states in the matrix mean, in legend order: `startup  loaded at session start`, or
 * with the compact matrix `S  startup  loaded at session start`.
 */
function matrixKey(used: ReadonlySet<MatrixCell>, compact: boolean, context: Context): string[] {
  const { style } = context;
  const legend = MATRIX_LEGEND.filter((item) => used.has(item.cell));
  if (compact) {
    const nameWidth = Math.max(0, ...legend.map((item) => item.cell.length));
    return legend.map((item) => {
      const letter = cellText(item.cell, MATRIX_CELL_LETTERS, context);
      return style.dim(`${letter}${GAP}${item.cell.padEnd(nameWidth)}${GAP}${item.text}`);
    });
  }
  const label = (cell: MatrixCell): string => cellText(cell, MATRIX_CELL_LABELS, context);
  const keyWidth = Math.max(0, ...legend.map((item) => displayWidth(label(item.cell))));
  return legend.map((item) =>
    style.dim(`${label(item.cell)}${padding(label(item.cell), keyWidth)}${GAP}${item.text}`),
  );
}

function contextOf(options: ContextTextOptions): Context {
  const ascii = options.ascii === true;
  return {
    style: options.style ?? plainStyle,
    symbols: ascii ? ASCII_SYMBOLS : UNICODE_SYMBOLS,
    ascii,
  };
}

/** Lines joined, trailing blanks removed, workflow-command lines defused, final newline. */
function finish(blocks: readonly (readonly string[])[]): string {
  const text = blocks.map((block) => block.map((line) => line.trimEnd()).join('\n')).join('\n\n');
  return guardWorkflowCommands(`${text}\n`);
}

function footnotes(views: readonly PlanView[], context: Context): string[] {
  const { style, symbols } = context;
  const fixable = fixableNote(views);
  const lines = fixable === undefined ? [] : [`${fixable}: agentcheckup fix`];
  lines.push(style.dim(`${symbols.approx}tokens = characters ${symbols.divide} 4`));
  if (views.some((view) => view.unverified)) {
    lines.push(style.dim('? = unverified: neither documentation nor source code confirms it'));
  }
  return lines;
}

/**
 * The file-by-agent matrix (`--matrix`): one row per file, one column per agent that reads any
 * of them, "—" where the agent does not read the file. Up to four columns show full names and
 * states; more show one letter per state under a grouped header, with a key. Empty string when
 * the report has no matrix.
 */
export function formatMatrixText(
  context: ContextReport | undefined,
  options: ContextTextOptions = {},
): string {
  const blocks = renderMatrix(matrixView(context), contextOf(options));
  return blocks.length === 0 ? '' : finish(blocks);
}

/** Each plan's blocks; the one-line blocks of consecutive empty plans become one block. */
function planBlocks(views: readonly PlanView[], context: Context): string[][] {
  const blocks: string[][] = [];
  let previousEmpty = false;
  for (const view of views) {
    const rendered = renderPlan(view, context);
    const last = blocks.at(-1);
    if (view.empty && previousEmpty && last !== undefined) last.push(...rendered.flat());
    else blocks.push(...rendered);
    previousEmpty = view.empty;
  }
  return blocks;
}

/**
 * Load plans as terminal text, then the matrix when the report has one. Paths are relative to
 * the scanned directory, which the first line names when the report was rebased. Returns text
 * ending with a newline.
 */
export function formatContextText(result: ScanResult, options: ContextTextOptions = {}): string {
  const context = contextOf(options);
  const view = contextView(result);
  const blocks = planBlocks(view.plans, context);
  blocks.push(...renderMatrix(view.matrix, context));
  if (blocks.length === 0) return finish([['No load plans in this report.']]);
  if (view.pathBase !== '') {
    blocks.unshift([
      context.style.dim(`Paths are relative to ${cleanPath(view.pathBase, context)}`),
    ]);
  }
  blocks.push(footnotes(view.plans, context));
  return finish(blocks);
}
