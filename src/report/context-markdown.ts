/**
 * GitHub-flavored Markdown for load plans: the same content as the terminal output
 * (context-text.ts), as tables. Every untrusted string goes through `forMarkdown`; the output
 * contains no raw HTML. Tables stop at `maxRows` rows and say how many they left out.
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import type { ContextReport, Size } from '../platforms/load/types.js';
import {
  contextView,
  EMPTY_MATRIX_NOTE,
  EMPTY_PLAN_NOTE,
  fixableNote,
  ignoredNote,
  MATRIX_CELL_LABELS,
  MATRIX_LEGEND,
  matrixView,
  type MatrixView,
  notShownNote,
  type Part,
  type PlanView,
  type StartupRow,
} from './context-view.js';
import { skipFixLabel } from './feedback.js';
import { cappedRows, escaped, omittedNote, paragraphs, ruleLink } from './markdown-common.js';
import { plural } from './text.js';

export interface ContextMarkdownOptions {
  /** Rows per table. Default 100. */
  readonly maxRows?: number | undefined;
}

const DEFAULT_MAX_ROWS = 100;
/** Per table; keeps a plan well inside a 1 MiB job summary. */
const MAX_TABLE_CHARACTERS = 50_000;
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;
const MAX_NOT_READ = 5;

function path(value: string): string {
  return escaped(value, MAX_PATH_LENGTH);
}

function text(value: string): string {
  return escaped(value, MAX_TEXT_LENGTH);
}

function sizeText(size: Size): string {
  return `${formatInteger(size.bytes)} bytes ≈ ${formatInteger(size.tokens)}`;
}

function partsText(parts: readonly Part[]): string {
  return parts
    .map((part, index) => {
      const value = `${part.arrow === true ? '→ ' : ''}${text(part.text)}`;
      const separator = index === 0 ? '' : part.attach === true ? ' ' : ' · ';
      return `${separator}${part.warn === true ? `**${value}**` : value}`;
    })
    .join('');
}

function table(
  header: string,
  align: string,
  rows: readonly string[],
  total: number,
  noun: string,
): string[] {
  const note = omittedNote(rows.length, total, noun);
  return [header, align, ...rows, ...(note.length > 0 ? ['', ...note] : [])];
}

function startupFile(row: StartupRow): string {
  if (row.kind === 'skills')
    return `Skills listing (${plural(row.skills ?? 0, 'skill')}, metadata)`;
  // The `@` goes through forMarkdown with the path: `@AGENTS.md` raw would mention a user.
  let file = row.kind === 'import' ? `↳ ${path(`@${row.path}`)}` : path(row.path);
  if (row.realPath !== undefined) file += ` → ${path(row.realPath)}`;
  if (row.truncated !== undefined) {
    file += ` **(cut at byte ${formatInteger(row.truncated.atByte)}, line ${formatInteger(row.truncated.line)})**`;
  }
  return file;
}

