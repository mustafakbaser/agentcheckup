/**
 * What a scan did not check, as the formatters say it, so that a scan that could not see
 * something never reads like a clean one: where the walk stopped at its entry limit, the
 * directories it could not list, the agent configuration files it did not read, and those it
 * left out on purpose (gitignored, or in build output and vendored code). Pure.
 *
 * Messages are built from trusted text and paths that each formatter passes through its own
 * sanitizer (`show`).
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import type { SkippedEntry } from '../core/types.js';
import { parseIncomplete } from '../inventory/incomplete.js';
import { classify } from '../platforms/classify.js';
import { breakdown, SKIP_REASON_LABELS } from './text.js';

/** Paths a message names before `… and N more`. */
export const MAX_COVERAGE_PATHS = 3;

export interface Coverage {
  /** The first entry the walk did not visit, when it stopped at its entry limit. */
  readonly stoppedAt: string | undefined;
  /** Directories the walk could not list: too deep or unreadable. */
  readonly unlisted: readonly SkippedEntry[];
  /** Agent configuration files the walk found but did not read. */
  readonly unread: readonly SkippedEntry[];
  /** Agent configuration files a `.gitignore` left out of a scan that honors it. */
  readonly gitignored: readonly string[];
  /** Agent configuration files in build output and vendored directories. */
  readonly excluded: readonly string[];
  /** False when the count of the last two stopped at its limit: there may be more. */
  readonly complete: boolean;
  /**
   * Configuration files the scan read but could not analyze for MCP servers, hooks and
   * permissions: past a parser limit, or in a format agentcheckup does not model (the plain
   * paths of `inventory.incomplete`).
   */
  readonly unanalyzed: readonly string[];
}

export function coverageOf(
  result: Pick<ScanResult, 'skipped' | 'unscannedConfig'> & {
    readonly inventory?: Pick<ScanResult['inventory'], 'incomplete'>;
  },
): Coverage {
  const stop = result.skipped.find((entry) => entry.reason === 'file-limit');
  return {
    stoppedAt: stop?.path,
    unlisted: result.skipped.filter(
      (entry) => entry.reason !== 'file-limit' && entry.path.endsWith('/'),
    ),
    unread: result.skipped.filter(isUnreadConfig),
    gitignored: result.unscannedConfig?.gitignored ?? [],
    excluded: result.unscannedConfig?.excluded ?? [],
    complete: result.unscannedConfig?.complete ?? true,
    unanalyzed: (result.inventory?.incomplete ?? []).filter(
      (entry) => parseIncomplete(entry).tag === undefined,
    ),
  };
}

/** A skipped agent configuration file: one the classifier recognizes, other than an import. */
export function isUnreadConfig(entry: SkippedEntry): boolean {
  return (
    entry.reason !== 'file-limit' &&
    entry.reason !== 'import-limit' &&
    !entry.path.endsWith('/') &&
    classify(entry.path) !== undefined
  );
}

/** Whether the scan found agent configuration it did not check. */
export function hasUncheckedConfig(coverage: Coverage): boolean {
  return (
    coverage.unread.length > 0 || coverage.gitignored.length > 0 || coverage.excluded.length > 0
  );
}

/**
 * Whether a limit, not a choice, kept agent configuration from the scan: where the walk stopped,
 * a directory it could not list, a file it did not read or could not analyze.
 */
export function missedByLimit(coverage: Coverage): boolean {
  return (
    coverage.stoppedAt !== undefined ||
    coverage.unlisted.length > 0 ||
    coverage.unread.length > 0 ||
    coverage.unanalyzed.length > 0
  );
}

