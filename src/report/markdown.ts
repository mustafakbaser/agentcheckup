/**
 * GitHub-flavored Markdown for `$GITHUB_STEP_SUMMARY` and PR comments. Every untrusted string
 * goes through {@link forMarkdown}; the output contains no raw HTML at all.
 *
 * Size: a PR comment body is limited to 65,536 characters and a step summary to 1 MiB, so the
 * findings table stops at `maxFindings` rows or MAX_TABLE_CHARACTERS, whichever comes first,
 * and says how many findings it left out.
 */
import type { ScanResult } from '../core/engine.js';
import { REPOSITORY_URL, ruleDocsUrl } from '../core/meta.js';
import { CATEGORIES, type Finding } from '../core/types.js';
import { forMarkdown } from './sanitize.js';
import {
  breakdown,
  plural,
  SEVERITY_LABELS,
  SEVERITY_RANK,
  SKIP_REASON_LABELS,
  SYMLINK_PROBLEM_LABELS,
  truncate,
} from './text.js';

export interface MarkdownOptions {
  /** Rows in the findings table, most severe first. Default 50. */
  readonly maxFindings?: number | undefined;
}

const DEFAULT_MAX_FINDINGS = 50;
/** Budget for the findings table, leaving room for the rest within GitHub's 65,536. */
const MAX_TABLE_CHARACTERS = 50_000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_PATH_LENGTH = 200;
const MAX_LISTED = 3;
/** Rule ids that are safe to put in a code span and a docs URL as they are. */
const SAFE_RULE_ID = /^[a-z\d]+(?:-[a-z\d]+)*\/[a-z\d]+(?:-[a-z\d]+)*$/;

function text(value: string, max: number): string {
  return forMarkdown(truncate(value, max));
}

function heading(result: ScanResult): string {
  const { score, grade } = result.score;
  if (score === null || grade === null)
    return '## agentcheckup: no agent configuration files found';
  return `## agentcheckup: agent config score ${score}/100 (${grade})`;
}

function countsTable(result: ScanResult): string[] {
  const { errors, warnings, infos, suppressed } = result.summary;
  return [
    '| Errors | Warnings | Infos | Suppressed | Files checked |',
    '| -----: | -------: | ----: | ---------: | ------------: |',
    `| ${errors} | ${warnings} | ${infos} | ${suppressed} | ${result.artifacts.length} |`,
  ];
}

function categoriesLine(result: ScanResult): string | undefined {
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
  return parts.length === 0 ? undefined : `**By category:** ${parts.join(' · ')}`;
}

function ruleFailures(result: ScanResult): string[] {
  const failures = result.ruleFailures;
  if (failures.length === 0) return [];
  return [
    '> [!CAUTION]',
    `> ${plural(failures.length, 'rule')} failed to run. Results are incomplete.`,
    '>',
    ...failures.map(
      (failure) => `> - ${ruleCode(failure.ruleId)}: ${text(failure.message, MAX_MESSAGE_LENGTH)}`,
    ),
  ];
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  const hidden = items.length - MAX_LISTED;
  return hidden > 0 ? `${shown}, and ${hidden} more` : shown;
}

function notices(result: ScanResult): string[] {
  const lines: string[] = [];
  if (result.skipped.length > 0) {
    const reasons = breakdown(
      result.skipped.map((entry) => entry.reason),
      SKIP_REASON_LABELS,
    );
    const paths = listed(result.skipped.map((entry) => text(entry.path, MAX_PATH_LENGTH)));
    lines.push(`**Not checked:** ${plural(result.skipped.length, 'file')} (${reasons}): ${paths}`);
  }
  if (result.unresolvedSymlinks.length > 0) {
    const problems = breakdown(
      result.unresolvedSymlinks.map((link) => link.problem),
      SYMLINK_PROBLEM_LABELS,
    );
    const paths = listed(result.unresolvedSymlinks.map((link) => text(link.path, MAX_PATH_LENGTH)));
    lines.push(
      `**Not followed:** ${plural(result.unresolvedSymlinks.length, 'symlink')} (${problems}): ${paths}`,
    );
  }
  for (const warning of result.configWarnings.slice(0, MAX_LISTED)) {
    lines.push(`**Configuration:** ${text(warning, MAX_MESSAGE_LENGTH)}`);
  }
  if (result.configWarnings.length > MAX_LISTED) {
    lines.push(
      `**Configuration:** ${plural(result.configWarnings.length - MAX_LISTED, 'more warning')}`,
    );
  }
  // Separate lines in one paragraph render as one line; a blank line between keeps them apart.
  return lines.flatMap((line, index) => (index === 0 ? [line] : ['', line]));
}

