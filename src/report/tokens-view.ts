/**
 * The token summary of `agentcheckup tokens`: what each agent's configuration costs in context,
 * from the load plans. Per agent: what is in context from the first message, the listings the
 * model picks skills and subagents from, the most later triggers can add, and the subagents it
 * loads; then the subagent calls, largest first, with the model each runs on; and, with
 * `--by-directory`, the start directories by what a session there starts with. Pure.
 *
 * Every number is the plans' estimate, characters ÷ 4 (`Size.tokens`): not a tokenizer count, and
 * never a finding. A call does not add to an agent's numbers: a subagent works in a context
 * window of its own.
 */
import type { AgentDefinition, EffectiveModel } from '../agents/types.js';
import { compareStrings } from '../core/compare.js';
import type { ScanResult } from '../core/engine.js';
import { tokensOf } from '../core/measure.js';
import { isListing, unverifiedAtStart } from '../platforms/load/directories.js';
import {
  ALL_CONTEXT_AGENTS,
  type ContextAgent,
  type LoadPlan,
  type OwnContext,
} from '../platforms/load/types.js';
import { toJsonReport } from './json.js';
import { forJsonOutput } from './sanitize.js';

/** One agent at the working directory the scan planned. */
export interface AgentTokens {
  readonly agent: ContextAgent;
  readonly cwd: string;
  /** ≈tokens in context from the first message, listings included. */
  readonly startup: number;
  /** Of `startup`: the names and descriptions of the skills and subagents the model picks from. */
  readonly listings: number;
  /** The most other triggers can add (the plan's `totals.onDemand`). */
  readonly onDemand: number;
  /**
   * Subagents the agent loads, each with a call of its own: those it lists and those it runs only
   * when asked by name, and those it may load.
   */
  readonly subagents: number;
  /** True when a startup entry is unverified. */
  readonly unverified: boolean;
}

/** What one subagent call starts with, and the model it runs on as far as the repository says. */
export interface CallTokens {
  readonly agent: ContextAgent;
  readonly cwd: string;
  /** The plan entry's id, or the skip's for a call that may run instead of the preferred one. */
  readonly id: string;
  readonly path: string;
  readonly name?: string;
  /**
   * ≈tokens the call starts with, a lower bound when `unmeasured` names files. Absent when
   * nothing of the call can be measured, as for a file agentcheckup cannot read.
   */
  readonly tokens?: number;
  /** Files the call starts with that the scan did not read. */
  readonly unmeasured?: readonly string[];
  /** True when a part of the call, or the call itself, is unverified. */
  readonly unverified: boolean;
  /**
   * True for a definition another one of its name may win over, where the agent does not
   * document which one: its call runs only if it is the one that loads.
   */
  readonly mayRun?: true;
  /**
   * From the agent definition: the model, where it comes from, and `undocumented` for a value
   * outside the ones the agent documents.
   */
  readonly model?: Pick<EffectiveModel, 'value' | 'source'> & { readonly undocumented?: true };
}

/** A start directory: what a session there starts with, per agent. */
export interface DirectoryTokens {
  readonly cwd: string;
  /** The largest `startup` of its agents. */
  readonly largest: number;
  readonly agents: readonly {
    readonly agent: ContextAgent;
    readonly startup: number;
    readonly unverified: boolean;
  }[];
}

export interface TokenSummary {
  /** The plans of the working directory, in report order. */
  readonly agents: readonly AgentTokens[];
  /** Their subagent calls, largest first. */
  readonly calls: readonly CallTokens[];
  /**
   * With `--by-directory`: the start directories planned besides the root, largest first, and
   * how many more hold agent configuration but were not planned.
   */
  readonly directories?: readonly DirectoryTokens[];
  readonly directoriesNotPlanned?: number;
}

const AGENT_RANK: ReadonlyMap<ContextAgent, number> = new Map(
  ALL_CONTEXT_AGENTS.map((agent, index) => [agent, index]),
);

function rank(agent: ContextAgent): number {
  return AGENT_RANK.get(agent) ?? ALL_CONTEXT_AGENTS.length;
}

function agentTokens(plan: LoadPlan): AgentTokens {
  let listed = 0;
  let subagents = 0;
  for (const entry of plan.entries) {
    if (entry.role === 'subagent') subagents++;
    if (isListing(entry)) listed += entry.size?.chars ?? 0;
  }
  return {
    agent: plan.agent,
    cwd: plan.cwd,
    startup: plan.totals.startup.tokens,
    // The estimate of the listings' characters together, as the totals count them.
    listings: tokensOf(listed),
    onDemand: plan.totals.onDemand.tokens,
    subagents,
    unverified: unverifiedAtStart(plan),
  };
}

