/**
 * The policy block of the stylish output: a header with the policy's name, mode, digest and
 * number of checks, one aligned line per violation (failing ones first), a headline, and the
 * notes. Untrusted text goes through `forTerminal`; the caller guards the whole output against
 * workflow commands.
 */
import type { ScanResult } from '../core/engine.js';
import type { PolicyViolation } from '../policy/types.js';
import {
  baselineBreakdown,
  policyCounts,
  rankedViolations,
  shortSha,
  violationLocation,
  violationsHeadline,
  splitHookNote,
} from './policy-common.js';
import { forTerminal } from './sanitize.js';
import type { Style } from './stylish.js';
import { displayWidth, plural, truncate } from './text.js';

export interface PolicyBlockOptions {
  readonly style: Style;
  /** ASCII-only decorations. */
  readonly ascii: boolean;
}

/** Violations listed before `… and N more`. */
const MAX_LINES = 50;
const MAX_MESSAGE_LENGTH = 500;
const MAX_NAME_LENGTH = 120;
/** Locations wider than this do not push the other lines' columns to the right. */
const MAX_ALIGNED_LOCATION_WIDTH = 40;

interface Line {
  readonly violation: PolicyViolation;
  readonly location: string;
  readonly status: string;
  readonly marker: string;
}

/** The block's lines; none without a policy. */
export function renderPolicy(result: ScanResult, options: PolicyBlockOptions): string[] {
  const report = result.policy;
  if (report === undefined) return [];
  const { style, ascii } = options;
  const more = ascii ? '...' : '…';
  const dot = ascii ? '-' : '·';
  const clean = (text: string, max = MAX_MESSAGE_LENGTH): string =>
    forTerminal(truncate(text, max, more), { ascii }).replaceAll('\t', ' ');

  const mode = report.mode === 'audit' ? 'audit' : 'enforce';
  const facts = [mode, `sha256 ${clean(shortSha(report.sha256))}`, plural(report.checks, 'check')];
  const lines = [
    `${style.bold('Policy')} ${clean(report.name, MAX_NAME_LENGTH)} ${style.dim(`(${facts.join(` ${dot} `)})`)}`,
  ];

  const counts = policyCounts(report);
  const shown: Line[] = rankedViolations(report)
    .slice(0, MAX_LINES)
    .map((violation) => {
      const location = violationLocation(violation);
      return {
        violation,
        location: location === undefined ? (ascii ? '-' : '—') : clean(location),
        status: violation.fails ? 'fails' : 'reported',
        marker: violation.baseline === 'new' ? 'new' : '',
      };
    });
  const locationWidth = Math.max(
    0,
    ...shown
      .map((line) => displayWidth(line.location))
      .filter((width) => width <= MAX_ALIGNED_LOCATION_WIDTH),
  );
  const statusWidth = Math.max(0, ...shown.map((line) => line.status.length));
  const markerWidth = counts.compared ? 'new'.length + 2 : 0;
  for (const line of shown) {
    const { violation } = line;
    const padding = ' '.repeat(Math.max(0, locationWidth - displayWidth(line.location)));
    const status = line.status.padEnd(statusWidth);
    const marker = line.marker === '' ? ' '.repeat(markerWidth) : `${style.bold('new')}  `;
    const { text, hookNote } = splitHookNote(violation.message);
    const message = clean(text) + (hookNote === undefined ? '' : ` ${clean(hookNote)}`);
    lines.push(
      `  ${line.location}${padding}  ${violation.fails ? style.red(status) : style.dim(status)}  ` +
        `${marker}${message}  ${style.gray(clean(violation.check))}`,
    );
  }
  if (counts.total > shown.length) {
    lines.push(
      `  ${style.dim(`${more} and ${counts.total - shown.length} more: --format json lists them all`)}`,
    );
  }

  const headline = violationsHeadline(counts);
  const breakdown = baselineBreakdown(counts);
  const tail = breakdown === undefined ? '' : style.dim(` ${dot} ${breakdown}`);
  if (counts.failing > 0) {
    lines.push(`${style.red(style.bold(`${ascii ? 'x' : '✖'} ${headline}`))}${tail}`);
  } else if (counts.total > 0) {
    lines.push(`${style.yellow(`! ${headline}`)}${tail}`);
  } else {
    lines.push(style.green(ascii ? headline : `✔ ${headline}`));
  }
  for (const note of report.notes) {
    lines.push(`${style.yellow('!')} ${clean(note.message)}`);
  }
  return lines;
}
