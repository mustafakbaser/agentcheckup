/**
 * What a scan report adds to its findings so the reader knows what to do next, computed once
 * for the stylish, Markdown and GitHub formatters so they say the same thing:
 *
 * - the fix a rule attached to a finding (class and title) or, without one, its manual
 *   guidance;
 * - what the root load plans add to a finding: the size of what the agent misses and which
 *   other agents still load the file (the `why` line);
 * - the impact summary, "what each agent misses": one row per skip in a root load plan, with
 *   the class of the fix that would remove it.
 *
 * Strings here are raw. Paths, names, fix titles and guidance come from the scanned repository,
 * so each formatter passes every string through its own sanitizer when it writes it. Pure.
 */
import { compareStrings } from '../core/compare.js';
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import { ruleDocsUrl } from '../core/meta.js';
import type { Finding, Fix, FixClass } from '../core/types.js';
import {
  CONTEXT_AGENTS,
  type ContextAgent,
  type LoadPlan,
  type SkippedLoad,
} from '../platforms/load/types.js';
import { AGENT_NAMES, SKIP_LABELS } from './context-view.js';

/**
 * How much a human-readable report shows.
 * - `compact`: the findings as before fixes existed, plus a `fixable` tag.
 * - `default`: what each agent misses, then per finding a `why` line (when the load plans add a
 *   fact the message lacks) and a `fix` or `how` line, then the fix counts with the commands.
 * - `verbose`: `default` plus, per finding, the rule's docs URL, the first paragraph of its
 *   rationale and its sources.
 */
export const DETAIL_LEVELS = ['compact', 'default', 'verbose'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export function isDetailLevel(value: string): value is DetailLevel {
  return (DETAIL_LEVELS as readonly string[]).includes(value);
}

/** Rule ids that are safe in a code span, a URL and a terminal hyperlink as they are. */
const SAFE_RULE_ID = /^[a-z\d]+(?:-[a-z\d]+)*\/[a-z\d]+(?:-[a-z\d]+)*$/;

export function isSafeRuleId(ruleId: string): boolean {
  return SAFE_RULE_ID.test(ruleId);
}

/** The rule's documentation page, or undefined for an id that is not a plain identifier. */
export function docsUrl(ruleId: string): string | undefined {
  return isSafeRuleId(ruleId) ? ruleDocsUrl(ruleId) : undefined;
}

/**
 * Where a fix is shown. `pull-request` (Markdown, annotations, SARIF) leaves out fixes that
 * apply only when named explicitly: the credential fix of mcp/literal-secret is never suggested
 * in a pull request (docs/adr/0008-write-fixes-to-the-scanned-repository.md).
 */
export type Channel = 'terminal' | 'pull-request';

/** Rules whose fix `agentcheckup fix` applies only when named with `--rule` or accepted in `-i`. */
export const OPT_IN_FIX_RULES: ReadonlySet<string> = new Set(['mcp/literal-secret']);

/** The fix to show for a finding: none for a suppressed finding, which is never fixed. */
export function fixOf(finding: Finding, channel: Channel): Fix | undefined {
  if (finding.suppressed !== undefined || finding.fix === undefined) return undefined;
  if (channel === 'pull-request' && OPT_IN_FIX_RULES.has(finding.ruleId)) return undefined;
  return finding.fix;
}

/** The manual step to show for a finding: none for a suppressed finding or blank guidance. */
export function guidanceOf(finding: Finding): string | undefined {
  if (finding.suppressed !== undefined || finding.guidance === undefined) return undefined;
  return finding.guidance.trim() === '' ? undefined : finding.guidance;
}

export interface FixCounts {
  readonly safe: number;
  readonly review: number;
  /** Unsuppressed findings without a fix: a person has to make the change. */
  readonly manual: number;
}

/** How many unsuppressed findings have a safe fix, a fix that needs review, or none. */
export function fixCounts(findings: readonly Finding[], channel: Channel): FixCounts {
  let safe = 0;
  let review = 0;
  let manual = 0;
  for (const finding of findings) {
    if (finding.suppressed !== undefined) continue;
    const fix = fixOf(finding, channel);
    if (fix === undefined) manual++;
    else if (fix.class === 'safe') safe++;
    else review++;
  }
  return { safe, review, manual };
}

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/** The first paragraph of a Markdown text, its lines joined with spaces. */
export function firstParagraph(markdown: string): string {
  const lines: string[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(trimmed);
  }
  return lines.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Root load plans
// ---------------------------------------------------------------------------------------------

const AGENT_RANK: ReadonlyMap<ContextAgent, number> = new Map(
  CONTEXT_AGENTS.map((agent, index) => [agent, index]),
);

/** `pathBase` as a plan's `cwd` holds it after a rebase: no trailing slash, `''` for none. */
function rootCwd(result: ScanResult): string {
  const base = result.pathBase ?? '';
  if (base === '.') return '';
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  return base.slice(0, end);
}

/**
 * Plans for a session started in the scanned directory, one per agent, in CONTEXT_AGENTS
 * order. After a rebase their `cwd` is the report's `pathBase`.
 */
export function rootPlans(result: ScanResult): LoadPlan[] {
  if (result.context === undefined) return [];
  const cwd = rootCwd(result);
  const seen = new Set<ContextAgent>();
  return [...result.context.plans]
    .filter((plan) => plan.cwd === cwd && AGENT_RANK.has(plan.agent))
    .sort((a, b) => (AGENT_RANK.get(a.agent) ?? 0) - (AGENT_RANK.get(b.agent) ?? 0))
    .filter((plan) => {
      if (seen.has(plan.agent)) return false;
      seen.add(plan.agent);
      return true;
    });
}

function findingKey(ruleId: string, path: string): string {
  return `${ruleId}\u0000${path}`;
}

/** The skips that mean a problem: not the files an agent does not read at all. */
function problemSkips(plan: LoadPlan): SkippedLoad[] {
  return plan.skipped
    .filter((skip) => skip.code !== 'not-read')
    .sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id));
}

