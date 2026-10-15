import type { Inventory } from '../inventory/types.js';
import { parseFrontmatter } from '../parse/frontmatter.js';
import { parseJson, parseJsonWithComments } from '../parse/json.js';
import { parseMarkdown } from '../parse/markdown.js';
import type { FrontmatterResult, JsonDocument, MarkdownDocument } from '../parse/types.js';
import { classify, READERS } from '../platforms/classify.js';
import { MARKDOWN_KINDS } from '../platforms/kinds.js';
import type { ContextReport } from '../platforms/load/types.js';
import type { BaselineDiff } from './baseline-types.js';
import { compareStrings } from './compare.js';
import { EMPTY_CONFIG, type ResolvedConfig } from './config.js';
import {
  DIRECTIVE_MISSING_REASON,
  DIRECTIVE_RULES,
  DIRECTIVE_UNKNOWN_RULE,
  DIRECTIVE_UNUSED,
} from './directive-rules.js';
import { hash53, normalizeExcerpt } from './fingerprint.js';
import { DIRECTIVE_PREFIX, REPORT_SCHEMA_VERSION, RULESET_VERSION, TOOL_NAME } from './meta.js';
import { computeScore, type ScoreReport } from './score.js';
import { type Directive, parseDirective } from './suppress.js';
import { decode, lineText, positionAt, rangeOf } from './text.js';
import {
  type AnyRule,
  type Artifact,
  type Finding,
  PLATFORM_IDS,
  type PlatformId,
  type ReportDescriptor,
  type RuleFailure,
  type RuleMeta,
  type Severity,
  type SkippedEntry,
  type Snapshot,
  type Span,
  type UnresolvedSymlink,
} from './types.js';
import { VERSION } from './version.js';

/**
 * Scan-wide cap on Markdown characters analyzed. The Markdown parser can need far more time and
 * memory than the input size suggests, and parsed documents stay cached while rules run, so a
 * per-file limit alone does not bound a scan of many files. The largest repository in our corpus
 * of 80 real projects has 9.4 MiB and 300,245 lines of agent-config Markdown; files beyond the
 * budget are reported by `analysis/partial` instead of being parsed. See docs/adr/0003.
 */
export const SCAN_MARKDOWN_BUDGET = 16 * 1024 * 1024;

/**
 * Scan-wide cap on Markdown lines analyzed. Parsed-document memory tracks the number of block
 * nodes, which follows lines more closely than characters: 128 KiB of one-line headings parses
 * into a tree about 100 times its size. Twice the largest real repository.
 */
export const SCAN_MARKDOWN_LINE_BUDGET = 600_000;

export interface ScanOptions {
  readonly rules: readonly AnyRule[];
  /** Overrides {@link SCAN_MARKDOWN_BUDGET}, in characters. */
  readonly markdownBudget?: number;
  /** Overrides {@link SCAN_MARKDOWN_LINE_BUDGET}, in lines. */
  readonly markdownLineBudget?: number;
  readonly config?: ResolvedConfig;
  /** Overrides `config.targets`. Defaults to every supported platform. */
  readonly targets?: readonly PlatformId[];
  /** Honor inline suppression directives. False in `--untrusted` mode. Default true. */
  readonly trustDirectives?: boolean;
}

export interface ArtifactSummary {
  readonly path: string;
  readonly kind: Artifact['kind'];
  readonly readers: readonly PlatformId[];
}

export interface ScanResult {
  readonly schemaVersion: number;
  readonly tool: { readonly name: string; readonly version: string };
  readonly ruleset: string;
  readonly targets: readonly PlatformId[];
  readonly artifacts: readonly ArtifactSummary[];
  /** Sorted by path, line, column, rule id. Includes suppressed findings, marked as such. */
  readonly findings: readonly Finding[];
  readonly score: ScoreReport;
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
    readonly suppressed: number;
  };
  /** Metadata of every rule that ran, plus the directive rules. */
  readonly rules: readonly RuleMeta[];
  readonly skipped: readonly SkippedEntry[];
  readonly unresolvedSymlinks: readonly UnresolvedSymlink[];
  readonly ruleFailures: readonly RuleFailure[];
  readonly configWarnings: readonly string[];
  /**
   * The prefix `rebaseResult` added to every path, `''` when paths are relative to the scanned
   * directory. `--baseline` removes it before comparing two reports.
   */
  readonly pathBase?: string;
  /**
   * Security inventory. Optional only until the inventory builder (src/inventory, work unit U6)
   * lands; after that every scan includes it.
   */
  readonly inventory?: Inventory;
  /** Load plans, from `agentcheckup context` or a scan with `--context`. */
  readonly context?: ContextReport;
  /** Comparison with the `--baseline` report, when one was given. */
  readonly baseline?: BaselineDiff;
}

