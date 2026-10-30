/**
 * The file-by-agent matrix (`--matrix`): one row per agent-configuration file or item, one
 * column per agent, each cell saying how that agent treats it. Pure.
 *
 * Rows are instruction files, rule files, skills (by skill directory) and the files that declare
 * MCP servers and hooks, by path as the agent reaches them. The plans are every agent at the scan
 * root, plus a Codex plan for each directory with an `AGENTS.md` or `AGENTS.override.md`, because
 * the files Codex reads depend on where the session starts ({@link matrixPlans}).
 *
 * A cell comes from the root plan first, then from the other plans of the same agent:
 * - an entry: `startup`, `on-path`, `model-selected`, `manual` or `unknown` after its trigger;
 *   `listed` for a skill in the listing; `partial` when a limit cuts it; MCP servers and hooks,
 *   which the agent starts with the session once approved, are `startup`. An entry found only in a
 *   plan that starts below the root is `start-dir`.
 * - a skip: `skipped`, or `not-read` when the agent does not read that kind of file.
 * - neither: `start-dir` when the root plan leaves the file to a deeper start (`below-start-dir`),
 *   `unknown` when the plan could not analyze it (`incomplete`), else `not-read`.
 *
 * A file of MCP servers or hooks has one row; when the agent loads some of its items and skips
 * others, the cell shows what it loads, and the plan lists the skips.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { dirnamePosix } from '../../core/paths.js';
import type { ArtifactKind } from '../../core/types.js';
import { classify } from '../classify.js';
import { basename } from '../paths.js';
import { CODEX_FILE_NAMES } from './codex-chain.js';
import { checkContextWindow, loadPlans, orderedAgents } from './index.js';
import {
  type ContextAgent,
  type ContextReport,
  type LoadEntry,
  type LoadPlan,
  type LoadRole,
  type MatrixCell,
  TRIGGER_RANK,
} from './types.js';
import type { LoadView } from './view.js';

export type MatrixRow = NonNullable<ContextReport['matrix']>['rows'][number];

export interface MatrixPlanOptions {
  readonly agents: readonly ContextAgent[];
  readonly config: ResolvedConfig;
  readonly contextWindow?: number;
  /**
   * The scan as if `ignore` matched nothing, for the plans at the root: see
   * `LoadPlansOptions.withIgnored`. Codex's plans in other directories count only the ignored
   * files their loader finds without reading them: planning each of thousands of directories
   * twice would cost more than the count is worth.
   */
  readonly withIgnored?: LoadView;
}

/** Kinds of agent definition files: subagents, which get no row, even below the start. */
const DEFINITION_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'claude-agent',
  'codex-agent',
  'cursor-agent',
  'gemini-agent',
  'copilot-agent',
  'devin-agent',
]);

/** Roles that get a row: configuration files, not imports, commands or subagents. */
const ROW_ROLES: ReadonlySet<LoadRole> = new Set([
  'instructions',
  'rule',
  'skill',
  'mcp-server',
  'hook',
]);

/**
 * Directories other than the root that hold an `AGENTS.md` or `AGENTS.override.md`, by exact
 * name, through any path that reaches the file. Codex reads a different chain when it starts in
 * each of them. Sorted.
 */
export function codexStartDirectories(view: Pick<LoadView, 'index'>): string[] {
  const directories = new Set<string>();
  for (const path of view.index.keys()) {
    if (!CODEX_FILE_NAMES.includes(basename(path))) continue;
    const directory = dirnamePosix(path);
    if (directory !== '') directories.add(directory);
  }
  return [...directories].sort(compareStrings);
}

/**
 * The plans the matrix is built from: every agent at the scan root, and Codex in each of
 * {@link codexStartDirectories}.
 */
export function matrixPlans(view: LoadView, options: MatrixPlanOptions): LoadPlan[] {
  checkContextWindow(options.contextWindow);
  const agents = orderedAgents(options.agents);
  const shared = {
    config: options.config,
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  };
  const plans = loadPlans(view, {
    ...shared,
    agents,
    cwd: '',
    ...(options.withIgnored === undefined ? {} : { withIgnored: options.withIgnored }),
  });
  if (agents.includes('codex')) {
    for (const cwd of codexStartDirectories(view)) {
      plans.push(...loadPlans(view, { ...shared, agents: ['codex'], cwd }));
    }
  }
  return plans;
}

// ---------------------------------------------------------------------------------------------
// Rows and cells
// ---------------------------------------------------------------------------------------------

/** The row a path belongs to: a skill's directory, any other file itself. */
function rowPath(path: string, skill: boolean): string {
  return skill ? dirnamePosix(path) : path;
}

function isSkillPath(path: string): boolean {
  return classify(path)?.kind === 'skill';
}

/** A `.claude/commands` file; the cheap test first, since most paths are not. */
function isCommandPath(path: string): boolean {
  return (
    path.toLowerCase().includes('.claude/commands/') && classify(path)?.kind === 'claude-command'
  );
}

/**
 * A plan without its commands. Commands get no row, but the Copilot CLI lists them as skills
 * (SOURCES.copilotCliReference), which would make a `.claude/commands` folder a skill row that
 * Claude Code and Devin Local do not read.
 */
function withoutCommands(plan: LoadPlan): LoadPlan {
  const keep = (path: string): boolean => !isCommandPath(path);
  return {
    ...plan,
    entries: plan.entries.filter((entry) => keep(entry.path)),
    skipped: plan.skipped.filter((skip) => keep(skip.path)),
    outOfScope: plan.outOfScope.filter((item) => keep(item.path)),
    incomplete: plan.incomplete.filter((item) => keep(item.slice(item.indexOf(':') + 1))),
  };
}

