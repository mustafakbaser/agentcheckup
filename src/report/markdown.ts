/**
 * GitHub-flavored Markdown for `$GITHUB_STEP_SUMMARY` and PR comments. Every untrusted string
 * goes through {@link forMarkdown}; the output contains no raw HTML at all.
 *
 * Size: a PR comment body is limited to 65,536 characters, the agentcheckup Action cuts a
 * comment at 60,000 bytes, and a step summary is limited to 1 MiB, so the findings table stops
 * at `maxFindings` rows or MAX_TABLE_BYTES of UTF-8, whichever comes first, and says how many
 * findings it left out. With `--baseline`, the summary of changes (baseline-markdown.ts) comes
 * out of the same budget, and so do the table of what each agent misses and, with `--policy`,
 * the policy section (policy-markdown.ts): the findings table gets what they leave.
 *
 * At the `default` and `verbose` levels (see {@link DetailLevel}), a table of what each agent
 * misses (from the root load plans, when the result has them) comes before the findings, the
 * findings get a Fix column (`needs your words (fix -i)` for a fix that needs the user's words),
 * and a closing line says how to preview the fixes and answer those. With a baseline
 * whose comparison has plan deltas, the table lists only the skips the change adds. `compact`
 * is the report from before fixes.
 */
import type { ScanResult } from '../core/engine.js';
import { REPOSITORY_URL } from '../core/meta.js';
import { formatInteger } from '../core/format.js';
import { CATEGORIES, type Finding } from '../core/types.js';
import { baselineSummary } from './baseline-markdown.js';
import {
  type DetailLevel,
  fixCounts,
  fixOf,
  impactOf,
  type ImpactRow,
  INPUT_FIX_LABEL,
  needsWords,
  skipFixLabel,
} from './feedback.js';
import { newRuleSet } from './gate.js';
import {
  cappedRows,
  escaped as text,
  omittedNote,
  ruleCode as safeRuleCode,
  ruleLink as safeRuleLink,
  shownOf,
  utf8Length,
} from './markdown-common.js';
import { policySection } from './policy-markdown.js';
import { forMarkdown } from './sanitize.js';
import {
  breakdown,
  plural,
  SEVERITY_LABELS,
  SEVERITY_RANK,
  SKIP_REASON_LABELS,
  SYMLINK_PROBLEM_LABELS,
} from './text.js';

export interface MarkdownOptions {
  /** Rows in the findings table, most severe first. Default 50. */
  readonly maxFindings?: number | undefined;
  /** How much to show. Default `default`; `verbose` shows what `default` does. */
  readonly level?: DetailLevel | undefined;
}

const DEFAULT_MAX_FINDINGS = 50;
/**
 * Budget in UTF-8 bytes for the findings table and the baseline summary together, leaving room
 * for the rest within the Action's 60,000 bytes (see utf8Length).
 */
const MAX_TABLE_BYTES = 50_000;
/** Most of MAX_TABLE_BYTES the table of baseline changes may take. */
const MAX_BASELINE_BYTES = 10_000;
/** Most of MAX_TABLE_BYTES the table of what each agent misses may take. */
const MAX_IMPACT_BYTES = 10_000;
/** Rows in the table of what each agent misses. */
const MAX_IMPACT_ROWS = 25;
const MAX_MESSAGE_LENGTH = 300;
const MAX_PATH_LENGTH = 200;
const MAX_LISTED = 3;

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

function ruleCode(ruleId: string): string {
  return safeRuleCode(ruleId, MAX_PATH_LENGTH);
}

function ruleLink(ruleId: string): string {
  return safeRuleLink(ruleId, MAX_PATH_LENGTH);
}

/**
 * The Fix cell: the class of the finding's fix, `needs your words (fix -i)` for a fix that
 * needs the user's words, or `—`.
 */
function fixCell(finding: Finding): string {
  const fix = fixOf(finding, 'pull-request');
  if (fix === undefined) return '—';
  return needsWords(fix) ? INPUT_FIX_LABEL : fix.class;
}

/**
 * One table row. A new finding is marked **new**, or **new rule** when its rule is newer than
 * the baseline's rule set, so it is not mistaken for a regression. With `withFix`, a last cell
 * says what fixes the finding ({@link fixCell}).
 */
function findingRow(finding: Finding, newRules: ReadonlySet<string>, withFix: boolean): string {
  const where = `${text(finding.path, MAX_PATH_LENGTH)}:${finding.range.start.line}`;
  const message = text(finding.message, MAX_MESSAGE_LENGTH);
  const severity = SEVERITY_LABELS[finding.severity];
  let marked = severity;
  if (finding.baseline === 'new') {
    marked = `**${newRules.has(finding.ruleId) ? 'new rule' : 'new'}** ${severity}`;
  }
  const row = `| ${where} | ${marked} | ${ruleLink(finding.ruleId)} | ${message} |`;
  return withFix ? `${row} ${fixCell(finding)} |` : row;
}

/**
 * Unsuppressed findings: new ones first when the scan has a baseline, then most severe first,
 * otherwise in report order.
 */
function ranked(result: ScanResult): Finding[] {
  const fresh = (finding: Finding): number => (finding.baseline === 'new' ? 1 : 0);
  return result.findings
    .map((finding, position) => ({ finding, position }))
    .filter((entry) => !entry.finding.suppressed)
    .sort(
      (a, b) =>
        fresh(b.finding) - fresh(a.finding) ||
        SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
        a.position - b.position,
    )
    .map((entry) => entry.finding);
}

