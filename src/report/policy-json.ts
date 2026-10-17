/**
 * The `policy` field of the JSON report (schemas/report.schema.json), rebuilt with a fixed key
 * order and only the documented properties, as json.ts does for the rest of the report. The
 * policy core already sorts violations, and notes come in a fixed order.
 */
import type { PolicyNote, PolicyReport, PolicyViolation } from '../policy/types.js';

function violation(value: PolicyViolation): PolicyViolation {
  return {
    id: value.id,
    check: value.check,
    entry: value.entry,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.line === undefined ? {} : { line: value.line }),
    ...(value.agent === undefined ? {} : { agent: value.agent }),
    message: value.message,
    ...(value.baseline === undefined ? {} : { baseline: value.baseline }),
    fails: value.fails,
  };
}

function note(value: PolicyNote): PolicyNote {
  return {
    id: value.id,
    message: value.message,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.line === undefined ? {} : { line: value.line }),
  };
}

/** A canonical copy of a policy report. */
export function toJsonPolicy(report: PolicyReport): PolicyReport {
  return {
    name: report.name,
    sha256: report.sha256,
    mode: report.mode,
    insideScanRoot: report.insideScanRoot,
    checks: report.checks,
    violations: report.violations.map(violation),
    notes: report.notes.map(note),
  };
}
