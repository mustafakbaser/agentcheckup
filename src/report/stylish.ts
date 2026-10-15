/**
 * ESLint-"stylish"-like terminal output: findings grouped by file with aligned columns, then a
 * summary with counts, the score and notices. Pure: the CLI decides about color (NO_COLOR,
 * FORCE_COLOR, TTY) and passes a {@link Style}.
 */
import type { ScanResult } from '../core/engine.js';
import { REPOSITORY_URL } from '../core/meta.js';
import type { Grade } from '../core/score.js';
import { CATEGORIES, type Finding, type Severity } from '../core/types.js';
import { gateRows, isNewRuleFinding, newRuleFindings, newRuleSet } from './gate.js';
import { forTerminal, guardWorkflowCommands } from './sanitize.js';
import {
  breakdown,
  displayWidth,
  plural,
  SEVERITY_LABELS,
  SKIP_REASON_LABELS,
  SYMLINK_PROBLEM_LABELS,
  truncate,
} from './text.js';

export type Paint = (text: string) => string;

/** Color functions. Severity is always written as a word, so output stays readable without. */
export interface Style {
  readonly red: Paint;
  readonly yellow: Paint;
  readonly blue: Paint;
  readonly green: Paint;
  readonly dim: Paint;
  readonly bold: Paint;
  readonly underline: Paint;
  readonly gray: Paint;
}

const identity: Paint = (text) => text;

/** No colors. */
export const plainStyle: Style = Object.freeze({
  red: identity,
  yellow: identity,
  blue: identity,
  green: identity,
  dim: identity,
  bold: identity,
  underline: identity,
  gray: identity,
});

export interface StylishOptions {
  readonly style: Style;
  /** ASCII-only decorations (no `✖`, `·`, `↳`, `…`, `⏎`) for limited terminals. */
  readonly ascii?: boolean | undefined;
  /** List suppressed findings too, marked as such. They are always counted. */
  readonly showSuppressed?: boolean | undefined;
  /** Show at most this many findings per file, then `… and N more`. Default: all. */
  readonly maxPerFile?: number | undefined;
}

interface Symbols {
  readonly fail: string;
  readonly ok: string;
  readonly info: string;
  readonly notice: string;
  readonly dot: string;
  readonly arrow: string;
  readonly sub: string;
  readonly more: string;
}

const UNICODE_SYMBOLS: Symbols = {
  fail: '✖',
  ok: '✔',
  info: 'ℹ',
  notice: '!',
  dot: '·',
  arrow: '→',
  sub: '↳',
  more: '…',
};

const ASCII_SYMBOLS: Symbols = {
  fail: 'x',
  ok: '',
  info: 'i',
  notice: '!',
  dot: '-',
  arrow: '->',
  sub: '->',
  more: '...',
};

/** Untrusted messages longer than this (code points) are cut. Keeps one finding on one line. */
const MAX_MESSAGE_LENGTH = 500;
/** Messages wider than this do not push the rule-id column of the other rows to the right. */
const MAX_ALIGNED_MESSAGE_WIDTH = 72;
/** Related locations shown per finding. */
const MAX_RELATED = 3;
/** Paths listed per notice (skipped files, symlinks). */
const MAX_NOTICE_PATHS = 3;
/** Rule failures and configuration warnings listed before `… and N more`. */
const MAX_LISTED = 10;

interface Context {
  readonly style: Style;
  readonly symbols: Symbols;
  readonly ascii: boolean;
  /** The scan ran with `--baseline`: rows get a column that marks new findings. */
  readonly baseline: boolean;
  /** Rules newer than the baseline's rule set: their new findings are marked "new rule". */
  readonly newRules: ReadonlySet<string>;
  /** Width of the marker column, without the gap after it. */
  readonly markerWidth: number;
}

/** Marker for findings the baseline does not have; unchanged ones get blanks of equal width. */
const NEW_MARKER = 'new';
/** Marker for new findings of a rule the baseline's rule set did not have. */
const NEW_RULE_MARKER = 'new rule';

/** Sanitized single-line text, safe to write to a terminal. TAB becomes a space for alignment. */
function clean(text: string, context: Context, max = MAX_MESSAGE_LENGTH): string {
  return forTerminal(truncate(text, max, context.symbols.more), {
    ascii: context.ascii,
  }).replaceAll('\t', ' ');
}

