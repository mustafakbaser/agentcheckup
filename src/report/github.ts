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
 * remain in the log. Paths are relative to the scan root, which GitHub resolves against the
 * repository root.
 */
import type { ScanResult } from '../core/engine.js';
import type { Finding, Severity } from '../core/types.js';
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

/**
 * Workflow commands, one per line, ending with a newline; empty when there is nothing to
 * annotate. A rule that crashed is reported as an error annotation too: the results are
 * incomplete, and in CI this output may be the only thing anyone reads.
 */
export function formatGithub(result: ScanResult): string {
  const lines = result.findings.filter((finding) => !finding.suppressed).map(annotation);
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
