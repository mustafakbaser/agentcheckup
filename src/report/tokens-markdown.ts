/**
 * Markdown output for `agentcheckup tokens`, for a pull request comment or a job summary: the
 * same tables as the terminal output. Every string from the scanned repository is escaped
 * (markdown-common.ts), and each table stops at a row and character limit.
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import { stripPathBase } from '../core/rebase.js';
import { AGENT_COLUMNS, AGENT_NAMES } from './context-view.js';
import { cappedRows, escaped, omittedNote } from './markdown-common.js';
import {
  anyUnverified,
  callSubjectText,
  callTokensText,
  MAX_TOKEN_ROWS,
  modelText,
  NOTES,
} from './tokens-text.js';
import { tokenSummary } from './tokens-view.js';

/** Per table; keeps the output well inside a 1 MiB job summary. */
const MAX_TABLE_CHARACTERS = 50_000;
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 120;

function path(value: string): string {
  return escaped(value.replaceAll('\t', ' '), MAX_PATH_LENGTH);
}

function text(value: string): string {
  return escaped(value.replaceAll('\t', ' '), MAX_TEXT_LENGTH);
}

export function formatTokensMarkdown(result: ScanResult): string {
  const summary = tokenSummary(stripPathBase(result));
  if (summary === undefined) return '';
  const number = (value: number): string => formatInteger(value);
  const cwd = summary.agents[0]?.cwd ?? '';
  const lines: string[] = [`## Context cost by agent · ${cwd === '' ? './' : path(cwd)}`, ''];
  if (summary.agents.length === 0) {
    lines.push('No agent planned.');
  } else {
    lines.push(
      '| Agent | ≈Tokens at start | Listings | On demand | Subagents |',
      '| :---- | ---------------: | -------: | --------: | --------: |',
      ...summary.agents.map(
        (row) =>
          `| ${AGENT_NAMES[row.agent]} | ${number(row.startup)}${row.unverified ? '?' : ''} | ${number(row.listings)} | ${number(row.onDemand)} | ${number(row.subagents)} |`,
      ),
    );
  }

  if (summary.calls.length > 0) {
    const { rows } = cappedRows(
      summary.calls,
      (call) =>
        `| ${call.tokens === undefined ? '' : '≈'}${callTokensText(call)} | ${AGENT_NAMES[call.agent]} | ${text(callSubjectText(call))} | ${text(modelText(call))} | ${path(call.path)} |`,
      MAX_TOKEN_ROWS,
      MAX_TABLE_CHARACTERS,
    );
    lines.push(
      '',
      '### Largest subagent calls, each in a context window of its own',
      '',
      '| ≈Tokens | Agent | Subagent | Model | File |',
      '| ------: | :---- | :------- | :---- | :--- |',
      ...rows,
      ...omittedNote(rows.length, summary.calls.length, 'call').flatMap((note) => ['', note]),
    );
  }

  if (summary.directories !== undefined) {
    const agents = summary.agents.map((row) => row.agent);
    const labels = agents.map((agent) => {
      const column = AGENT_COLUMNS[agent];
      return column.surface === undefined ? column.group : `${column.group} ${column.surface}`;
    });
    const startup = (row: { readonly startup: number; readonly unverified: boolean }): string =>
      `${number(row.startup)}${row.unverified ? '?' : ''}`;
    const root = `| ./ | ${summary.agents.map(startup).join(' | ')} |`;
    const { rows } = cappedRows(
      summary.directories,
      (directory) => {
        const cells = agents.map((agent) => {
          const cell = directory.agents.find((row) => row.agent === agent);
          return cell === undefined ? '' : startup(cell);
        });
        return `| ${path(directory.cwd)} | ${cells.join(' | ')} |`;
      },
      MAX_TOKEN_ROWS,
      MAX_TABLE_CHARACTERS,
    );
    const notPlanned = summary.directoriesNotPlanned ?? 0;
    lines.push(
      '',
      '### Start directories by ≈tokens at start',
      '',
      `| Directory | ${labels.join(' | ')} |`,
      `| :-------- | ${labels.map(() => '---:').join(' | ')} |`,
      root,
      ...rows,
      ...omittedNote(rows.length, summary.directories.length, 'directory', 'directories').flatMap(
        (note) => ['', note],
      ),
      ...(notPlanned > 0
        ? [
            '',
            `${formatInteger(notPlanned)} more directories hold agent configuration; plan one with \`agentcheckup tokens --cwd <dir>\`.`,
          ]
        : []),
    );
  }

  lines.push('', ...NOTES.map((note) => `_${note}_`), '', '_≈Tokens = characters ÷ 4._');
  if (anyUnverified(summary)) {
    lines.push('_? = unverified: neither documentation nor source code confirms it._');
  }
  if (summary.calls.some((call) => call.unmeasured !== undefined)) {
    lines.push('_+ = the call starts with more: files the scan did not read._');
  }
  return `${lines.join('\n')}\n`;
}
