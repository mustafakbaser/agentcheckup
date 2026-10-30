/**
 * GitHub Actions workflow commands: one annotation per unsuppressed finding.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 *
 *   ::error file=CLAUDE.md,line=3,col=5,endLine=3,endColumn=20,title=<rule id>::<message>
 *
 * Every property value and the message go through the workflow-command sanitizers, so each
 * finding is exactly one line and no untrusted text can start a command of its own.
 *
 * A finding with a fix gets `(fix: safe)` or `(fix: review)` in its title, or
 * `(fix: needs your words)` when only `agentcheckup fix -i` can complete the fix. At the
 * `default` and `verbose` levels the body adds lines, joined as `%0A`: `Why:` when the root load
 * plans add a fact the message lacks, `Fix:` (or `How:` for manual guidance) and `Docs:` with the
 * rule's documentation URL. Each added line is single-line: a line break in a fix title or
 * guidance is shown as `⏎`, so it cannot fake another line of the body.
 *
 * GitHub shows the first 10 error, 10 warning and 10 notice annotations of a step (and 50 per
 * job); the rest remain in the log only. The output is therefore ordered by what a reader must
 * see: rule failures, changes that trip `--gate` and policy violations that fail the run, then
 * findings by severity, `risk` findings first. When GitHub will not show every annotation, a
 * notice ahead of the other notices says how many are only in the log. GitHub resolves `file`
 * against the repository root, so the CLI rebases paths onto $GITHUB_WORKSPACE for this format
 * when the scanned directory is inside it.
 * https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md#limitations
 */
import type { BaselineDiff } from '../core/baseline-types.js';
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import type { Finding, Severity } from '../core/types.js';
import { joinNames } from '../rules/shared/format.js';
import {
  type DetailLevel,
  docsUrl,
  fixOf,
  guidanceOf,
  needsWords,
  type PlanIndex,
  planIndex,
  whyText,
} from './feedback.js';
import { gateLocations, gateRows } from './gate.js';
import { policyAnnotations } from './policy-github.js';
import { forWorkflowCommand, forWorkflowProperty, NEWLINE_MARKER } from './sanitize.js';
import { SEVERITY_RANK, truncate } from './text.js';

export interface GithubOptions {
  /** How much to show. Default `default`; `verbose` shows what `default` does. */
  readonly level?: DetailLevel | undefined;
}

/** Fix titles and guidance longer than this (code points) are cut. */
const MAX_DETAIL_LENGTH = 500;
/**
 * Annotations of each type GitHub shows for a step (the runner's `_maxCountPerIssueType`).
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs
 */
export const MAX_ANNOTATIONS_PER_TYPE = 10;
const LINE_BREAK = /\r\n?|\n/g;

/** Untrusted text for one line of an annotation body: line breaks shown as `⏎`, cut. */
function oneLine(text: string): string {
  return truncate(text, MAX_DETAIL_LENGTH).replace(LINE_BREAK, NEWLINE_MARKER);
}

type AnnotationCommand = 'error' | 'warning' | 'notice';

const COMMANDS: Readonly<Record<Severity, AnnotationCommand>> = {
  error: 'error',
  warn: 'warning',
  info: 'notice',
};

/** `::<command> k=v,k=v::<data>`, all values already escaped. */
function command(
  name: AnnotationCommand,
  properties: readonly (readonly [string, string])[],
  data: string,
): string {
  const list = properties.map(([key, value]) => `${key}=${value}`).join(',');
  return `::${name} ${list}::${data}`;
}

/**
 * `rule/id (fix: safe)` for a finding with a fix, `rule/id (fix: needs your words)` for one whose
 * fix needs the user's words, else the rule id.
 */
function title(finding: Finding): string {
  const fix = fixOf(finding, 'pull-request');
  if (fix === undefined) return finding.ruleId;
  return `${finding.ruleId} (fix: ${needsWords(fix) ? 'needs your words' : fix.class})`;
}

/** The message, then the Why, Fix or How, and Docs lines the level asks for. */
function body(finding: Finding, level: DetailLevel, plans: PlanIndex): string {
  if (level === 'compact') return finding.message;
  const lines = [finding.message];
  const facts = plans.facts(finding);
  if (facts !== undefined) lines.push(`Why: ${whyText(facts, '≈')}`);
  const fix = fixOf(finding, 'pull-request');
  const guidance = guidanceOf(finding);
  if (fix !== undefined) {
    const kind = needsWords(fix) ? 'needs your words, agentcheckup fix -i' : fix.class;
    lines.push(`Fix (${kind}): ${oneLine(fix.title)}`);
  } else if (guidance !== undefined) lines.push(`How: ${oneLine(guidance)}`);
  const url = docsUrl(finding.ruleId);
  if (url !== undefined) lines.push(`Docs: ${url}`);
  return lines.join('\n');
}

function annotation(finding: Finding, level: DetailLevel, plans: PlanIndex): string {
  const { start, end } = finding.range;
  return command(
    COMMANDS[finding.severity],
    [
      ['file', forWorkflowProperty(finding.path)],
      ['line', String(start.line)],
      ['col', String(start.column)],
      ['endLine', String(end.line)],
      ['endColumn', String(end.column)],
      ['title', forWorkflowProperty(title(finding))],
    ],
    forWorkflowCommand(body(finding, level, plans)),
  );
}