interface PendingFinding {
  readonly meta: RuleMeta;
  readonly artifact: Artifact;
  readonly severity: Severity;
  readonly descriptor: ReportDescriptor;
}

/**
 * Classifies and decodes the snapshot's files. A file reached through a symlink whose real file
 * is also in the snapshot is folded into that artifact as an alias, so it is linted and scored
 * once. Example: `.claude/skills -> ../.agents/skills` makes every shared skill visible twice.
 */
export function buildArtifacts(snapshot: Snapshot, config: ResolvedConfig): Artifact[] {
  const realPaths = new Set(
    snapshot.files.filter((file) => file.symlinkTarget === undefined).map((file) => file.path),
  );
  const aliases = new Map<string, string[]>();
  for (const file of snapshot.files) {
    const target = file.symlinkTarget;
    if (target === undefined || !realPaths.has(target)) continue;
    const list = aliases.get(target) ?? [];
    list.push(file.path);
    aliases.set(target, list);
  }

  const artifacts: Artifact[] = [];
  for (const file of snapshot.files) {
    if (file.symlinkTarget !== undefined && realPaths.has(file.symlinkTarget)) continue;
    if (config.isIgnored(file.path)) continue;
    const classification = classify(file.path);
    if (!classification) continue;
    artifacts.push({
      path: file.path,
      realPath: file.symlinkTarget ?? file.path,
      kind: classification.kind,
      file,
      decoded: decode(file.bytes),
      readers: READERS[classification.kind],
      aliases: (aliases.get(file.path) ?? []).sort(compareStrings),
      ...(classification.caseMismatch ? { caseMismatch: classification.caseMismatch } : {}),
    });
  }
  artifacts.sort((a, b) => compareStrings(a.path, b.path));
  return artifacts;
}

function memoize<T>(compute: (artifact: Artifact) => T): (artifact: Artifact) => T {
  const cache = new WeakMap<Artifact, T>();
  return (artifact) => {
    const hit = cache.get(artifact);
    if (hit !== undefined) return hit;
    const value = compute(artifact);
    cache.set(artifact, value);
    return value;
  };
}

