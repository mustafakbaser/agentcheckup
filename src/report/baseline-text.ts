/**
 * Terminal text for a comparison with `--baseline`, printed after the load plans of
 * `agentcheckup context`: the security-relevant changes that trip the gate, the finding counts,
 * and the change in session-start context. The scan's stylish output has its own baseline lines
 * (stylish.ts); the content matches the Markdown summary (baseline-markdown.ts).
 *
 * Gate summaries, paths and the baseline's ruleset come from repositories or from the baseline
 * file: every such string goes through `forTerminal`, and the output through
 * `guardWorkflowCommands`.
 */
import type { ScanResult } from '../core/engine.js';
import { stripPathBase } from '../core/rebase.js';
import { contextDeltas } from './baseline-markdown.js';
import type { ContextTextOptions } from './context-text.js';
import { gateLocations, gateRows, newRuleFindings } from './gate.js';
import { toJsonBaseline } from './json.js';
import { forTerminal, guardWorkflowCommands } from './sanitize.js';
import { plainStyle } from './stylish.js';
import { plural, truncate } from './text.js';

/** Gate rows listed before `… and N more`. */
const MAX_LISTED = 10;
const MAX_TEXT_LENGTH = 300;

/**
 * The baseline comparison as terminal text ending with a newline; empty when the result has no
 * baseline. Paths are relative to the scanned directory, as in the context output it follows
 * (see contextView).
 */
export function formatBaselineText(input: ScanResult, options: ContextTextOptions = {}): string {
  if (input.baseline === undefined) return '';
  const result = stripPathBase(input);
  if (result.baseline === undefined) return '';
  const style = options.style ?? plainStyle;
  const ascii = options.ascii === true;
  const more = ascii ? '...' : '…';
  const clean = (value: string, max: number): string =>
    forTerminal(truncate(value, max, more), { ascii }).replaceAll('\t', ' ');
  const diff = toJsonBaseline(result.baseline);
  const lines = [style.bold('Since the baseline')];

  if (diff.gate.classes.length > 0) {
    const rows = gateRows(diff);
    if (rows.length === 0) {
      lines.push(`${ascii ? '' : '✔ '}No security-relevant changes need review`);
    } else {
      const verb = rows.length === 1 ? 'needs' : 'need';
      lines.push(
        style.red(
          style.bold(
            `${ascii ? 'x' : '✖'} ${plural(rows.length, 'security-relevant change')} ${verb} review`,
          ),
        ),
      );
      const locate = gateLocations(result);
      for (const row of rows.slice(0, MAX_LISTED)) {
        const where = row.hit.class === 'unicode' ? undefined : locate(row.hit);
        const at =
          where === undefined
            ? ''
            : style.dim(
                ` ${ascii ? '-' : '·'} ${clean(`${where.file}:${String(where.line)}`, MAX_TEXT_LENGTH)}`,
              );
        lines.push(`    ${style.bold(row.label)}: ${clean(row.hit.summary, MAX_TEXT_LENGTH)}${at}`);
      }
      if (rows.length > MAX_LISTED) {
        lines.push(`    ${more} and ${rows.length - MAX_LISTED} more`);
      }
    }
  }

  const { findings } = diff;
  const fromNewRules = newRuleFindings(result);
  const newRules = fromNewRules > 0 ? ` (${fromNewRules} from new rules)` : '';
  lines.push(
    `Findings: ${findings.new} new${newRules}, ${findings.unchanged} unchanged, ` +
      `${findings.resolved.length} resolved`,
  );

  const deltas = contextDeltas(result, diff, clean);
  if (deltas !== undefined) {
    lines.push('Session-start context:');
    for (const part of deltas.changed) lines.push(`  ${part}`);
    if (deltas.unchanged.length > 0) lines.push(`  Unchanged: ${deltas.unchanged.join(', ')}`);
    if (deltas.hidden > 0) lines.push(`  and ${plural(deltas.hidden, 'more plan')}`);
  }

  if (!diff.against.sameRuleset) {
    lines.push(
      `! The baseline was written with ruleset ${clean(diff.against.ruleset, MAX_TEXT_LENGTH)}, ` +
        'so findings from rules it did not run count as new.',
    );
  }
  return guardWorkflowCommands(`${lines.join('\n')}\n`);
}
