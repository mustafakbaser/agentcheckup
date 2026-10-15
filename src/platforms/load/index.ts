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
import { PLATFORM_IDS, type PlatformId, type RuleSource } from '../../core/types.js';
import { SOURCES } from '../sources.js';
import { loadClaudeCode } from './claude-code.js';
import { loadCodex } from './codex.js';
import { loadCursor } from './cursor.js';
import {
  CONTEXT_AGENTS,
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

const LOADERS: Readonly<Record<ContextAgent, Loader>> = {
  'claude-code': loadClaudeCode,
  codex: loadCodex,
  cursor: loadCursor,
};

/** True for an agent agentcheckup has a load model for. */
export function isContextAgent(platform: string): platform is ContextAgent {
  return (CONTEXT_AGENTS as readonly string[]).includes(platform);
}

/** The modeled agents among `targets`, in PLATFORM_IDS order. */
export function contextAgentsOf(targets: Iterable<PlatformId>): ContextAgent[] {
  const set = new Set<string>(targets);
  return CONTEXT_AGENTS.filter((agent) => set.has(agent));
}

/** `agents` without repeats, in PLATFORM_IDS order. Throws for an agent without a load model. */
export function orderedAgents(agents: readonly string[]): ContextAgent[] {
  for (const agent of agents) {
    if (!isContextAgent(agent)) {
      throw new Error(`No load model for ${JSON.stringify(agent)}.`);
    }
  }
  return contextAgentsOf(agents as readonly PlatformId[]);
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

/** One plan per agent for a session started in `options.cwd`, in PLATFORM_IDS order. */
export function loadPlans(view: LoadView, options: LoadPlansOptions): LoadPlan[] {
  checkWorkingDirectory(options.cwd);
  checkContextWindow(options.contextWindow);
  return orderedAgents(options.agents).map((agent) =>
    LOADERS[agent](view, {
      cwd: options.cwd,
      config: options.config,
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
    }),
  );
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

const PLATFORM_RANK: ReadonlyMap<PlatformId, number> = new Map(
  PLATFORM_IDS.map((id, index) => [id, index]),
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
    (PLATFORM_RANK.get(a.agent) ?? 0) - (PLATFORM_RANK.get(b.agent) ?? 0) ||
    compareStrings(a.cwd, b.cwd)
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
  /** The report's columns. Put in PLATFORM_IDS order. */
  readonly agents: readonly ContextAgent[];
  readonly plans: readonly LoadPlan[];
  readonly matrix?: ContextReport['matrix'];
}

/**
 * The context report of `plans`: agents in PLATFORM_IDS order, plans by agent then working
 * directory, every list inside a plan sorted, matrix rows by path, and `sources` holding exactly
 * the sources the plans cite, by key. A matrix's cells must already follow `agents` in
 * PLATFORM_IDS order (see `buildMatrix`).
 */
export function buildContextReport(input: ContextReportInput): ContextReport {
  const plans = input.plans.map(sortedPlan).sort(comparePlans);
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