/**
 * One error annotation per change that trips `--gate`, on the file and line that declare it when
 * they are known.
 */
function gateAnnotations(result: ScanResult, diff: BaselineDiff): string[] {
  const rows = gateRows(diff);
  if (rows.length === 0) return [];
  const locate = gateLocations(result);
  return rows.map(({ hit, label }) => {
    const where = locate(hit);
    const properties: (readonly [string, string])[] =
      where === undefined
        ? []
        : [
            ['file', forWorkflowProperty(where.file)],
            ['line', String(Math.max(1, where.line))],
          ];
    properties.push(['title', forWorkflowProperty(`Needs review: ${label}`)]);
    return command('error', properties, forWorkflowCommand(hit.summary));
  });
}

/** More severe first, `risk` first within a severity, otherwise in report order. */
function ranked(findings: readonly Finding[]): Finding[] {
  const risk = (finding: Finding): number => (finding.category === 'risk' ? 0 : 1);
  return findings
    .map((finding, position) => ({ finding, position }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
        risk(a.finding) - risk(b.finding) ||
        a.position - b.position,
    )
    .map(({ finding }) => finding);
}

/** `1 error`, `29,990 errors`. */
function counted(count: number, noun: string): string {
  return `${formatInteger(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** How many lines of `lines` are annotations of `type`. */
function countOf(lines: readonly string[], type: AnnotationCommand): number {
  return lines.filter((line) => line.startsWith(`::${type} `)).length;
}

/**
 * `lines` with a notice when GitHub will not show all of them, saying how many are only in the
 * log. It goes ahead of the other notices so that it is shown itself; it then counts against
 * the notices' cap too.
 */
function withOverflowNotice(lines: readonly string[]): readonly string[] {
  const hidden = (count: number): number => Math.max(0, count - MAX_ANNOTATIONS_PER_TYPE);
  const errors = hidden(countOf(lines, 'error'));
  const warnings = hidden(countOf(lines, 'warning'));
  if (errors + warnings + hidden(countOf(lines, 'notice')) === 0) return lines;
  const notices = hidden(countOf(lines, 'notice') + 1);
  const parts = [
    errors > 0 ? counted(errors, 'error') : '',
    warnings > 0 ? counted(warnings, 'warning') : '',
    notices > 0 ? counted(notices, 'notice') : '',
  ].filter((part) => part !== '');
  const verb = errors + warnings + notices === 1 ? 'is' : 'are';
  const notice = command(
    'notice',
    [['title', forWorkflowProperty('agentcheckup annotations')]],
    forWorkflowCommand(
      `GitHub shows ${MAX_ANNOTATIONS_PER_TYPE} annotations of each type per step, so ` +
        `${joinNames(parts)} from agentcheckup ${verb} only in the log. The ones that fail ` +
        'the run come first, then the findings by severity.',
    ),
  );
  const first = lines.findIndex((line) => line.startsWith('::notice '));
  const at = first === -1 ? lines.length : first;
  return [...lines.slice(0, at), notice, ...lines.slice(at)];
}

/**
 * Workflow commands, one per line, ending with a newline; empty when there is nothing to
 * annotate. A rule that crashed is reported as an error annotation too: the results are
 * incomplete, and in CI this output may be the only thing anyone reads.
 *
 * With `--baseline`, only new findings are annotated (unchanged ones were there before the
 * change under review), each change that trips `--gate` gets an error annotation, and a baseline
 * from another ruleset gets a warning. With `--policy`, violations get annotations of their own
 * (policy-github.ts). The order: rule failures, gate hits and failing policy violations (the
 * errors that decide the run), the baseline's ruleset warning, the findings ranked by severity,
 * then the other policy annotations.
 */
export function formatGithub(result: ScanResult, options: GithubOptions = {}): string {
  const level = options.level ?? 'default';
  const plans = planIndex(result);
  const diff = result.baseline;
  const policy = policyAnnotations(result);
  const lines = result.ruleFailures.map((failure) =>
    command(
      'error',
      [['title', forWorkflowProperty('agentcheckup internal error')]],
      forWorkflowCommand(
        `Rule ${failure.ruleId} failed to run, so results are incomplete: ${failure.message}`,
      ),
    ),
  );
  if (diff !== undefined) lines.push(...gateAnnotations(result, diff));
  lines.push(...policy.failing);
  if (diff !== undefined && !diff.against.sameRuleset) {
    lines.push(
      command(
        'warning',
        [['title', forWorkflowProperty('agentcheckup baseline')]],
        forWorkflowCommand(
          `The baseline was written with ruleset ${diff.against.ruleset}, so findings from rules it did not run count as new.`,
        ),
      ),
    );
  }
  const findings = result.findings.filter(
    (finding) => !finding.suppressed && finding.baseline !== 'unchanged',
  );
  lines.push(...ranked(findings).map((finding) => annotation(finding, level, plans)));
  lines.push(...policy.other);
  return lines.length === 0 ? '' : `${withOverflowNotice(lines).join('\n')}\n`;
}
