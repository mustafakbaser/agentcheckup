/**
 * GitHub-flavored Markdown for load plans: the same content as the terminal output
 * (context-text.ts), as tables. Every untrusted string goes through `forMarkdown`; the output
 * contains no raw HTML. Tables stop at `maxRows` rows and say how many they left out.
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import type { ContextReport, Size } from '../platforms/load/types.js';
import {
  MATRIX_CELL_LABELS,
  matrixView,
  type Part,
  planViews,
  type PlanView,
  type StartupRow,
} from './context-view.js';
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
  const lines = [
    '### At session start',
    '',
    ...table(
      '| # | File | Bytes | ≈Tokens | Via |',
      '| -: | :--- | ----: | ------: | :-- |',
      [...rows, total],
      view.startup.length + 1,
      'row',
    ),
  ];
  if (view.services.length > 0) {
    const services = cappedRows(
      view.services,
      (row) => `| ${row.group} | ${partsText(row.parts)}${row.unverified ? ' ?' : ''} |`,
      maxRows,
      MAX_TABLE_CHARACTERS,
    );
    lines.push(
      '',
      ...table(
        '| Service | Detail |',
        '| :------ | :----- |',
        services.rows,
        view.services.length,
        'service',
      ),
    );
  }
  return lines;
}

function onDemandSection(view: PlanView, maxRows: number): string[] {
  if (view.onDemand.length === 0) return [];
  const { rows } = cappedRows(
    view.onDemand,
    (row) => {
      const size = row.size === undefined ? '' : `${row.body ? 'body ' : ''}${sizeText(row.size)}`;
      return `| ${path(row.path)} | ${size} | ${text(row.when)}${row.unverified ? ' ?' : ''} |`;
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
    const { rows } = cappedRows(
      view.skipped,
      (row) => {
        const where =
          row.name === undefined ? path(row.path) : `${path(row.path)} › ${text(row.name)}`;
        const rule = row.ruleId === undefined ? '' : ruleLink(row.ruleId, MAX_PATH_LENGTH);
        return `| ${where} | ${text(row.reason)}${row.unverified ? ' ?' : ''} | ${rule} |`;
      },
      maxRows,
      MAX_TABLE_CHARACTERS,
    );
    lines.push(
      '### Skipped',
      '',
      ...table(
        '| File | Reason | Rule |',
        '| :--- | :----- | :--- |',
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

function planBlocks(view: PlanView, maxRows: number): string[][] {
  const where = view.cwd === '' ? './' : path(view.cwd);
  const header = [`## ${view.agentName} context · ${where}`];
  const notes: string[] = [];
  if (view.assumptions.length > 0) {
    notes.push(`**Assumes:** ${view.assumptions.map(text).join(', ')}`);
  }
  if (view.hidden.length > 0) notes.push(`**Not visible:** ${view.hidden.map(text).join('; ')}`);
  return [
    header,
    paragraphs(notes),
    startupSection(view, maxRows),
    onDemandSection(view, maxRows),
    skippedSection(view, maxRows),
    incompleteSection(view, maxRows),
  ].filter((block) => block.length > 0);
}

function matrixBlock(context: ContextReport | undefined, maxRows: number): string[] {
  const view = matrixView(context);
  if (view === undefined) return [];
  const { rows } = cappedRows(
    view.rows,
    (row) =>
      `| ${path(row.path)} | ${row.cells.map((cell) => MATRIX_CELL_LABELS[cell]).join(' | ')} |`,
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  return [
    '## Files by agent',
    '',
    ...table(
      `| File | ${view.agents.join(' | ')} |`,
      `| :--- |${view.agents.map(() => ' :--- |').join('')}`,
      rows,
      view.rows.length,
      'file',
    ),
  ];
}

function maxRowsOf(options: ContextMarkdownOptions): number {
  const requested = options.maxRows ?? DEFAULT_MAX_ROWS;
  return Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
}

function footnotes(views: readonly PlanView[]): string[] {
  const lines = ['_≈Tokens = characters ÷ 4._'];
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
  const block = matrixBlock(context, maxRowsOf(options));
  return block.length === 0 ? '' : `${block.join('\n')}\n`;
}

/** Load plans as Markdown, then the matrix when the report has one. Ends with a newline. */
export function formatContextMarkdown(
  result: ScanResult,
  options: ContextMarkdownOptions = {},
): string {
  const maxRows = maxRowsOf(options);
  const views = planViews(result);
  const blocks = views.flatMap((view) => planBlocks(view, maxRows));
  const matrix = matrixBlock(result.context, maxRows);
  if (matrix.length > 0) blocks.push(matrix);
  if (blocks.length === 0) return 'No load plans in this report.\n';
  blocks.push(footnotes(views));
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