function paintSeverity(severity: Severity, text: string, style: Style): string {
  switch (severity) {
    case 'error':
      return style.red(text);
    case 'warn':
      return style.yellow(text);
    case 'info':
      return style.blue(text);
  }
}

function paintGrade(grade: Grade, style: Style): string {
  if (grade === 'A' || grade === 'B') return style.green(grade);
  if (grade === 'F') return style.red(grade);
  return style.yellow(grade);
}

function location(path: string, line: number, column: number, context: Context): string {
  return `${clean(path, context)}:${line}:${column}`;
}

interface Row {
  readonly finding: Finding;
  readonly line: string;
  readonly column: string;
  readonly severity: string;
  readonly message: string;
}

/** Lines for one file: underlined path, aligned rows, continuation lines, overflow note. */
function renderFile(
  path: string,
  findings: readonly Finding[],
  maxPerFile: number,
  context: Context,
): string[] {
  const { style, symbols } = context;
  const rows: Row[] = findings.slice(0, maxPerFile).map((finding) => ({
    finding,
    line: String(finding.range.start.line),
    column: String(finding.range.start.column),
    severity: SEVERITY_LABELS[finding.severity],
    message: clean(finding.message, context),
  }));

  const lineWidth = Math.max(...rows.map((row) => row.line.length));
  const columnWidth = Math.max(...rows.map((row) => row.column.length));
  const severityWidth = Math.max(...rows.map((row) => row.severity.length));
  const messageWidth = Math.max(
    0,
    ...rows
      .map((row) => displayWidth(row.message))
      .filter((width) => width <= MAX_ALIGNED_MESSAGE_WIDTH),
  );
  const markerWidth = context.baseline ? context.markerWidth + 2 : 0;
  const indent = ' '.repeat(2 + lineWidth + 1 + columnWidth + 2 + severityWidth + 2 + markerWidth);

  const lines = [style.underline(clean(path, context))];
  for (const row of rows) {
    const { finding } = row;
    const position = `${row.line.padStart(lineWidth)}:${row.column.padEnd(columnWidth)}`;
    const severity =
      paintSeverity(
        finding.severity,
        row.severity,
        finding.suppressed
          ? { ...style, red: style.dim, yellow: style.dim, blue: style.dim }
          : style,
      ) + ' '.repeat(severityWidth - row.severity.length);
    const message = finding.suppressed ? style.dim(row.message) : row.message;
    const padding = ' '.repeat(Math.max(0, messageWidth - displayWidth(row.message)));
    let marker = '';
    if (context.baseline) {
      const text =
        finding.baseline !== 'new'
          ? ''
          : isNewRuleFinding(finding, context.newRules)
            ? NEW_RULE_MARKER
            : NEW_MARKER;
      const pad = ' '.repeat(context.markerWidth - text.length + 2);
      marker = text === '' ? pad : `${style.bold(text)}${pad}`;
    }
    lines.push(
      `  ${style.dim(position)}  ${severity}  ${marker}${message}${padding}  ${style.gray(clean(finding.ruleId, context))}`,
    );

    if (finding.suppressed) {
      const how = finding.suppressed.kind === 'inline' ? 'inline directive' : 'configuration';
      lines.push(
        `${indent}${style.dim(`suppressed by ${how}: ${clean(finding.suppressed.reason, context)}`)}`,
      );
    }
    for (const related of finding.related.slice(0, MAX_RELATED)) {
      const where = related.range
        ? location(related.path, related.range.start.line, related.range.start.column, context)
        : clean(related.path, context);
      lines.push(
        `${indent}${style.gray(`${symbols.sub} ${where}: ${clean(related.message, context)}`)}`,
      );
    }
    if (finding.related.length > MAX_RELATED) {
      const hidden = finding.related.length - MAX_RELATED;
      lines.push(
        `${indent}${style.gray(`${symbols.sub} ${symbols.more} and ${plural(hidden, 'more related location')}`)}`,
      );
    }
  }
  if (findings.length > rows.length) {
    lines.push(
      `  ${style.dim(`${symbols.more} and ${findings.length - rows.length} more in this file`)}`,
    );
  }
  return lines;
}

/** Visible findings grouped by path, in first-seen order (the engine sorts by path). */
function groupByPath(findings: readonly Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.path);
    if (group) group.push(finding);
    else groups.set(finding.path, [finding]);
  }
  return groups;
}

