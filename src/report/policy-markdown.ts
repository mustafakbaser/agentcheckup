/**
 * The "Policy" section of the Markdown report, placed before the summary of changes since the
 * baseline: the policy's name, mode, digest and number of checks, a table of violations with the
 * failing ones first, and the notes. Untrusted text (the policy name, paths, messages) reaches
 * Markdown only through `escaped`.
 */
import type { ScanResult } from '../core/engine.js';
import type { PolicyViolation } from '../policy/types.js';
import { cappedRows, escaped, omittedNote, paragraphs } from './markdown-common.js';
import {
  baselineBreakdown,
  isPolicyCheck,
  POLICY_DOCS_URL,
  policyCounts,
  rankedViolations,
  shortSha,
  violationsHeadline,
  splitHookNote,
} from './policy-common.js';
import { forMarkdown } from './sanitize.js';
import { plural } from './text.js';

/** Most of the report the violations table may take. */
export const MAX_POLICY_BYTES = 10_000;
const MAX_ROWS = 50;
const MAX_NAME_LENGTH = 120;
const MAX_PATH_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 300;
const HEX = /^[\da-f]+$/;

function locationCell(violation: PolicyViolation): string {
  if (violation.path === undefined) return '—';
  const path = escaped(violation.path, MAX_PATH_LENGTH);
  return violation.line === undefined ? path : `${path}:${violation.line}`;
}

function checkCell(violation: PolicyViolation): string {
  const { check } = violation;
  return isPolicyCheck(check) ? `\`${check}\`` : escaped(check, MAX_PATH_LENGTH);
}

/** `**new**, fails`, `unchanged, reported`, `fails`. */
function statusCell(violation: PolicyViolation): string {
  const outcome = violation.fails ? 'fails' : 'reported';
  if (violation.baseline === 'new') return `**new**, ${outcome}`;
  if (violation.baseline === 'unchanged') return `unchanged, ${outcome}`;
  return outcome;
}

function row(violation: PolicyViolation): string {
  const { text, hookNote } = splitHookNote(violation.message);
  const message =
    escaped(text, MAX_MESSAGE_LENGTH) + (hookNote === undefined ? '' : ` ${forMarkdown(hookNote)}`);
  return `| ${locationCell(violation)} | ${checkCell(violation)} | ${message} | ${statusCell(violation)} |`;
}

/** The section's lines, or none without a policy. */
export function policySection(result: ScanResult): string[] {
  const report = result.policy;
  if (report === undefined) return [];
  const counts = policyCounts(report);
  const breakdown = baselineBreakdown(counts);
  const summary = `**${violationsHeadline(counts)}.**${breakdown === undefined ? '' : ` ${breakdown}.`}`;
  const short = shortSha(report.sha256);
  // A code span shows text as is, so only hex digits go in one.
  const digest = HEX.test(short) ? `\`${short}\`` : escaped(short, short.length);
  const facts =
    `Mode \`${report.mode === 'audit' ? 'audit' : 'enforce'}\` · sha256 ${digest} · ` +
    `${plural(report.checks, 'check')} · [what the checks mean](${POLICY_DOCS_URL})`;
  const lines = [
    `### Policy: ${escaped(report.name, MAX_NAME_LENGTH)}`,
    '',
    ...paragraphs([summary, facts]),
  ];

  if (counts.total > 0) {
    const ranked = rankedViolations(report);
    const { rows } = cappedRows(ranked, row, MAX_ROWS, MAX_POLICY_BYTES);
    lines.push(
      '',
      '| Location | Check | Violation | Status |',
      '| :------- | :---- | :-------- | :----- |',
      ...rows,
    );
    const note = omittedNote(rows.length, ranked.length, 'violation');
    if (note.length > 0) lines.push('', ...note);
  }

  if (report.notes.length > 0) {
    lines.push('', ...report.notes.map((note) => `- ${escaped(note.message, MAX_MESSAGE_LENGTH)}`));
  }
  return lines;
}
