/**
 * SARIF 2.1.0 for GitHub code scanning.
 *
 * Follows https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
 * Limits that make GitHub reject an upload (same page, "Upload limits") and how they are met:
 * - 25,000 results per run: results are capped (see MAX_RESULTS); a notification says so.
 * - 25,000 rules per run: only rules that ran are listed (a few dozen).
 * - 20 tags per rule: tags are capped (GitHub shows 10).
 * - 1,000 locations per result: one location, related locations capped at MAX_RELATED.
 * - 1,024 characters for `shortDescription`/`fullDescription`, 255 for `name`: truncated.
 * - Empty strings are not accepted for required properties: every one has a fallback.
 * - 10 MB gzipped per file: not enforceable here; 25,000 results stay well below it.
 */
import type { ScanResult } from '../core/engine.js';
import { REPOSITORY_URL, ruleDocsUrl } from '../core/meta.js';
import type { Finding, Range, RuleMeta, Severity } from '../core/types.js';
import { forJsonOutput, forSarifMessage, forSarifText } from './sanitize.js';
import {
  breakdown,
  markdownToPlain,
  plural,
  SEVERITY_RANK,
  SKIP_REASON_LABELS,
  SYMLINK_PROBLEM_LABELS,
  truncate,
} from './text.js';

export const SARIF_SCHEMA_URL = 'https://json.schemastore.org/sarif-2.1.0.json';
/** GitHub rejects runs with more results; it displays the 5,000 most severe. */
export const MAX_RESULTS = 25_000;
/** GitHub rejects rules with more than 20 tags. */
const MAX_TAGS = 20;
/** GitHub displays at most 100 locations per result. */
const MAX_RELATED = 100;
/** Locations attached to a skipped-files or symlink notification. */
const MAX_NOTIFICATION_LOCATIONS = 100;
const MAX_DESCRIPTION = 1024;
const MAX_NAME = 255;
/** `partialFingerprints` key. Versioned: a new fingerprint algorithm gets a new key. */
export const FINGERPRINT_KEY = 'agentcheckup/v1';
/** Category for `runAutomationDetails.id`: `<category>/<run id>` with an empty run id. */
const AUTOMATION_ID = 'agentcheckup/';
const SRCROOT = '%SRCROOT%';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;

type SarifLevel = 'error' | 'warning' | 'note';

interface SarifMessage {
  readonly text: string;
}

interface SarifRegion {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

interface SarifPhysicalLocation {
  readonly artifactLocation: { readonly uri: string; readonly uriBaseId: string };
  readonly region?: SarifRegion;
}

interface SarifLocation {
  readonly id?: number;
  readonly physicalLocation: SarifPhysicalLocation;
  readonly message?: SarifMessage;
}

interface SarifRule {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: SarifMessage;
  readonly fullDescription: SarifMessage;
  readonly helpUri: string;
  readonly help: { readonly text: string; readonly markdown: string };
  readonly defaultConfiguration: { readonly level: SarifLevel };
  readonly properties: { readonly tags: readonly string[]; readonly 'security-severity'?: string };
}

interface SarifResult {
  readonly ruleId: string;
  readonly ruleIndex: number;
  readonly level: SarifLevel;
  readonly message: SarifMessage;
  readonly locations: readonly SarifLocation[];
  readonly relatedLocations?: readonly SarifLocation[];
  readonly partialFingerprints: Readonly<Record<string, string>>;
  /** The finding against the `--baseline` report, when the scan ran with one. */
  readonly baselineState?: 'new' | 'unchanged';
  readonly suppressions?: readonly {
    readonly kind: 'inSource' | 'external';
    readonly justification: string;
  }[];
}

interface SarifNotification {
  readonly level: SarifLevel;
  readonly message: SarifMessage;
  readonly associatedRule?: { readonly id: string; readonly index?: number };
  readonly locations?: readonly SarifLocation[];
}

export interface SarifLog {
  readonly $schema: string;
  readonly version: '2.1.0';
  readonly runs: readonly [SarifRun];
}

interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly semanticVersion?: string;
      readonly informationUri: string;
      readonly rules: readonly SarifRule[];
    };
  };
  readonly automationDetails: { readonly id: string };
  readonly originalUriBaseIds: Readonly<Record<string, { readonly description: SarifMessage }>>;
  readonly invocations: readonly [
    {
      readonly executionSuccessful: boolean;
      readonly toolExecutionNotifications?: readonly SarifNotification[];
      readonly toolConfigurationNotifications?: readonly SarifNotification[];
    },
  ];
  readonly columnKind: 'utf16CodeUnits';
  readonly results: readonly SarifResult[];
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

const LEVELS: Readonly<Record<Severity, SarifLevel>> = {
  error: 'error',
  warn: 'warning',
  info: 'note',
};

/**
 * `security-severity` for `risk` rules, by default severity. GitHub maps 7.0-8.9 to "High" and
 * 4.0-6.9 to "Medium", and only for rules tagged `security`.
 */
const SECURITY_SEVERITY: Readonly<Partial<Record<Severity, string>>> = {
  error: '8.0',
  warn: '5.0',
};

