/**
 * Assembly of load plans into a context report: which loader runs for which agent, and the
 * report's `sources`, built from exactly the evidence the plans cite. Pure.
 *
 * Run the loaders on the analysis the rules ran on, after the rules (see `scanWithContext` in
 * src/core/engine.ts): they read the same cached parses, so the scan's Markdown budget is spent
 * in the same order and findings cannot change. The second plan that counts what `ignore` hides
 * runs on an analysis of its own (`LoadPlansOptions.withIgnored`).
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { normalizeRelative } from '../../core/paths.js';
import type { Finding, PlatformId, RuleSource } from '../../core/types.js';
import { SOURCES } from '../sources.js';
import { loadClaudeCode } from './claude-code.js';
import { loadCline } from './cline.js';
import { loadCodex } from './codex.js';
import { loadCopilotCli, loadCopilotCloud, loadCopilotVscode } from './copilot.js';
import { loadCursor } from './cursor.js';
import { loadGemini } from './gemini.js';
import { compareEntries, compareOutOfScope, compareSkips } from './order.js';
import { withSubagents } from './subagents.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type ContextAgent,
  type ContextReport,
  type HiddenScope,
  type LoadEntry,
  type LoadPlan,
  type SkipFix,
  type SourceKey,
} from './types.js';
import type { LoadView } from './view.js';
import { loadWindsurf } from './windsurf.js';

export interface LoadPlansOptions {
  /** Agents to plan for, in any order; each is planned once. */
  readonly agents: readonly ContextAgent[];
  /** Working directory, root-relative POSIX, normalized, `''` for the scan root. */
  readonly cwd: string;
  /** The scan's configuration: rule options set limits and assumptions. */
  readonly config: ResolvedConfig;
  /** The model's context window in tokens (`--context-window`): a positive integer. */
  readonly contextWindow?: number;
  /**
   * The scan as if the configuration's `ignore` matched nothing, when `ignore` leaves out any
   * file (`analyzeWithIgnored` in src/core/engine.ts). Each agent is planned over it too, to count
   * the files `ignore` hides that the agent may load (see {@link withoutIgnored}). Without it, a
   * plan counts only the ignored files its loader finds without reading them.
   */
  readonly withIgnored?: LoadView;
}

type Loader = (
  view: LoadView,
  options: {
    readonly cwd: string;
    readonly config: ResolvedConfig;
    readonly contextWindow?: number;
  },
) => LoadPlan;

/**
 * The loader of each agent. Its `LOADER_ENABLED` flag in ./types.ts can turn an agent off: no
 * command, scan or matrix then plans it.
 */
const LOADERS: Readonly<Record<ContextAgent, Loader>> = {
  'claude-code': loadClaudeCode,
  codex: loadCodex,
  cursor: loadCursor,
  'copilot-cli': loadCopilotCli,
  'copilot-vscode': loadCopilotVscode,
  'copilot-cloud': loadCopilotCloud,
  gemini: loadGemini,
  windsurf: loadWindsurf,
  cline: loadCline,
};

/** True for an agent agentcheckup has a load model for that is turned on. */
export function isContextAgent(agent: string): agent is ContextAgent {
  return (CONTEXT_AGENTS as readonly string[]).includes(agent);
}

/**
 * The modeled agents of the platforms in `targets`, in report order: every agent that is turned
 * on and whose platform ({@link CONTEXT_PLATFORM}) is targeted.
 */
export function contextAgentsOf(targets: Iterable<PlatformId>): ContextAgent[] {
  const set = new Set<PlatformId>(targets);
  return CONTEXT_AGENTS.filter((agent) => set.has(CONTEXT_PLATFORM[agent]));
}

/**
 * `agents` without repeats, in report order. Throws for an agent without a load model, or one
 * that is turned off.
 */
export function orderedAgents(agents: readonly string[]): ContextAgent[] {
  for (const agent of agents) {
    if (!isContextAgent(agent)) {
      throw new Error(`No load model for ${JSON.stringify(agent)}.`);
    }
  }
  const set = new Set<string>(agents);
  return CONTEXT_AGENTS.filter((agent) => set.has(agent));
}

/** Throws unless `cwd` is a normalized root-relative path that does not climb above the root. */
export function checkWorkingDirectory(cwd: string): void {
  if (normalizeRelative(cwd) !== cwd) {
    throw new Error(
      `Working directory must be a normalized relative path, got ${JSON.stringify(cwd)}.`,
    );
  }
}

