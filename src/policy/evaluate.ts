/**
 * Checks a scan against an organization policy. Pure and deterministic: the same policy and scan
 * give the same report, with every list sorted.
 *
 * The checks read the security inventory, the agent definitions and model settings, and the load
 * plans, never the files: an MCP server's package and pin, permission and environment items, hook
 * items, the model each definition and setting names, and each plan's startup tokens.
 * Broad grants come from broadGrant and environment classes from the inventory, so the policy
 * and the gate (src/core/baseline.ts) agree on what an item does.
 *
 * Baselines. The same policy is evaluated on the baseline's inventory and plans. A violation is
 * `unchanged` when the baseline has one with the same id: same check, same subject and, for an
 * inventory item, the same digest, so changing a server that already violates the policy makes a
 * new violation. A startup budget violation is new unless the baseline exceeded the budget too,
 * with at least as many tokens.
 */
import { isModelChoice } from '../agents/settings.js';
import type { AgentDefinition, AgentsReport, ModelSetting } from '../agents/types.js';
import { isUnpinned } from '../core/baseline.js';
import { compareStrings } from '../core/compare.js';
import { formatInteger } from '../core/format.js';
import { COMMAND_SETTINGS } from '../inventory/env-class.js';
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PackageSpec,
  PermissionItem,
} from '../inventory/types.js';
import { classify } from '../platforms/classify.js';
import { type HookPlatform, hookPlatformOf } from '../platforms/hooks.js';
import { canonicalJson } from '../platforms/inventory-ids.js';
import { AGENT_NAMES, ALL_CONTEXT_AGENTS, type ContextAgent } from '../platforms/load/types.js';
import { broadGrant } from '../platforms/permissions.js';
import { joinNames, quote, quotePath, readerName } from '../rules/shared/format.js';
import { grantsTool, isShellTool, shellProgram, toolRule } from './grants.js';
import { allowForm, entryAllows, serverTarget, type ServerTarget } from './mcp.js';
import {
  type ForbidName,
  type HookRequirement,
  type ModelRule,
  type Policy,
  POLICY_CHECKS,
  type PolicyCheck,
  type PolicyNote,
  type PolicyReport,
  type PolicyViolation,
} from './types.js';

/** The load-plan fields the budget check reads. A LoadPlan and a BaselinePlan are assignable. */
export interface PolicyPlan {
  readonly agent: ContextAgent;
  readonly cwd: string;
  readonly totals: { readonly startup: { readonly tokens: number } };
}

/**
 * The parts of a scan a policy reads. A ScanResult and a BaselineReport are assignable. `context`
 * must hold the plans of every agent the policy budgets: each agent at the root, and the matrix
 * plans (Codex in each directory with an AGENTS.md).
 */
export interface PolicySubject {
  readonly inventory?: Inventory;
  readonly agents?: AgentsReport;
  readonly context?: { readonly plans: readonly PolicyPlan[] };
  readonly pathBase?: string;
}

export interface PolicyInput {
  /**
   * Lowercase hex SHA-256 of the policy file's bytes, as `shasum -a 256` prints it. The caller
   * reads the file and computes it; reports print it so readers can tell which policy ran.
   */
  readonly sha256: string;
  /** The scan under review. */
  readonly current: PolicySubject;
  /** The scan to compare with, such as the base branch's report. */
  readonly baseline?: PolicySubject;
  /** Whether the policy file lies inside the scanned directory. Default false. */
  readonly insideScanRoot?: boolean;
}

/** Every hook-missing message ends with it: a configured hook is not an enforced one. */
export const HOOKS_NOT_ENFORCED =
  'Configured, not enforced: hooks fail open on errors and timeouts, and user settings can turn them off.';

/** A violation before the baseline comparison. `tokens` is set for startup budgets. */
interface Found {
  readonly id: string;
  readonly check: PolicyCheck;
  readonly entry: string;
  readonly path?: string;
  readonly line?: number;
  readonly agent?: ContextAgent;
  readonly message: string;
  readonly tokens?: number;
}

