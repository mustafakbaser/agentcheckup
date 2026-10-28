import { buildAgents } from '../agents/build.js';
import type { AgentsReport } from '../agents/types.js';
import { buildInventory } from '../inventory/build.js';
import type { Inventory } from '../inventory/types.js';
import { parseFrontmatter } from '../parse/frontmatter.js';
import { parseJson, parseJsonc, parseJsonWithComments } from '../parse/json.js';
import { parseMarkdown } from '../parse/markdown.js';
import { markdownWindowEnd } from '../parse/markdown-guard.js';
import { parseToml } from '../parse/toml.js';
import type {
  FrontmatterResult,
  JsonDocument,
  JsonLocation,
  MarkdownDocument,
  TomlDocument,
} from '../parse/types.js';
import { classifyFile, READERS } from '../platforms/classify.js';
import {
  configDocument,
  JSON_KINDS,
  MARKDOWN_OR_IMPORTED_KINDS,
  TOML_KINDS,
} from '../platforms/kinds.js';
import {
  buildContextReport,
  checkContextWindow,
  checkWorkingDirectory,
  contextAgentsOf,
  loadPlans,
  orderedAgents,
} from '../platforms/load/index.js';
import {
  MAX_START_DIRECTORIES,
  startDirectories,
  startDirectoryTotals,
} from '../platforms/load/directories.js';
import { buildMatrix, matrixPlans } from '../platforms/load/matrix.js';
import type { ContextAgent, ContextReport } from '../platforms/load/types.js';
import type { PolicyReport } from '../policy/types.js';
import type { BaselineDiff } from './baseline-types.js';
import { compareStrings } from './compare.js';
import { EMPTY_CONFIG, type ResolvedConfig } from './config.js';
import {
  CAPPED_FINDINGS,
  MAX_SUGGESTED_IDS,
  missingReasonGuidance,
  similarRuleIds,
  unknownRuleFix,
  unknownRuleGuidance,
  unusedDirectiveFix,
} from './directive-fixes.js';
import {
  DIRECTIVE_MISSING_REASON,
  DIRECTIVE_RULES,
  DIRECTIVE_UNKNOWN_RULE,
  DIRECTIVE_UNUSED,
} from './directive-rules.js';
import { hash53, jsonAnchor, lineAnchor, WHOLE_FILE_ANCHOR } from './fingerprint.js';
import {
  DIRECTIVE_PREFIX,
  FINGERPRINT_VERSION,
  REPORT_SCHEMA_VERSION,
  RULESET_VERSION,
  TOOL_NAME,
} from './meta.js';
import type { JsonDialect, ParseCache } from './parse-cache.js';
import { computeScore, type ScoreReport } from './score.js';
import { type Directive, parseDirective } from './suppress.js';
import { decode, lineText, positionAt, rangeOf } from './text.js';
import {
  type AnyRule,
  type Artifact,
  type ArtifactKind,
  type Finding,
  type ParseServices,
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

/** Options {@link analyze} reads: which files count, which platforms are targeted, the budget. */
export interface AnalyzeOptions {
  /** Overrides {@link SCAN_MARKDOWN_BUDGET}, in characters. */
  readonly markdownBudget?: number;
  /** Overrides {@link SCAN_MARKDOWN_LINE_BUDGET}, in lines. */
  readonly markdownLineBudget?: number;
  readonly config?: ResolvedConfig;
  /** Overrides `config.targets`. Defaults to every supported platform. */
  readonly targets?: readonly PlatformId[];
  /**
   * Decoded texts and parses to share with other scans of related snapshots, from
   * `createParseCache` (./parse-cache.ts). The results are the same with or without it.
   */
  readonly parseCache?: ParseCache;
}

/** Options {@link runRules} reads. Configuration and targets come from the {@link Analysis}. */
export interface RunRulesOptions {
  readonly rules: readonly AnyRule[];
  /** Honor inline suppression directives. False in `--untrusted` mode. Default true. */
  readonly trustDirectives?: boolean;
}

export interface ScanOptions extends AnalyzeOptions, RunRulesOptions {}

/** Options {@link scanWithContext} reads on top of {@link ScanOptions}. */
export interface ContextOptions {
  /**
   * Agents to plan for, each with a load model (CONTEXT_AGENTS). Default: every modeled agent
   * among the scan's targets.
   */
  readonly agents?: readonly ContextAgent[];
  /**
   * Working directory of the session, relative to the scan root, normalized, without `..`.
   * Default `''`, the root. Must be the root with {@link matrix}.
   */
  readonly cwd?: string;
  /**
   * Plan every agent at the root, plus Codex in each directory with an AGENTS.md or
   * AGENTS.override.md, and add the file-by-agent matrix. Default false.
   */
  readonly matrix?: boolean;
  /** The model's context window in tokens, for limits that depend on it. A positive integer. */
  readonly contextWindow?: number;
  /**
   * Also plan every agent in each start directory below the root (startDirectories), up to
   * MAX_START_DIRECTORIES of them in path order, for `tokens --by-directory`. Default false.
   */
  readonly startDirectories?: boolean;
}

/**
 * One scan's view of a snapshot: its classified, decoded artifacts and lazy parsers cached per
 * artifact. Built by {@link analyze}; {@link runRules} runs the rules over it, and code that needs
 * the same parses after the rules (load plans, the inventory) reads them from here.
 *
 * Use one Analysis for one scan. Its Markdown parser spends the scan-wide budget
 * ({@link SCAN_MARKDOWN_BUDGET}, {@link SCAN_MARKDOWN_LINE_BUDGET}) in the order files are first
 * parsed, so findings stay the same only if the rules parse first. A file parsed after the budget
 * ran out is analyzed partially or not at all: check `markdown(artifact).analysis` before relying
 * on it.
 */
export interface Analysis extends ParseServices {
  readonly snapshot: Snapshot;
  readonly config: ResolvedConfig;
  readonly targets: ReadonlySet<PlatformId>;
  /** {@link targets}, sorted by code point. */
  readonly targetList: readonly PlatformId[];
  /** Sorted by path. See {@link buildArtifacts}. */
  readonly artifacts: readonly Artifact[];
  /** Artifact by every path that reaches it: its own path, and each symlink alias. */
  readonly index: ReadonlyMap<string, Artifact>;
  // Redeclared as properties: the parsers are closures, safe to pass around without `this`.
  readonly frontmatter: ParseServices['frontmatter'];
  readonly markdown: ParseServices['markdown'];
  readonly json: ParseServices['json'];
  readonly toml: ParseServices['toml'];
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
  /** How findings' fingerprints are computed: FINGERPRINT_VERSION (src/core/fingerprint.ts). */
  readonly fingerprintVersion: number;
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
  /** Security inventory: every MCP server, hook, permission and env override. Every scan has it. */
  readonly inventory: Inventory;
  /**
   * Agent definitions and model settings (src/agents). Every scan has them; optional so that a
   * result built before they existed still formats.
   */
  readonly agents?: AgentsReport;
  /** Load plans, from `agentcheckup context` or a scan with `--context`. */
  readonly context?: ContextReport;
  /** Comparison with the `--baseline` report, when one was given. */
  readonly baseline?: BaselineDiff;
  /**
   * The check against the `--policy` file, when one was given. Violations are not findings: they
   * never change the score, and no configuration or directive can suppress them.
   */
  readonly policy?: PolicyReport;
}

/** A scan with load plans: what {@link scanWithContext} returns. */
export interface ContextScanResult extends ScanResult {
  readonly context: ContextReport;
}

/**
 * What {@link runRules} returns: the findings and everything about them. {@link scanSnapshot} adds
 * the inventory, {@link scanWithContext} the inventory and the load plans.
 */
export type RuleResult = Omit<
  ScanResult,
  'inventory' | 'context' | 'baseline' | 'pathBase' | 'policy'
>;

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
 * With `cache`, a file whose bytes it already decoded is not decoded again.
 */
export function buildArtifacts(
  snapshot: Snapshot,
  config: ResolvedConfig,
  cache?: ParseCache,
): Artifact[] {
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
    const classification = classifyFile(file);
    if (!classification) continue;
    artifacts.push({
      path: file.path,
      realPath: file.symlinkTarget ?? file.path,
      kind: classification.kind,
      file,
      decoded:
        cache === undefined
          ? decode(file.bytes)
          : cache.decoded(file.bytes, () => decode(file.bytes)),
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

/** Artifact by path, then by each alias that no artifact owns as its own path. */
function indexArtifacts(artifacts: readonly Artifact[]): Map<string, Artifact> {
  const index = new Map<string, Artifact>();
  for (const artifact of artifacts) index.set(artifact.path, artifact);
  for (const artifact of artifacts) {
    for (const alias of artifact.aliases) if (!index.has(alias)) index.set(alias, artifact);
  }
  return index;
}

/**
 * Lazy parsers cached per artifact, and in `options.parseCache` across scans. Markdown parsing
 * spends one shared budget of characters and lines, in the order files are first parsed; a
 * cached parse is reused only for the same text and the same analysis window, so the budget is
 * spent exactly as without the cache.
 */
function createParseServices(
  options: AnalyzeOptions,
): Pick<Analysis, 'frontmatter' | 'markdown' | 'json' | 'toml'> {
  const cache = options.parseCache;
  const frontmatter = memoize<FrontmatterResult>((a) => {
    const { text } = a.decoded;
    return cache === undefined
      ? parseFrontmatter(text)
      : cache.frontmatter(text, () => parseFrontmatter(text));
  });
  let markdownBudget = options.markdownBudget ?? SCAN_MARKDOWN_BUDGET;
  let lineBudget = options.markdownLineBudget ?? SCAN_MARKDOWN_LINE_BUDGET;
  const markdown = memoize<MarkdownDocument>((a) => {
    const { lineStarts, text } = a.decoded;
    // The character offset where the remaining line budget runs out in this file.
    const lineLimit = lineBudget <= 0 ? 0 : (lineStarts[lineBudget] ?? Number.POSITIVE_INFINITY);
    const maxAnalyzedChars = Math.max(0, Math.min(markdownBudget, lineLimit));
    const parse = (): MarkdownDocument => parseMarkdown(text, frontmatter(a), { maxAnalyzedChars });
    // parseMarkdown depends on the budget only through the window it analyzes.
    const doc =
      cache === undefined
        ? parse()
        : cache.markdown(text, markdownWindowEnd(text, maxAnalyzedChars), parse);
    const analyzed = doc.analysis.analyzedLength;
    markdownBudget -= analyzed;
    lineBudget -= countLineStartsBefore(lineStarts, analyzed);
    return doc;
  });
  // Parse JSON the way the reading platform does: Gemini CLI strips comments from its
  // settings.json before JSON.parse, Devin Local documents comments in .devin/config.json, VS
  // Code reads .vscode/mcp.json as JSONC, and every other agent uses strict JSON.
  const json = memoize<JsonDocument>((a) => {
    const { text } = a.decoded;
    const dialect = jsonDialect(a.kind);
    const parse = (): JsonDocument =>
      dialect === 'comments'
        ? parseJsonWithComments(text)
        : dialect === 'jsonc'
          ? parseJsonc(text)
          : parseJson(text);
    return cache === undefined ? parse() : cache.json(text, dialect, parse);
  });
  // TOML as Codex's crate reads it; the decoding tells UTF-16, a byte order mark and bytes that
  // are not UTF-8 apart.
  const toml = memoize<TomlDocument>((a) => {
    const parse = (): TomlDocument => parseToml(a.decoded.text, a.decoded);
    return cache === undefined ? parse() : cache.toml(a.decoded, parse);
  });
  return { frontmatter, markdown, json, toml };
}

function jsonDialect(kind: ArtifactKind): JsonDialect {
  if (kind === 'gemini-settings' || kind === 'devin-config') return 'comments';
  return kind === 'vscode-mcp' ? 'jsonc' : 'strict';
}

/**
 * Decodes and classifies a snapshot's files and sets up the parsers. Parses nothing yet: each
 * file is parsed when something first asks for it. Pure: no I/O.
 */
export function analyze(snapshot: Snapshot, options: AnalyzeOptions = {}): Analysis {
  const config = options.config ?? EMPTY_CONFIG;
  const targetList = [...new Set(options.targets ?? config.targets ?? PLATFORM_IDS)].sort(
    compareStrings,
  );
  const artifacts = buildArtifacts(snapshot, config, options.parseCache);
  return {
    snapshot,
    config,
    targets: new Set(targetList),
    targetList,
    artifacts,
    index: indexArtifacts(artifacts),
    ...createParseServices(options),
  };
}

/** Runs every applicable rule over an analysis. Pure: no I/O, deterministic output. */
export function runRules(analysis: Analysis, options: RunRulesOptions): RuleResult {
  const { snapshot, config, targets, targetList, artifacts, frontmatter, markdown, json, toml } =
    analysis;
  const trustDirectives = options.trustDirectives ?? true;

  const pending: PendingFinding[] = [];
  const ruleFailures: RuleFailure[] = [];
  const ranRules: RuleMeta[] = [];
  const knownRuleIds = new Set<string>(DIRECTIVE_RULES.map((meta) => meta.id));
  // The files each rule ran on and completed, and how many findings it reported per file: an
  // unused directive is removed only when every rule it names ran on its file in this scan.
  const ranOn = new Map<string, ReadonlySet<string>>();
  const reportCounts = new Map<string, number>();

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
    ranOn.set(rule.meta.id, new Set(ruleArtifacts.map((artifact) => artifact.path)));

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
        toml,
        report: (descriptor) => {
          const configured = config.ruleSetting(rule.meta.id, descriptor.artifact.path)?.severity;
          if (configured === 'off') return;
          const countKey = `${rule.meta.id}\u0000${descriptor.artifact.path}`;
          reportCounts.set(countKey, (reportCounts.get(countKey) ?? 0) + 1);
          pending.push({
            meta: rule.meta,
            artifact: descriptor.artifact,
            severity: configured ?? descriptor.severity ?? rule.meta.severity,
            descriptor,
          });
        },
      });
    } catch (error) {
      ranOn.delete(rule.meta.id);
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
      // Directives apply to findings in their own file, imported files included.
      if (!MARKDOWN_OR_IMPORTED_KINDS.has(artifact.kind)) continue;
      // A cheap substring test avoids parsing every file just to look for directives.
      if (!artifact.decoded.text.includes(`${DIRECTIVE_PREFIX}-disable`)) continue;
      const directives = collectDirectives(artifact, frontmatter(artifact), markdown(artifact));
      if (directives.length === 0) continue;
      const entries: { directive: Directive; used: boolean }[] = [];
      let suggested = 0;
      for (const directive of directives) {
        directive.ruleIds.forEach((id, index) => {
          if (knownRuleIds.has(id)) return;
          const similar =
            suggested++ < MAX_SUGGESTED_IDS ? similarRuleIds(id, knownRuleIds) : undefined;
          const [only] = similar ?? [];
          const fix =
            similar?.length === 1 && only !== undefined
              ? unknownRuleFix(artifact, directive, index, only)
              : undefined;
          pending.push({
            meta: DIRECTIVE_UNKNOWN_RULE,
            artifact,
            severity: DIRECTIVE_UNKNOWN_RULE.severity,
            descriptor: {
              artifact,
              span: directive.span,
              message: `Unknown rule "${id}".`,
              ...(fix === undefined ? { guidance: unknownRuleGuidance(similar ?? []) } : { fix }),
            },
          });
        });
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
              guidance: missingReasonGuidance(
                directive,
                artifact.decoded.text.startsWith('#', directive.span.offset),
              ),
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
  const fingerprint = fingerprints(json, toml);

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
      fingerprint: fingerprint(meta.id, artifact, descriptor.span, range.start.line),
      ...(descriptor.fix ? { fix: descriptor.fix } : {}),
      ...(descriptor.guidance === undefined ? {} : { guidance: descriptor.guidance }),
      ...(suppressed ? { suppressed } : {}),
    });
  }

  for (const [path, entries] of directivesByPath) {
    const artifact = artifacts.find((candidate) => candidate.path === path);
    if (!artifact) continue;
    // Only rules that saw the whole file can prove a directive unused: the Markdown budget may
    // have left part of it unanalyzed.
    const complete = markdown(artifact).analysis.complete;
    for (const entry of entries) {
      if (entry.used) continue;
      const range = rangeOf(artifact.decoded, entry.directive.span);
      const provenUnused =
        complete &&
        entry.directive.ruleIds.every(
          (id) =>
            ranOn.get(id)?.has(path) === true &&
            (reportCounts.get(`${id}\u0000${path}`) ?? 0) < CAPPED_FINDINGS,
        );
      const fix = provenUnused ? unusedDirectiveFix(artifact, entry.directive) : undefined;
      findings.push({
        ruleId: DIRECTIVE_UNUSED.id,
        severity: DIRECTIVE_UNUSED.severity,
        category: DIRECTIVE_UNUSED.category,
        message: `No ${entry.directive.ruleIds.join(', ')} finding to suppress here.`,
        path,
        range,
        related: [],
        platforms: DIRECTIVE_UNUSED.platforms,
        fingerprint: fingerprint(
          DIRECTIVE_UNUSED.id,
          artifact,
          entry.directive.span,
          range.start.line,
        ),
        ...(fix === undefined
          ? {
              guidance:
                'remove the directive unless a rule it names reports here with other targets or settings',
            }
          : { fix }),
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
    fingerprintVersion: FINGERPRINT_VERSION,
    targets: targetList,
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      readers: artifact.readers,
    })),
    findings,
    score: computeScore(scoredPaths(artifacts, active), findings),
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

/**
 * Runs every applicable rule over a snapshot, then lists its security inventory. Pure: no I/O,
 * deterministic output.
 */
export function scanSnapshot(snapshot: Snapshot, options: ScanOptions): ScanResult {
  const analysis = analyze(snapshot, options);
  const result = runRules(analysis, options);
  return { ...result, inventory: buildInventory(analysis), agents: buildAgents(analysis) };
}

/**
 * {@link scanSnapshot} plus what each agent loads: the rules run first, then the inventory is
 * built, then the loaders plan each agent on the same analysis. The loaders read the parses the
 * rules made, so the scan's Markdown budget is spent in the same order and the findings are those
 * of {@link scanSnapshot}. Pure: no I/O, deterministic output.
 *
 * Throws, before running any rule, for an agent without a load model, a working directory that
 * is not normalized or climbs above the root, a context window that is not a positive integer,
 * or a matrix requested for a working directory other than the root.
 */
export function scanWithContext(
  snapshot: Snapshot,
  options: ScanOptions & ContextOptions,
): ContextScanResult {
  const cwd = options.cwd ?? '';
  checkWorkingDirectory(cwd);
  checkContextWindow(options.contextWindow);
  if (options.matrix === true && cwd !== '') {
    throw new Error('The matrix covers the whole repository: plan it from the root.');
  }
  if (options.startDirectories === true && (cwd !== '' || options.matrix === true)) {
    throw new Error('Start directories are planned from the root, without the matrix.');
  }
  if (options.agents !== undefined) orderedAgents(options.agents);

  const analysis = analyze(snapshot, options);
  const result = runRules(analysis, options);
  const inventory = buildInventory(analysis);
  const definitions = buildAgents(analysis);
  const agents = options.agents ?? contextAgentsOf(analysis.targetList);
  const shared = {
    agents,
    config: analysis.config,
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  };
  const context =
    options.matrix === true
      ? (() => {
          const plans = matrixPlans(analysis, shared);
          return buildContextReport({
            agents,
            plans,
            matrix: buildMatrix(analysis, plans, agents),
            findings: result.findings,
          });
        })()
      : options.startDirectories === true
        ? (() => {
            const found = startDirectories(analysis);
            const planned = found.slice(0, MAX_START_DIRECTORIES);
            return buildContextReport({
              agents,
              plans: loadPlans(analysis, { ...shared, cwd: '' }),
              // Each directory's plans are summed up and dropped, one directory at a time.
              directories: {
                planned: planned.map((directory) =>
                  startDirectoryTotals(
                    directory,
                    loadPlans(analysis, { ...shared, cwd: directory }),
                  ),
                ),
                notPlanned: found.length - planned.length,
              },
              findings: result.findings,
            });
          })()
        : buildContextReport({
            agents,
            plans: loadPlans(analysis, { ...shared, cwd }),
            findings: result.findings,
          });
  return { ...result, inventory, agents: definitions, context };
}

/**
 * Fingerprints in report order, as src/core/fingerprint.ts describes: `<hash>:<occurrence>`. In a
 * JSON or TOML file that parses, the anchor is the value the span points at; elsewhere it is the
 * text of the finding's first line. Anchors are cached per line and per value, so thousands of
 * findings on one long line or in one long string stay linear instead of quadratic.
 */
function fingerprints(
  json: ParseServices['json'],
  toml: ParseServices['toml'],
): (ruleId: string, artifact: Artifact, span: Span | undefined, line: number) => string {
  const occurrences = new Map<string, number>();
  const lineAnchors = new Map<string, string>();
  const valueAnchors = new WeakMap<JsonLocation, string>();

  const anchorOf = (artifact: Artifact, span: Span | undefined, line: number): string => {
    if (span === undefined) return WHOLE_FILE_ANCHOR;
    if (JSON_KINDS.has(artifact.kind) || TOML_KINDS.has(artifact.kind)) {
      const doc = configDocument({ json, toml }, artifact);
      const location = doc.ok ? doc.locate(span) : undefined;
      if (location !== undefined) {
        let anchor = valueAnchors.get(location);
        if (anchor === undefined) {
          anchor = jsonAnchor(location);
          valueAnchors.set(location, anchor);
        }
        return anchor;
      }
    }
    const key = `${artifact.path}\u0000${line}`;
    let anchor = lineAnchors.get(key);
    if (anchor === undefined) {
      anchor = lineAnchor(lineText(artifact.decoded, line));
      lineAnchors.set(key, anchor);
    }
    return anchor;
  };

  return (ruleId, artifact, span, line) => {
    const base = hash53([ruleId, artifact.path, anchorOf(artifact, span, line)].join('\u0000'));
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return `${base}:${occurrence}`;
  };
}

/**
 * The files the score covers: every artifact, except that a file read only because an
 * instruction file imports it (`imported-file`) counts once it has an error or a warning. Its
 * problems lower the score like any file's, but following imports never raises the score by
 * adding clean files that are not agent configuration.
 */
function scoredPaths(artifacts: readonly Artifact[], active: readonly Finding[]): string[] {
  const penalized = new Set(
    active.filter((finding) => finding.severity !== 'info').map((finding) => finding.path),
  );
  return artifacts
    .filter((artifact) => artifact.kind !== 'imported-file' || penalized.has(artifact.path))
    .map((artifact) => artifact.path);
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
