/**
 * Terminal output for `agentcheckup tokens`: a table of what each agent's configuration costs in
 * context, the largest subagent calls with the models they run on, and, with `--by-directory`,
 * the start directories by what a session there starts with.
 *
 * Pure, like the other formatters: the CLI decides about color and passes a {@link Style}. Every
 * string from the scanned repository goes through `forTerminal`, and the whole output through
 * `guardWorkflowCommands`.
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import { stripPathBase } from '../core/rebase.js';
import { AGENT_COLUMNS, AGENT_NAMES } from './context-view.js';
import { forTerminal, guardWorkflowCommands } from './sanitize.js';
import { plainStyle, type Style } from './stylish.js';
import { displayWidth, truncate } from './text.js';
import { type CallTokens, type TokenSummary, tokenSummary } from './tokens-view.js';

export interface TokensTextOptions {
  /** Color functions. Default {@link plainStyle}. */
  readonly style?: Style | undefined;
  /** ASCII-only decorations (`~` for `≈`, `/` for `÷`, `-` for `·`, `...` for `…`). */
  readonly ascii?: boolean | undefined;
}

/** Calls and directories shown before `and N more`; JSON has every one. */
export const MAX_TOKEN_ROWS = 10;

const MAX_PATH_LENGTH = 120;
const MAX_TEXT_LENGTH = 80;
const GAP = '  ';

interface Context {
  readonly style: Style;
  readonly ascii: boolean;
  readonly approx: string;
  readonly divide: string;
  readonly dot: string;
  readonly more: string;
}

function clean(text: string, context: Context, max = MAX_TEXT_LENGTH): string {
  return forTerminal(truncate(text, max, context.more), { ascii: context.ascii }).replaceAll(
    '\t',
    ' ',
  );
}

/** Rows of cells under a header, each column aligned left (`l`) or right (`r`). */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly ('l' | 'r')[],
): string[] {
  const widths = header.map((cell, index) =>
    Math.max(displayWidth(cell), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const pad = ' '.repeat(Math.max(0, (widths[index] ?? 0) - displayWidth(cell)));
        return align[index] === 'r' ? pad + cell : cell + pad;
      })
      .join(GAP)
      .trimEnd();
  return [line(header), ...rows.map(line)].map((text) => `  ${text}`);
}

/**
 * The model a call runs on: as written, then where it comes from unless its own file, or that
 * the agent does not document the value.
 */
export function modelText(call: CallTokens): string {
  const model = call.model;
  if (model?.value === undefined) return 'model not visible';
  const value = typeof model.value === 'string' ? model.value : model.value.join(', ');
  if (model.source !== 'definition') return `${value} (${model.source})`;
  return model.undocumented === true ? `${value} (not documented)` : value;
}

/**
 * A call's ≈tokens: `+` when files it starts with were not read, `?` when unverified, or
 * `not measured`.
 */
export function callTokensText(call: CallTokens): string {
  const mark = call.unverified ? '?' : '';
  if (call.tokens === undefined) return `not measured${mark}`;
  const more = call.unmeasured === undefined ? '' : '+';
  return `${formatInteger(call.tokens)}${more}${mark}`;
}

/** The subagent's name, and that it runs only if it wins over another of its name. */
export function callSubjectText(call: CallTokens): string {
  return `${call.name ?? ''}${call.mayRun === true ? ' (if it loads)' : ''}`;
}

/** What the columns mean, and what no file shows: one short line each. */
export const NOTES: readonly string[] = [
  'At start: in context from the first message.',
  'Listings: the names and descriptions the model picks skills and subagents by, part of At start.',
  'On demand: the most later triggers can add.',
  'A subagent call starts in a context window of its own and adds to none of these.',
  'Not visible: user, managed and plugin scopes, tool definitions and the conversation.',
];

/** Whether a number the output shows has a `?`: an agent's, or a start directory's. */
export function anyUnverified(summary: TokenSummary): boolean {
  return (
    summary.agents.some((row) => row.unverified) ||
    summary.calls.some((call) => call.unverified) ||
    (summary.directories ?? []).some((directory) => directory.agents.some((row) => row.unverified))
  );
}

function more(total: number, shown: number, noun: string, context: Context): string[] {
  const hidden = total - shown;
  return hidden > 0
    ? [context.style.dim(`  ${context.more} and ${formatInteger(hidden)} more ${noun}`)]
    : [];
}