function findingsSection(
  result: ScanResult,
  maxFindings: number,
  budget: number,
  withFix: boolean,
): string[] {
  const findings = ranked(result);
  if (findings.length === 0) {
    return result.score.score === null ? [] : ['No problems found.'];
  }
  const newRules = newRuleSet(result);
  const rows: string[] = [];
  let size = 0;
  for (const finding of findings.slice(0, maxFindings)) {
    const row = findingRow(finding, newRules, withFix);
    const bytes = utf8Length(row);
    if (size + bytes > budget) break;
    rows.push(row);
    size += bytes + 1;
  }
  const lines = ['### Findings', ''];
  if (rows.length > 0) {
    lines.push(
      withFix
        ? '| Location | Severity | Rule | Message | Fix |'
        : '| Location | Severity | Rule | Message |',
      withFix
        ? '| :------- | :------- | :--- | :------ | :-- |'
        : '| :------- | :------- | :--- | :------ |',
      ...rows,
    );
  }
  if (rows.length < findings.length) {
    if (rows.length > 0) lines.push('');
    lines.push(
      `Showing ${shownOf(rows.length, findings.length)} ${findings.length === 1 ? 'finding' : 'findings'}, most severe first. ` +
        'Run `npx agentcheckup` locally for the full report.',
    );
  }
  return lines;
}

/** `| Cursor | .cursor/rules/style.md | only .mdc files are read here (≈310 tokens) | review |`. */
function impactRow(row: ImpactRow): string {
  const { subject } = row;
  const what =
    subject.prefix === undefined
      ? text(subject.text, MAX_PATH_LENGTH)
      : `${subject.prefix} ${text(subject.text, MAX_PATH_LENGTH)}`;
  const label = text(row.label, MAX_MESSAGE_LENGTH);
  const why =
    row.importer === undefined
      ? label
      : `${text(row.importer, MAX_PATH_LENGTH)} imports it, but ${label}`;
  const tokens = row.tokens === undefined ? '' : ` (≈${formatInteger(row.tokens)} tokens)`;
  return `| ${row.agentName} | ${what} | ${why}${tokens} | ${row.fix === undefined ? '—' : skipFixLabel(row.fix)} |`;
}

/**
 * What each agent misses, from the root load plans; with a baseline that has plan deltas, only
 * what the change makes them miss. No lines without plans or skips.
 */
function impactSection(result: ScanResult): string[] {
  const impact = impactOf(result, { onlyNew: true });
  if (impact === undefined || impact.rows.length === 0) return [];
  const { rows } = cappedRows(impact.rows, impactRow, MAX_IMPACT_ROWS, MAX_IMPACT_BYTES);
  const note = omittedNote(rows.length, impact.rows.length, 'skip');
  return [
    impact.onlyNew ? '### What this change makes each agent miss' : '### What each agent misses',
    '',
    '| Agent | Not loaded | Why | Fix |',
    '| :---- | :--------- | :-- | :-- |',
    ...rows,
    ...(note.length > 0 ? ['', ...note] : []),
  ];
}

/**
 * `Preview 4 fixes locally: \`npx agentcheckup fix\``, when any finding has a fix, followed by
 * `· 1 needs your words: \`npx agentcheckup fix -i\`` when a fix needs the user's words.
 */
function previewLine(result: ScanResult): string[] {
  const counts = fixCounts(result.findings, 'pull-request');
  const fixes = counts.safe + counts.review;
  const parts: string[] = [];
  if (fixes > 0) {
    parts.push(`Preview ${plural(fixes, 'fix', 'fixes')} locally: \`npx agentcheckup fix\``);
  }
  if (counts.input > 0) {
    const verb = counts.input === 1 ? 'needs' : 'need';
    const subject = fixes > 0 ? String(counts.input) : plural(counts.input, 'fix', 'fixes');
    parts.push(`${subject} ${verb} your words: \`npx agentcheckup fix -i\``);
  }
  return parts.length === 0 ? [] : [parts.join(' · ')];
}

/** Markdown report ending with a newline. */
export function formatMarkdown(result: ScanResult, options: MarkdownOptions = {}): string {
  const requested = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxFindings = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const detailed = (options.level ?? 'default') !== 'compact';

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
  const policy = policySection(result);
  if (policy.length > 0) blocks.push(policy);
  const baseline = baselineSummary(result, MAX_BASELINE_BYTES);
  if (baseline.length > 0) blocks.push(baseline);
  const failures = ruleFailures(result);
  if (failures.length > 0) blocks.push(failures);
  const notes = notices(result);
  if (notes.length > 0) blocks.push(notes);
  const impact = detailed ? impactSection(result) : [];
  if (impact.length > 0) blocks.push(impact);
  const used = [...policy, ...baseline, ...impact].reduce(
    (size, line) => size + utf8Length(line) + 1,
    0,
  );
  const findings = findingsSection(
    result,
    maxFindings,
    Math.max(0, MAX_TABLE_BYTES - used),
    detailed,
  );
  if (findings.length > 0) blocks.push(findings);
  const preview = detailed ? previewLine(result) : [];
  if (preview.length > 0) blocks.push(preview);
  blocks.push([
    '---',
    '',
    `Generated by [agentcheckup](${REPOSITORY_URL}) ${forMarkdown(result.tool.version)} · ruleset ${forMarkdown(result.ruleset)}`,
  ]);

  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