/** Runs every applicable rule over a snapshot. Pure: no I/O, deterministic output. */
export function scanSnapshot(snapshot: Snapshot, options: ScanOptions): ScanResult {
  const config = options.config ?? EMPTY_CONFIG;
  const targetList = [...new Set(options.targets ?? config.targets ?? PLATFORM_IDS)].sort(
    compareStrings,
  );
  const targets: ReadonlySet<PlatformId> = new Set(targetList);
  const trustDirectives = options.trustDirectives ?? true;

  const artifacts = buildArtifacts(snapshot, config);

  const frontmatter = memoize<FrontmatterResult>((a) => parseFrontmatter(a.decoded.text));
  let markdownBudget = options.markdownBudget ?? SCAN_MARKDOWN_BUDGET;
  let lineBudget = options.markdownLineBudget ?? SCAN_MARKDOWN_LINE_BUDGET;
  const markdown = memoize<MarkdownDocument>((a) => {
    const { lineStarts } = a.decoded;
    // The character offset where the remaining line budget runs out in this file.
    const lineLimit = lineBudget <= 0 ? 0 : (lineStarts[lineBudget] ?? Number.POSITIVE_INFINITY);
    const doc = parseMarkdown(a.decoded.text, frontmatter(a), {
      maxAnalyzedChars: Math.max(0, Math.min(markdownBudget, lineLimit)),
    });
    const analyzed = doc.analysis.analyzedLength;
    markdownBudget -= analyzed;
    lineBudget -= countLineStartsBefore(lineStarts, analyzed);
    return doc;
  });
  // Parse JSON the way the reading platform does: Gemini CLI strips comments from its
  // settings.json before JSON.parse; every other agent uses strict JSON.
  const json = memoize<JsonDocument>((a) =>
    a.kind === 'gemini-settings'
      ? parseJsonWithComments(a.decoded.text)
      : parseJson(a.decoded.text),
  );

  const pending: PendingFinding[] = [];
  const ruleFailures: RuleFailure[] = [];
  const ranRules: RuleMeta[] = [];
  const knownRuleIds = new Set<string>(DIRECTIVE_RULES.map((meta) => meta.id));

  for (const rule of options.rules) {
    knownRuleIds.add(rule.meta.id);
    if (!rule.meta.platforms.some((platform) => targets.has(platform))) continue;

    const appliesTo = new Set(rule.meta.appliesTo);
    const ruleArtifacts = artifacts.filter(
      (artifact) =>
        appliesTo.has(artifact.kind) &&
        config.ruleSetting(rule.meta.id, artifact.path)?.severity !== 'off',
    );
    if (ruleArtifacts.length === 0) continue;
    ranRules.push(rule.meta);

    const baseSetting = config.ruleSetting(rule.meta.id, '');
    let ruleOptions: unknown = rule.defaultOptions;
    if (baseSetting?.options !== undefined) {
      ruleOptions = { ...(rule.defaultOptions as Record<string, unknown>), ...baseSetting.options };
    }

    try {
      rule.check({
        options: ruleOptions,
        targets,
        artifacts: ruleArtifacts,
        allArtifacts: artifacts,
        snapshot,
        frontmatter,
        markdown,
        json,
        report: (descriptor) => {
          const configured = config.ruleSetting(rule.meta.id, descriptor.artifact.path)?.severity;
          if (configured === 'off') return;
          pending.push({
            meta: rule.meta,
            artifact: descriptor.artifact,
            severity: configured ?? descriptor.severity ?? rule.meta.severity,
            descriptor,
          });
        },
      });
    } catch (error) {
      ruleFailures.push({
        ruleId: rule.meta.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const configWarnings = config.referencedRuleIds
    .filter((id) => !knownRuleIds.has(id))
    .map((id) => `Unknown rule "${id}" in configuration.`);

  // Inline directives
  const directivesByPath = new Map<string, { directive: Directive; used: boolean }[]>();
  if (trustDirectives) {
    for (const artifact of artifacts) {
      if (!MARKDOWN_KINDS.has(artifact.kind)) continue;
      // A cheap substring test avoids parsing every file just to look for directives.
      if (!artifact.decoded.text.includes(`${DIRECTIVE_PREFIX}-disable`)) continue;
      const directives = collectDirectives(artifact, frontmatter(artifact), markdown(artifact));
      if (directives.length === 0) continue;
      const entries: { directive: Directive; used: boolean }[] = [];
      for (const directive of directives) {
        const unknown = directive.ruleIds.filter((id) => !knownRuleIds.has(id));
        for (const id of unknown) {
          pending.push({
            meta: DIRECTIVE_UNKNOWN_RULE,
            artifact,
            severity: DIRECTIVE_UNKNOWN_RULE.severity,
            descriptor: { artifact, span: directive.span, message: `Unknown rule "${id}".` },
          });
        }
        if (directive.reason.length === 0 || directive.ruleIds.length === 0) {
          pending.push({
            meta: DIRECTIVE_MISSING_REASON,
            artifact,
            severity: DIRECTIVE_MISSING_REASON.severity,
            descriptor: {
              artifact,
              span: directive.span,
              message:
                directive.ruleIds.length === 0
                  ? 'Directive must name the rules it disables, then give a reason after " -- ".'
                  : 'Directive needs a reason after " -- ". It has no effect until it has one.',
            },
          });
          continue;
        }
        entries.push({ directive, used: false });
      }
      directivesByPath.set(artifact.path, entries);
    }
  }

  const findings: Finding[] = [];
  const occurrences = new Map<string, number>();
  // Normalizing and hashing a source line is O(line length). Cache it per file and line, so
  // thousands of findings on one long line stay linear instead of quadratic.
  const lineHashes = new Map<string, string>();
  const lineHash = (artifact: Artifact, line: number): string => {
    const key = `${artifact.path}\u0000${line}`;
    let value = lineHashes.get(key);
    if (value === undefined) {
      value = hash53(normalizeExcerpt(lineText(artifact.decoded, line)));
      lineHashes.set(key, value);
    }
    return value;
  };

  for (const item of pending) {
    const { artifact, descriptor, meta } = item;
    const range = rangeOf(artifact.decoded, descriptor.span);

    let suppressed: Finding['suppressed'];
    const isDirectiveFinding = meta.id.startsWith('directive/');
    if (!isDirectiveFinding) {
      for (const entry of directivesByPath.get(artifact.path) ?? []) {
        const { directive } = entry;
        if (!directive.ruleIds.includes(meta.id)) continue;
        if (directive.scope === 'file' || directive.targetLine === range.start.line) {
          entry.used = true;
          suppressed = { kind: 'inline', reason: directive.reason };
          break;
        }
      }
    }

    const base = hash53(
      [meta.id, artifact.path, lineHash(artifact, range.start.line)].join('\u0000'),
    );
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);

    findings.push({
      ruleId: meta.id,
      severity: item.severity,
      category: meta.category,
      message: descriptor.message,
      path: artifact.path,
      range,
      related: (descriptor.related ?? []).map((related) => {
        const target = artifacts.find((candidate) => candidate.path === related.path);
        return {
          path: related.path,
          message: related.message,
          ...(target && related.span ? { range: rangeOf(target.decoded, related.span) } : {}),
        };
      }),
      platforms: descriptor.platforms ?? meta.platforms,
      fingerprint: `${base}:${occurrence}`,
      ...(descriptor.fix ? { fix: descriptor.fix } : {}),
      ...(suppressed ? { suppressed } : {}),
    });
  }

  for (const [path, entries] of directivesByPath) {
    const artifact = artifacts.find((candidate) => candidate.path === path);
    if (!artifact) continue;
    for (const entry of entries) {
      if (entry.used) continue;
      const range = rangeOf(artifact.decoded, entry.directive.span);
      findings.push({
        ruleId: DIRECTIVE_UNUSED.id,
        severity: DIRECTIVE_UNUSED.severity,
        category: DIRECTIVE_UNUSED.category,
        message: `No ${entry.directive.ruleIds.join(', ')} finding to suppress here.`,
        path,
        range,
        related: [],
        platforms: DIRECTIVE_UNUSED.platforms,
        fingerprint: `${hash53([DIRECTIVE_UNUSED.id, path, String(range.start.line)].join('\u0000'))}:1`,
      });
    }
  }

  findings.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.column - b.range.start.column ||
      compareStrings(a.ruleId, b.ruleId) ||
      compareStrings(a.message, b.message),
  );

  const active = findings.filter((finding) => !finding.suppressed);
  ranRules.push(...DIRECTIVE_RULES);
  ranRules.sort((a, b) => compareStrings(a.id, b.id));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: VERSION },
    ruleset: RULESET_VERSION,
    targets: targetList,
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      readers: artifact.readers,
    })),
    findings,
    score: computeScore(
      artifacts.map((artifact) => artifact.path),
      findings,
    ),
    summary: {
      errors: active.filter((finding) => finding.severity === 'error').length,
      warnings: active.filter((finding) => finding.severity === 'warn').length,
      infos: active.filter((finding) => finding.severity === 'info').length,
      suppressed: findings.length - active.length,
    },
    rules: ranRules,
    skipped: snapshot.skipped,
    unresolvedSymlinks: snapshot.unresolvedSymlinks,
    ruleFailures,
    configWarnings,
  };
}

