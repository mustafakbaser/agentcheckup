/**
 * Assembly of load plans into a context report: which loader runs for which agent, and the
 * report's `sources`, built from exactly the evidence the plans cite. Pure.
 *
 * Run the loaders on the analysis the rules ran on, after the rules (see `scanWithContext` in
 * src/core/engine.ts): they read the same cached parses, so the scan's Markdown budget is spent
 * in the same order and findings cannot change.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { normalizeRelative } from '../../core/paths.js';
import type { Finding, FixClass, PlatformId, RuleSource } from '../../core/types.js';
import { SOURCES } from '../sources.js';
import { loadClaudeCode } from './claude-code.js';
import { loadCline } from './cline.js';
import { loadCodex } from './codex.js';
import { loadCopilotCli, loadCopilotCloud, loadCopilotVscode } from './copilot.js';
import { loadCursor } from './cursor.js';
import { loadGemini } from './gemini.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type ContextAgent,
  type ContextReport,
  type HiddenScope,
  type LoadEntry,
  type LoadPlan,
  type OutOfScope,
  type SkippedLoad,
  type SourceKey,
  TRIGGER_RANK,
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
  return orderedAgents(options.agents).map((agent) =>
    withoutIgnored(
      LOADERS[agent](view, {
        cwd: options.cwd,
        config: options.config,
        ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      }),
      options.config,
    ),
  );
}

/** The path an `incomplete` item names: `unread:docs/a.md` -> `docs/a.md`; a directory without its `/`. */
function incompletePath(item: string): string {
  const path = item.slice(item.indexOf(':') + 1);
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * `plan` without the paths the configuration's `ignore` matches, and with `ignored` set to how
 * many distinct paths it left out.
 *
 * The scan never reads an ignored file, so a loader finds it on disk without its content and
 * would list it as unread, skipped or out of scope, and the matrix would give it a row. The
 * agents still load those files, so the plan does not pretend they are gone: it counts them.
 * A count, not a list, because `ignore` usually covers whole directories such as test fixtures,
 * whose files would otherwise crowd out the real configuration. `--untrusted` ignores the
 * repository's configuration, so its plans leave nothing out.
 *
 * Only an item's own path counts: an item whose path is not ignored stays, whatever the files
 * behind it, so plans keep agreeing with the findings (src/platforms/load/consistency.ts).
 */
export function withoutIgnored(plan: LoadPlan, config: ResolvedConfig): LoadPlan {
  const ignored = new Set<string>();
  const keep = (path: string): boolean => {
    if (path === '' || !config.isIgnored(path)) return true;
    ignored.add(path);
    return false;
  };
  const entries = plan.entries.filter((entry) => keep(entry.path));
  const skipped = plan.skipped.filter((skip) => keep(skip.path));
  const outOfScope = plan.outOfScope.filter((item) => keep(item.path));
  const incomplete = plan.incomplete.filter((item) => keep(incompletePath(item)));
  // A limit measured on an ignored file, such as the import depth an ignored import reaches.
  const limits = plan.limits.filter((limit) => keep(limit.subject));
  if (ignored.size === 0) return plan;
  return {
    ...plan,
    entries: renumbered(entries),
    skipped,
    outOfScope,
    limits,
    incomplete,
    ignored: ignored.size,
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

function compareEntries(a: LoadEntry, b: LoadEntry): number {
  return (
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
    TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
    compareStrings(a.path, b.path) ||
    compareStrings(a.id, b.id)
  );
}

function compareSkips(a: SkippedLoad, b: SkippedLoad): number {
  return compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
}

function compareOutOfScope(a: OutOfScope, b: OutOfScope): number {
  return compareStrings(a.path, b.path) || compareStrings(a.because, b.because);
}

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
  /**
   * The scan's findings. A skip gets `fix`, the class of the fix on the unsuppressed finding of
   * its rule on its file ({@link withFixClasses}). Without them, skips keep what they have.
   */
  readonly findings?: readonly Finding[];
}

/**
 * The fix class of each (rule, file): from the unsuppressed findings that carry a fix. When
 * several do, `review` wins: the skip is gone only once every one of them is applied.
 */
function fixClasses(findings: readonly Finding[]): Map<string, FixClass> {
  const classes = new Map<string, FixClass>();
  for (const finding of findings) {
    if (finding.suppressed !== undefined || finding.fix === undefined) continue;
    const key = `${finding.ruleId}\u0000${finding.path}`;
    if (classes.get(key) !== 'review') classes.set(key, finding.fix.class);
  }
  return classes;
}

/**
 * `plan` with `fix` set on each skip a rule reports, from the finding of that rule on the same
 * path (`SkippedLoad.ruleId`, `SkippedLoad.path`) when it carries a fix, and removed otherwise.
 */
export function withFixClasses(plan: LoadPlan, findings: readonly Finding[]): LoadPlan {
  const classes = fixClasses(findings);
  return {
    ...plan,
    skipped: plan.skipped.map((skip) => {
      const { fix: _previous, ...rest } = skip;
      const fix =
        skip.ruleId === undefined ? undefined : classes.get(`${skip.ruleId}\u0000${skip.path}`);
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