/** Throws unless `contextWindow` is absent or a positive safe integer. */
export function checkContextWindow(contextWindow: number | undefined): void {
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error(`Context window must be a positive integer, got ${String(contextWindow)}.`);
  }
}

/**
 * One plan per agent for a session started in `options.cwd`, in report order, without the
 * paths the configuration ignores ({@link withoutIgnored}).
 */
export function loadPlans(view: LoadView, options: LoadPlansOptions): LoadPlan[] {
  checkWorkingDirectory(options.cwd);
  checkContextWindow(options.contextWindow);
  const loaderOptions = {
    cwd: options.cwd,
    config: options.config,
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  };
  const planOver = (agent: ContextAgent, over: LoadView): LoadPlan =>
    withSubagents(LOADERS[agent](over, loaderOptions), over);
  const { withIgnored } = options;
  // Only the count depends on the plan over the ignored files: if a loader fails on one of them,
  // the count falls back to what the plan itself finds, and the command goes on.
  const unignored = (agent: ContextAgent): LoadPlan | undefined => {
    if (withIgnored === undefined) return undefined;
    try {
      return planOver(agent, withIgnored);
    } catch {
      return undefined;
    }
  };
  return orderedAgents(options.agents).map((agent) =>
    withoutIgnored(planOver(agent, view), options.config, unignored(agent)),
  );
}

