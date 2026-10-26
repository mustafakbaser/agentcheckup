/**
 * The "What agents load" section of corpus/SUMMARY.md: aggregate statistics over the load plans
 * and the security inventory of every corpus repository.
 *
 * Each repository is scanned as `agentcheckup --untrusted --context --matrix` scans a checkout:
 * the rules run first, then the inventory is built and every modeled agent is planned at the root,
 * plus Codex in each directory with an AGENTS.md (src/platforms/load/matrix.ts). The findings are
 * those of scanSnapshot, so the rest of SUMMARY.md does not change.
 *
 * Per repository this keeps counts and flags only. The rendered section adds them up across the
 * corpus and names no repository, path or server (docs/adr/0005-scoring.md: no per-repository
 * rankings). Output is deterministic: integers, sorted keys, nearest-rank percentiles.
 */
import { isUnpinned } from '../../src/core/baseline.js';
import { compareStrings } from '../../src/core/compare.js';
import { analyze, type RuleResult, runRules } from '../../src/core/engine.js';
import type { ParseCache } from '../../src/core/parse-cache.js';
import type { Snapshot } from '../../src/core/types.js';
import { buildInventory } from '../../src/inventory/build.js';
import type { EnvItem } from '../../src/inventory/types.js';
import { contextAgentsOf } from '../../src/platforms/load/index.js';
import { matrixPlans } from '../../src/platforms/load/matrix.js';
import { skillDirectoryOf } from '../../src/platforms/location.js';
import { inPayloadFolder } from '../../src/platforms/paths.js';
import {
  AGENT_NAMES,
  CONTEXT_AGENTS,
  type ContextAgent,
  type LoadEntry,
  type LoadPlan,
  type LoadRole,
  type SkipCode,
} from '../../src/platforms/load/types.js';
import { builtinRules } from '../../src/rules/index.js';
import { joinNames } from '../../src/rules/shared/format.js';

/** Codex's documented `project_doc_max_bytes` limit, as the Codex loader reports it. */
const CODEX_BUDGET_KEY = 'codex.project_doc_max_bytes';

/** Roles that put instruction text in the prompt: instruction files, their imports, rules. */
const INSTRUCTION_ROLES: ReadonlySet<LoadRole> = new Set(['instructions', 'import', 'rule']);

/** The row that compares the agents' instructions, and the note that explains it. */
const DIFFERENT_INSTRUCTIONS = 'The agents load different instructions';

type EnvClass = Exclude<EnvItem['class'], 'other'>;
const ENV_CLASSES: readonly EnvClass[] = ['endpoint', 'credential', 'tls', 'code-exec'];

/** What one repository contributes. Never rendered on its own. */
export interface RepoContextFacts {
  /** Message of a loader or inventory crash; every other field is then empty. */
  readonly crash?: string;
  /**
   * Per agent, the real paths of instruction files, imports and rules in context at session
   * start in the root directory, sorted.
   */
  readonly startupInstructions: Readonly<Record<ContextAgent, readonly string[]>>;
  /**
   * Per agent, ≈tokens (characters / 4) of {@link startupInstructions} as the agent receives
   * them, after documented cuts such as Codex's byte limit.
   */
  readonly instructionTokens: Readonly<Record<ContextAgent, number>>;
  /**
   * Per agent, ≈tokens of everything at session start in the root directory: instructions plus
   * the skills listing as the repository writes it, before an agent shortens a long listing.
   */
  readonly startupTokens: Readonly<Record<ContextAgent, number>>;
  /** True when the root plan has at least one session-start entry. */
  readonly loadsAtStartup: Readonly<Record<ContextAgent, boolean>>;
  readonly rootAgentsMd: boolean;
  /** Claude Code skips the root AGENTS.md because a CLAUDE.md is read instead. */
  readonly claudeSkipsRootAgentsMd: boolean;
  /**
   * Agents that skip at least one file or item for a reason other than not-read, in a plan at the
   * root or in a working directory, unless the plan reads the same file through another path.
   */
  readonly skippingAgents: readonly ContextAgent[];
  /** The skip codes behind {@link skippingAgents}, sorted. */
  readonly skipCodes: readonly SkipCode[];
  /**
   * The AGENTS.md chain is over Codex's byte limit: at the root, or in any directory where a
   * session would start (see {@link isWorkingDirectory}).
   */
  readonly codexOverBudget: { readonly root: boolean; readonly anyDirectory: boolean };
  readonly mcpServers: number;
  /** Servers started from a command, not reached by URL. */
  readonly localServers: number;
  readonly unpinnedServers: number;
  readonly remoteServers: number;
  readonly hooks: number;
  readonly failOpenHooks: number;
  readonly broadPermissions: number;
  /** Env overrides of each class other than `other`. */
  readonly env: Readonly<Record<EnvClass, number>>;
  /** Codex config in TOML, which agentcheckup does not parse. */
  readonly codexTomlUnparsed: boolean;
}