/** `subagent:<file>[#<role>]` -> `agent:<file>[#<role>]@<agent>`: the definition's id. */
function definitionId(entry: { readonly id: string }, agent: ContextAgent): string {
  return `agent:${entry.id.slice(entry.id.indexOf(':') + 1)}@${agent}`;
}

function callTokens(
  plan: LoadPlan,
  call: {
    readonly id: string;
    readonly path: string;
    readonly name?: string;
    readonly ownContext?: OwnContext;
  },
  definitions: ReadonlyMap<string, AgentDefinition>,
  mayRun: boolean,
): CallTokens {
  const definition = definitions.get(definitionId(call, plan.agent));
  const effective = definition?.effective;
  const context = call.ownContext;
  const unverified =
    context === undefined ||
    mayRun ||
    context.parts.some((part) => part.certainty === 'unverified');
  // The definition's own model, as written, outside the values the agent documents.
  const undocumented =
    effective?.source === 'definition' && definition?.model?.form === 'not-documented';
  return {
    agent: plan.agent,
    cwd: plan.cwd,
    id: call.id,
    path: call.path,
    ...(call.name === undefined ? {} : { name: call.name }),
    ...(context === undefined ? {} : { tokens: context.size.tokens }),
    ...(context?.unmeasured === undefined ? {} : { unmeasured: context.unmeasured }),
    unverified,
    ...(mayRun ? { mayRun: true as const } : {}),
    ...(effective === undefined
      ? {}
      : {
          model: {
            ...(effective.value === undefined ? {} : { value: effective.value }),
            source: effective.source,
            ...(undocumented ? { undocumented: true as const } : {}),
          },
        }),
  };
}

/**
 * Calls first that nothing of can be measured, then the largest; then by agent, working
 * directory and id.
 */
function compareCalls(a: CallTokens, b: CallTokens): number {
  return (
    (a.tokens === undefined ? 0 : 1) - (b.tokens === undefined ? 0 : 1) ||
    (b.tokens ?? 0) - (a.tokens ?? 0) ||
    rank(a.agent) - rank(b.agent) ||
    compareStrings(a.cwd, b.cwd) ||
    compareStrings(a.id, b.id)
  );
}

/** The summary of a scan with load plans, or undefined without them. */
export function tokenSummary(result: ScanResult): TokenSummary | undefined {
  const { context } = result;
  if (context === undefined) return undefined;
  const main = [...context.plans].sort(
    (a, b) => rank(a.agent) - rank(b.agent) || compareStrings(a.cwd, b.cwd),
  );
  const definitions = new Map(
    (result.agents?.definitions ?? []).map((definition) => [definition.id, definition]),
  );
  // Every subagent the plan lists, measured or not, and each one that may run instead.
  const calls = main
    .flatMap((plan) => [
      ...plan.entries
        .filter((entry) => entry.role === 'subagent')
        .map((entry) => callTokens(plan, entry, definitions, false)),
      ...plan.skipped.flatMap((skip) =>
        skip.ownContext === undefined ? [] : [callTokens(plan, skip, definitions, true)],
      ),
    ])
    .sort(compareCalls);
  if (context.directories === undefined) return { agents: main.map(agentTokens), calls };
  const directories = context.directories.planned
    .map((directory) => {
      const agents = directory.agents
        .map((row) => ({
          agent: row.agent,
          startup: row.startup.tokens,
          unverified: row.unverified,
        }))
        .sort((a, b) => rank(a.agent) - rank(b.agent));
      return {
        cwd: directory.cwd,
        largest: Math.max(0, ...agents.map((row) => row.startup)),
        agents,
      };
    })
    .sort((a, b) => b.largest - a.largest || compareStrings(a.cwd, b.cwd));
  return {
    agents: main.map(agentTokens),
    calls,
    directories,
    directoriesNotPlanned: context.directories.notPlanned,
  };
}

/** The JSON report of `agentcheckup tokens`: the scan's report with the summary as `tokens`. */
export function formatTokensJson(result: ScanResult): string {
  const summary = tokenSummary(result);
  const report = { ...toJsonReport(result), ...(summary === undefined ? {} : { tokens: summary }) };
  return `${forJsonOutput(JSON.stringify(report, null, 2))}\n`;
}
