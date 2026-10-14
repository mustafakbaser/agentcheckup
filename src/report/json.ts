/**
 * JSON report: the ScanResult, described by schemas/report.schema.json (`schemaVersion`).
 *
 * The result is rebuilt field by field before serializing, so key order is fixed by this file
 * rather than by how the engine happened to construct its objects, and stray runtime properties
 * cannot leak into a published format. Adding a required field to ScanResult fails type
 * checking here, which is the reminder to update the schema too.
 */
import type { ScanResult } from '../core/engine.js';
import type { CategoryTally, ScoreReport } from '../core/score.js';
import {
  CATEGORIES,
  type Category,
  type Finding,
  type Position,
  type Range,
  type RuleMeta,
  type RuleSource,
} from '../core/types.js';
import { forJsonOutput } from './sanitize.js';

function position(value: Position): Position {
  return { line: value.line, column: value.column };
}

function range(value: Range): Range {
  return { start: position(value.start), end: position(value.end) };
}

function finding(value: Finding): Finding {
  return {
    ruleId: value.ruleId,
    severity: value.severity,
    category: value.category,
    message: value.message,
    path: value.path,
    range: range(value.range),
    related: value.related.map((related) => ({
      path: related.path,
      message: related.message,
      ...(related.range ? { range: range(related.range) } : {}),
    })),
    platforms: [...value.platforms],
    fingerprint: value.fingerprint,
    ...(value.fix
      ? {
          fix: {
            description: value.fix.description,
            safety: value.fix.safety,
            edits: value.fix.edits.map((edit) => ({
              offset: edit.offset,
              length: edit.length,
              text: edit.text,
            })),
          },
        }
      : {}),
    ...(value.suppressed
      ? { suppressed: { kind: value.suppressed.kind, reason: value.suppressed.reason } }
      : {}),
  };
}

function tally(value: CategoryTally): CategoryTally {
  return { errors: value.errors, warnings: value.warnings, infos: value.infos };
}

function score(value: ScoreReport): ScoreReport {
  return {
    formula: value.formula,
    score: value.score,
    grade: value.grade,
    capped: value.capped,
    categories: Object.fromEntries(
      CATEGORIES.map((category) => [category, tally(value.categories[category])]),
    ) as Record<Category, CategoryTally>,
    artifacts: value.artifacts.map((artifact) => ({ path: artifact.path, score: artifact.score })),
  };
}

function source(value: RuleSource): RuleSource {
  return { title: value.title, url: value.url, checked: value.checked, status: value.status };
}

function rule(value: RuleMeta): RuleMeta {
  const [first, ...rest] = value.sources;
  return {
    id: value.id,
    title: value.title,
    rationale: value.rationale,
    category: value.category,
    severity: value.severity,
    appliesTo: [...value.appliesTo],
    platforms: [...value.platforms],
    sources: [source(first), ...rest.map(source)],
    since: value.since,
    ...(value.fixable ? { fixable: value.fixable } : {}),
  };
}

/** A canonical copy of `result`: fixed key order, only the documented properties. */
export function toJsonReport(result: ScanResult): ScanResult {
  return {
    schemaVersion: result.schemaVersion,
    tool: { name: result.tool.name, version: result.tool.version },
    ruleset: result.ruleset,
    targets: [...result.targets],
    artifacts: result.artifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      readers: [...artifact.readers],
    })),
    findings: result.findings.map(finding),
    score: score(result.score),
    summary: {
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      infos: result.summary.infos,
      suppressed: result.summary.suppressed,
    },
    rules: result.rules.map(rule),
    skipped: result.skipped.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    })),
    unresolvedSymlinks: result.unresolvedSymlinks.map((link) => ({
      path: link.path,
      target: link.target,
      problem: link.problem,
    })),
    ruleFailures: result.ruleFailures.map((failure) => ({
      ruleId: failure.ruleId,
      message: failure.message,
    })),
    configWarnings: [...result.configWarnings],
  };
}

/**
 * Pretty JSON (2-space indent, trailing newline). Lossless: string values are exactly the
 * scanned data, with display-dangerous characters written as `\uXXXX` escapes (see
 * {@link forJsonOutput}).
 */
export function formatJson(result: ScanResult): string {
  return `${forJsonOutput(JSON.stringify(toJsonReport(result), null, 2))}\n`;
}
