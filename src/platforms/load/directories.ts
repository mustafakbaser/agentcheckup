/**
 * Start directories: the directories below the scan root where a session can start with other
 * context than at the root, because an instruction file sits there or a folder of agent
 * configuration does. `agentcheckup tokens --by-directory` plans each agent in each of them. Pure.
 */
import { compareStrings } from '../../core/compare.js';
import { dirnamePosix } from '../../core/paths.js';
import { basename } from '../paths.js';
import type { LoadEntry, LoadPlan, StartDirectoryTotals } from './types.js';
import type { LoadView } from './view.js';

/** Most directories planned besides the root; the report says how many more there are. */
export const MAX_START_DIRECTORIES = 50;

/** Instruction files an agent loads from the directory a session starts in or one above it. */
const INSTRUCTION_FILES: ReadonlySet<string> = new Set([
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
]);

/** Folders of agent configuration that a session started in their parent reads. */
const CONFIG_FOLDERS: ReadonlySet<string> = new Set([
  '.agents',
  '.claude',
  '.clinerules',
  '.codex',
  '.cursor',
  '.devin',
  '.gemini',
  '.github',
  '.windsurf',
]);

/** The directory that owns the first agent configuration folder on `path`, if any. */
function configOwner(path: string): string | undefined {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (CONFIG_FOLDERS.has(parts[i] ?? '')) return parts.slice(0, i).join('/');
  }
  return undefined;
}

/**
 * Every directory other than the root that holds an instruction file or owns a folder of agent
 * configuration, through any path that reaches the file, sorted by path.
 */
export function startDirectories(view: Pick<LoadView, 'index'>): string[] {
  const directories = new Set<string>();
  for (const path of view.index.keys()) {
    // `.claude/CLAUDE.md` belongs to the directory that owns `.claude`, not to `.claude`.
    const owner =
      configOwner(path) ?? (INSTRUCTION_FILES.has(basename(path)) ? dirnamePosix(path) : undefined);
    if (owner !== undefined && owner !== '') directories.add(owner);
  }
  return [...directories].sort(compareStrings);
}

/**
 * A listing entry: a skill or subagent the model picks from by its name and description, in the
 * context from the start. A skill the model selects is listed as one it picks at startup is.
 */
export function isListing(entry: LoadEntry): boolean {
  return entry.role === 'skill'
    ? entry.trigger === 'startup' || entry.trigger === 'model-selected'
    : entry.role === 'subagent' && entry.trigger === 'startup';
}

/** True when an entry of the plan's startup total is unverified: what it starts with is not certain. */
export function unverifiedAtStart(plan: LoadPlan): boolean {
  return plan.entries.some(
    (entry) =>
      (entry.trigger === 'startup' || isListing(entry)) && entry.certainty === 'unverified',
  );
}

/** The totals of the plans of a session started in `cwd`; the plans themselves are dropped. */
export function startDirectoryTotals(
  cwd: string,
  plans: readonly LoadPlan[],
): StartDirectoryTotals {
  return {
    cwd,
    agents: plans.map((plan) => ({
      agent: plan.agent,
      startup: plan.totals.startup,
      unverified: unverifiedAtStart(plan),
    })),
  };
}
