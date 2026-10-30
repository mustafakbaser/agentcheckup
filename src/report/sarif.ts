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
 *
 * A finding's fix becomes `result.fixes` (SARIF 2.1.0 §3.55) when it is one `edit` of one file:
 * each text edit is a replacement whose `deletedRegion` is `charOffset`/`charLength` in UTF-16
 * code units (the run's `columnKind`) of the decoded text, without a byte order mark, and whose
 * `insertedContent.text` is the new text, exactly. Creates, renames, re-encodings and fixes that
 * touch several files have no SARIF form here, and fixes that apply only when named
 * (mcp/literal-secret) are never offered. A fix that needs the user's words changes nothing
 * until `agentcheckup fix -i` asks for them, so it has no `fixes` entry either: the result's
 * `properties.fix` says `needs your words (fix -i)`, as the stylish and GitHub output do.
 *
 * With `--policy`, violations follow the findings as results of `policy/<check>` rules
 * (policy-sarif.ts), within the same result cap.
 */
import type { ScanResult } from '../core/engine.js';
import { FINGERPRINT_VERSION, REPOSITORY_URL, ruleDocsUrl } from '../core/meta.js';
import type { Finding, Fix, FixClass, Range, RuleMeta, Severity } from '../core/types.js';
import { fixOf, INPUT_FIX_LABEL, needsWords } from './feedback.js';
import { isNewRuleFinding, newRuleSet } from './gate.js';
import { policySarif } from './policy-sarif.js';
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
/** GitHub's limit for `shortDescription` and `fullDescription`, in characters. */
const MAX_DESCRIPTION = 1024;
const MAX_NAME = 255;
/** `partialFingerprints` key. Versioned: a new fingerprint algorithm gets a new key. */
export const FINGERPRINT_KEY = `agentcheckup/v${String(FINGERPRINT_VERSION)}`;
/**
 * Category for `runAutomationDetails.id`: `<category>/<run id>` with an empty run id. GitHub
 * keeps one analysis per tool and category, and github/codeql-action's upload-sarif uses this id
 * instead of its own `category` input, so two scans of one repository need
 * {@link SarifOptions.category} to stay apart. The default never changes: alerts are tracked
 * per category.
 */
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
  readonly region?: SarifRegion | { readonly startLine: number };
}

interface SarifLocation {
  readonly id?: number;
  readonly physicalLocation: SarifPhysicalLocation;
  readonly message?: SarifMessage;
}

export interface SarifRule {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: SarifMessage;
  readonly fullDescription: SarifMessage;
  readonly helpUri: string;
  readonly help: { readonly text: string; readonly markdown: string };
  readonly defaultConfiguration: { readonly level: SarifLevel };
  readonly properties: { readonly tags: readonly string[]; readonly 'security-severity'?: string };
}

interface SarifReplacement {
  readonly deletedRegion: { readonly charOffset: number; readonly charLength: number };
  /** Absent for a pure deletion. */
  readonly insertedContent?: { readonly text: string };
}

interface SarifFix {
  readonly description: SarifMessage;
  readonly artifactChanges: readonly [
    {
      readonly artifactLocation: { readonly uri: string; readonly uriBaseId: string };
      readonly replacements: readonly SarifReplacement[];
    },
  ];
  /** `class`: `safe` fixes are applied by `agentcheckup fix --write`, `review` ones on request. */
  readonly properties: { readonly class: FixClass };
}

export interface SarifResult {
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
  readonly fixes?: readonly SarifFix[];
  /**
   * `newRule`: a new finding of a rule newer than the baseline's rule set, which the baseline
   * could not have reported. Set only then. `policy`: a `--policy` violation, not a finding
   * (policy-sarif.ts). `fix`: `needs your words (fix -i)` when the finding's fix needs the
   * user's words, which has no SARIF form: it changes nothing until `agentcheckup fix -i` asks.
   */
  readonly properties?: {
    readonly newRule?: true;
    readonly policy?: true;
    readonly fix?: typeof INPUT_FIX_LABEL;
  };
}

