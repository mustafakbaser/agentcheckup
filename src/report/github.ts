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
 * GitHub shows at most 10 annotations of each type per step (50 per job) in the UI; the rest
 * remain in the log. GitHub resolves `file` against the repository root, so the CLI rebases
 * paths onto $GITHUB_WORKSPACE for this format when the scanned directory is inside it.
 */
import type { BaselineDiff } from '../core/baseline-types.js';
import type { ScanResult } from '../core/engine.js';
import type { Finding, Severity } from '../core/types.js';
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
import { gateRows } from './gate.js';
import { policyAnnotations } from './policy-github.js';
import { forWorkflowCommand, forWorkflowProperty, NEWLINE_MARKER } from './sanitize.js';
import { truncate } from './text.js';

export interface GithubOptions {
  /** How much to show. Default `default`; `verbose` shows what `default` does. */
  readonly level?: DetailLevel | undefined;
}

/** Fix titles and guidance longer than this (code points) are cut. */
const MAX_DETAIL_LENGTH = 500;
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

/** Where an inventory item is declared, by id, for gate annotations. */
function itemLocations(result: ScanResult): Map<string, { file: string; line: number }> {
  const map = new Map<string, { file: string; line: number }>();
  const { mcpServers, hooks, permissions, env } = result.inventory;
  for (const item of [...mcpServers, ...hooks, ...permissions, ...env]) {
    if (!map.has(item.id)) map.set(item.id, { file: item.file, line: item.line });
  }
  return map;
}

/**
 * One error annotation per security-relevant change that trips `--gate`, on the file and line
 * that declare it when they are known.
 */
function gateAnnotations(result: ScanResult, diff: BaselineDiff): string[] {
  const rows = gateRows(diff);
  if (rows.length === 0) return [];
  const items = itemLocations(result);
  return rows.map(({ hit, label }) => {
    const finding =
      hit.class === 'unicode'
        ? result.findings.find((candidate) => candidate.fingerprint === hit.id)
        : undefined;
    const where =
      finding === undefined
        ? items.get(hit.id)
        : { file: finding.path, line: finding.range.start.line };
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

/**
 * Workflow commands, one per line, ending with a newline; empty when there is nothing to
 * annotate. A rule that crashed is reported as an error annotation too: the results are
 * incomplete, and in CI this output may be the only thing anyone reads.
 *
 * With `--baseline`, only new findings are annotated (unchanged ones were there before the
 * change under review), each security-relevant change that trips `--gate` gets an error
 * annotation, and a baseline from another ruleset gets a warning. With `--policy`, violations
 * get annotations of their own (policy-github.ts).
 */
export function formatGithub(result: ScanResult, options: GithubOptions = {}): string {
  const level = options.level ?? 'default';
  const plans = planIndex(result);
  const lines = result.findings
    .filter((finding) => !finding.suppressed && finding.baseline !== 'unchanged')
    .map((finding) => annotation(finding, level, plans));
  const diff = result.baseline;
  if (diff !== undefined) {
    lines.push(...gateAnnotations(result, diff));
    if (!diff.against.sameRuleset) {
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
  }
  lines.push(...policyAnnotations(result));
  for (const failure of result.ruleFailures) {
    lines.push(
      command(
        'error',
        [['title', forWorkflowProperty('agentcheckup internal error')]],
        forWorkflowCommand(
          `Rule ${failure.ruleId} failed to run, so results are incomplete: ${failure.message}`,
        ),
      ),
    );
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