/** Number of lines that start before `offset` (binary search over sorted line starts). */
function countLineStartsBefore(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((lineStarts[mid] ?? 0) < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Finds directive comments: HTML comments in the body and `#` comments in YAML frontmatter. */
function collectDirectives(
  artifact: Artifact,
  frontmatterResult: FrontmatterResult,
  doc: MarkdownDocument,
): Directive[] {
  const directives: Directive[] = [];
  const { decoded } = artifact;

  for (const comment of doc.htmlComments) {
    const directive = parseDirective({
      text: decoded.text
        .slice(comment.span.offset, comment.span.offset + comment.span.length)
        .trim(),
      span: comment.span,
      startLine: positionAt(decoded, comment.span.offset).line,
      endLine: positionAt(decoded, comment.span.offset + comment.span.length).line,
    });
    if (directive) directives.push(directive);
  }

  if (frontmatterResult.kind === 'valid' || frontmatterResult.kind === 'invalid') {
    const block: Span = frontmatterResult.span;
    const startLine = positionAt(decoded, block.offset).line;
    const endLine = positionAt(decoded, block.offset + block.length).line;
    for (let line = startLine; line <= endLine; line++) {
      const text = lineText(decoded, line);
      const trimmed = text.trim();
      if (!trimmed.startsWith('#')) continue;
      const offset = (decoded.lineStarts[line - 1] ?? 0) + text.indexOf('#');
      const directive = parseDirective({
        text: trimmed,
        span: { offset, length: trimmed.length },
        startLine: line,
        endLine: line,
      });
      if (directive) directives.push(directive);
    }
  }
  return directives;
}