/** The path an `incomplete` item names: `unread:docs/a.md` -> `docs/a.md`; a directory without its `/`. */
function incompletePath(item: string): string {
  const path = item.slice(item.indexOf(':') + 1);
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Every path `plan` lists: its entries, skips, files out of scope, limit subjects and incomplete
 * items.
 */
function listedPaths(plan: LoadPlan): string[] {
  return [
    ...plan.entries.map((entry) => entry.path),
    ...plan.skipped.map((skip) => skip.path),
    ...plan.outOfScope.map((item) => item.path),
    ...plan.limits.map((limit) => limit.subject),
    ...plan.incomplete.map(incompletePath),
  ];
}

/** Incomplete items that name a file the agent may load; the others mark how far parsing went. */
const MAY_LOAD_INCOMPLETE: ReadonlySet<string> = new Set(['unread', 'unparsed', 'fallback']);

/**
 * The files `plan` says its agent loads or may load: its entries, the skips no source confirms,
 * and the files it could not analyze. Not the files it skips for a documented reason or leaves out
 * of scope, which the agent is not expected to load, and not directories.
 */
function mayLoad(plan: LoadPlan): string[] {
  return [
    ...plan.entries.map((entry) => entry.path),
    ...plan.skipped.filter((skip) => skip.certainty === 'unverified').map((skip) => skip.path),
    ...plan.incomplete
      .filter((item) => MAY_LOAD_INCOMPLETE.has(item.slice(0, item.indexOf(':'))))
      .filter((item) => !item.endsWith('/'))
      .map(incompletePath),
  ].filter((path) => path !== '');
}

/**
 * `plan` without the paths the configuration's `ignore` matches, and with `ignored` set to how
 * many files it hides that the agent may load.
 *
 * Neither the rules nor the plan read an ignored file. A loader that looks on disk still finds
 * one, without its content, and lists it as unread, skipped or out of scope; the matrix would
 * give it a row. A loader that looks only among the files the scan read, as for a nested
 * CLAUDE.md, does not find it at all. So `unignored`, the same agent's plan over the scan as if
 * `ignore` matched nothing, counts too.
 *
 * `ignored` counts the files the plan over the ignored files says the agent loads or may load
 * (entries, unverified skips, files not analyzed) that this plan does not show: ignored files,
 * and files the agent reaches only through them, such as a skill symlinked into an ignored
 * directory. Ignored files that plan does not list count when this plan could not read them, as
 * for a settings file without hooks or servers. Files the agent skips for a documented reason,
 * or does not look at from this session, are left out without a count, so "may still load them"
 * holds. A count, not a list, because `ignore` usually covers whole directories such as test
 * fixtures, whose files would otherwise crowd out the real configuration. `--untrusted` ignores
 * the repository's configuration, so its plans leave nothing out.
 *
 * Only an item's own path decides whether it stays: an item whose path is not ignored stays,
 * whatever the files behind it, so plans keep agreeing with the findings
 * (src/platforms/load/consistency.ts).
 */
export function withoutIgnored(
  plan: LoadPlan,
  config: ResolvedConfig,
  unignored?: LoadPlan,
): LoadPlan {
  const isIgnored = (path: string): boolean => path !== '' && config.isIgnored(path);
  const keep = (path: string): boolean => !isIgnored(path);
  const entries = plan.entries.filter((entry) => keep(entry.path));
  const skipped = plan.skipped.filter((skip) => keep(skip.path));
  const outOfScope = plan.outOfScope.filter((item) => keep(item.path));
  const incomplete = plan.incomplete.filter((item) => keep(incompletePath(item)));
  // A limit measured on an ignored file, such as the import depth an ignored import reaches.
  const limits = plan.limits.filter((limit) => keep(limit.subject));
  const kept = { ...plan, entries, skipped, outOfScope, limits, incomplete };
  // The plan over the ignored files decides for every file it lists. For the others, such as a
  // settings file that declares nothing it lists, the files this plan could not read count.
  const decided = new Set(unignored === undefined ? [] : listedPaths(unignored));
  const hidden = new Set(mayLoad(plan).filter((path) => isIgnored(path) && !decided.has(path)));
  if (unignored !== undefined) {
    const shown = new Set(listedPaths(kept));
    for (const path of mayLoad(unignored))
      if (isIgnored(path) || !shown.has(path)) hidden.add(path);
  }
  const removed =
    entries.length !== plan.entries.length ||
    skipped.length !== plan.skipped.length ||
    outOfScope.length !== plan.outOfScope.length ||
    incomplete.length !== plan.incomplete.length ||
    limits.length !== plan.limits.length;
  if (!removed && hidden.size === 0) return plan;
  return {
    ...kept,
    entries: renumbered(entries),
    ...(hidden.size === 0 ? {} : { ignored: hidden.size }),
  };
}

/**
 * Startup positions 1, 2, 3… again, in the same order, after entries were left out. An unread
 * import of an ignored file has a position but no size, so totals do not change.
 */
function renumbered(entries: readonly LoadEntry[]): LoadEntry[] {
  const positions = [
    ...new Set(entries.flatMap((entry) => (entry.position === undefined ? [] : [entry.position]))),
  ].sort((a, b) => a - b);
  const next = new Map(positions.map((position, index) => [position, index + 1]));
  return entries.map((entry) => {
    const position = entry.position === undefined ? undefined : next.get(entry.position);
    return position === undefined || position === entry.position ? entry : { ...entry, position };
  });
}

/** One plan of `agent` for a session started in `cwd`. */
export function loadPlan(
  view: LoadView,
  agent: ContextAgent,
  options: Omit<LoadPlansOptions, 'agents'>,
): LoadPlan {
  const [plan] = loadPlans(view, { ...options, agents: [agent] });
  if (plan === undefined) throw new Error(`No plan for ${agent}.`);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

/** Every source key a plan cites: in entries, skips, assumptions and limits. */
export function citedSourceKeys(plans: readonly LoadPlan[]): SourceKey[] {
  const keys = new Set<SourceKey>();
  const add = (evidence: readonly SourceKey[]): void => {
    for (const key of evidence) keys.add(key);
  };
  for (const plan of plans) {
    for (const entry of plan.entries) add(entry.evidence);
    for (const skip of plan.skipped) add(skip.evidence);
    for (const assumption of plan.assumptions) add(assumption.evidence);
    for (const limit of plan.limits) add(limit.evidence);
  }
  return [...keys].sort(compareStrings);
}

const SOURCE_TABLE: Readonly<Record<string, RuleSource>> = SOURCES;

/**
 * The sources of `keys`, sorted by key. Throws for a key that is not in src/platforms/sources.ts:
 * a plan must never cite evidence the report cannot show.
 */
export function sourcesOf(keys: readonly SourceKey[]): Record<SourceKey, RuleSource> {
  const sources: Record<SourceKey, RuleSource> = {};
  for (const key of [...keys].sort(compareStrings)) {
    if (!Object.hasOwn(SOURCE_TABLE, key)) {
      throw new Error(`Load plans cite ${JSON.stringify(key)}, which is not a known source.`);
    }
    const source = SOURCE_TABLE[key];
    if (source !== undefined) sources[key] = source;
  }
  return sources;
}

const AGENT_RANK: ReadonlyMap<ContextAgent, number> = new Map(
  ALL_CONTEXT_AGENTS.map((agent, index) => [agent, index]),
);

const SCOPE_RANK: Readonly<Record<HiddenScope['scope'], number>> = {
  managed: 0,
  user: 1,
  global: 2,
  team: 3,
  account: 4,
  plugin: 5,
};

function comparePlans(a: LoadPlan, b: LoadPlan): number {
  return (
    (AGENT_RANK.get(a.agent) ?? 0) - (AGENT_RANK.get(b.agent) ?? 0) || compareStrings(a.cwd, b.cwd)
  );
}

/** A plan with every list in the order of the design (section 1). */
export function sortedPlan(plan: LoadPlan): LoadPlan {
  return {
    ...plan,
    entries: [...plan.entries].sort(compareEntries),
    skipped: [...plan.skipped].sort(compareSkips),
    outOfScope: [...plan.outOfScope].sort(compareOutOfScope),
    assumptions: [...plan.assumptions].sort((a, b) => compareStrings(a.key, b.key)),
    hidden: [...plan.hidden].sort(
      (a, b) =>
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        compareStrings(a.locations.join('\n'), b.locations.join('\n')),
    ),
    limits: [...plan.limits].sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    ),
    incomplete: [...plan.incomplete].sort(compareStrings),
  };
}

export interface ContextReportInput {
  /** The report's columns. Put in report order. */
  readonly agents: readonly ContextAgent[];
  readonly plans: readonly LoadPlan[];
  readonly matrix?: ContextReport['matrix'];
  readonly directories?: ContextReport['directories'];
  /**
   * The scan's findings. A skip gets `fix`, how the fix on the unsuppressed finding of its rule
   * on its file is applied ({@link withFixClasses}). Without them, skips keep what they have.
   */
  readonly findings?: readonly Finding[];
}

/** How hard each way of applying a fix is: the skip is gone only once the hardest is done. */
const SKIP_FIX_RANK: Readonly<Record<SkipFix, number>> = { safe: 0, review: 1, input: 2 };

/**
 * How the fix of each (rule, file) is applied, from the unsuppressed findings that carry a fix:
 * `input` when it needs the user's words, else its class. When several findings do, the
 * hardest wins (`input`, then `review`): the skip is gone only once every one of them is
 * applied.
 */
function skipFixes(findings: readonly Finding[]): Map<string, SkipFix> {
  const fixes = new Map<string, SkipFix>();
  for (const finding of findings) {
    if (finding.suppressed !== undefined || finding.fix === undefined) continue;
    const key = `${finding.ruleId}\u0000${finding.path}`;
    const fix: SkipFix = finding.fix.input === undefined ? finding.fix.class : 'input';
    const previous = fixes.get(key);
    if (previous === undefined || SKIP_FIX_RANK[fix] > SKIP_FIX_RANK[previous]) {
      fixes.set(key, fix);
    }
  }
  return fixes;
}

/**
 * `plan` with `fix` set on each skip a rule reports, from the finding of that rule on the same
 * path (`SkippedLoad.ruleId`, `SkippedLoad.path`) when it carries a fix, and removed otherwise.
 * `fix` is `input` when that fix needs the user's words.
 */
export function withFixClasses(plan: LoadPlan, findings: readonly Finding[]): LoadPlan {
  const fixes = skipFixes(findings);
  return {
    ...plan,
    skipped: plan.skipped.map((skip) => {
      const { fix: _previous, ...rest } = skip;
      const fix =
        skip.ruleId === undefined ? undefined : fixes.get(`${skip.ruleId}\u0000${skip.path}`);
      return fix === undefined ? rest : { ...rest, fix };
    }),
  };
}

/**
 * The context report of `plans`: agents in report order, plans by agent then working
 * directory, every list inside a plan sorted, matrix rows by path, and `sources` holding exactly
 * the sources the plans cite, by key. A matrix's cells must already follow `agents` in
 * report order (see `buildMatrix`). With `findings`, skips get their fix class.
 */
export function buildContextReport(input: ContextReportInput): ContextReport {
  const { findings } = input;
  const plans = input.plans
    .map((plan) => sortedPlan(findings === undefined ? plan : withFixClasses(plan, findings)))
    .sort(comparePlans);
  return {
    agents: orderedAgents(input.agents),
    sources: sourcesOf(citedSourceKeys(plans)),
    plans,
    ...(input.directories === undefined ? {} : { directories: input.directories }),
    ...(input.matrix === undefined
      ? {}
      : {
          matrix: {
            rows: [...input.matrix.rows].sort(
              (a, b) => compareStrings(a.path, b.path) || compareStrings(a.kind, b.kind),
            ),
          },
        }),
  };
}