function startupSection(view: PlanView, maxRows: number): string[] {
  if (view.startup.length === 0) {
    return ['### At session start', '', 'No files.', ...servicesTable(view, maxRows)];
  }
  const { rows } = cappedRows(
    view.startup,
    (row) => {
      const position = `${row.position ?? ''}${row.unverified ? '?' : ''}`;
      const bytes = row.size === undefined ? '' : formatInteger(row.size.bytes);
      const tokens = row.size === undefined ? '' : formatInteger(row.size.tokens);
      const via = row.via.map(path).join(' › ');
      return `| ${position} | ${startupFile(row)} | ${bytes} | ${tokens} | ${via} |`;
    },
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  const total = `|  | **Total** | **${formatInteger(view.total.bytes)}** | **≈ ${formatInteger(view.total.tokens)}** |  |`;
  return [
    '### At session start',
    '',
    ...table(
      '| # | File | Bytes | ≈Tokens | Via |',
      '| -: | :--- | ----: | ------: | :-- |',
      [...rows, total],
      view.startup.length + 1,
      'row',
    ),
    ...servicesTable(view, maxRows),
  ];
}

/** MCP servers and hooks, after a blank line; nothing when the plan has none. */
function servicesTable(view: PlanView, maxRows: number): string[] {
  if (view.services.length === 0) return [];
  const services = cappedRows(
    view.services,
    (row) => `| ${row.group} | ${partsText(row.parts)}${row.unverified ? ' ?' : ''} |`,
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  return [
    '',
    ...table(
      '| Service | Detail |',
      '| :------ | :----- |',
      services.rows,
      view.services.length,
      'service',
    ),
  ];
}

function onDemandSection(view: PlanView, maxRows: number): string[] {
  if (view.onDemand.length === 0) return [];
  const { rows } = cappedRows(
    view.onDemand,
    (row) => {
      const size = row.size === undefined ? '' : `${row.body ? 'body ' : ''}${sizeText(row.size)}`;
      const importer = row.importedBy === undefined ? '' : `, imported by ${path(row.importedBy)}`;
      const when = `${text(row.when)}${importer}${row.unverified ? ' ?' : ''}`;
      return `| ${path(row.path)} | ${size} | ${when} |`;
    },
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  return [
    '### On demand',
    '',
    ...table(
      '| File | Size | When |',
      '| :--- | ---: | :--- |',
      rows,
      view.onDemand.length,
      'file',
    ),
  ];
}

function skippedSection(view: PlanView, maxRows: number): string[] {
  const lines: string[] = [];
  if (view.skipped.length > 0) {
    // A Fix column only when a skip in this plan can be fixed.
    const withFix = view.skipped.some((row) => row.fix !== undefined);
    const { rows } = cappedRows(
      view.skipped,
      (row) => {
        const where =
          row.name === undefined ? path(row.path) : `${path(row.path)} › ${text(row.name)}`;
        const rule = row.ruleId === undefined ? '' : ruleLink(row.ruleId, MAX_PATH_LENGTH);
        const cells = `| ${where} | ${text(row.reason)}${row.unverified ? ' ?' : ''} | ${rule} |`;
        return withFix ? `${cells} ${row.fix === undefined ? '' : skipFixLabel(row.fix)} |` : cells;
      },
      maxRows,
      MAX_TABLE_CHARACTERS,
    );
    lines.push(
      '### Skipped',
      '',
      ...table(
        withFix ? '| File | Reason | Rule | Fix |' : '| File | Reason | Rule |',
        withFix ? '| :--- | :----- | :--- | :-- |' : '| :--- | :----- | :--- |',
        rows,
        view.skipped.length,
        'skipped file',
      ),
    );
  }
  if (view.notRead.length > 0) {
    const names = view.notRead
      .slice(0, MAX_NOT_READ)
      .map((entry) =>
        entry.name === undefined ? path(entry.path) : `${path(entry.path)} › ${text(entry.name)}`,
      );
    const hidden = view.notRead.length - MAX_NOT_READ;
    const more = hidden > 0 ? `, and ${hidden} more` : '';
    if (lines.length > 0) lines.push('');
    lines.push(`**Not read by ${view.agentName}:** ${names.join(', ')}${more}`);
  }
  return lines;
}

function incompleteSection(view: PlanView, maxRows: number): string[] {
  if (view.incomplete.length === 0) return [];
  const { rows } = cappedRows(
    view.incomplete,
    (row) => `| ${path(row.subject)} | ${text(row.reason)} |`,
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  return [
    '### Incomplete',
    '',
    ...table('| File | Problem |', '| :--- | :------ |', rows, view.incomplete.length, 'entry'),
  ];
}

/** Every hidden location, one list item per scope. */
function hiddenList(view: PlanView): string[] {
  if (view.hidden.length === 0) return [];
  return [
    '**Not visible** (outside the repository, never read):',
    '',
    ...view.hidden.map(
      (scope) => `- ${text(scope.scope)}: ${scope.locations.map(path).join(', ')}`,
    ),
  ];
}

/** How many files the configuration's `ignore` left out: one paragraph. */
function ignoredBlock(view: PlanView): string[] {
  const note = ignoredNote(view);
  return note === undefined ? [] : [`**Ignored by configuration:** ${text(note)}.`];
}

function planBlocks(view: PlanView, maxRows: number): string[][] {
  const where = view.cwd === '' ? './' : path(view.cwd);
  const title = `## ${view.agentName} context · ${where}`;
  if (view.empty) return [[`${title}: ${EMPTY_PLAN_NOTE}`]];
  const notes: string[] = [];
  if (view.assumptions.length > 0) {
    notes.push(`**Assumes:** ${view.assumptions.map(text).join(', ')}`);
  }
  return [
    [title],
    paragraphs(notes),
    hiddenList(view),
    startupSection(view, maxRows),
    onDemandSection(view, maxRows),
    skippedSection(view, maxRows),
    incompleteSection(view, maxRows),
    ignoredBlock(view),
  ].filter((block) => block.length > 0);
}

/**
 * The matrix with full agent names, then a line naming the agents left out because they read
 * none of the files, then the legend. One line for a matrix without rows.
 */
function matrixBlock(view: MatrixView | undefined, maxRows: number): string[] {
  if (view === undefined) return [];
  if (view.rows.length === 0) return [`${EMPTY_MATRIX_NOTE}.`];
  const { rows } = cappedRows(
    view.rows,
    (row) =>
      `| ${path(row.path)} | ${row.cells.map((cell) => MATRIX_CELL_LABELS[cell]).join(' | ')} |`,
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  const used = new Set(view.rows.flatMap((row) => row.cells));
  const legend = MATRIX_LEGEND.filter((item) => used.has(item.cell)).map(
    (item) => `${MATRIX_CELL_LABELS[item.cell]}: ${item.text}`,
  );
  const names = view.columns.map((column) => column.name);
  const note = notShownNote(view);
  return [
    '## Files by agent',
    '',
    ...table(
      `| File | ${names.join(' | ')} |`,
      `| :--- |${names.map(() => ' :--- |').join('')}`,
      rows,
      view.rows.length,
      'file',
    ),
    ...(note === undefined ? [] : ['', `${note}.`]),
    ...(legend.length > 0 ? ['', legend.join(' · ')] : []),
  ];
}

function maxRowsOf(options: ContextMarkdownOptions): number {
  const requested = options.maxRows ?? DEFAULT_MAX_ROWS;
  return Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
}

function footnotes(views: readonly PlanView[]): string[] {
  const fixable = fixableNote(views);
  const lines = fixable === undefined ? [] : [`${fixable}: \`agentcheckup fix\``];
  lines.push('_≈Tokens = characters ÷ 4._');
  if (views.some((view) => view.unverified)) {
    lines.push('_? = unverified: neither documentation nor source code confirms it._');
  }
  return paragraphs(lines);
}

/**
 * The file-by-agent matrix as a Markdown table, "—" where the agent does not read the file.
 * Empty string when the report has no matrix.
 */
export function formatMatrixMarkdown(
  context: ContextReport | undefined,
  options: ContextMarkdownOptions = {},
): string {
  const block = matrixBlock(matrixView(context), maxRowsOf(options));
  return block.length === 0 ? '' : `${block.join('\n')}\n`;
}

/**
 * Load plans as Markdown, then the matrix when the report has one. Paths are relative to the
 * scanned directory, which the first line names when the report was rebased. Ends with a
 * newline.
 */
export function formatContextMarkdown(
  result: ScanResult,
  options: ContextMarkdownOptions = {},
): string {
  const maxRows = maxRowsOf(options);
  const view = contextView(result);
  const blocks = view.plans.flatMap((plan) => planBlocks(plan, maxRows));
  const matrix = matrixBlock(view.matrix, maxRows);
  if (matrix.length > 0) blocks.push(matrix);
  if (blocks.length === 0) return 'No load plans in this report.\n';
  if (view.pathBase !== '') blocks.unshift([`Paths are relative to ${path(view.pathBase)}`]);
  blocks.push(footnotes(view.plans));
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