/** How a formatter shows one coverage message. */
export interface CoverageMessage {
  /**
   * `warning` when agent configuration may have been missed by accident (a limit, an unread
   * file); `notice` when the scan left it out on purpose and an option checks it.
   */
  readonly level: 'warning' | 'notice';
  readonly text: string;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatInteger(value)} ${value === 1 ? singular : plural}`;
}

/** How a formatter shows paths: each sanitized, and its sign for more (`…` or `...`). */
export interface CoverageStyle {
  readonly show: (path: string) => string;
  readonly more?: string;
}

function listed(paths: readonly string[], style: CoverageStyle): string {
  const shown = paths.slice(0, MAX_COVERAGE_PATHS).map(style.show).join(', ');
  const hidden = paths.length - MAX_COVERAGE_PATHS;
  return hidden > 0 ? `${shown}, ${style.more ?? '…'} and ${formatInteger(hidden)} more` : shown;
}

/**
 * The messages, most serious first. `style.show` sanitizes a path for the output channel.
 * `unread: false` leaves out the unread agent configuration files, for a formatter that lists
 * every skipped file already.
 */
export function coverageMessages(
  coverage: Coverage,
  style: CoverageStyle,
  options: { readonly unread?: boolean } = {},
): CoverageMessage[] {
  const { show } = style;
  const messages: CoverageMessage[] = [];
  if (coverage.stoppedAt !== undefined) {
    messages.push({
      level: 'warning',
      text:
        `The scan stopped at its limit of directory entries before ${show(coverage.stoppedAt)}, ` +
        'so agent configuration in the directories it had not listed was not checked.',
    });
  }
  if (coverage.unlisted.length > 0) {
    const reasons = breakdown(
      coverage.unlisted.map((entry) => entry.reason),
      SKIP_REASON_LABELS,
    );
    messages.push({
      level: 'warning',
      text:
        `${count(coverage.unlisted.length, 'directory', 'directories')} could not be listed ` +
        `(${reasons}), so agent configuration in them was not checked: ` +
        listed(
          coverage.unlisted.map((entry) => entry.path),
          style,
        ),
    });
  }
  if ((options.unread ?? true) && coverage.unread.length > 0) {
    const reasons = breakdown(
      coverage.unread.map((entry) => entry.reason),
      SKIP_REASON_LABELS,
    );
    const many = coverage.unread.length !== 1;
    messages.push({
      level: 'warning',
      text:
        `${count(coverage.unread.length, 'agent configuration file')} ${many ? 'were' : 'was'} ` +
        `not checked (${reasons}): ${listed(
          coverage.unread.map((entry) => entry.path),
          style,
        )}`,
    });
  }
  if (coverage.unanalyzed.length > 0) {
    const many = coverage.unanalyzed.length !== 1;
    messages.push({
      level: 'warning',
      text:
        `${count(coverage.unanalyzed.length, 'configuration file')} could not be analyzed ` +
        `(past a parser limit or in a format agentcheckup does not read), so ` +
        `${many ? 'their' : 'its'} MCP servers, hooks and permissions are not listed: ` +
        listed(coverage.unanalyzed, style),
    });
  }
  const atLeast = coverage.complete ? '' : 'at least ';
  if (coverage.gitignored.length > 0) {
    const many = coverage.gitignored.length !== 1;
    messages.push({
      level: 'notice',
      text:
        `${atLeast}${count(coverage.gitignored.length, 'agent configuration file')} ` +
        `${many ? 'are' : 'is'} excluded by .gitignore; add --no-gitignore to check ` +
        `${many ? 'them' : 'it'}: ${listed(coverage.gitignored, style)}`,
    });
  }
  if (coverage.excluded.length > 0) {
    const many = coverage.excluded.length !== 1;
    messages.push({
      level: 'notice',
      text:
        `${atLeast}${count(coverage.excluded.length, 'agent configuration file')} in build ` +
        `output or vendored code ${many ? 'are' : 'is'} not checked; add --untrusted to check ` +
        `${many ? 'them' : 'it'}: ${listed(coverage.excluded, style)}`,
    });
  }
  return messages.map((message) => ({ ...message, text: capitalized(message.text) }));
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