/** The key under which an agent's entries for the item a skip names are indexed. */
function itemKey(role: string, path: string, name: string | undefined): string {
  if ((role === 'mcp-server' || role === 'hook') && name !== undefined) {
    return `${path}\u0000${name}`;
  }
  // A skipped import names the import's target; the importing file is its path.
  if (role === 'import' && name !== undefined) return name;
  return path;
}

// ---------------------------------------------------------------------------------------------
// The `why` line
// ---------------------------------------------------------------------------------------------

/** What the root load plans know about a finding that its message does not say. */
export interface PlanFacts {
  /** Agents that skip the file because of this finding, by display name. */
  readonly skippers: readonly string[];
  /** Estimated tokens the skipping agents miss, when the loader knows the size. */
  readonly tokens?: number;
  /** Other agents whose root plan loads the same file or item, by display name. */
  readonly loaders: readonly string[];
}

/** Plan facts by finding, built once per report. */
export interface PlanIndex {
  facts(finding: Finding): PlanFacts | undefined;
}

/**
 * Indexes the root plans: skips by the rule and file of the finding that reports them, and
 * which agents load each file or item. Empty without load plans.
 */
export function planIndex(result: ScanResult): PlanIndex {
  const skips = new Map<string, { agent: ContextAgent; skip: SkippedLoad }[]>();
  const loaders = new Map<string, Set<ContextAgent>>();
  for (const plan of rootPlans(result)) {
    for (const skip of problemSkips(plan)) {
      if (skip.ruleId === undefined) continue;
      const key = findingKey(skip.ruleId, skip.path);
      const list = skips.get(key) ?? [];
      list.push({ agent: plan.agent, skip });
      skips.set(key, list);
    }
    for (const entry of plan.entries) {
      const keys =
        (entry.role === 'mcp-server' || entry.role === 'hook') && entry.name !== undefined
          ? [itemKey(entry.role, entry.path, entry.name)]
          : [entry.path, entry.realPath];
      for (const key of keys) {
        const agents = loaders.get(key) ?? new Set<ContextAgent>();
        agents.add(plan.agent);
        loaders.set(key, agents);
      }
    }
  }
  return {
    facts(finding) {
      if (finding.suppressed !== undefined) return undefined;
      const matches = skips.get(findingKey(finding.ruleId, finding.path));
      const first = matches?.[0];
      if (matches === undefined || first === undefined) return undefined;
      const skipping = new Set(matches.map((match) => match.agent));
      const tokens = matches.find((match) => (match.skip.size?.tokens ?? 0) > 0)?.skip.size?.tokens;
      const loading = loaders.get(itemKey(first.skip.role, first.skip.path, first.skip.name));
      const others = CONTEXT_AGENTS.filter(
        (agent) => loading?.has(agent) === true && !skipping.has(agent),
      );
      if (tokens === undefined && others.length === 0) return undefined;
      return {
        skippers: CONTEXT_AGENTS.filter((agent) => skipping.has(agent)).map(
          (agent) => AGENT_NAMES[agent],
        ),
        ...(tokens === undefined ? {} : { tokens }),
        loaders: others.map((agent) => AGENT_NAMES[agent]),
      };
    },
  };
}

/** `≈197 tokens`. */
export function tokensText(tokens: number, approx: string): string {
  return `${approx}${formatInteger(tokens)} ${tokens === 1 ? 'token' : 'tokens'}`;
}

/**
 * One sentence from plan facts: `Claude Code never loads these ≈197 tokens; Codex and Cursor
 * do.` or `Codex and Cursor still load it.` Only agent names and numbers: no repository text.
 */
export function whyText(facts: PlanFacts, approx: string): string {
  const others = joinNames(facts.loaders);
  const many = facts.loaders.length > 1;
  if (facts.tokens === undefined) return `${others} still ${many ? 'load' : 'loads'} it.`;
  const verb = facts.skippers.length > 1 ? 'load' : 'loads';
  const missed = `${joinNames(facts.skippers)} never ${verb} these ${tokensText(facts.tokens, approx)}`;
  return facts.loaders.length === 0
    ? `${missed}.`
    : `${missed}; ${others} ${many ? 'do' : 'does'}.`;
}

// ---------------------------------------------------------------------------------------------
// What each agent misses
// ---------------------------------------------------------------------------------------------