export interface SarifNotification {
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
 * `security-severity` for `risk` rules, by severity. GitHub maps 7.0-8.9 to "High" and 4.0-6.9
 * to "Medium", only for rules tagged `security`, and shows it instead of the result's level.
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

/** `text` within GitHub's description limit, the `…` of a cut text included. */
function description(text: string): string {
  return text.length <= MAX_DESCRIPTION ? text : truncate(text, MAX_DESCRIPTION - 1);
}

/** Non-empty SARIF text: GitHub rejects empty required strings. */
function nonEmpty(text: string, fallback: string): string {
  return text.trim() === '' ? fallback : text;
}

/**
 * The descriptor of a rule that ran. `severity` is the one the configuration's top-level `rules`
 * sets, else the rule's default: a descriptor has one level and one `security-severity` for all
 * its results, so a per-file override changes only the level of the results it covers.
 */
function describeRule(meta: RuleMeta, severity: Severity): SarifRule {
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
  const securitySeverity = meta.category === 'risk' ? SECURITY_SEVERITY[severity] : undefined;
  return {
    id: meta.id,
    name: ruleName(meta.id),
    shortDescription: { text: description(title) },
    fullDescription: { text: description(rationale) },
    helpUri: docs,
    help: {
      text: `${rationale}\n\nDocumentation: ${docs}`,
      markdown:
        `**${title}**\n\n${forSarifText(meta.rationale, { multiline: true })}\n\n` +
        `**Sources**\n\n${sources}\n\n[Rule documentation](${docs})`,
    },
    defaultConfiguration: { level: LEVELS[severity] },
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
  const configured = result.configuredSeverities ?? {};
  for (const meta of result.rules) {
    const severity = Object.hasOwn(configured, meta.id) ? configured[meta.id] : undefined;
    add(meta.id, () => describeRule(meta, severity ?? meta.severity));
  }
  for (const finding of result.findings) add(finding.ruleId, () => placeholderRule(finding.ruleId));
  return { rules, index };
}

/**
 * The SARIF form of a fix that edits one file, or undefined for any other fix. Edits do not
 * overlap and all index the text before the change, as SARIF replacements do; they are listed
 * by offset.
 */
export function toSarifFix(fix: Fix): SarifFix | undefined {
  const [change, ...rest] = fix.changes;
  if (change?.kind !== 'edit' || rest.length > 0 || change.edits.length === 0) return undefined;
  const replacements = [...change.edits]
    .sort((a, b) => a.offset - b.offset || a.length - b.length)
    .map((edit): SarifReplacement => ({
      deletedRegion: {
        charOffset: Math.max(0, Math.floor(edit.offset)),
        charLength: Math.max(0, Math.floor(edit.length)),
      },
      // The text to write, exactly: forJsonOutput escapes what must not be shown raw.
      ...(edit.text === '' ? {} : { insertedContent: { text: edit.text } }),
    }));
  return {
    description: { text: nonEmpty(forSarifMessage(fix.title), 'Fix') },
    artifactChanges: [
      {
        artifactLocation: { uri: pathToUri(change.path), uriBaseId: SRCROOT },
        replacements,
      },
    ],
    properties: { class: fix.class },
  };
}

function toResult(finding: Finding, ruleIndex: number, newRules: ReadonlySet<string>): SarifResult {
  const fix = fixOf(finding, 'pull-request');
  const sarifFix = fix === undefined ? undefined : toSarifFix(fix);
  const properties: NonNullable<SarifResult['properties']> = {
    ...(isNewRuleFinding(finding, newRules) ? { newRule: true } : {}),
    ...(fix !== undefined && needsWords(fix) ? { fix: INPUT_FIX_LABEL } : {}),
  };
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
    ...(sarifFix === undefined ? {} : { fixes: [sarifFix] }),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
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

export interface SarifOptions {
  /**
   * The run's category within agentcheckup, for a repository scanned more than once, such as
   * each package of a monorepo: `automationDetails.id` becomes `agentcheckup/<category>/`.
   * Default: none, `agentcheckup/`.
   */
  readonly category?: string | undefined;
}

/** The SARIF log object (for callers that post-process it). */
export function toSarif(result: ScanResult, options: SarifOptions = {}): SarifLog {
  const { rules, index } = buildRules(result);
  const policy = policySarif(result, rules.length);
  const findings = capFindings(result.findings, Math.max(0, MAX_RESULTS - policy.results.length));
  const newRules = newRuleSet(result);
  const results = findings.map((finding) =>
    toResult(finding, index.get(finding.ruleId) ?? 0, newRules),
  );
  results.push(...policy.results);
  rules.push(...policy.rules);
  const execution = executionNotifications(result, index, result.findings.length - findings.length);
  execution.push(...policy.notifications);
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
        automationDetails: {
          id:
            options.category === undefined
              ? AUTOMATION_ID
              : `${AUTOMATION_ID}${forSarifText(options.category)}/`,
        },
        // SARIF §3.14.14: the absolute URI may be omitted, here to keep local paths private.
        originalUriBaseIds: {
          [SRCROOT]: { description: { text: 'The directory that result paths are relative to.' } },
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
export function formatSarif(result: ScanResult, options: SarifOptions = {}): string {
  return `${forJsonOutput(JSON.stringify(toSarif(result, options), null, 2))}\n`;
}
