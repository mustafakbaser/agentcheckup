/**
 * GitHub-flavored Markdown for `agentcheckup agents`: the same content as the terminal output
 * (agents-text.ts), as tables. Every untrusted string goes through `forMarkdown`; the output
 * contains no raw HTML. Tables stop at `maxRows` rows and say how many they left out.
 */
import type { ScanResult } from '../core/engine.js';
import {
  agentsView,
  type DefinitionRow,
  type FileGroup,
  NO_DEFINITIONS,
  NOT_VISIBLE_NOTE,
  summaryText,
} from './agents-view.js';
import { cappedRows, escaped, omittedNote, paragraphs } from './markdown-common.js';

export interface AgentsMarkdownOptions {
  /** Rows per table. Default 100. */
  readonly maxRows?: number | undefined;
}

const DEFAULT_MAX_ROWS = 100;
/** Per table; keeps the output well inside a 1 MiB job summary. */
const MAX_TABLE_CHARACTERS = 50_000;
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;

/** Untrusted text for a table cell; a TAB becomes a space, as in the terminal output. */
function path(value: string): string {
  return escaped(value.replaceAll('\t', ' '), MAX_PATH_LENGTH);
}

function text(value: string): string {
  return escaped(value.replaceAll('\t', ' '), MAX_TEXT_LENGTH);
}

function modelCell(row: DefinitionRow): string {
  if (row.model === '') return '';
  const model = text(row.model);
  const runs = row.runsOn === '' ? model : `${model} → ${text(row.runsOn)}`;
  const effort = row.effort === '' ? '' : `, effort ${text(row.effort)}`;
  return row.warn ? `**${runs}${effort}**` : `${runs}${effort}`;
}

function statusCell(row: DefinitionRow): string {
  const status = row.status === '' ? 'loads' : text(row.status);
  return `${row.warn && row.status !== '' ? `**${status}**` : status}${row.unverified ? ' ?' : ''}`;
}

function definitionTable(files: readonly FileGroup[], maxRows: number): string[] {
  const items = files.flatMap((group) => group.rows.map((row) => ({ file: group.file, row })));
  const { rows } = cappedRows(
    items,
    ({ file, row }) =>
      `| ${path(file)} | ${text(row.agent)} | ${text(row.name)} | ${modelCell(row)} | ${statusCell(row)} |`,
    maxRows,
    MAX_TABLE_CHARACTERS,
  );
  return [
    '| File | Agent | Name | Model | Status |',
    '| :--- | :---- | :--- | :---- | :----- |',
    ...rows,
    ...(rows.length < items.length
      ? ['', ...omittedNote(rows.length, items.length, 'definition')]
      : []),
  ];
}

/**
 * The agent definitions and model settings of a result as Markdown. Paths are relative to the
 * scanned directory, which the first line names when the report was rebased. Ends with a newline.
 */
export function formatAgentsMarkdown(
  result: ScanResult,
  options: AgentsMarkdownOptions = {},
): string {
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
  const view = agentsView(result);
  if (view.counts.definitions === 0 && view.settings.length === 0) return `${NO_DEFINITIONS}\n`;
  const blocks: string[][] = [];
  if (view.pathBase !== '') blocks.push([`Paths are relative to ${path(view.pathBase)}`]);
  blocks.push(['## Agent definitions', '', `${summaryText(view)}.`]);
  if (view.files.length > 0) blocks.push(definitionTable(view.files, maxRows));
  if (view.settings.length > 0) {
    const { rows } = cappedRows(
      view.settings,
      (setting) =>
        `| ${path(setting.file)}:${setting.line} | ${text(setting.key)} | ${text(setting.value)} | ${text(setting.applies)} |`,
      maxRows,
      MAX_TABLE_CHARACTERS,
    );
    blocks.push(['## Model settings']);
    blocks.push([
      '| Where | Setting | Value | Applies to |',
      '| :---- | :------ | :---- | :--------- |',
      ...rows,
      ...(rows.length < view.settings.length
        ? ['', ...omittedNote(rows.length, view.settings.length, 'setting')]
        : []),
    ]);
  }
  const notes = [`_${NOT_VISIBLE_NOTE}_`];
  if (view.unverified) {
    notes.push('_? = unverified: neither documentation nor source code confirms it._');
  }
  blocks.push(paragraphs(notes));
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
