/**
 * GitHub Actions annotations for a `--policy` check, titled `policy: <check>`: an error for each
 * violation that fails the run, a warning for each other violation the change brings (audit
 * mode, or no baseline), on the file and line when the violation has them, and a notice for
 * each note. A violation the baseline had that does not fail the run was there before the change,
 * so, like an unchanged finding, it is not annotated. The errors and the rest come apart: the
 * GitHub output puts the errors before the findings, and the rest after them (github.ts).
 *
 * Every property value and message goes through the workflow-command sanitizers, so each
 * annotation is one line and no policy or repository text can start a command of its own.
 */
import type { ScanResult } from '../core/engine.js';
import { quote } from '../rules/shared/format.js';
import { checkDocsUrl, isPolicyCheck, shortSha } from './policy-common.js';
import { forWorkflowCommand, forWorkflowProperty, NEWLINE_MARKER } from './sanitize.js';

type Property = readonly [string, string];

const LINE_BREAK = /\r\n?|\n/g;

/**
 * Text for one line of an annotation body. The body's lines are joined with line breaks, so a
 * line break inside a value is shown as `⏎` and cannot fake a line such as `Docs:`.
 */
function oneLine(text: string): string {
  return text.replace(LINE_BREAK, NEWLINE_MARKER);
}

/** `::<command> k=v,k=v::<data>`, all values already escaped. */
function command(
  name: 'error' | 'warning' | 'notice',
  properties: readonly Property[],
  data: string,
): string {
  const list = properties.map(([key, value]) => `${key}=${value}`).join(',');
  return `::${name} ${list}::${data}`;
}

/** A policy's annotations, one per line, without line endings. */
export interface PolicyAnnotations {
  /** Errors, for the violations that fail the run. */
  readonly failing: readonly string[];
  /** Warnings for the other violations the change brings, then a notice for each note. */
  readonly other: readonly string[];
}

const NONE: PolicyAnnotations = { failing: [], other: [] };

/** The annotations, in report order within each part; none without a policy. */
export function policyAnnotations(result: ScanResult): PolicyAnnotations {
  const report = result.policy;
  if (report === undefined) return NONE;
  const source = oneLine(`Policy: ${quote(report.name)} (sha256 ${shortSha(report.sha256)})`);
  const failing: string[] = [];
  const other: string[] = [];
  for (const violation of report.violations) {
    if (!violation.fails && violation.baseline === 'unchanged') continue;
    const properties: Property[] = [];
    if (violation.path !== undefined) {
      properties.push(['file', forWorkflowProperty(violation.path)]);
      if (violation.line !== undefined) {
        properties.push(['line', String(Math.max(1, violation.line))]);
      }
    }
    properties.push(['title', forWorkflowProperty(`policy: ${violation.check}`)]);
    const body = [oneLine(violation.message), source];
    if (isPolicyCheck(violation.check)) body.push(`Docs: ${checkDocsUrl(violation.check)}`);
    const data = forWorkflowCommand(body.join('\n'));
    if (violation.fails) failing.push(command('error', properties, data));
    else other.push(command('warning', properties, data));
  }
  for (const note of report.notes) {
    other.push(
      command(
        'notice',
        [['title', forWorkflowProperty('policy')]],
        forWorkflowCommand(oneLine(note.message)),
      ),
    );
  }
  return { failing, other };
}