/** `a, b, c, … and 4 more` from already-sanitized items. */
function listWithOverflow(items: readonly string[], context: Context): string {
  const shown = items.slice(0, MAX_NOTICE_PATHS).join(', ');
  const hidden = items.length - MAX_NOTICE_PATHS;
  return hidden > 0 ? `${shown}, ${context.symbols.more} and ${hidden} more` : shown;
}

function renderNotices(result: ScanResult, context: Context): string[] {
  const { style, symbols } = context;
  const lines: string[] = [];
  const mark = style.yellow(symbols.notice);

  if (result.skipped.length > 0) {
    const reasons = breakdown(
      result.skipped.map((entry) => entry.reason),
      SKIP_REASON_LABELS,
    );
    const paths = listWithOverflow(
      result.skipped.map((entry) => clean(entry.path, context)),
      context,
    );
    lines.push(
      `${mark} ${plural(result.skipped.length, 'file')} not checked (${reasons}): ${paths}`,
    );
  }

  if (result.unresolvedSymlinks.length > 0) {
    const problems = breakdown(
      result.unresolvedSymlinks.map((link) => link.problem),
      SYMLINK_PROBLEM_LABELS,
    );
    const links = listWithOverflow(
      result.unresolvedSymlinks.map(
        (link) => `${clean(link.path, context)} ${symbols.arrow} ${clean(link.target, context)}`,
      ),
      context,
    );
    lines.push(
      `${mark} ${plural(result.unresolvedSymlinks.length, 'symlink')} not followed (${problems}): ${links}`,
    );
  }

  if (result.baseline !== undefined && !result.baseline.against.sameRuleset) {
    lines.push(
      `${mark} The baseline was written with ruleset ${clean(result.baseline.against.ruleset, context)}, ` +
        'so findings from rules it did not run count as new.',
    );
  }

  for (const warning of result.configWarnings.slice(0, MAX_LISTED)) {
    lines.push(`${mark} ${clean(warning, context)}`);
  }
  if (result.configWarnings.length > MAX_LISTED) {
    lines.push(
      `${mark} ${symbols.more} and ${plural(result.configWarnings.length - MAX_LISTED, 'more configuration warning')}`,
    );
  }
  return lines;
}

/** Internal errors: results are incomplete, and the user should know before trusting a score. */
function renderRuleFailures(result: ScanResult, context: Context): string[] {
  const { style, symbols } = context;
  const failures = result.ruleFailures;
  if (failures.length === 0) return [];
  const lines = [
    style.red(
      style.bold(
        `${symbols.fail} ${plural(failures.length, 'rule')} failed to run. Results are incomplete.`,
      ),
    ),
  ];
  for (const failure of failures.slice(0, MAX_LISTED)) {
    lines.push(
      `    ${style.bold(clean(failure.ruleId, context))}: ${clean(failure.message, context)}`,
    );
  }
  if (failures.length > MAX_LISTED) {
    lines.push(`    ${symbols.more} and ${failures.length - MAX_LISTED} more`);
  }
  lines.push(`  This is a bug in agentcheckup. Please report it: ${REPOSITORY_URL}/issues`);
  return lines;
}

/** Security-relevant changes since the baseline that trip the gate: the reason for exit 1. */
function renderGateHits(result: ScanResult, context: Context): string[] {
  if (result.baseline === undefined) return [];
  const rows = gateRows(result.baseline);
  if (rows.length === 0) return [];
  const { style, symbols } = context;
  const lines = [
    style.red(
      style.bold(
        `${symbols.fail} ${plural(rows.length, 'security-relevant change')} since the baseline ${rows.length === 1 ? 'needs' : 'need'} review`,
      ),
    ),
  ];
  for (const row of rows.slice(0, MAX_LISTED)) {
    lines.push(`    ${style.bold(row.label)}: ${clean(row.hit.summary, context)}`);
  }
  if (rows.length > MAX_LISTED) {
    lines.push(`    ${symbols.more} and ${rows.length - MAX_LISTED} more`);
  }
  return lines;
}

/** `2 new (1 from new rules), 5 unchanged, 1 resolved since the baseline`. */
function baselineLine(result: ScanResult, context: Context): string | undefined {
  if (result.baseline === undefined) return undefined;
  const { findings } = result.baseline;
  const resolved = findings.resolved.length > 0 ? `, ${findings.resolved.length} resolved` : '';
  const fromNewRules = newRuleFindings(result);
  const newRules = fromNewRules > 0 ? ` (${fromNewRules} from new rules)` : '';
  return (
    `${context.style.bold(`${findings.new} new`)}${newRules}, ${findings.unchanged} unchanged` +
    `${resolved} since the baseline`
  );
}