/** A value for each of `agents`, the agents planned; the others have none. */
function perAgent<T>(
  agents: readonly ContextAgent[],
  value: (agent: ContextAgent) => T,
): Record<ContextAgent, T> {
  return Object.fromEntries(agents.map((agent) => [agent, value(agent)])) as Record<
    ContextAgent,
    T
  >;
}

function emptyFacts(crash: string, agents: readonly ContextAgent[]): RepoContextFacts {
  return {
    crash,
    startupInstructions: perAgent(agents, () => []),
    instructionTokens: perAgent(agents, () => 0),
    startupTokens: perAgent(agents, () => 0),
    loadsAtStartup: perAgent(agents, () => false),
    rootAgentsMd: false,
    claudeSkipsRootAgentsMd: false,
    skippingAgents: [],
    skipCodes: [],
    codexOverBudget: { root: false, anyDirectory: false },
    mcpServers: 0,
    localServers: 0,
    unpinnedServers: 0,
    remoteServers: 0,
    hooks: 0,
    failOpenHooks: 0,
    broadPermissions: 0,
    env: { endpoint: 0, credential: 0, tls: 0, 'code-exec': 0 },
    codexTomlUnparsed: false,
  };
}

/**
 * A directory where people start Codex, as instr/codex-size-budget decides: not inside a dot
 * directory, a skill, or a templates, examples or fixtures folder. The matrix also plans Codex in
 * those, because a session can start anywhere, but an AGENTS.md in a skill is the skill's
 * reference document, so counting it would overstate the problem.
 */
function isWorkingDirectory(snapshot: Snapshot, cwd: string): boolean {
  if (cwd === '') return true;
  const file = `${cwd}/AGENTS.md`;
  if (cwd.split('/').some((segment) => segment.startsWith('.'))) return false;
  return skillDirectoryOf(snapshot, file) === undefined && !inPayloadFolder(file);
}

function overBudget(plan: LoadPlan | undefined): boolean {
  return (
    plan?.limits.some(
      (usage) => usage.key === CODEX_BUDGET_KEY && usage.limit !== null && usage.used > usage.limit,
    ) === true
  );
}

/**
 * Scans one repository like `agentcheckup --untrusted --context --matrix` and returns the rule
 * result with the repository's facts. A loader that throws is recorded in `crash`; the rule
 * result is kept. `parseCache` shares parses with other scans of the repository. `agents` are
 * the agents to plan (run.ts `--agents`), every modeled agent by default.
 */
