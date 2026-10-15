/**
 * Drift report output: human-readable text and JSON.
 *
 * Reasons come from the network (status lines, error codes), so every string goes through the
 * sanitizer of the channel it is written to, like everything agentcheckup prints.
 */
import { forJsonOutput, forTerminal } from '../../src/report/sanitize.js';
import {
  type ChangedSource,
  type CitedSource,
  type DriftReport,
  REPORT_VERSION,
  type UnreachableSource,
} from './baseline.js';

/** Short form of a hash for text output. */
function short(hash: string | null): string {
  return hash === null ? 'not in the baseline' : hash.slice(0, 12);
}

function line(text: string): string {
  return forTerminal(text);
}

function rulesLine(rules: readonly string[]): string {
  return `    rules: ${line(rules.join(', '))}`;
}

export function formatText(report: DriftReport): string {
  const out: string[] = [
    `Source drift: ${report.checked} cited URL${report.checked === 1 ? '' : 's'} checked.`,
  ];
  if (report.changed.length > 0) {
    out.push('', `Changed (${report.changed.length}):`);
    for (const source of report.changed) {
      out.push(
        `  ${line(source.url)}`,
        rulesLine(source.rules),
        `    hash: ${short(source.previous)} -> ${short(source.current)}`,
      );
    }
  }
  if (report.unreachable.length > 0) {
    out.push('', `Unreachable (${report.unreachable.length}):`);
    for (const source of report.unreachable) {
      out.push(
        `  ${line(source.url)}`,
        `    reason: ${line(source.reason)}`,
        rulesLine(source.rules),
      );
    }
  }
  out.push('', `Unchanged: ${report.unchanged}`);
  if (report.uncited.length > 0) {
    out.push(`No longer cited by any rule (--update removes them): ${report.uncited.length}`);
    for (const url of report.uncited) out.push(`  ${line(url)}`);
  }
  if (report.skipped.length > 0) {
    out.push(`Not checked, in this repository: ${report.skipped.length}`);
  }
  if (report.changed.length > 0 || report.unreachable.length > 0) {
    out.push(
      '',
      'Re-read each changed source and update the rule or its `checked` date. Then run',
      '`pnpm drift:update --only <url>` and commit scripts/drift/baseline.json in the same pull request.',
    );
  }
  return `${out.join('\n')}\n`;
}

export function formatJson(report: DriftReport): string {
  return `${forJsonOutput(JSON.stringify(report, null, 2))}\n`;
}

// ---------------------------------------------------------------------------------------------
// Reading a JSON report back (scripts/drift/sync-issues.ts)
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCited(value: unknown): value is CitedSource {
  return isRecord(value) && typeof value['url'] === 'string' && isStringArray(value['rules']);
}

function isChanged(value: unknown): value is ChangedSource {
  return (
    isCited(value) &&
    isRecord(value) &&
    (value['previous'] === null || typeof value['previous'] === 'string') &&
    typeof value['current'] === 'string'
  );
}

function isUnreachable(value: unknown): value is UnreachableSource {
  return isCited(value) && isRecord(value) && typeof value['reason'] === 'string';
}

/** Parses the output of `--format json` or `--report`. Throws if the shape is wrong. */
export function parseReport(text: string): DriftReport {
  const raw: unknown = JSON.parse(text);
  if (
    !isRecord(raw) ||
    raw['version'] !== REPORT_VERSION ||
    !isCount(raw['checked']) ||
    !isCount(raw['unchanged']) ||
    !Array.isArray(raw['changed']) ||
    !raw['changed'].every(isChanged) ||
    !Array.isArray(raw['unreachable']) ||
    !raw['unreachable'].every(isUnreachable) ||
    !isStringArray(raw['uncited']) ||
    !Array.isArray(raw['skipped']) ||
    !raw['skipped'].every(isCited)
  ) {
    throw new Error(`not a version ${REPORT_VERSION} source drift report`);
  }
  return {
    version: REPORT_VERSION,
    checked: raw['checked'],
    changed: raw['changed'],
    unreachable: raw['unreachable'],
    unchanged: raw['unchanged'],
    uncited: raw['uncited'],
    skipped: raw['skipped'],
  };
}