/** `` `rule/id` `` for known-safe ids, otherwise escaped text. */
function ruleCode(ruleId: string): string {
  return SAFE_RULE_ID.test(ruleId) ? `\`${ruleId}\`` : text(ruleId, MAX_PATH_LENGTH);
}

function ruleLink(ruleId: string): string {
  return SAFE_RULE_ID.test(ruleId)
    ? `[\`${ruleId}\`](${ruleDocsUrl(ruleId)})`
    : text(ruleId, MAX_PATH_LENGTH);
}

function findingRow(finding: Finding): string {
  const where = `${text(finding.path, MAX_PATH_LENGTH)}:${finding.range.start.line}`;
  const message = text(finding.message, MAX_MESSAGE_LENGTH);
  return `| ${where} | ${SEVERITY_LABELS[finding.severity]} | ${ruleLink(finding.ruleId)} | ${message} |`;
}

/** Unsuppressed findings, most severe first, otherwise in report order. */
function ranked(result: ScanResult): Finding[] {
  return result.findings
    .map((finding, position) => ({ finding, position }))
    .filter((entry) => !entry.finding.suppressed)
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
        a.position - b.position,
    )
    .map((entry) => entry.finding);
}

function findingsSection(result: ScanResult, maxFindings: number): string[] {
  const findings = ranked(result);
  if (findings.length === 0) {
    return result.score.score === null ? [] : ['No problems found.'];
  }
  const rows: string[] = [];
  let size = 0;
  for (const finding of findings.slice(0, maxFindings)) {
    const row = findingRow(finding);
    if (size + row.length > MAX_TABLE_CHARACTERS) break;
    rows.push(row);
    size += row.length + 1;
  }
  const lines = ['### Findings', ''];
  if (rows.length > 0) {
    lines.push(
      '| Location | Severity | Rule | Message |',
      '| :------- | :------- | :--- | :------ |',
      ...rows,
    );
  }
  if (rows.length < findings.length) {
    if (rows.length > 0) lines.push('');
    lines.push(
      `Showing ${rows.length} of ${plural(findings.length, 'finding')}, most severe first. ` +
        'Run `npx agentcheckup` locally for the full report.',
    );
  }
  return lines;
}

/** Markdown report ending with a newline. */
export function formatMarkdown(result: ScanResult, options: MarkdownOptions = {}): string {
  const requested = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxFindings = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;

  const blocks: string[][] = [[heading(result)]];
  if (result.score.score !== null) {
    blocks.push(countsTable(result));
    const details: string[] = [];
    if (result.score.capped) details.push('**Score capped:** a risk finding limits the score.');
    const categories = categoriesLine(result);
    if (categories !== undefined) details.push(categories);
    if (details.length > 0)
      blocks.push(details.flatMap((line, i) => (i === 0 ? [line] : ['', line])));
  }
  const failures = ruleFailures(result);
  if (failures.length > 0) blocks.push(failures);
  const notes = notices(result);
  if (notes.length > 0) blocks.push(notes);
  const findings = findingsSection(result, maxFindings);
  if (findings.length > 0) blocks.push(findings);
  blocks.push([
    '---',
    '',
    `Generated by [agentcheckup](${REPOSITORY_URL}) ${forMarkdown(result.tool.version)} · ruleset ${forMarkdown(result.ruleset)}`,
  ]);

  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