export function scanForSummary(
  snapshot: Snapshot,
  parseCache?: ParseCache,
  agents?: readonly ContextAgent[],
): {
  readonly result: RuleResult;
  readonly facts: RepoContextFacts;
} {
  // As scanSnapshot with these options: no configuration, every platform targeted.
  const analysis = analyze(snapshot, parseCache === undefined ? {} : { parseCache });
  const result = runRules(analysis, { rules: builtinRules, trustDirectives: false });
  const planned = agents ?? contextAgentsOf(analysis.targetList);
  try {
    const inventory = buildInventory(analysis);
    const plans = matrixPlans(analysis, { agents: planned, config: analysis.config });
    const root = new Map(
      plans.filter((plan) => plan.cwd === '').map((plan) => [plan.agent, plan] as const),
    );
    const realPathOf = (path: string): string => analysis.index.get(path)?.realPath ?? path;

    // A skip counts when the agent misses the content: not when it reads the same file through
    // another path, as with AGENTS.md and CLAUDE.md symlinked to one file.
    const skipping = new Set<ContextAgent>();
    const codes = new Set<SkipCode>();
    for (const plan of plans) {
      if (!isWorkingDirectory(snapshot, plan.cwd)) continue;
      const loaded = new Set(plan.entries.map((entry) => entry.realPath));
      for (const skip of plan.skipped) {
        if (skip.code === 'not-read' || loaded.has(realPathOf(skip.path))) continue;
        skipping.add(plan.agent);
        codes.add(skip.code);
      }
    }

    const env = { endpoint: 0, credential: 0, tls: 0, 'code-exec': 0 };
    for (const item of inventory.env) if (item.class !== 'other') env[item.class] += 1;

    const instructionEntries = (agent: ContextAgent): LoadEntry[] =>
      (root.get(agent)?.entries ?? []).filter(
        (entry) => entry.trigger === 'startup' && INSTRUCTION_ROLES.has(entry.role),
      );
    const startupInstructions = perAgent(planned, (agent) =>
      [...new Set(instructionEntries(agent).map((entry) => entry.realPath))].sort(compareStrings),
    );
    const facts: RepoContextFacts = {
      startupInstructions,
      instructionTokens: perAgent(planned, (agent) =>
        Math.ceil(
          instructionEntries(agent).reduce((chars, entry) => chars + (entry.size?.chars ?? 0), 0) /
            4,
        ),
      ),
      startupTokens: perAgent(planned, (agent) => root.get(agent)?.totals.startup.tokens ?? 0),
      loadsAtStartup: perAgent(
        planned,
        (agent) => root.get(agent)?.entries.some((entry) => entry.trigger === 'startup') === true,
      ),
      rootAgentsMd: analysis.index.get('AGENTS.md')?.kind === 'agents-md',
      claudeSkipsRootAgentsMd:
        root
          .get('claude-code')
          ?.skipped.some(
            (skip) => skip.path === 'AGENTS.md' && skip.code === 'shadowed-by-claude-md',
          ) === true && !startupInstructions['claude-code'].includes(realPathOf('AGENTS.md')),
      skippingAgents: planned.filter((agent) => skipping.has(agent)),
      skipCodes: [...codes].sort(compareStrings),
      codexOverBudget: {
        root: overBudget(root.get('codex')),
        anyDirectory: plans.some(
          (plan) =>
            plan.agent === 'codex' && isWorkingDirectory(snapshot, plan.cwd) && overBudget(plan),
        ),
      },
      mcpServers: inventory.mcpServers.length,
      localServers: inventory.mcpServers.filter((server) => server.url === undefined).length,
      unpinnedServers: inventory.mcpServers.filter((server) => isUnpinned(server)).length,
      remoteServers: inventory.mcpServers.filter((server) => server.url !== undefined).length,
      hooks: inventory.hooks.length,
      failOpenHooks: inventory.hooks.filter((hook) => hook.failsOpen).length,
      broadPermissions: inventory.permissions.filter((permission) => permission.broad).length,
      env,
      codexTomlUnparsed: inventory.incomplete.some(
        (entry) => entry === '.codex/config.toml' || entry.endsWith('/.codex/config.toml'),
      ),
    };
    return { result, facts };
  } catch (error) {
    return {
      result,
      facts: emptyFacts(error instanceof Error ? error.message : String(error), planned),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function table(
  header: readonly string[],
  align: readonly string[],
  rows: readonly string[][],
): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${align.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** Nearest-rank percentile of integers sorted ascending: deterministic, always a member. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

function number(value: number): string {
  // Grouped like the CLI's own output (1,234), without locale-dependent formatting.
  const digits = String(value);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return out;
}

function ratio(part: number, whole: number): string {
  return whole === 0 ? `${number(part)} of 0` : `${number(part)} of ${number(whole)}`;
}

function sameSets(sets: readonly (readonly string[])[]): boolean {
  const [first, ...rest] = sets;
  if (first === undefined) return true;
  return rest.every(
    (set) => set.length === first.length && set.every((path, index) => path === first[index]),
  );
}

const SKIP_LABELS: Readonly<Record<SkipCode, string>> = {
  'shadowed-by-claude-md': 'AGENTS.md hidden by a CLAUDE.md (Claude Code)',
  'shadowed-by-override': 'AGENTS.md hidden by AGENTS.override.md (Codex)',
  'over-byte-budget': 'over a byte limit',
  'empty-override': 'empty AGENTS.override.md',
  'blank-file': 'blank file',
  'not-mdc': 'not an .mdc file (Cursor)',
  'no-frontmatter': 'no frontmatter',
  'invalid-frontmatter': 'invalid frontmatter',
  bom: 'byte order mark before the frontmatter',
  'no-description': 'no description',
  'invalid-subagent': 'invalid subagent',
  'import-unresolved': 'import does not resolve',
  'import-too-deep': 'import too deep',
  'import-outside-root': 'import leaves the repository',
  'url-without-type': 'MCP server with a url but no type',
  'unknown-event': 'unknown hook event',
  'invalid-json': 'invalid JSON',
  'not-utf8': 'not UTF-8',
  'case-mismatch': 'file name case does not match',
  'materialized-symlink': 'symlink checked out as a text file',
  'wrong-location': 'not in a location the agent reads',
  'no-apply-to': 'no valid applyTo (Copilot)',
  'shadowed-by-preferred': 'a preferred file is read instead',
  disabled: 'turned off in the configuration',
  'never-active': 'never active',
  'invalid-toml': 'invalid TOML',
  'not-read': 'not read',
};

/** Median, 90th percentile and maximum of `values`, as table cells. */
function distribution(label: string, values: readonly number[]): string[] {
  const sorted = [...values].sort((a, b) => a - b);
  return [
    label,
    number(sorted.length),
    number(percentile(sorted, 50)),
    number(percentile(sorted, 90)),
    number(sorted.at(-1) ?? 0),
  ];
}

/**
 * The "What agents load" section, from every scanned repository's facts. Counts only: no
 * repository names, paths, server names or per-repository rows. `agents` must be the agents
 * the facts were planned for.
 */
export function renderContextSection(
  all: readonly RepoContextFacts[],
  agents: readonly ContextAgent[] = CONTEXT_AGENTS,
): string {
  const facts = all.filter((item) => item.crash === undefined);
  const crashes = all.length - facts.length;
  const count = (test: (item: RepoContextFacts) => boolean): number => facts.filter(test).length;
  const sum = (value: (item: RepoContextFacts) => number): number =>
    facts.reduce((total, item) => total + value(item), 0);
  const items = (value: (item: RepoContextFacts) => number): string[] => [
    number(count((item) => value(item) > 0)),
    number(sum(value)),
  ];

  // Instructions at session start, root directory.
  const withInstructions = facts.filter((item) =>
    agents.some((agent) => item.startupInstructions[agent].length > 0),
  );
  const differ = withInstructions.filter(
    (item) => !sameSets(agents.map((agent) => item.startupInstructions[agent])),
  );
  const someAgentWithout = differ.filter((item) =>
    agents.some((agent) => item.startupInstructions[agent].length === 0),
  );
  const rootAgentsMd = count((item) => item.rootAgentsMd);

  // Skips.
  const skipCodes = new Map<SkipCode, number>();
  for (const item of facts) {
    for (const code of item.skipCodes) skipCodes.set(code, (skipCodes.get(code) ?? 0) + 1);
  }
  const skipRows = [...skipCodes]
    .sort(([a, x], [b, y]) => y - x || compareStrings(a, b))
    .map(([code, repos]) => [`\`${code}\``, SKIP_LABELS[code], number(repos)]);

  const lines = [
    `What ${joinNames(agents.map((agent) => AGENT_NAMES[agent]))} load from each repository, ` +
      'as `agentcheckup context --matrix` plans it: every agent in the root directory, plus Codex ' +
      'in each directory with an `AGENTS.md`. Repository scope only: user and managed settings ' +
      'are not visible. Token counts are estimates (characters ÷ 4). See ' +
      '[docs/context.md](../docs/context.md).',
    '',
    table(
      ['', 'Repositories'],
      ['---', '---:'],
      [
        [
          'Some agent loads instructions at session start, root directory',
          number(withInstructions.length),
        ],
        [DIFFERENT_INSTRUCTIONS, ratio(differ.length, withInstructions.length)],
        ['Some agent loads no instructions at all', ratio(someAgentWithout.length, differ.length)],
        ['Root `AGENTS.md`', number(rootAgentsMd)],
        [
          'Claude Code skips the root `AGENTS.md` and reads a `CLAUDE.md` instead',
          ratio(
            count((item) => item.claudeSkipsRootAgentsMd),
            rootAgentsMd,
          ),
        ],
        [
          'Some agent skips an agent-config file or item',
          number(count((item) => item.skippingAgents.length > 0)),
        ],
        ...agents.map((agent) => [
          `${AGENT_NAMES[agent]} skips one`,
          number(count((item) => item.skippingAgents.includes(agent))),
        ]),
        [
          "`AGENTS.md` chain over Codex's 32 KiB default, root directory",
          number(count((item) => item.codexOverBudget.root)),
        ],
        [
          "`AGENTS.md` chain over Codex's 32 KiB default, any working directory",
          number(count((item) => item.codexOverBudget.anyDirectory)),
        ],
        ['Loader crashes', number(crashes)],
      ],
    ),
    '',
    `"${DIFFERENT_INSTRUCTIONS}" compares the instruction files, imports and rules each agent ` +
      'has in context at session start, by real path. Working directories ' +
      'are the root and each directory with an `AGENTS.md`, except inside skills, dot ' +
      'directories, and templates, examples or fixtures folders, as `instr/codex-size-budget` ' +
      'decides. A skip counts only when the agent does not read the same file through another ' +
      'path, such as an `AGENTS.md` and a `CLAUDE.md` symlinked to one file.',
    '',
    '### Session-start context, root directory',
    '',
    'In ≈tokens. "Instructions" are instruction files, imports and rules, after documented cuts ' +
      "such as Codex's byte limit; only repositories where the agent loads one are counted. " +
      '"With the skills listing" adds skill names and descriptions as the repository writes ' +
      'them, before an agent shortens a long listing; only repositories where the agent loads ' +
      'anything at session start are counted. Percentiles use the nearest-rank method.',
    '',
    table(
      ['', 'Repositories', 'Median', '90th percentile', 'Largest'],
      ['---', '---:', '---:', '---:', '---:'],
      agents.flatMap((agent) => [
        distribution(
          `${AGENT_NAMES[agent]}: instructions`,
          facts
            .filter((item) => item.startupInstructions[agent].length > 0)
            .map((item) => item.instructionTokens[agent]),
        ),
        distribution(
          `${AGENT_NAMES[agent]}: with the skills listing`,
          facts
            .filter((item) => item.loadsAtStartup[agent])
            .map((item) => item.startupTokens[agent]),
        ),
      ]),
    ),
    '',
    '### Why agents skip files',
    '',
    'Repositories where a modeled agent skips a file or item for this reason, in a plan for a ' +
      'working directory.',
    '',
    skipRows.length === 0
      ? 'None.'
      : table(['Code', 'Reason', 'Repositories'], ['---', '---', '---:'], skipRows),
    '',
    '### MCP servers, hooks, permissions and env overrides',
    '',
    'From the security inventory, which lists every item whether or not an agent loads it today, ' +
      'in configuration files and in the frontmatter of Claude Code skills, commands and ' +
      'subagents. A local server is unpinned when its package has no exact version or digest, or ' +
      'when its command cannot be shown to be pinned: what the `mcp-unpinned` gate class checks. ' +
      'Broad permissions allow any shell command, any file write or edit, or every tool without ' +
      'asking (`bypassPermissions`); they include the `allowed-tools` of skills and commands and ' +
      'Codex `.codex/config.toml` items.',
    '',
    table(
      ['', 'Repositories', 'Items'],
      ['---', '---:', '---:'],
      [
        ['MCP servers', ...items((item) => item.mcpServers)],
        ['Local MCP servers (started from a command)', ...items((item) => item.localServers)],
        ['Unpinned local MCP servers', ...items((item) => item.unpinnedServers)],
        ['Remote MCP servers (URL)', ...items((item) => item.remoteServers)],
        ['Hooks', ...items((item) => item.hooks)],
        ['Hooks that fail open', ...items((item) => item.failOpenHooks)],
        ['Broad permissions', ...items((item) => item.broadPermissions)],
        ...ENV_CLASSES.map((envClass) => [
          `Env overrides: ${envClass}`,
          ...items((item) => item.env[envClass]),
        ]),
        [
          '`.codex/config.toml`, not analyzed',
          number(count((item) => item.codexTomlUnparsed)),
          '-',
        ],
      ],
    ),
  ];
  return lines.join('\n');
}