/** `foo/bar-baz` -> `FooBarBaz`, the conventional SARIF rule `name`. */
export function ruleName(id: string): string {
  const name = id
    .split(/[^\da-z]+/i)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return truncate(name === '' ? 'Rule' : name, MAX_NAME, '');
}

/** Replaces lone surrogates, which `encodeURIComponent` refuses, with U+FFFD. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
}

/**
 * Relative URI reference for a POSIX path: every segment percent-encoded (RFC 3986), `/` kept.
 * Encoding `:` also keeps a first segment like `c:` from reading as a URI scheme.
 */
export function pathToUri(path: string): string {
  return wellFormed(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** SARIF region; positions clamped to valid values, end never before start. */
function region(range: Range): SarifRegion {
  const startLine = Math.max(1, range.start.line);
  const startColumn = Math.max(1, range.start.column);
  const endLine = Math.max(startLine, range.end.line);
  let endColumn = Math.max(1, range.end.column);
  if (endLine === startLine && endColumn < startColumn) endColumn = startColumn;
  return { startLine, startColumn, endLine, endColumn };
}

function physicalLocation(path: string, range?: Range): SarifPhysicalLocation {
  return {
    artifactLocation: { uri: pathToUri(path), uriBaseId: SRCROOT },
    ...(range ? { region: region(range) } : {}),
  };
}

/** Non-empty SARIF text: GitHub rejects empty required strings. */
function nonEmpty(text: string, fallback: string): string {
  return text.trim() === '' ? fallback : text;
}

function describeRule(meta: RuleMeta): SarifRule {
  const docs = ruleDocsUrl(meta.id);
  const title = nonEmpty(forSarifText(meta.title), meta.id);
  const rationale = nonEmpty(
    forSarifText(markdownToPlain(meta.rationale), { multiline: true }),
    title,
  );
  const sources = meta.sources
    .map((source) => `- [${forSarifText(source.title)}](${source.url}) (checked ${source.checked})`)
    .join('\n');
  const tags = [
    meta.category,
    ...(meta.category === 'risk' ? ['security'] : []),
    ...meta.platforms,
  ];
  const securitySeverity = meta.category === 'risk' ? SECURITY_SEVERITY[meta.severity] : undefined;
  return {
    id: meta.id,
    name: ruleName(meta.id),
    shortDescription: { text: truncate(title, MAX_DESCRIPTION) },
    fullDescription: { text: truncate(rationale, MAX_DESCRIPTION) },
    helpUri: docs,
    help: {
      text: `${rationale}\n\nDocumentation: ${docs}`,
      markdown:
        `**${title}**\n\n${forSarifText(meta.rationale, { multiline: true })}\n\n` +
        `**Sources**\n\n${sources}\n\n[Rule documentation](${docs})`,
    },
    defaultConfiguration: { level: LEVELS[meta.severity] },
    properties: {
      tags: [...new Set(tags)].slice(0, MAX_TAGS),
      ...(securitySeverity === undefined ? {} : { 'security-severity': securitySeverity }),
    },
  };
}

/** Descriptor for a finding whose rule is missing from `result.rules` (should not happen). */
function placeholderRule(id: string): SarifRule {
  const docs = ruleDocsUrl(id);
  const text = nonEmpty(forSarifText(id), 'unknown rule');
  return {
    id,
    name: ruleName(id),
    shortDescription: { text },
    fullDescription: { text },
    helpUri: docs,
    help: { text: `Documentation: ${docs}`, markdown: `[Rule documentation](${docs})` },
    defaultConfiguration: { level: 'warning' },
    properties: { tags: [] },
  };
}

/** Rule descriptors in `result.rules` order, then placeholders; index by id. */
function buildRules(result: ScanResult): { rules: SarifRule[]; index: Map<string, number> } {
  const rules: SarifRule[] = [];
  const index = new Map<string, number>();
  const add = (id: string, describe: () => SarifRule): void => {
    if (index.has(id)) return;
    index.set(id, rules.length);
    rules.push(describe());
  };
  for (const meta of result.rules) add(meta.id, () => describeRule(meta));
  for (const finding of result.findings) add(finding.ruleId, () => placeholderRule(finding.ruleId));
  return { rules, index };
}

function toResult(finding: Finding, ruleIndex: number): SarifResult {
  const related = finding.related.slice(0, MAX_RELATED).map((location, position) => ({
    id: position + 1,
    physicalLocation: physicalLocation(location.path, location.range),
    message: { text: nonEmpty(forSarifMessage(location.message), 'Related location') },
  }));
  return {
    ruleId: finding.ruleId,
    ruleIndex,
    level: LEVELS[finding.severity],
    message: { text: nonEmpty(forSarifMessage(finding.message), finding.ruleId) },
    locations: [{ physicalLocation: physicalLocation(finding.path, finding.range) }],
    ...(related.length > 0 ? { relatedLocations: related } : {}),
    partialFingerprints: { [FINGERPRINT_KEY]: finding.fingerprint },
    ...(finding.baseline === undefined ? {} : { baselineState: finding.baseline }),
    ...(finding.suppressed
      ? {
          suppressions: [
            {
              // An inline directive lives in the analyzed file; a config entry does not.
              kind: finding.suppressed.kind === 'inline' ? 'inSource' : 'external',
              justification: forSarifText(finding.suppressed.reason),
            },
          ],
        }
      : {}),
  };
}

/** Rank for the result cap: unsuppressed before suppressed, then by severity. */
function priority(finding: Finding): number {
  return (finding.suppressed ? 0 : 10) + SEVERITY_RANK[finding.severity];
}

/**
 * At most `max` findings, keeping the most important ones (GitHub keeps the most severe too),
 * in their original order.
 */
function capFindings(findings: readonly Finding[], max: number): readonly Finding[] {
  if (findings.length <= max) return findings;
  const keep = new Set(
    findings
      .map((finding, position) => ({ finding, position }))
      .sort((a, b) => priority(b.finding) - priority(a.finding) || a.position - b.position)
      .slice(0, max)
      .map((entry) => entry.position),
  );
  return findings.filter((_, position) => keep.has(position));
}

function executionNotifications(
  result: ScanResult,
  ruleIndex: ReadonlyMap<string, number>,
  omitted: number,
): SarifNotification[] {
  const notifications: SarifNotification[] = result.ruleFailures.map((failure) => {
    const index = ruleIndex.get(failure.ruleId);
    return {
      level: 'error',
      message: {
        text: forSarifMessage(`Rule ${failure.ruleId} failed: ${failure.message}`),
      },
      associatedRule: { id: failure.ruleId, ...(index === undefined ? {} : { index }) },
    };
  });
  if (omitted > 0) {
    notifications.push({
      level: 'warning',
      message: {
        text: `${plural(omitted, 'result')} omitted: GitHub accepts at most ${MAX_RESULTS} per run.`,
      },
    });
  }
  if (result.skipped.length > 0) {
    const reasons = breakdown(
      result.skipped.map((entry) => entry.reason),
      SKIP_REASON_LABELS,
    );
    notifications.push({
      level: 'warning',
      message: { text: `${plural(result.skipped.length, 'file')} not checked (${reasons}).` },
      locations: result.skipped
        .slice(0, MAX_NOTIFICATION_LOCATIONS)
        .map((entry) => ({ physicalLocation: physicalLocation(entry.path) })),
    });
  }
  if (result.unresolvedSymlinks.length > 0) {
    const problems = breakdown(
      result.unresolvedSymlinks.map((link) => link.problem),
      SYMLINK_PROBLEM_LABELS,
    );
    notifications.push({
      level: 'warning',
      message: {
        text: `${plural(result.unresolvedSymlinks.length, 'symlink')} not followed (${problems}).`,
      },
      locations: result.unresolvedSymlinks
        .slice(0, MAX_NOTIFICATION_LOCATIONS)
        .map((link) => ({ physicalLocation: physicalLocation(link.path) })),
    });
  }
  return notifications;
}

/** The SARIF log object (for callers that post-process it). */
export function toSarif(result: ScanResult): SarifLog {
  const { rules, index } = buildRules(result);
  const findings = capFindings(result.findings, MAX_RESULTS);
  const results = findings.map((finding) => toResult(finding, index.get(finding.ruleId) ?? 0));
  const execution = executionNotifications(result, index, result.findings.length - findings.length);
  const configuration = result.configWarnings.map((warning) => ({
    level: 'warning' as const,
    message: { text: nonEmpty(forSarifMessage(warning), 'Configuration warning') },
  }));
  const version = nonEmpty(forSarifText(result.tool.version), '0.0.0');

  return {
    $schema: SARIF_SCHEMA_URL,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: nonEmpty(forSarifText(result.tool.name), 'agentcheckup'),
            version,
            ...(SEMVER.test(version) ? { semanticVersion: version } : {}),
            informationUri: REPOSITORY_URL,
            rules,
          },
        },
        automationDetails: { id: AUTOMATION_ID },
        // SARIF §3.14.14: the absolute URI may be omitted, here to keep local paths private.
        originalUriBaseIds: {
          [SRCROOT]: { description: { text: 'The directory agentcheckup scanned.' } },
        },
        invocations: [
          {
            executionSuccessful: result.ruleFailures.length === 0,
            ...(execution.length > 0 ? { toolExecutionNotifications: execution } : {}),
            ...(configuration.length > 0 ? { toolConfigurationNotifications: configuration } : {}),
          },
        ],
        columnKind: 'utf16CodeUnits',
        results,
        properties: {
          score: result.score.score,
          grade: result.score.grade,
          capped: result.score.capped,
          ruleset: forSarifText(result.ruleset),
          scoreFormula: result.score.formula,
        },
      },
    ],
  };
}

/** SARIF 2.1.0 JSON, 2-space indent, trailing newline. Deterministic: no timestamps. */
export function formatSarif(result: ScanResult): string {
  return `${forJsonOutput(JSON.stringify(toSarif(result), null, 2))}\n`;
}