function countsLine(result: ScanResult, context: Context): string | undefined {
  const { style, symbols } = context;
  const { errors, warnings, infos, suppressed } = result.summary;
  const total = errors + warnings + infos;
  const suppressedNote =
    suppressed > 0 ? style.dim(` ${symbols.dot} ${suppressed} suppressed`) : '';

  if (total === 0) {
    if (result.score.score === null && suppressed === 0) return undefined;
    const files = plural(result.artifacts.length, 'file');
    const ok = symbols.ok === '' ? '' : `${symbols.ok} `;
    return `${style.green(`${ok}No problems found`)} (${files} checked)${suppressedNote}`;
  }

  const text = `${plural(total, 'problem')} (${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${plural(infos, 'info')})`;
  if (errors > 0) return `${style.red(style.bold(`${symbols.fail} ${text}`))}${suppressedNote}`;
  if (warnings > 0)
    return `${style.yellow(style.bold(`${symbols.fail} ${text}`))}${suppressedNote}`;
  return `${style.blue(style.bold(`${symbols.info} ${text}`))}${suppressedNote}`;
}

/** `loading 1 error · budget 2 warnings`, unsuppressed only, in category order. */
function categoriesLine(result: ScanResult, context: Context): string | undefined {
  const parts: string[] = [];
  for (const category of CATEGORIES) {
    const tally = result.score.categories[category];
    const counts = [
      tally.errors > 0 ? plural(tally.errors, 'error') : '',
      tally.warnings > 0 ? plural(tally.warnings, 'warning') : '',
      tally.infos > 0 ? plural(tally.infos, 'info') : '',
    ].filter((part) => part !== '');
    if (counts.length > 0) parts.push(`${category} ${counts.join(', ')}`);
  }
  if (parts.length === 0) return undefined;
  return `  ${context.style.dim(parts.join(` ${context.symbols.dot} `))}`;
}

function scoreLine(result: ScanResult, context: Context): string {
  const { style, symbols } = context;
  const { score, grade, capped } = result.score;
  if (score === null || grade === null) return 'No agent configuration files found.';
  const cap = capped ? ` ${symbols.dot} ${style.red('capped by a risk finding')}` : '';
  return (
    `Agent config score ${style.bold(`${score}/100`)} (${paintGrade(grade, style)})` +
    `${cap} ${symbols.dot} ruleset ${clean(result.ruleset, context)}`
  );
}

/** Formats a scan result for a terminal. Returns text ending with a newline. */
export function formatStylish(result: ScanResult, options: StylishOptions): string {
  const ascii = options.ascii === true;
  const newRules = newRuleSet(result);
  const context: Context = {
    style: options.style,
    symbols: ascii ? ASCII_SYMBOLS : UNICODE_SYMBOLS,
    ascii,
    baseline:
      result.baseline !== undefined ||
      result.findings.some((finding) => finding.baseline !== undefined),
    newRules,
    markerWidth: result.findings.some(
      (finding) =>
        (options.showSuppressed === true || !finding.suppressed) &&
        isNewRuleFinding(finding, newRules),
    )
      ? NEW_RULE_MARKER.length
      : NEW_MARKER.length,
  };
  const maxPerFile =
    options.maxPerFile !== undefined && Number.isFinite(options.maxPerFile)
      ? Math.max(1, Math.floor(options.maxPerFile))
      : Number.POSITIVE_INFINITY;

  const visible = result.findings.filter(
    (finding) => options.showSuppressed === true || !finding.suppressed,
  );
  const blocks: string[][] = [];
  for (const [path, findings] of groupByPath(visible)) {
    blocks.push(renderFile(path, findings, maxPerFile, context));
  }

  const notices = renderNotices(result, context);
  if (notices.length > 0) blocks.push(notices);
  const failures = renderRuleFailures(result, context);
  if (failures.length > 0) blocks.push(failures);
  const gate = renderGateHits(result, context);
  if (gate.length > 0) blocks.push(gate);

  const summary = [
    countsLine(result, context),
    categoriesLine(result, context),
    baselineLine(result, context),
    scoreLine(result, context),
  ].filter((line) => line !== undefined);
  blocks.push(summary);

  // Paths start lines here (the file headings), so a path must not read as a workflow command.
  return guardWorkflowCommands(`${blocks.map((block) => block.join('\n')).join('\n\n')}\n`);
}