function kindOf(view: Pick<LoadView, 'index'>, path: string): ArtifactKind | undefined {
  return classify(path)?.kind ?? view.index.get(path)?.kind;
}

/** What a plan says about one row, if it has an entry or a skip for it. */
function judge(plan: LoadPlan, row: string, deeper: boolean): MatrixCell | undefined {
  let best: LoadEntry | undefined;
  let truncated = false;
  // Imports load files that are rows of their own, such as an AGENTS.md a CLAUDE.md imports.
  // An import's skip names the importing file, so skips count only for row roles.
  for (const entry of plan.entries) {
    if (!ROW_ROLES.has(entry.role) && entry.role !== 'import') continue;
    if (rowPath(entry.path, entry.role === 'skill') !== row) continue;
    truncated ||= entry.truncated !== undefined;
    if (best === undefined || TRIGGER_RANK[entry.trigger] < TRIGGER_RANK[best.trigger]) {
      best = entry;
    }
  }
  if (best !== undefined) {
    if (truncated) return 'partial';
    if (deeper) return 'start-dir';
    return entryCell(best);
  }
  let notRead = false;
  for (const skip of plan.skipped) {
    if (!ROW_ROLES.has(skip.role)) continue;
    if (rowPath(skip.path, skip.role === 'skill') !== row) continue;
    if (skip.code !== 'not-read') return 'skipped';
    notRead = true;
  }
  return notRead ? 'not-read' : undefined;
}

function entryCell(entry: LoadEntry): MatrixCell {
  switch (entry.trigger) {
    case 'startup':
      return entry.role === 'skill' ? 'listed' : 'startup';
    case 'model-selected':
      return entry.role === 'skill' ? 'listed' : 'model-selected';
    case 'on-approval':
      return 'startup';
    case 'on-path':
    case 'manual':
    case 'unknown':
      return entry.trigger;
  }
}

/** True when the plan lists the row's path in `incomplete`. */
function incompleteFor(plan: LoadPlan, row: string, skill: boolean): boolean {
  return plan.incomplete.some((item) => {
    const colon = item.indexOf(':');
    if (colon < 0) return false;
    const path = item.slice(colon + 1);
    return path === row || (skill && dirnamePosix(path) === row);
  });
}

function cellFor(plans: readonly LoadPlan[], row: MatrixRow): MatrixCell {
  const skill = row.kind === 'skill';
  // The root plan first; then plans that start deeper, the shallowest first.
  const ordered = [...plans].sort(
    (a, b) =>
      Number(a.cwd !== '') - Number(b.cwd !== '') ||
      a.cwd.split('/').length - b.cwd.split('/').length ||
      compareStrings(a.cwd, b.cwd),
  );
  for (const plan of ordered) {
    const cell = judge(plan, row.path, plan.cwd !== '');
    if (cell !== undefined) return cell;
  }
  const root = ordered.find((plan) => plan.cwd === '');
  if (
    root?.outOfScope.some(
      (item) => item.because === 'below-start-dir' && rowPath(item.path, skill) === row.path,
    ) === true
  ) {
    return 'start-dir';
  }
  if (ordered.some((plan) => incompleteFor(plan, row.path, skill))) return 'unknown';
  return 'not-read';
}

/**
 * The matrix of `plans`: a row for every configuration file or skill a plan mentions, with one
 * cell per agent in PLATFORM_IDS order. Rows where no agent reads the file are left out.
 */
export function buildMatrix(
  view: Pick<LoadView, 'index'>,
  planned: readonly LoadPlan[],
  agents: readonly ContextAgent[],
): NonNullable<ContextReport['matrix']> {
  const plans = planned.map(withoutCommands);
  const columns = orderedAgents(agents);
  const kinds = new Map<string, ArtifactKind>();
  const addRow = (path: string, skill: boolean): void => {
    const row = rowPath(path, skill);
    if (kinds.has(row)) return;
    const kind = skill ? 'skill' : kindOf(view, path);
    if (kind !== undefined) kinds.set(row, kind);
  };
  for (const plan of plans) {
    if (!columns.includes(plan.agent)) continue;
    for (const entry of plan.entries) {
      if (ROW_ROLES.has(entry.role)) addRow(entry.path, entry.role === 'skill');
    }
    for (const skip of plan.skipped) {
      if (ROW_ROLES.has(skip.role)) addRow(skip.path, skip.role === 'skill');
    }
    for (const item of plan.outOfScope) {
      if (item.because !== 'below-start-dir') continue;
      const kind = kindOf(view, item.path);
      if (kind === undefined || !DEFINITION_KINDS.has(kind)) {
        addRow(item.path, isSkillPath(item.path));
      }
    }
    // A configuration file the plan could not analyze still gets its row, marked `unknown`.
    for (const item of plan.incomplete) {
      const path = item.slice(item.indexOf(':') + 1);
      if (path !== '' && !path.endsWith('/')) addRow(path, isSkillPath(path));
    }
  }

  const rows: MatrixRow[] = [];
  for (const [path, kind] of kinds) {
    const row: MatrixRow = { path, kind, cells: [] };
    const cells = columns.map((agent) =>
      cellFor(
        plans.filter((plan) => plan.agent === agent),
        row,
      ),
    );
    if (cells.every((cell) => cell === 'not-read')) continue;
    rows.push({ path, kind, cells });
  }
  return {
    rows: rows.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.kind, b.kind)),
  };
}
