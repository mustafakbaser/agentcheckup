/**
 * Terminal output for `agentcheckup agents`: per file, each agent that reads it with the name it
 * knows the definition by, the model as written and where the one it runs with comes from, and
 * why an agent skips the file; then the model settings, and what agentcheckup cannot see.
 *
 * Pure, like the other formatters: the CLI decides about color and passes a {@link Style}.
 * Every string from the scanned repository goes through `forTerminal`, and the whole output
 * through `guardWorkflowCommands`, because paths start some lines.
 */
import type { ScanResult } from '../core/engine.js';
import {
  agentsView,
  type DefinitionRow,
  NO_DEFINITIONS,
  NOT_VISIBLE_NOTE,
  type SettingRow,
  summaryText,
} from './agents-view.js';
import { forTerminal, guardWorkflowCommands } from './sanitize.js';
import { plainStyle, type Style } from './stylish.js';
import { displayWidth, truncate } from './text.js';

export interface AgentsTextOptions {
  /** Color functions. Default {@link plainStyle}. */
  readonly style?: Style | undefined;
  /** ASCII-only decorations (`->` for `→`, `-` for `·`, `...` for `…`). */
  readonly ascii?: boolean | undefined;
}

interface Context {
  readonly style: Style;
  readonly ascii: boolean;
  readonly arrow: string;
  readonly dot: string;
  readonly more: string;
}

/** Untrusted paths and text longer than this (code points) are cut. */
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;
/** Names wider than this do not push the column of the other rows to the right. */
const MAX_NAME_WIDTH = 32;
/** Settings wider than this do not push the column of the other rows to the right. */
const MAX_ASSIGNMENT_WIDTH = 60;
const GAP = '  ';

/** Sanitized single-line text. TAB becomes a space so columns stay aligned. */
function clean(text: string, context: Context, max = MAX_TEXT_LENGTH): string {
  return forTerminal(truncate(text, max, context.more), { ascii: context.ascii }).replaceAll(
    '\t',
    ' ',
  );
}

function padded(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function details(row: DefinitionRow, context: Context): string {
  const model =
    row.model === ''
      ? ''
      : row.runsOn === ''
        ? clean(row.model, context)
        : `${clean(row.model, context)} ${context.arrow} ${clean(row.runsOn, context)}`;
  const parts = [
    model,
    row.effort === '' ? '' : `effort ${clean(row.effort, context)}`,
    clean(row.status, context),
  ].filter((part) => part !== '');
  const text = parts.join(` ${context.dot} `);
  return `${row.warn ? context.style.yellow(text) : text}${row.unverified ? ' ?' : ''}`;
}

function definitionLines(view: ReturnType<typeof agentsView>, context: Context): string[] {
  const rows = view.files.flatMap((group) => group.rows);
  const agentWidth = Math.max(0, ...rows.map((row) => displayWidth(row.agent)));
  const names = rows.map((row) => clean(row.name, context));
  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(0, ...names.map(displayWidth)));
  const lines: string[] = [];
  for (const group of view.files) {
    lines.push(context.style.bold(clean(group.file, context, MAX_PATH_LENGTH)));
    for (const row of group.rows) {
      const name = clean(row.name, context);
      lines.push(
        `${GAP}${padded(row.agent, agentWidth)}${GAP}${padded(name, nameWidth)}${GAP}${details(row, context)}`,
      );
    }
  }
  return lines;
}

function settingLines(settings: readonly SettingRow[], context: Context): string[] {
  const where = settings.map(
    (setting) => `${clean(setting.file, context, MAX_PATH_LENGTH)}:${setting.line}`,
  );
  const assignments = settings.map(
    (setting) => `${clean(setting.key, context)} = ${clean(setting.value, context)}`,
  );
  const width = Math.max(0, ...where.map(displayWidth));
  const assignmentWidth = Math.min(
    MAX_ASSIGNMENT_WIDTH,
    Math.max(0, ...assignments.map(displayWidth)),
  );
  return [
    context.style.bold('Model settings'),
    ...settings.map(
      (setting, index) =>
        `${GAP}${padded(where[index] ?? '', width)}${GAP}` +
        `${padded(assignments[index] ?? '', assignmentWidth)}${GAP}${context.style.dim(setting.applies)}`,
    ),
  ];
}

/** Lines joined, trailing blanks removed, workflow-command lines defused, final newline. */
function finish(blocks: readonly (readonly string[])[]): string {
  const text = blocks.map((block) => block.map((line) => line.trimEnd()).join('\n')).join('\n\n');
  return guardWorkflowCommands(`${text}\n`);
}

/**
 * The agent definitions and model settings of a result as terminal text. Paths are relative to
 * the scanned directory, which the first line names when the report was rebased. Returns text
 * ending with a newline.
 */
export function formatAgentsText(result: ScanResult, options: AgentsTextOptions = {}): string {
  const ascii = options.ascii === true;
  const context: Context = {
    style: options.style ?? plainStyle,
    ascii,
    arrow: ascii ? '->' : '→',
    dot: ascii ? '-' : '·',
    more: ascii ? '...' : '…',
  };
  const view = agentsView(result);
  if (view.counts.definitions === 0 && view.settings.length === 0) {
    return finish([[NO_DEFINITIONS]]);
  }
  const blocks: string[][] = [];
  if (view.pathBase !== '') {
    blocks.push([
      context.style.dim(`Paths are relative to ${clean(view.pathBase, context, MAX_PATH_LENGTH)}`),
    ]);
  }
  blocks.push([context.style.bold(summaryText(view))]);
  if (view.files.length > 0) blocks.push(definitionLines(view, context));
  if (view.settings.length > 0) blocks.push(settingLines(view.settings, context));
  const notes = [context.style.dim(NOT_VISIBLE_NOTE)];
  if (view.unverified) {
    notes.push(
      context.style.dim('? = unverified: neither documentation nor source code confirms it'),
    );
  }
  blocks.push(notes);
  return finish(blocks);
}
