/**
 * Checks a scan against an organization policy. Pure and deterministic: the same policy and scan
 * give the same report, with every list sorted.
 *
 * The checks read the security inventory and the load plans, never the files: an MCP server's
 * package and pin, permission and environment items, hook items, and each plan's startup tokens.
 * Broad grants come from broadGrant and environment classes from the inventory, so the policy
 * and the gate (src/core/baseline.ts) agree on what an item does.
 *
 * Baselines. The same policy is evaluated on the baseline's inventory and plans. A violation is
 * `unchanged` when the baseline has one with the same id: same check, same subject and, for an
 * inventory item, the same digest, so changing a server that already violates the policy makes a
 * new violation. A startup budget violation is new unless the baseline exceeded the budget too,
 * with at least as many tokens.
 */
import { isUnpinned } from '../core/baseline.js';
import { compareStrings } from '../core/compare.js';
import { formatInteger } from '../core/format.js';
import type { Artifact } from '../core/types.js';
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
import { AGENT_NAMES, type ContextAgent } from '../platforms/load/types.js';
import { broadGrant } from '../platforms/permissions.js';
import { joinNames, platformName, quote, quotePath } from '../rules/shared/format.js';
import { grantsTool, isShellTool, shellProgram, toolRule } from './grants.js';
import { allowForm, entryAllows, serverTarget, type ServerTarget } from './mcp.js';
import {
  type ForbidName,
  type HookRequirement,
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
  readonly context?: { readonly plans: readonly PolicyPlan[] };
  readonly pathBase?: string;
}

export interface PolicyInput {
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
    sha256: policy.sha256,
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

const INVALID_JSON = 'invalid-json:';

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

/** Which agent's settings `file` is, for the agents that have a load model. */
function settingsAgent(file: string): ContextAgent | undefined {
  return classify(file)?.kind === 'claude-settings' ? 'claude-code' : undefined;
}

/** The agent whose hook configuration `file` is. */
function hookAgent(file: string): HookPlatform | undefined {
  const kind = classify(file)?.kind;
  // hookPlatformOf reads only the kind.
  return kind === undefined ? undefined : hookPlatformOf({ kind } as Artifact);
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
        ...agentField(item.key === 'allowed-tools' ? undefined : 'claude-code'),
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

  if (readsInventory(policy)) {
    for (const entry of inventory?.incomplete ?? []) {
      const invalid = entry.startsWith(INVALID_JSON);
      const path = invalid ? entry.slice(INVALID_JSON.length) : entry;
      const root = stripPath(path, base);
      out.push({
        id: `unanalyzed-config:${invalid ? INVALID_JSON : ''}${root}`,
        check: 'unanalyzed-config',
        entry: `${invalid ? INVALID_JSON : ''}${root}`,
        path,
        message: unanalyzedMessage(root, invalid),
      });
    }
  }
  return out;
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
      const who = grant === undefined ? 'the agent' : platformName(grant.platform);
      const capability = grant?.capability ?? 'does more';
      return `${setting}: ${who} ${capability} without asking; ${forbids}${ineffective(item)}`;
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
    message: `${item.key} ${quote(item.value)} lets ${who} ${what} without asking; the policy denies ${joinNames(entries)}.${ineffective(item)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

function satisfies(hook: HookItem, requirement: HookRequirement, rootFile: string): boolean {
  return (
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
  let hook = `${platformName(agent)} ${event} hook`;
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
    ...agentField(agent === 'gemini' ? undefined : agent),
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
// Unanalyzed configuration
// ---------------------------------------------------------------------------------------------

function unanalyzedMessage(path: string, invalid: boolean): string {
  const tail = 'so what it configures cannot be checked against the policy.';
  if (invalid) return `This file is not valid JSON, ${tail}`;
  if (path === '.codex/config.toml' || path.endsWith('/.codex/config.toml')) {
    return `agentcheckup does not parse TOML, ${tail}`;
  }
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
