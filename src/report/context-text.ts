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
  MATRIX_CELL_LABELS,
  matrixView,
  type Part,
  planViews,
  type PlanView,
  type StartupRow,
} from './context-view.js';
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
/** Cells wider than this do not push the next column of the other rows to the right. */
const MAX_ALIGNED_WIDTH = 60;
/** Not-read files listed per plan before `… and N more`. */
const MAX_NOT_READ = 5;
const GAP = '  ';
const MATRIX_GAP = '   ';

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
    lines.push(
      `  ${row.position.padStart(positionWidth)}${GAP}${label}${padding(row.label, labelWidth)}` +
        numbers(row.bytes, row.tokens),
    );
  }
  lines.push(
    style.bold(
      `${' '.repeat(lead)}${'Total'.padStart(labelWidth)}${numbers(totalBytes, totalTokens)}`,
    ),
  );

  const groups = view.services.map((row) => `${row.group}:`);
  const groupWidth = columnWidth(groups);
  view.services.forEach((row, index) => {
    const group = groups[index] ?? '';
    const label = index > 0 && groups[index - 1] === group ? '' : group;
    const unverified = row.unverified ? ' ?' : '';
    lines.push(
      `  ${label}${padding(label, groupWidth)}${GAP}${partsText(row.parts, context)}${unverified}`,
    );
  });
  return lines;
}

function renderOnDemand(view: PlanView, context: Context): string[] {
  if (view.onDemand.length === 0) return [];
  const rows = view.onDemand.map((row) => {
    const size =
      row.size === undefined
        ? undefined
        : `${row.body ? 'body ' : ''}${sizeText(row.size, context)}`;
    const when = `${clean(row.when, context)}${row.unverified ? ' ?' : ''}`;
    return {
      path: cleanPath(row.path, context),
      detail: size === undefined ? when : `${size}, ${when}`,
    };
  });
  const pathWidth = columnWidth(rows.map((row) => row.path));
  return [
    context.style.bold('On demand'),
    ...rows.map((row) => `  ${row.path}${padding(row.path, pathWidth)}${GAP}${row.detail}`),
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
    }));
    const whereWidth = columnWidth(rows.map((row) => row.where));
    const reasonWidth = columnWidth(rows.map((row) => row.reason));
    lines.push(style.bold('Skipped'));
    for (const row of rows) {
      const rule =
        row.rule === '' ? '' : `${padding(row.reason, reasonWidth)}${GAP}${style.gray(row.rule)}`;
      lines.push(`  ${row.where}${padding(row.where, whereWidth)}${GAP}${row.reason}${rule}`);
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
    ...rows.map((row) => `  ${row.subject}${padding(row.subject, width)}${GAP}${row.reason}`),
  ];
}

function renderPlan(view: PlanView, context: Context): string[][] {
  const { style, symbols } = context;
  const where = view.cwd === '' ? './' : cleanPath(view.cwd, context);
  const header = [style.bold(`${view.agentName} context ${symbols.dot} ${where}`)];
  if (view.assumptions.length > 0) {
    header.push(
      style.dim(`Assumes ${view.assumptions.map((text) => clean(text, context)).join(', ')}`),
    );
  }
  if (view.hidden.length > 0) {
    header.push(
      style.dim(`Not visible: ${view.hidden.map((text) => clean(text, context)).join('; ')}`),
    );
  }
  return [
    header,
    renderStartup(view, context),
    renderOnDemand(view, context),
    renderSkipped(view, context),
    renderNotRead(view, context),
    renderIncomplete(view, context),
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

function renderMatrix(context: ContextReport | undefined, options: Context): string[] {
  const view = matrixView(context);
  if (view === undefined) return [];
  const { style, symbols } = options;
  const label = (cell: MatrixCell): string =>
    cell === 'not-read' ? symbols.notRead : MATRIX_CELL_LABELS[cell];
  const paths = view.rows.map((row) => cleanPath(row.path, options));
  const pathWidth = columnWidth(paths);
  const widths = view.agents.map((agent, index) =>
    Math.max(
      displayWidth(agent),
      ...view.rows.map((row) => {
        const cell = row.cells[index];
        return cell === undefined ? 0 : displayWidth(label(cell));
      }),
    ),
  );
  /** Painted cells, padded by the width of their plain text; the last column is not padded. */
  const columns = (painted: readonly string[], plain: readonly string[]): string =>
    painted
      .map((cell, index) =>
        index === painted.length - 1
          ? cell
          : `${cell}${padding(plain[index] ?? '', widths[index] ?? 0)}`,
      )
      .join(MATRIX_GAP);

  const lines = [
    `${' '.repeat(pathWidth)}${MATRIX_GAP}${columns(view.agents.map(style.bold), view.agents)}`,
  ];
  view.rows.forEach((row, index) => {
    const path = paths[index] ?? '';
    const plain = row.cells.map(label);
    const painted = row.cells.map((cell) => paintCell(cell, label(cell), style));
    lines.push(`${path}${padding(path, pathWidth)}${MATRIX_GAP}${columns(painted, plain)}`);
  });
  return lines;
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
  const lines = [style.dim(`${symbols.approx}tokens = characters ${symbols.divide} 4`)];
  if (views.some((view) => view.unverified)) {
    lines.push(style.dim('? = unverified: neither documentation nor source code confirms it'));
  }
  return lines;
}

/**
 * The file-by-agent matrix (`--matrix`): one row per file, one column per agent, "—" where the
 * agent does not read the file. Empty string when the report has no matrix.
 */
export function formatMatrixText(
  context: ContextReport | undefined,
  options: ContextTextOptions = {},
): string {
  const lines = renderMatrix(context, contextOf(options));
  return lines.length === 0 ? '' : finish([lines]);
}

/**
 * Load plans as terminal text, then the matrix when the report has one. Returns text ending
 * with a newline.
 */
export function formatContextText(result: ScanResult, options: ContextTextOptions = {}): string {
  const context = contextOf(options);
  const views = planViews(result);
  const blocks = views.flatMap((view) => renderPlan(view, context));
  const matrix = renderMatrix(result.context, context);
  if (matrix.length > 0) blocks.push(matrix);
  if (blocks.length === 0) return finish([['No load plans in this report.']]);
  blocks.push(footnotes(views, context));
  return finish(blocks);
}