/**
 * What a skip names. `prefix` is fixed text (`MCP server`, `hook`, `skill`); `text` comes from
 * the repository.
 */
export interface SkipSubject {
  readonly prefix?: string;
  readonly text: string;
}

export interface ImpactRow {
  readonly agent: ContextAgent;
  readonly agentName: string;
  readonly subject: SkipSubject;
  /** For a skipped import: the file that imports it. The reason reads "<importer> imports it, but <label>". */
  readonly importer?: string;
  /** Why the agent skips it, in plain words (SKIP_LABELS). */
  readonly label: string;
  /** Estimated tokens the agent misses, when known and not zero. */
  readonly tokens?: number;
  /** Class of the fix that removes the skip; absent when a person has to fix it. */
  readonly fix?: FixClass;
  readonly ruleId?: string;
}

export interface Impact {
  readonly rows: readonly ImpactRow[];
  /**
   * True when the rows are only the skips the change under review adds, from the baseline
   * comparison's plan deltas.
   */
  readonly onlyNew: boolean;
}

/** `skill release-notes` for `.agents/skills/release-notes/SKILL.md`. */
function skillName(path: string): string {
  const parts = path.split('/');
  return parts.length >= 2 && parts.at(-1) === 'SKILL.md' ? (parts.at(-2) ?? path) : path;
}

function subjectOf(skip: SkippedLoad): { subject: SkipSubject; importer?: string } {
  switch (skip.role) {
    case 'mcp-server':
      return skip.name === undefined
        ? { subject: { text: skip.path } }
        : { subject: { prefix: 'MCP server', text: skip.name } };
    case 'hook':
      return skip.name === undefined
        ? { subject: { text: skip.path } }
        : { subject: { prefix: 'hook', text: skip.name } };
    case 'skill':
      return { subject: { prefix: 'skill', text: skip.name ?? skillName(skip.path) } };
    case 'import':
      return skip.name === undefined
        ? { subject: { text: skip.path } }
        : { subject: { text: skip.name }, importer: skip.path };
    case 'instructions':
    case 'rule':
    case 'subagent':
    case 'command':
      return { subject: { text: skip.path } };
  }
}

/**
 * Whether a skip's finding was suppressed: the user has accepted it, so the summary leaves it
 * out. A skip reported on another file (the hiding file) or by no rule stays.
 */
function suppressedSkips(result: ScanResult): (skip: SkippedLoad) => boolean {
  const state = new Map<string, boolean>();
  for (const finding of result.findings) {
    const key = findingKey(finding.ruleId, finding.path);
    const active = finding.suppressed === undefined;
    state.set(key, (state.get(key) ?? false) || active);
  }
  return (skip) => {
    if (skip.ruleId === undefined) return false;
    return state.get(findingKey(skip.ruleId, skip.path)) === false;
  };
}

/** The ids of skips the baseline did not have, per root plan agent; undefined without deltas. */
function newSkipIds(result: ScanResult): Map<ContextAgent, ReadonlySet<string>> | undefined {
  if (result.baseline === undefined) return undefined;
  const cwd = rootCwd(result);
  const added = new Map<ContextAgent, ReadonlySet<string>>();
  for (const delta of result.baseline.context) {
    if (delta.cwd !== cwd) continue;
    added.set(delta.agent, new Set(delta.skipped.added));
  }
  return added.size === 0 ? undefined : added;
}

export interface ImpactOptions {
  /**
   * With a baseline whose comparison has plan deltas, only the skips the change adds. Agents
   * without a delta are left out. Without deltas, every skip.
   */
  readonly onlyNew?: boolean;
}

/**
 * What each agent misses in a session started in the scanned directory: every skip of the root
 * plans except files the agent does not read at all and skips whose finding is suppressed, by
 * agent, then path. Undefined when the report has no load plans.
 */
export function impactOf(result: ScanResult, options: ImpactOptions = {}): Impact | undefined {
  if (result.context === undefined) return undefined;
  const suppressed = suppressedSkips(result);
  const fresh = options.onlyNew === true ? newSkipIds(result) : undefined;
  const rows: ImpactRow[] = [];
  for (const plan of rootPlans(result)) {
    let only: ReadonlySet<string> | undefined;
    if (fresh !== undefined) {
      only = fresh.get(plan.agent);
      if (only === undefined) continue;
    }
    for (const skip of problemSkips(plan)) {
      if (suppressed(skip) || (only !== undefined && !only.has(skip.id))) continue;
      const { subject, importer } = subjectOf(skip);
      const tokens = skip.size?.tokens ?? 0;
      rows.push({
        agent: plan.agent,
        agentName: AGENT_NAMES[plan.agent],
        subject,
        ...(importer === undefined ? {} : { importer }),
        label: SKIP_LABELS[skip.code],
        ...(tokens > 0 ? { tokens } : {}),
        ...(skip.fix === undefined ? {} : { fix: skip.fix }),
        ...(skip.ruleId === undefined ? {} : { ruleId: skip.ruleId }),
      });
    }
  }
  return { rows, onlyNew: fresh !== undefined };
}
