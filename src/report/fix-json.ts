/**
 * `agentcheckup fix --format json`: a {@link FixRun} as the object schemas/fix.schema.json
 * describes.
 *
 * Like the scan report (src/report/json.ts), the object is built field by field in the order of
 * the schema, so key order is fixed here and no stray runtime property reaches the output.
 * Lists whose order carries no meaning are sorted with `compareStrings`: files by path, effects
 * by agent and gate class, finding fingerprints, introduced findings by path and line. Fixes and
 * manual steps keep the planner's order, which depends only on the scan.
 *
 * Paths are relative to the scan root with `pathBase` in front, as in the scan report. A path
 * that is absolute or climbs out with `..` is an internal error and throws: the report must never
 * name one. Hunks, titles, notes, warnings, guidance and messages are redacted like the human
 * output (see src/report/fix-diff.ts); serialization escapes display-dangerous characters
 * (`forJsonOutput`).
 */
import { compareStrings } from '../core/compare.js';
import { TOOL_NAME, RULESET_VERSION } from '../core/meta.js';
import { VERSION } from '../core/version.js';
import type {
  FileReport,
  FileState,
  FixEffect,
  FixReport,
  FixReportEntry,
  IntroducedFinding,
  ManualStep,
  PlannedFix,
} from '../fix/index.js';
import {
  type ChangedFile,
  changedFileHunks,
  type FixRun,
  normalizedBase,
  type Redact,
  runRedactor,
  sortedEffects,
  withBase,
} from './fix-diff.js';
import { forJsonOutput } from './sanitize.js';

export interface FixJsonOptions {
  /** Default: agentcheckup and its version. */
  readonly tool?: { readonly name: string; readonly version: string } | undefined;
  /** Default: the rule set of this build. */
  readonly ruleset?: string | undefined;
}

/** Thrown for a path the fix report must not contain. */
export class UnsafeReportPathError extends Error {
  constructor() {
    super('A fix report path is absolute or leaves the scan root.');
    this.name = 'UnsafeReportPathError';
  }
}

const DRIVE_LETTER = /^[a-z]:/i;

/** Rejects what schemas/fix.schema.json rejects: absolute paths, drive letters and `..`. */
function checkedPath(path: string): string {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    DRIVE_LETTER.test(path) ||
    path.split('/').includes('..')
  ) {
    throw new UnsafeReportPathError();
  }
  return path;
}

interface Builder {
  readonly redact: Redact;
  /** A path of the report: `pathBase` in front, checked. */
  readonly path: (path: string) => string;
  /** A directory (`''` for the root) with `pathBase` in front. */
  readonly directory: (path: string) => string;
}

function builderOf(run: FixRun): Builder {
  const base = normalizedBase(run.pathBase);
  if (base !== '') checkedPath(base);
  return {
    redact: runRedactor(run),
    path: (path) => checkedPath(withBase(base, path)),
    directory: (path) => {
      const joined = withBase(base, path);
      return joined === '' ? '' : checkedPath(joined);
    },
  };
}

/** `<kind>:<path>…` gets the base after its kind, as `rebaseResult` maps inventory ids. */
function itemId(id: string, base: string): string {
  const colon = id.indexOf(':');
  if (base === '' || colon < 0) return id;
  return `${id.slice(0, colon + 1)}${withBase(base, id.slice(colon + 1))}`;
}

function effect(value: FixEffect, builder: Builder, base: string): FixEffect {
  switch (value.kind) {
    case 'tokens':
      return {
        kind: 'tokens',
        agent: value.agent,
        cwd: builder.directory(value.cwd),
        before: value.before,
        after: value.after,
      };
    case 'gate':
      return {
        kind: 'gate',
        class: value.class,
        id: value.class === 'unicode' ? value.id : itemId(value.id, base),
        change: value.change,
        summary: builder.redact(value.summary),
      };
  }
}

function fixEntry(value: PlannedFix, builder: Builder, base: string): FixReportEntry {
  const decision = {
    id: value.fix.id,
    ruleId: value.ruleId,
    class: value.fix.class,
    title: builder.redact(value.fix.title),
    effects: sortedEffects(value.effects).map((entry) => effect(entry, builder, base)),
    findings: [...new Set(value.findings)].sort(compareStrings),
    ...(value.fix.notes === undefined ? {} : { notes: value.fix.notes.map(builder.redact) }),
    ...(value.fix.warning === undefined ? {} : { warning: builder.redact(value.fix.warning) }),
  };
  return value.status === 'skipped'
    ? { ...decision, status: value.status, reason: value.reason }
    : { ...decision, status: value.status };
}

function fileState(value: FileState): FileState {
  return {
    sha256: value.sha256,
    encoding: value.encoding,
    bom: value.bom,
    lineEnding: value.lineEnding,
  };
}

function fileReport(value: ChangedFile, builder: Builder): FileReport {
  const hunks = changedFileHunks(value, builder.redact);
  switch (value.op) {
    case 'create':
      return {
        path: builder.path(value.path),
        op: 'create',
        after: fileState(value.after.state),
        hunks,
      };
    case 'edit':
      return {
        path: builder.path(value.path),
        op: 'edit',
        before: fileState(value.before.state),
        after: fileState(value.after.state),
        hunks,
      };
    case 'rename':
      return {
        path: builder.path(value.path),
        op: 'rename',
        from: builder.path(value.from),
        before: fileState(value.before.state),
        after: fileState(value.after.state),
        hunks,
      };
  }
}

function manualStep(value: ManualStep, builder: Builder): ManualStep {
  return {
    ruleId: value.ruleId,
    path: builder.path(value.path),
    line: value.line,
    guidance: builder.redact(value.guidance),
  };
}

/** A canonical `fix --format json` object for `run`. */
export function toFixReport(run: FixRun, options: FixJsonOptions = {}): FixReport {
  const builder = builderOf(run);
  const base = normalizedBase(run.pathBase);
  const introduced = run.verification.introduced
    .map((finding): IntroducedFinding => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      path: builder.path(finding.path),
      line: finding.range.start.line,
      message: builder.redact(finding.message),
    }))
    .sort(
      (a, b) =>
        compareStrings(a.path, b.path) || a.line - b.line || compareStrings(a.ruleId, b.ruleId),
    );
  const tool = options.tool ?? { name: TOOL_NAME, version: VERSION };
  return {
    schemaVersion: 1,
    tool: { name: tool.name, version: tool.version },
    ruleset: options.ruleset ?? RULESET_VERSION,
    mode: run.mode,
    ...(base === '' ? {} : { pathBase: base }),
    fixes: run.fixes.map((fix) => fixEntry(fix, builder, base)),
    files: run.files
      .map((file) => fileReport(file, builder))
      .sort((a, b) => compareStrings(a.path, b.path)),
    manual: run.manual.map((step) => manualStep(step, builder)),
    verification: {
      resolved: run.verification.resolved,
      remaining: run.verification.remaining,
      introduced,
    },
  };
}

/**
 * Pretty JSON (2-space indent, trailing newline) for `fix --format json`. Strings are the data
 * with credentials redacted; display-dangerous characters are written as `\uXXXX` escapes.
 */
export function formatFixJson(run: FixRun, options: FixJsonOptions = {}): string {
  return `${forJsonOutput(JSON.stringify(toFixReport(run, options), null, 2))}\n`;
}
