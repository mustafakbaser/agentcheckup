/**
 * GitHub Actions workflow commands: one annotation per unsuppressed finding.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 *
 *   ::error file=CLAUDE.md,line=3,col=5,endLine=3,endColumn=20,title=<rule id>::<message>
 *
 * Every property value and the message go through the workflow-command sanitizers, so each
 * finding is exactly one line and no untrusted text can start a command of its own.
 *
 * GitHub shows at most 10 annotations of each type per step (50 per job) in the UI; the rest
 * remain in the log. GitHub resolves `file` against the repository root, so the CLI rebases
 * paths onto $GITHUB_WORKSPACE for this format when the scanned directory is inside it.
 */
import type { BaselineDiff } from '../core/baseline-types.js';
import type { ScanResult } from '../core/engine.js';
import type { Finding, Severity } from '../core/types.js';
import { gateRows } from './gate.js';
import { forWorkflowCommand, forWorkflowProperty } from './sanitize.js';

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

function annotation(finding: Finding): string {
  const { start, end } = finding.range;
  return command(
    COMMANDS[finding.severity],
    [
      ['file', forWorkflowProperty(finding.path)],
      ['line', String(start.line)],
      ['col', String(start.column)],
      ['endLine', String(end.line)],
      ['endColumn', String(end.column)],
      ['title', forWorkflowProperty(finding.ruleId)],
    ],
    forWorkflowCommand(finding.message),
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
 * annotation, and a baseline from another ruleset gets a warning.
 */
export function formatGithub(result: ScanResult): string {
  const lines = result.findings
    .filter((finding) => !finding.suppressed && finding.baseline !== 'unchanged')
    .map(annotation);
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