export function formatTokensText(result: ScanResult, options: TokensTextOptions = {}): string {
  const style = options.style ?? plainStyle;
  const ascii = options.ascii === true;
  const context: Context = {
    style,
    ascii,
    approx: ascii ? '~' : '≈',
    divide: ascii ? '/' : '÷',
    dot: ascii ? '-' : '·',
    more: ascii ? '...' : '…',
  };
  // Paths relative to the scanned directory, as the context output shows them.
  const summary = tokenSummary(stripPathBase(result));
  if (summary === undefined) return '';
  const number = (value: number): string => formatInteger(value);
  const lines: string[] = [];
  const cwd = summary.agents[0]?.cwd ?? '';
  const where = cwd === '' ? './' : clean(cwd, context, MAX_PATH_LENGTH);
  lines.push(
    style.bold(`Context cost by agent ${context.dot} ${where}`) +
      style.dim(`  ${context.approx}tokens`),
  );
  if (summary.agents.length === 0) {
    lines.push('  No agent planned.');
  } else {
    lines.push(
      ...table(
        ['', 'At start', 'Listings', 'On demand', 'Subagents'],
        summary.agents.map((row) => [
          AGENT_NAMES[row.agent],
          `${number(row.startup)}${row.unverified ? '?' : ''}`,
          number(row.listings),
          number(row.onDemand),
          number(row.subagents),
        ]),
        ['l', 'r', 'r', 'r', 'r'],
      ),
    );
  }

  if (summary.calls.length > 0) {
    lines.push('', style.bold('Largest subagent calls, each in a context window of its own'));
    const shown = summary.calls.slice(0, MAX_TOKEN_ROWS);
    lines.push(
      ...table(
        [`${context.approx}tokens`, 'Agent', 'Subagent', 'Model', 'File'],
        shown.map((call) => [
          callTokensText(call),
          AGENT_NAMES[call.agent],
          clean(callSubjectText(call), context),
          clean(modelText(call), context),
          clean(call.path, context, MAX_PATH_LENGTH),
        ]),
        ['r', 'l', 'l', 'l', 'l'],
      ),
      ...more(summary.calls.length, shown.length, 'calls', context),
    );
  }

  if (summary.directories !== undefined) {
    lines.push(
      '',
      style.bold('Start directories by context at start') + style.dim(`  ${context.approx}tokens`),
    );
    const agents = summary.agents.map((row) => row.agent);
    const label = (agent: (typeof agents)[number]): string => {
      const column = AGENT_COLUMNS[agent];
      return column.surface === undefined ? column.group : `${column.group} ${column.surface}`;
    };
    const startup = (row: { readonly startup: number; readonly unverified: boolean }): string =>
      `${number(row.startup)}${row.unverified ? '?' : ''}`;
    const root = ['./', ...summary.agents.map(startup)];
    const shown = summary.directories.slice(0, MAX_TOKEN_ROWS);
    const rows = shown.map((directory) => [
      clean(directory.cwd, context, MAX_PATH_LENGTH),
      ...agents.map((agent) => {
        const cell = directory.agents.find((row) => row.agent === agent);
        return cell === undefined ? '' : startup(cell);
      }),
    ]);
    lines.push(
      ...table(
        ['', ...agents.map(label)],
        [root, ...rows],
        ['l', ...agents.map(() => 'r' as const)],
      ),
      ...more(summary.directories.length, shown.length, 'directories', context),
    );
    if ((summary.directoriesNotPlanned ?? 0) > 0) {
      lines.push(
        style.dim(
          `  ${formatInteger(summary.directoriesNotPlanned ?? 0)} more directories hold agent configuration; plan one with agentcheckup tokens --cwd <dir>`,
        ),
      );
    }
  }

  lines.push(
    '',
    ...NOTES.map((note) => style.dim(note)),
    style.dim(`${context.approx}tokens = characters ${context.divide} 4`),
  );
  if (anyUnverified(summary)) {
    lines.push(style.dim('? = unverified: neither documentation nor source code confirms it'));
  }
  if (summary.calls.some((call) => call.unmeasured !== undefined)) {
    lines.push(style.dim('+ = the call starts with more: files the scan did not read'));
  }
  return guardWorkflowCommands(`${lines.join('\n')}\n`);
}