/** Checks `input.current` against `policy`, and compares with `input.baseline` when given. */
export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyReport {
  const found = collect(policy, input.current);
  const before =
    input.baseline === undefined
      ? undefined
      : new Map(collect(policy, input.baseline).map((item) => [item.id, item]));

  const violations = found
    .map((item): PolicyViolation => {
      const baseline = before === undefined ? undefined : statusOf(item, before.get(item.id));
      const fails =
        policy.mode === 'enforce' &&
        (policy.existing === 'fail' || baseline === undefined || baseline === 'new');
      const { tokens: _tokens, ...rest } = item;
      return { ...rest, ...(baseline === undefined ? {} : { baseline }), fails };
    })
    .sort(compareViolations);

  return {
    name: policy.name,
    sha256: input.sha256,
    mode: policy.mode,
    insideScanRoot: input.insideScanRoot ?? false,
    checks: activeChecks(policy).length,
    violations,
    notes: notesOf(policy, input, violations),
  };
}

function statusOf(item: Found, old: Found | undefined): 'new' | 'unchanged' {
  if (old === undefined) return 'new';
  if (item.tokens === undefined) return 'unchanged';
  return old.tokens !== undefined && item.tokens <= old.tokens ? 'unchanged' : 'new';
}

const CHECK_RANK: ReadonlyMap<PolicyCheck, number> = new Map(
  POLICY_CHECKS.map((check, index) => [check, index]),
);

function compareViolations(a: PolicyViolation, b: PolicyViolation): number {
  return (
    (CHECK_RANK.get(a.check) ?? 0) - (CHECK_RANK.get(b.check) ?? 0) ||
    compareStrings(a.path ?? '', b.path ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareStrings(a.id, b.id)
  );
}

/** The checks the policy turns on, in report order. */
export function activeChecks(policy: Policy): PolicyCheck[] {
  const on: Readonly<Record<PolicyCheck, boolean>> = {
    'mcp-not-allowed': policy.mcp.allow !== undefined,
    'mcp-unpinned': policy.mcp.requirePin,
    'forbidden-setting': policy.forbid.length > 0,
    'denied-tool': policy.denyTools.length > 0 || policy.denyCommands.length > 0,
    'hook-missing': policy.requireHooks.length > 0,
    'startup-budget': policy.budgets.length > 0,
    'model-not-allowed': policy.models.length > 0,
    'unanalyzed-config': readsInventory(policy),
  };
  return POLICY_CHECKS.filter((check) => on[check]);
}

/**
 * True when a check reads the inventory, so a file that could not be analyzed may hide a
 * violation. Only then is every such file a violation of its own (unanalyzed-config).
 */
function readsInventory(policy: Policy): boolean {
  return (
    policy.mcp.allow !== undefined ||
    policy.mcp.requirePin ||
    policy.forbid.length > 0 ||
    policy.denyTools.length > 0 ||
    policy.denyCommands.length > 0 ||
    policy.requireHooks.length > 0
  );
}

// ---------------------------------------------------------------------------------------------
// Paths and ids
// ---------------------------------------------------------------------------------------------

/** `pathBase` without trailing slashes; `''` when absent or `.`. */
function normalizeBase(base: string | undefined): string {
  if (base === undefined) return '';
  let end = base.length;
  while (end > 0 && base.charAt(end - 1) === '/') end--;
  const trimmed = base.slice(0, end);
  return trimmed === '.' ? '' : trimmed;
}

/** `path` without `base`. */
function stripPath(path: string, base: string): string {
  if (base === '') return path;
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** An inventory id `<kind>:<file>…` with `base` removed from its file. */
function rootId(id: string, file: string, base: string): string {
  const root = stripPath(file, base);
  if (root === file) return id;
  const start = id.indexOf(':') + 1;
  return id.startsWith(file, start)
    ? id.slice(0, start) + root + id.slice(start + file.length)
    : id;
}

/** Prefixes of inventory `incomplete` entries for files that do not parse. */
const INVALID_PREFIXES = ['invalid-json:', 'invalid-toml:'] as const;

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

/**
 * The one agent that reads `file`, for the agents that have a load model: Claude Code for its
 * settings, subagents and commands. A skill may reach several agents, so it has none.
 */
function settingsAgent(file: string): ContextAgent | undefined {
  const kind = classify(file)?.kind;
  return kind === 'claude-settings' || kind === 'claude-agent' || kind === 'claude-command'
    ? 'claude-code'
    : undefined;
}

/** The agent whose hook configuration `file` is. */
function hookAgent(file: string): HookPlatform | undefined {
  const kind = classify(file)?.kind;
  return kind === undefined ? undefined : hookPlatformOf({ kind, path: file });
}

/** The violations of one scan, each id once: a requirement the policy repeats is one violation. */
function collect(policy: Policy, subject: PolicySubject): Found[] {
  const unique = new Map<string, Found>();
  for (const item of collectAll(policy, subject)) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()];
}

function collectAll(policy: Policy, subject: PolicySubject): Found[] {
  const base = normalizeBase(subject.pathBase);
  const inventory = subject.inventory;
  const out: Found[] = [];
  const itemId = (check: string, item: { id: string; file: string; digest: string }): string =>
    `${check}:${rootId(item.id, item.file, base)}@${item.digest}`;

  for (const server of inventory?.mcpServers ?? []) {
    out.push(...serverViolations(policy, server, itemId));
  }
  const forbidden: ReadonlySet<ForbidName> = new Set(policy.forbid);
  for (const item of inventory?.permissions ?? []) {
    const name = forbiddenPermission(item);
    if (name !== undefined && forbidden.has(name)) {
      out.push({
        id: itemId(`forbidden-setting:${name}`, item),
        check: 'forbidden-setting',
        entry: name,
        path: item.file,
        line: item.line,
        ...agentField(settingsAgent(stripPath(item.file, base))),
        message: permissionMessage(item, name),
      });
    }
    const denied = deniedTool(policy, item);
    if (denied !== undefined) {
      out.push({
        id: itemId('denied-tool', item),
        check: 'denied-tool',
        entry: denied.entries.join(', '),
        path: item.file,
        line: item.line,
        ...agentField(
          item.key === 'allowed-tools' ? settingsAgent(stripPath(item.file, base)) : 'claude-code',
        ),
        message: denied.message,
      });
    }
  }
  for (const item of inventory?.env ?? []) {
    const name = ENV_FORBID[item.class];
    if (name === undefined || !forbidden.has(name)) continue;
    out.push({
      id: itemId(`forbidden-setting:${name}`, item),
      check: 'forbidden-setting',
      entry: name,
      path: item.file,
      line: item.line,
      ...agentField(settingsAgent(stripPath(item.file, base))),
      message: envMessage(item, name),
    });
  }

  for (const requirement of policy.requireHooks) {
    const hooks = inventory?.hooks ?? [];
    if (hooks.some((hook) => satisfies(hook, requirement, stripPath(hook.file, base)))) continue;
    out.push(hookMissing(requirement));
  }

  for (const budget of policy.budgets) {
    const violation = overBudget(budget, subject.context?.plans ?? []);
    if (violation !== undefined) out.push(violation);
  }

  if (policy.models.length > 0) out.push(...modelViolations(policy.models, subject.agents, itemId));

  if (readsInventory(policy)) {
    for (const entry of inventory?.incomplete ?? []) {
      const prefix = INVALID_PREFIXES.find((candidate) => entry.startsWith(candidate)) ?? '';
      const path = entry.slice(prefix.length);
      const root = stripPath(path, base);
      out.push({
        id: `unanalyzed-config:${prefix}${root}`,
        check: 'unanalyzed-config',
        entry: `${prefix}${root}`,
        path,
        message: unanalyzedMessage(prefix),
      });
    }
  }
  return out;
}

/** True for a hook platform that is also one agent with a load model; Copilot has several. */
function isContextAgent(platform: HookPlatform): platform is HookPlatform & ContextAgent {
  return (ALL_CONTEXT_AGENTS as readonly string[]).includes(platform);
}

function agentField(agent: ContextAgent | undefined): { readonly agent?: ContextAgent } {
  return agent === undefined ? {} : { agent };
}

// ---------------------------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------------------------

function serverViolations(
  policy: Policy,
  server: McpServerItem,
  itemId: (check: string, item: McpServerItem) => string,
): Found[] {
  const out: Found[] = [];
  const target = serverTarget(server);
  const entry = allowForm(target);
  const where = { path: server.file, line: server.line };
  const { allow, allowLocal } = policy.mcp;
  if (allow !== undefined) {
    const allowed =
      target.kind === 'local' ? allowLocal : allow.some((item) => entryAllows(item, target));
    if (!allowed) {
      out.push({
        id: itemId('mcp-not-allowed', server),
        check: 'mcp-not-allowed',
        entry,
        ...where,
        message: notAllowedMessage(server, target.kind),
      });
    }
  }
  if (policy.mcp.requirePin && isUnpinned(server)) {
    out.push({
      id: itemId('mcp-unpinned', server),
      check: 'mcp-unpinned',
      entry,
      ...where,
      message: unpinnedMessage(server),
    });
  }
  return out;
}

const ECOSYSTEM_LABEL: Readonly<Record<NonNullable<PackageSpec['ecosystem']>, string>> = {
  npm: 'npm package',
  pypi: 'PyPI package',
  oci: 'container image',
};

/** How a version follows the name: `@1.2.3`, `==1.0`, `>=1,<2`, `:latest`, `@sha256:…`. */
function versionSuffix(ecosystem: keyof typeof ECOSYSTEM_LABEL, spec: PackageSpec): string {
  const version = spec.version ?? '';
  if (version === '') return '';
  switch (ecosystem) {
    case 'npm':
      return `@${version}`;
    case 'pypi':
      if (spec.pin === 'tag') return `@${version}`;
      return '<>!~='.includes(version.charAt(0)) ? version : `==${version}`;
    case 'oci':
      return (spec.pin === 'digest' ? '@' : ':') + version;
  }
}

/** `npm package @scope/name@1.2.3`, `container image ghcr.io/acme/db@sha256:…`. */
function packageText(server: McpServerItem): string | undefined {
  const spec = server.package;
  if (spec?.ecosystem === undefined || spec.name === undefined) return undefined;
  return `${ECOSYSTEM_LABEL[spec.ecosystem]} ${bounded(spec.name + versionSuffix(spec.ecosystem, spec))}`;
}

/** Repository text placed in a message without quotes: one line, at most `max` code points. */
function bounded(text: string, max = 100): string {
  const quoted = quote(text, max);
  return quoted.slice(1, -1);
}

function notAllowedMessage(server: McpServerItem, kind: ServerTarget['kind']): string {
  const name = `MCP server ${quote(server.name)}`;
  switch (kind) {
    case 'package':
      return `${name} runs ${packageText(server) ?? 'a package'}, which the policy does not allow.`;
    case 'local':
      return `${name} runs the repository script ${bounded(server.package?.name ?? '')}, which the policy does not allow: mcp.allowLocal is off.`;
    case 'remote':
      return `${name} connects to ${bounded(server.url?.origin ?? '')}, which the policy does not allow.`;
    case 'unknown': {
      const what = packageText(server);
      return what === undefined
        ? `${name} runs a command agentcheckup cannot read as a package, so no allowlist entry can match it.`
        : `${name} runs ${what}, whose version or source cannot be told, so no allowlist entry can match it.`;
    }
  }
}

function unpinnedMessage(server: McpServerItem): string {
  const name = `MCP server ${quote(server.name)}`;
  const what = packageText(server);
  const tail = 'the policy requires an exact version, a digest or a repository script.';
  const pin = server.package?.pin;
  if (what === undefined || pin === undefined) {
    return `${name} runs a command whose version cannot be told; ${tail}`;
  }
  if (pin === 'none') {
    return `${name} runs ${what} without a version, so whatever is newest runs; ${tail}`;
  }
  if (pin === 'range') return `${name} runs ${what}, a version range; ${tail}`;
  if (pin === 'tag') return `${name} runs ${what}, a moving tag; ${tail}`;
  return `${name} runs ${what}, whose version cannot be told; ${tail}`;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

const lastSegment = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

/** The `forbid` name a permission item falls under, if any. Grants come from broadGrant. */
function forbiddenPermission(item: PermissionItem): ForbidName | undefined {
  switch (lastSegment(item.key)) {
    case 'defaultMode':
    case 'permissionMode':
      return item.value === 'bypassPermissions' ? 'bypass-permissions' : undefined;
    case 'enableAllProjectMcpServers':
      return item.value === 'true' ? 'auto-approve-project-mcp' : undefined;
    case 'enabledMcpjsonServers':
      return 'mcp-auto-approve';
    case 'trust':
      return item.value === 'true' ? 'gemini-trust' : undefined;
    case 'additionalDirectories':
      return 'additional-directories';
    case 'allow':
    case 'allowed-tools': {
      if (broadGrant(item.value) === undefined) return undefined;
      return isShellTool(toolRule(item.value).tool) ? 'broad-shell' : 'broad-write';
    }
    default:
      return undefined;
  }
}

const ENV_FORBID: Readonly<Record<EnvItem['class'], ForbidName | undefined>> = {
  endpoint: 'env-endpoint',
  tls: 'env-tls',
  'code-exec': 'env-code-exec',
  credential: undefined,
  other: undefined,
};

/** ` It has no effect where it is set today.` for an item no agent applies where it is set. */
function ineffective(item: PermissionItem): string {
  return item.effective ? '' : ' It has no effect where it is set today.';
}

function permissionMessage(item: PermissionItem, name: ForbidName): string {
  const forbids = `the policy forbids ${name}.`;
  const setting = `${bounded(item.key)} ${quote(item.value)}`;
  switch (name) {
    case 'bypass-permissions': {
      if (lastSegment(item.key) === 'permissionMode') {
        const note = item.effective
          ? ''
          : ' Since Claude Code v2.1.267 a subagent runs in this mode only when the main conversation does; older versions honor it.';
        return `${setting} asks Claude Code to run every tool of this subagent without asking; ${forbids}${note}`;
      }
      const note = item.effective
        ? ''
        : ' Ignored here since Claude Code v2.1.257; older versions honor it.';
      return `${setting} lets Claude Code run every tool without asking; ${forbids}${note}`;
    }
    case 'auto-approve-project-mcp':
      return `${bounded(item.key)} is true, so Claude Code starts every MCP server in .mcp.json without asking; ${forbids}${ineffective(item)}`;
    case 'mcp-auto-approve':
      return `${setting} lets Claude Code start that MCP server without asking; ${forbids}${ineffective(item)}`;
    case 'gemini-trust':
      return `${bounded(item.key)} is true, so Gemini CLI runs every tool call of that MCP server without confirmation; ${forbids}${ineffective(item)}`;
    case 'additional-directories':
      return `${setting} gives Claude Code files outside the project; ${forbids}${ineffective(item)}`;
    case 'broad-shell':
    case 'broad-write': {
      const grant = broadGrant(item.value);
      const who = grant === undefined ? 'the agent' : readerName(grant.platform);
      const capability = grant?.capability ?? 'does more';
      return `${setting}: ${who} ${capability} without asking${whenGranted(item)}; ${forbids}${ineffective(item)}`;
    }
    case 'env-endpoint':
    case 'env-tls':
    case 'env-code-exec':
      // Environment overrides are inventory env items: see envMessage.
      return `${setting}; ${forbids}`;
  }
}

function envMessage(item: EnvItem, name: ForbidName): string {
  const forbids = `the policy forbids ${name}.`;
  const key = bounded(item.key);
  if (COMMAND_SETTINGS.includes(item.key)) return `${key} runs a command; ${forbids}`;
  switch (item.class) {
    case 'endpoint':
      return `Env override ${key} sends traffic to ${item.shown === undefined ? 'another endpoint' : bounded(item.shown)}; ${forbids}`;
    case 'tls':
      return `Env override ${key}${item.shown === undefined ? '' : ` = ${item.shown}`} changes TLS certificate checks; ${forbids}`;
    case 'code-exec':
      return `Env override ${key} can make the agent or the programs it starts run code; ${forbids}`;
    case 'credential':
    case 'other':
      // ENV_FORBID names no setting for these classes.
      return `Env override ${key}; ${forbids}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Denied tools and commands
// ---------------------------------------------------------------------------------------------

/** Keys of grants that let an agent use a tool without asking. */
const GRANT_KEYS: ReadonlySet<string> = new Set(['permissions.allow', 'allowed-tools']);

function deniedTool(
  policy: Policy,
  item: PermissionItem,
): { readonly entries: string[]; readonly message: string } | undefined {
  if (!GRANT_KEYS.has(item.key)) return undefined;
  const rule = toolRule(item.value);
  const tools = policy.denyTools.filter((denied) => grantsTool(rule.tool, denied));
  const program = isShellTool(rule.tool) ? shellProgram(rule.specifier) : undefined;
  const commands =
    program === undefined
      ? []
      : policy.denyCommands.filter(
          (denied) => program.kind !== 'program' || program.name === denied,
        );
  const entries = [...tools, ...commands];
  if (entries.length === 0) return undefined;
  let what: string;
  if (program === undefined || commands.length === 0) what = `use ${bounded(rule.tool)}`;
  else if (program.kind === 'any') what = 'run any command';
  else if (program.kind === 'unknown') what = 'run commands whose program cannot be told';
  else what = `run ${bounded(program.name)}`;
  const who = item.key === 'allowed-tools' ? 'the agent' : 'Claude Code';
  return {
    entries,
    message: `${item.key} ${quote(item.value)} lets ${who} ${what} without asking${whenGranted(item)}; the policy denies ${joinNames(entries)}.${ineffective(item)}`,
  };
}

/**
 * When a grant applies, for a grant that does not last the session: a skill's or command's
 * `allowed-tools` applies when it is invoked (SOURCES.claudeSkills: for the turn that invokes it).
 */
function whenGranted(item: PermissionItem): string {
  return item.key === 'allowed-tools' ? ' when the skill or command is invoked' : '';
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

/**
 * True when `hook` meets the requirement. A hook from a subagent's or a skill's frontmatter runs
 * only while that subagent runs or once the skill is invoked, so it never stands in for a hook
 * the whole session needs.
 */
function satisfies(hook: HookItem, requirement: HookRequirement, rootFile: string): boolean {
  return (
    hook.scope === undefined &&
    hook.known &&
    hook.event === requirement.event &&
    hookAgent(rootFile) === requirement.agent &&
    (requirement.matcher === undefined || hook.matcher === requirement.matcher) &&
    (requirement.script === undefined || hook.script === requirement.script) &&
    (requirement.command === undefined || hook.command === requirement.command)
  );
}

function hookMissing(requirement: HookRequirement): Found {
  const { agent, event, matcher, script, command } = requirement;
  const parts = [agent, event];
  let hook = `${readerName(agent)} ${event} hook`;
  if (matcher !== undefined) {
    parts.push(`matcher ${quote(matcher)}`);
    hook += ` with matcher ${quote(matcher)}`;
  }
  if (script !== undefined) {
    parts.push(`script ${script}`);
    hook += ` that runs ${quotePath(script)}`;
  }
  if (command !== undefined) {
    parts.push(`command ${quote(command)}`);
    hook += ` with command ${quote(command)}`;
  }
  return {
    id: `hook-missing:${canonicalJson(requirement)}`,
    check: 'hook-missing',
    entry: parts.join(' '),
    ...agentField(isContextAgent(agent) ? agent : undefined),
    message: `The policy requires a ${hook}, and none is configured. ${HOOKS_NOT_ENFORCED}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Startup budgets
// ---------------------------------------------------------------------------------------------

function overBudget(
  budget: Policy['budgets'][number],
  plans: readonly PolicyPlan[],
): Found | undefined {
  const { agent, startupTokens: limit } = budget;
  const label = AGENT_NAMES[agent];
  const base = {
    id: `startup-budget:${agent}`,
    check: 'startup-budget',
    entry: agent,
    agent,
  } as const;
  let largest: PolicyPlan | undefined;
  for (const plan of plans) {
    if (plan.agent !== agent) continue;
    const tokens = plan.totals.startup.tokens;
    if (
      largest === undefined ||
      tokens > largest.totals.startup.tokens ||
      (tokens === largest.totals.startup.tokens && compareStrings(plan.cwd, largest.cwd) < 0)
    ) {
      largest = plan;
    }
  }
  if (largest === undefined) {
    return {
      ...base,
      message: `${label} has no load plan in this scan, so its startup context cannot be checked (policy limit ≈${formatInteger(limit)}).`,
    };
  }
  const tokens = largest.totals.startup.tokens;
  if (tokens <= limit) return undefined;
  return {
    ...base,
    message: `${label} loads ≈${formatInteger(tokens)} tokens at session start in ./${bounded(largest.cwd)} (policy limit ≈${formatInteger(limit)}).`,
    tokens,
  };
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

/** Why `value` fails `rule`, or undefined when it passes. Values match exactly. */
/** `opus[1m]` -> `opus`, `claude-opus-5[effort=high]` -> `claude-opus-5`: the model without options. */
function withoutOptions(value: string): string {
  return value.endsWith(']') && value.includes('[')
    ? value.slice(0, value.lastIndexOf('['))
    : value;
}

/**
 * Why `value` fails `rule`, or undefined when it passes. `allow` matches exactly; `deny` also
 * matches the value without the options in brackets, so `deny: ["opus"]` catches `opus[1m]`.
 * GitHub Copilot compares model ids without case (SOURCES.copilotCliAgents), so its rules do too.
 */
function modelProblem(
  rule: ModelRule,
  value: string,
  agent: ContextAgent,
): 'denies' | 'does not allow' | undefined {
  const fold = agent.startsWith('copilot-')
    ? (text: string): string => text.toLowerCase()
    : (text: string): string => text;
  const same = (entry: string, candidate: string): boolean => fold(entry) === fold(candidate);
  if (rule.deny.some((entry) => same(entry, value) || same(entry, withoutOptions(value)))) {
    return 'denies';
  }
  if (rule.allow !== undefined && !rule.allow.some((entry) => same(entry, value))) {
    return 'does not allow';
  }
  return undefined;
}

const valuesOf = (value: string | readonly string[]): readonly string[] =>
  typeof value === 'string' ? [value] : value;

/** True when the definition may run: loaded, or not known to lose to another or to be skipped. */
function mayRun(definition: AgentDefinition): boolean {
  if (definition.status === 'loads' || definition.status === 'unknown') return true;
  // Which of two definitions wins is often not documented: then either may run.
  return definition.status === 'shadowed' && definition.certainty === 'unverified';
}

/**
 * The models the repository makes each agent run on: a definition's own `model`, unless a setting
 * overrides it with a model the repository names (that setting is checked instead), and every
 * model setting. A definition the agent skips, or is documented to lose to another, runs on
 * nothing. One whose loading is not documented and whose model cannot be read fails an
 * allowlist: the policy fails closed, as it does for a scan without agent definitions. A
 * definition without a model runs on one chosen elsewhere: a setting, which is checked, or the
 * user's choice, which is not visible.
 */
function modelViolations(
  rules: readonly ModelRule[],
  agents: AgentsReport | undefined,
  itemId: (check: string, item: { id: string; file: string; digest: string }) => string,
): Found[] {
  const byAgent = new Map(rules.map((rule) => [rule.agent, rule]));
  if (agents === undefined) {
    return [
      {
        id: 'model-not-allowed:no-agents',
        check: 'model-not-allowed',
        entry: 'unknown',
        message:
          "This scan lists no agent definitions or model settings, so the policy's models cannot be checked.",
      },
    ];
  }
  const out: Found[] = [];
  for (const definition of agents.definitions) {
    const rule = byAgent.get(definition.agent);
    if (rule === undefined || !mayRun(definition)) continue;
    // A switch that hands every subagent a model the repository does not name, such as
    // CLAUDE_CODE_SUBAGENT_MODEL_FORCE alone, leaves older versions on the file's own model.
    const { overridden, source } = definition.effective;
    if (overridden !== undefined && source !== 'not-visible') continue;
    const where = {
      id: itemId('model-not-allowed', definition),
      check: 'model-not-allowed',
      path: definition.file,
      agent: definition.agent,
    } as const;
    const { model } = definition;
    if (model === undefined) {
      if (definition.status === 'unknown' && rule.allow !== undefined) {
        out.push({
          ...where,
          entry: 'unknown',
          line: definition.line,
          message: `${definitionName(definition)} may load, but its model cannot be read${definition.reason === undefined ? '' : ` (${definition.reason})`}, so the policy's allowlist cannot pass it.`,
        });
      }
      continue;
    }
    const failing = valuesOf(model.value).filter(
      (value) => modelProblem(rule, value, definition.agent) !== undefined,
    );
    const [first] = failing;
    if (first === undefined) continue;
    out.push({
      ...where,
      entry: failing.join(', '),
      line: model.line,
      message: `${definitionName(definition)} sets model ${failing.map((value) => quote(value)).join(', ')}, which the policy ${modelProblem(rule, first, definition.agent) ?? 'does not allow'} for ${AGENT_NAMES[definition.agent]}.`,
    });
  }
  for (const setting of agents.settings) {
    const rule = byAgent.get(setting.agent);
    if (rule === undefined || !isModelChoice(setting)) continue;
    const problem = modelProblem(rule, setting.value, setting.agent);
    if (problem === undefined) continue;
    out.push({
      id: itemId('model-not-allowed', setting),
      check: 'model-not-allowed',
      entry: setting.value,
      path: setting.file,
      line: setting.line,
      agent: setting.agent,
      message: `${bounded(setting.key)} sets model ${quote(setting.value)} for ${settingTarget(setting)}, which the policy ${problem} for ${AGENT_NAMES[setting.agent]}.`,
    });
  }
  return out;
}

/** `Agent definition "reviewer"`, or the file's when it has no name. */
function definitionName(definition: AgentDefinition): string {
  return definition.name === undefined
    ? `The agent definition in ${quotePath(definition.file)}`
    : `Agent definition ${quote(definition.name)}`;
}

function settingTarget(setting: ModelSetting): string {
  const agent = AGENT_NAMES[setting.agent];
  switch (setting.applies) {
    case 'subagents':
      return `${agent} subagents`;
    case 'alias':
      return `an alias in ${agent}`;
    case 'session':
    case 'allowed':
      return `${agent} sessions`;
  }
}

// ---------------------------------------------------------------------------------------------
// Unanalyzed configuration
// ---------------------------------------------------------------------------------------------

function unanalyzedMessage(prefix: string): string {
  const tail = 'so what it configures cannot be checked against the policy.';
  if (prefix === 'invalid-json:') return `This file is not valid JSON, ${tail}`;
  if (prefix === 'invalid-toml:') return `This file is not valid TOML, ${tail}`;
  return `agentcheckup cannot analyze this file, ${tail}`;
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

function notesOf(
  policy: Policy,
  input: PolicyInput,
  violations: readonly PolicyViolation[],
): PolicyNote[] {
  const notes: PolicyNote[] = [];
  if (policy.mode === 'audit') {
    notes.push({
      id: 'audit-mode',
      message: 'Audit mode: violations are reported but never fail the run.',
    });
  }
  if (input.insideScanRoot === true) {
    notes.push({
      id: 'policy-inside-scan-root',
      message:
        'The policy file is inside the scanned directory, so a change under review can edit it. In CI, read the policy from the base commit or a central repository.',
    });
  }
  if (
    policy.requireHooks.length > 0 &&
    !violations.some((violation) => violation.check === 'hook-missing')
  ) {
    notes.push({ id: 'hooks-not-enforced', message: HOOKS_NOT_ENFORCED });
  }
  const { baseline } = input;
  if (baseline !== undefined) {
    if (baseline.inventory === undefined && readsInventory(policy)) {
      notes.push({
        id: 'baseline-without-inventory',
        message:
          'The baseline has no security inventory, so every violation of an MCP server, setting, grant or hook counts as new.',
      });
    }
    if (baseline.agents === undefined && policy.models.length > 0) {
      notes.push({
        id: 'baseline-without-agents',
        message:
          'The baseline has no agent definitions, so every model violation counts as new. Write the baseline with this version of agentcheckup.',
      });
    }
    if (baseline.context === undefined && policy.budgets.length > 0) {
      notes.push({
        id: 'baseline-without-plans',
        message:
          'The baseline has no load plans, so every startup-budget violation counts as new. Write the baseline with --context.',
      });
    }
    if (
      violations.some(
        (violation) =>
          violation.check === 'unanalyzed-config' && violation.baseline === 'unchanged',
      )
    ) {
      notes.push({
        id: 'unanalyzed-unchanged',
        message:
          'A change inside a file agentcheckup cannot analyze is not visible, so such a file counts as unchanged when the baseline has it too.',
      });
    }
  }
  return notes;
}
