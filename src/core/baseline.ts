/**
 * Comparison of a scan with a baseline report (`--baseline`): which findings are new, which
 * inventory items and load-plan entries changed, and which changes trip the gate. Pure and
 * deterministic: every list in the result is sorted with compareStrings. The types are in
 * src/core/baseline-types.ts; the decision is docs/adr/0007-model-what-each-agent-loads.md.
 *
 * Identity. Findings match by fingerprint, which the engine computes from scan-root-relative
 * paths before any rebase. Paths and ids are compared after removing each report's `pathBase`,
 * so both reports must come from scans of the same directory, but they may have been rebased
 * differently. Every path and id in the returned diff is relative to the scan root, without
 * `pathBase`; the annotated findings keep their paths as they were.
 *
 * Credentials. Gate summaries are built from the inventory, which holds names, URL origins and
 * redacted arguments only. As a second line of defense, summaries show at most the program and
 * package of a command, mask `name=value` arguments and the value after a credential-like flag,
 * and show an environment value only for `endpoint` overrides, where it is a URL origin.
 */
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PermissionItem,
} from '../inventory/types.js';
import { classify } from '../platforms/classify.js';
import { REDACTED } from '../inventory/redact.js';
import { clinePlace } from '../platforms/cline-rules.js';
import { hookSourceOf } from '../platforms/hooks.js';
import { MCP_KINDS } from '../platforms/mcp.js';
import { broadGrant } from '../platforms/permissions.js';
import { coveredBy } from '../platforms/tool-rules.js';
import type {
  BaselineFinding,
  BaselineLimitUsage,
  BaselineLoadEntry,
  BaselinePlan,
  BaselineReport,
  BaselineSkippedLoad,
} from './baseline-input.js';
import type { AgentDefinition, AgentsReport, ModelSetting } from '../agents/types.js';
import { AGENT_NAMES } from '../platforms/load/types.js';
import type {
  BaselineDiff,
  CallDelta,
  GateClass,
  GateHit,
  ItemDiff,
  PlanDelta,
  SecurityGateClass,
} from './baseline-types.js';
import { compareStrings } from './compare.js';
import type { ScanResult } from './engine.js';
import type { ArtifactKind, Finding, RuleMeta } from './types.js';

// ---------------------------------------------------------------------------------------------
// Gate classes
// ---------------------------------------------------------------------------------------------

/** Each gate class, and whether `--gate security` selects it. */
const GATE_TABLE: Readonly<Record<GateClass, { readonly security: boolean }>> = {
  mcp: { security: true },
  'mcp-unpinned': { security: true },
  permissions: { security: true },
  hooks: { security: true },
  env: { security: true },
  unicode: { security: true },
  models: { security: false },
};

/** Every gate class, in documentation order. */
export const GATE_CLASSES: readonly GateClass[] = Object.keys(GATE_TABLE) as GateClass[];

/** Whether `--gate security` selects `gate`. */
export function isSecurityGateClass(gate: GateClass): gate is SecurityGateClass {
  return GATE_TABLE[gate].security;
}

/** The classes `--gate security` selects: every class but `models`. */
export const SECURITY_GATE_CLASSES: readonly SecurityGateClass[] =
  GATE_CLASSES.filter(isSecurityGateClass);

export type GateParseResult =
  | { readonly ok: true; readonly classes: readonly GateClass[] }
  | { readonly ok: false; readonly message: string };

function isGateClass(name: string): name is GateClass {
  return Object.hasOwn(GATE_TABLE, name);
}

/**
 * Parses a `--gate` value: a comma-separated list of gate classes, `security` for every class
 * but `models`, or `none` alone. The classes come back sorted, without duplicates.
 */
export function parseGateClasses(text: string): GateParseResult {
  const expected = `Use a comma-separated list of ${GATE_CLASSES.join(', ')}, or "security" for all but models, or "none".`;
  const classes = new Set<GateClass>();
  let none = false;
  for (const raw of text.split(',')) {
    const name = raw.trim();
    if (name === 'none') none = true;
    else if (name === 'security') for (const gate of SECURITY_GATE_CLASSES) classes.add(gate);
    else if (isGateClass(name)) classes.add(name);
    else if (name === '') return { ok: false, message: `Empty gate class. ${expected}` };
    else {
      return {
        ok: false,
        message: `Unknown gate class ${JSON.stringify(clip(name, 40))}. ${expected}`,
      };
    }
  }
  if (none && classes.size > 0) {
    return { ok: false, message: `"none" cannot be combined with other gate classes. ${expected}` };
  }
  return { ok: true, classes: [...classes].sort(compareStrings) };
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/**
 * The parts of the current scan a comparison reads. Every scan has an inventory; without one, the
 * comparison reads an empty inventory, as it does for a baseline made before inventories existed.
 */
export type CurrentScan = Pick<
  ScanResult,
  'ruleset' | 'rules' | 'findings' | 'pathBase' | 'context'
> & {
  readonly inventory?: Inventory;
  readonly agents?: AgentsReport;
};

export interface BaselineOptions {
  /** Classes whose changes trip the gate, as from {@link parseGateClasses}. Default: none. */
  readonly gate?: readonly GateClass[];
}

export interface BaselineComparison {
  readonly diff: BaselineDiff;
  /** The current findings in their original order, each with `baseline` set. */
  readonly findings: readonly Finding[];
  /**
   * Rules introduced after the baseline's rule set ({@link newRuleIds}). Their findings are
   * new because the baseline could not report them; a report can label them "new rule".
   */
  readonly newRules: readonly string[];
}

/** Compares the current scan with a baseline report. Does not modify either input. */
export function compareWithBaseline(
  current: CurrentScan,
  baseline: BaselineReport,
  options: BaselineOptions = {},
): BaselineComparison {
  const currentBase = normalizeBase(current.pathBase);
  const baselineBase = normalizeBase(baseline.pathBase);

  const { findings, resolved } = matchFindings(current.findings, baseline.findings, baselineBase);
  const before = indexInventory(baseline.inventory, baselineBase);
  const after = indexInventory(current.inventory, currentBase);

  const agentsBefore = indexAgents(baseline.agents, baselineBase);
  const agentsAfter = indexAgents(current.agents, currentBase);

  const classes = [...new Set(options.gate ?? [])].sort(compareStrings);
  const selected: ReadonlySet<GateClass> = new Set(classes);
  const hits = [
    ...gateHits(before, after, findings, currentBase),
    ...modelHits(agentsBefore, agentsAfter),
  ]
    .filter((hit) => selected.has(hit.class))
    .sort(compareHits);

  const versions = {
    version: baseline.tool.version,
    ruleset: baseline.ruleset,
    sameRuleset: baseline.ruleset === current.ruleset,
  };
  const newRules = newRuleIds(current.rules, versions);
  const fresh = findings.filter((finding) => finding.baseline === 'new').length;
  return {
    diff: {
      against: { ...versions, newRules },
      findings: { new: fresh, unchanged: findings.length - fresh, resolved },
      inventory: diffInventory(before, after),
      agents: diffAgents(agentsBefore, agentsAfter),
      context: diffPlans(
        baseline.context?.plans ?? [],
        baselineBase,
        current.context?.plans ?? [],
        currentBase,
      ),
      gate: { classes, hits },
    },
    findings,
    newRules,
  };
}

/**
 * Ids of rules whose `since` rule set is later than the baseline's, so the baseline could not
 * have run them. Empty when both reports use the same rule set, or when either version is not a
 * calendar version such as `2026.10`.
 */
export function newRuleIds(
  rules: readonly Pick<RuleMeta, 'id' | 'since'>[],
  against: Pick<BaselineDiff['against'], 'ruleset' | 'sameRuleset'>,
): string[] {
  if (against.sameRuleset) return [];
  const ids = new Set<string>();
  for (const rule of rules) {
    const order = compareRulesets(rule.since, against.ruleset);
    if (order !== undefined && order > 0) ids.add(rule.id);
  }
  return [...ids].sort(compareStrings);
}

function compareRulesets(a: string, b: string): number | undefined {
  const left = rulesetParts(a);
  const right = rulesetParts(b);
  if (left === undefined || right === undefined) return undefined;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function rulesetParts(version: string): number[] | undefined {
  if (version.length === 0 || version.length > 32) return undefined;
  const parts: number[] = [];
  for (const part of version.split('.')) {
    if (!/^\d{1,9}$/.test(part)) return undefined;
    parts.push(Number(part));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** `pathBase` without trailing slashes; `''` when absent or `.`. */
function normalizeBase(base: string | undefined): string {
  if (base === undefined) return '';
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  const trimmed = base.slice(0, end);
  return trimmed === '.' ? '' : trimmed;
}

/** Removes `base` from a path that carries it. `base` itself becomes `''` (the scan root). */
function stripPath(path: string, base: string): string {
  if (base === '') return path;
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/**
 * The root-relative form of an id `<prefix>:<path>`, `<prefix>:<path>#...` or
 * `<prefix>:<path>@<agent>` (an agent definition), where `path` is the item's own path field.
 * Strips `base` only when the id embeds the prefixed path, so ids that a rebase left untouched
 * stay as they are.
 */
function rootId(id: string, path: string, base: string): string {
  const root = stripPath(path, base);
  if (root === path) return id;
  const start = id.indexOf(':') + 1;
  if (start === 0 || !id.startsWith(path, start)) return id;
  const end = start + path.length;
  if (end !== id.length && id.charAt(end) !== '#' && id.charAt(end) !== '@') return id;
  return id.slice(0, start) + root + id.slice(end);
}

/** `invalid-json:<path>` and plain paths. */
function stripIncomplete(entry: string, base: string): string {
  const stripped = stripPath(entry, base);
  if (stripped !== entry) return stripped;
  const colon = entry.indexOf(':');
  return colon < 0 ? entry : entry.slice(0, colon + 1) + stripPath(entry.slice(colon + 1), base);
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

function matchFindings(
  current: readonly Finding[],
  baseline: readonly BaselineFinding[],
  baselineBase: string,
): { findings: Finding[]; resolved: BaselineDiff['findings']['resolved'] } {
  // Fingerprint -> indices of baseline findings, consumed in order: a multiset.
  const pool = new Map<string, { readonly indices: number[]; next: number }>();
  baseline.forEach((finding, index) => {
    const slot = pool.get(finding.fingerprint);
    if (slot === undefined) pool.set(finding.fingerprint, { indices: [index], next: 0 });
    else slot.indices.push(index);
  });

  const matched = new Uint8Array(baseline.length);
  const findings = current.map((finding): Finding => {
    const slot = pool.get(finding.fingerprint);
    const index = slot?.indices[slot.next];
    if (slot === undefined || index === undefined) return { ...finding, baseline: 'new' };
    slot.next++;
    matched[index] = 1;
    return { ...finding, baseline: 'unchanged' };
  });

  const resolved = baseline
    .filter((_, index) => matched[index] === 0)
    .map((finding) => ({
      ruleId: finding.ruleId,
      path: stripPath(finding.path, baselineBase),
      fingerprint: finding.fingerprint,
    }))
    .sort(
      (a, b) =>
        compareStrings(a.path, b.path) ||
        compareStrings(a.ruleId, b.ruleId) ||
        compareStrings(a.fingerprint, b.fingerprint),
    );
  return { findings, resolved };
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

/** One report's inventory, keyed by root-relative id. The first item with an id wins. */
interface IndexedInventory {
  readonly base: string;
  readonly mcpServers: ReadonlyMap<string, McpServerItem>;
  readonly hooks: ReadonlyMap<string, HookItem>;
  readonly permissions: ReadonlyMap<string, PermissionItem>;
  readonly env: ReadonlyMap<string, EnvItem>;
  readonly incomplete: ReadonlySet<string>;
}

interface Item {
  readonly id: string;
  readonly file: string;
  readonly digest: string;
}

function indexItems<T extends Item>(items: readonly T[], base: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = rootId(item.id, item.file, base);
    if (!map.has(id)) map.set(id, item);
  }
  return map;
}

/**
 * A report without an inventory is read as an empty one, so every current item counts as added
 * and the gate fails closed instead of passing changes it cannot see.
 */
function indexInventory(inventory: Inventory | undefined, base: string): IndexedInventory {
  return {
    base,
    mcpServers: indexItems(inventory?.mcpServers ?? [], base),
    hooks: indexItems(inventory?.hooks ?? [], base),
    permissions: indexItems(inventory?.permissions ?? [], base),
    env: indexItems(inventory?.env ?? [], base),
    incomplete: new Set((inventory?.incomplete ?? []).map((entry) => stripIncomplete(entry, base))),
  };
}

/**
 * How `changed` items list their fields. `skip`: identity or position, never listed. `path`:
 * compared without the report's pathBase. The Record type makes the compiler flag a field added
 * to an item type.
 */
type FieldMode = 'skip' | 'value' | 'path';
type FieldTable<T> = Readonly<Record<keyof T, FieldMode>>;

const BASE_FIELDS = {
  id: 'skip',
  file: 'path',
  line: 'skip',
  platforms: 'value',
  digest: 'skip',
} as const;

const SERVER_FIELDS = {
  ...BASE_FIELDS,
  name: 'value',
  transport: 'value',
  declaredType: 'value',
  command: 'value',
  args: 'value',
  package: 'value',
  url: 'value',
  envKeys: 'value',
  headerKeys: 'value',
  status: 'value',
  scope: 'value',
} as const satisfies FieldTable<McpServerItem>;

const HOOK_FIELDS = {
  ...BASE_FIELDS,
  event: 'value',
  known: 'value',
  matcher: 'value',
  type: 'value',
  command: 'value',
  script: 'path',
  failsOpen: 'value',
  remoteScript: 'value',
  scope: 'value',
  effective: 'value',
} as const satisfies FieldTable<HookItem>;

const PERMISSION_FIELDS = {
  ...BASE_FIELDS,
  key: 'value',
  value: 'value',
  broad: 'value',
  effective: 'value',
} as const satisfies FieldTable<PermissionItem>;

const ENV_FIELDS = {
  ...BASE_FIELDS,
  key: 'value',
  class: 'value',
  shown: 'value',
} as const satisfies FieldTable<EnvItem>;

/** Item values nest at most two levels (`package.pin`, `status.cursor`). */
const MAX_VALUE_DEPTH = 4;

function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth >= MAX_VALUE_DEPTH) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value: unknown, index) => sameValue(value, b[index], depth + 1));
  }
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], depth + 1),
  );
}

/** Fields that differ, sorted. `['digest']` when only the digest tells the items apart. */
function changedFields<T extends object>(
  before: T,
  beforeBase: string,
  after: T,
  afterBase: string,
  table: FieldTable<T>,
): string[] {
  const fields: string[] = [];
  for (const key of Object.keys(table) as (keyof T & string)[]) {
    const mode = table[key];
    if (mode === 'skip') continue;
    let left: unknown = before[key];
    let right: unknown = after[key];
    if (mode === 'path') {
      if (typeof left === 'string') left = stripPath(left, beforeBase);
      if (typeof right === 'string') right = stripPath(right, afterBase);
    }
    if (!sameValue(left, right)) fields.push(key);
  }
  return fields.length > 0 ? fields.sort(compareStrings) : ['digest'];
}

interface MutableItemDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: { readonly id: string; readonly fields: readonly string[] }[];
}

function diffItems<T extends Item>(
  before: ReadonlyMap<string, T>,
  beforeBase: string,
  after: ReadonlyMap<string, T>,
  afterBase: string,
  table: FieldTable<T>,
  out: MutableItemDiff,
): void {
  for (const [id, item] of after) {
    const old = before.get(id);
    if (old === undefined) out.added.push(id);
    else if (old.digest !== item.digest) {
      out.changed.push({ id, fields: changedFields(old, beforeBase, item, afterBase, table) });
    }
  }
  for (const id of before.keys()) if (!after.has(id)) out.removed.push(id);
}

function sortedDiff(diff: MutableItemDiff): ItemDiff {
  return {
    added: diff.added.sort(compareStrings),
    removed: diff.removed.sort(compareStrings),
    changed: diff.changed.sort((a, b) => compareStrings(a.id, b.id)),
  };
}

function diffInventory(before: IndexedInventory, after: IndexedInventory): ItemDiff {
  const out: MutableItemDiff = { added: [], removed: [], changed: [] };
  const bases = [before.base, after.base] as const;
  diffItems(before.mcpServers, bases[0], after.mcpServers, bases[1], SERVER_FIELDS, out);
  diffItems(before.hooks, bases[0], after.hooks, bases[1], HOOK_FIELDS, out);
  diffItems(before.permissions, bases[0], after.permissions, bases[1], PERMISSION_FIELDS, out);
  diffItems(before.env, bases[0], after.env, bases[1], ENV_FIELDS, out);
  return sortedDiff(out);
}

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------

const HIDDEN_UNICODE_RULE = 'risk/hidden-unicode';

function changeOf<T extends Item>(old: T | undefined, item: T): GateHit['change'] | undefined {
  if (old === undefined) return 'added';
  return old.digest === item.digest ? undefined : 'changed';
}

function gateHits(
  before: IndexedInventory,
  after: IndexedInventory,
  findings: readonly Finding[],
  currentBase: string,
): GateHit[] {
  const hits = new Map<string, GateHit>();
  const hit = (
    gate: GateClass,
    id: string,
    change: GateHit['change'],
    summary: string,
    kind?: GateHit['kind'],
  ): void => {
    const key = `${gate}\u0000${id}\u0000${change}`;
    if (!hits.has(key)) {
      hits.set(key, { class: gate, id, change, summary, ...(kind === undefined ? {} : { kind }) });
    }
  };

  for (const [id, server] of after.mcpServers) {
    const change = changeOf(before.mcpServers.get(id), server);
    if (change === undefined) continue;
    hit('mcp', id, change, serverSummary(server, change));
    if (isUnpinned(server)) hit('mcp-unpinned', id, change, unpinnedSummary(server, change));
  }
  for (const entry of after.incomplete) {
    if (before.incomplete.has(entry)) continue;
    if (isMcpConfig(entry)) hit('mcp', entry, 'added', incompleteSummary(entry, 'MCP'));
    if (isHookConfig(entry)) hit('hooks', entry, 'added', incompleteSummary(entry, 'hooks'));
  }

  // Earlier values of each setting the gate reports whenever it changes, by file and kind.
  const settingAt = (file: string, kind: NonNullable<GateHit['kind']>): string =>
    `${file}\u0000${kind}`;
  const previousSettings = new Map<string, string[]>();
  for (const permission of before.permissions.values()) {
    const kind = settingKind(permission);
    if (kind === undefined) continue;
    const at = settingAt(stripPath(permission.file, before.base), kind);
    previousSettings.set(at, [...(previousSettings.get(at) ?? []), permission.value]);
  }
  for (const [id, permission] of after.permissions) {
    const old = before.permissions.get(id);
    const change = changeOf(old, permission);
    if (change === undefined) continue;
    const kind = settingKind(permission);
    if (kind !== undefined) {
      const at = settingAt(stripPath(permission.file, after.base), kind);
      const summary = settingSummary(permission, change, previousSettings.get(at) ?? []);
      hit(
        'permissions',
        id,
        change,
        kind === 'agent' ? `${summary}${AGENT_EFFECT}` : summary,
        kind,
      );
    } else if (
      widens(permission) &&
      !(old !== undefined && alreadyAsWide(old, permission)) &&
      !(old === undefined && replacesWider(permission, before, after))
    ) {
      hit('permissions', id, change, permissionSummary(permission, change, old));
    }
  }

  for (const [id, hook] of after.hooks) {
    const change = changeOf(before.hooks.get(id), hook);
    if (change !== undefined) hit('hooks', id, change, hookSummary(hook, change, after.base));
  }

  for (const [id, item] of after.env) {
    if (item.class === 'other') continue;
    const change = changeOf(before.env.get(id), item);
    if (change !== undefined) hit('env', id, change, envSummary(item, change));
  }

  for (const finding of findings) {
    // Suppressed findings follow the scan's trust setting: --untrusted ignores directives.
    if (finding.baseline !== 'new' || finding.ruleId !== HIDDEN_UNICODE_RULE) continue;
    if (finding.suppressed) continue;
    hit(
      'unicode',
      finding.fingerprint,
      'added',
      `Hidden Unicode in ${text(stripPath(finding.path, currentBase))}, line ${finding.range.start.line}`,
    );
  }

  return [...hits.values()].sort(compareHits);
}

function compareHits(a: GateHit, b: GateHit): number {
  return (
    compareStrings(a.class, b.class) ||
    compareStrings(a.id, b.id) ||
    compareStrings(a.change, b.change)
  );
}

// Agent definitions and model settings ---------------------------------------------------------

interface IndexedAgents {
  readonly base: string;
  readonly definitions: ReadonlyMap<string, AgentDefinition>;
  readonly settings: ReadonlyMap<string, ModelSetting>;
}

/**
 * A report without agent definitions, made before agentcheckup listed them, is read as an empty
 * one: every current definition counts as added, so the `models` class fails closed.
 */
function indexAgents(report: AgentsReport | undefined, base: string): IndexedAgents {
  return {
    base,
    definitions: indexItems(report?.definitions ?? [], base),
    settings: indexItems(report?.settings ?? [], base),
  };
}

const DEFINITION_FIELDS = {
  id: 'skip',
  file: 'path',
  line: 'skip',
  agent: 'value',
  name: 'value',
  status: 'value',
  reason: 'value',
  shadowedBy: 'path',
  model: 'value',
  // Settings decide it, and each setting is an item of its own; the digest leaves it out too.
  effective: 'skip',
  effort: 'value',
  tools: 'value',
  permissionMode: 'value',
  certainty: 'value',
  evidence: 'value',
  digest: 'skip',
} as const satisfies FieldTable<AgentDefinition>;

const SETTING_FIELDS = {
  id: 'skip',
  agent: 'value',
  file: 'path',
  line: 'skip',
  key: 'value',
  value: 'value',
  applies: 'value',
  forced: 'value',
  digest: 'skip',
} as const satisfies FieldTable<ModelSetting>;

function diffAgents(before: IndexedAgents, after: IndexedAgents): ItemDiff {
  const out: MutableItemDiff = { added: [], removed: [], changed: [] };
  // Lines move with every edit above them: compare values without them.
  const withoutLines = (definition: AgentDefinition): AgentDefinition => ({
    ...definition,
    ...(definition.model === undefined ? {} : { model: { ...definition.model, line: 0 } }),
    ...(definition.effort === undefined ? {} : { effort: { ...definition.effort, line: 0 } }),
  });
  diffItems(
    new Map([...before.definitions].map(([id, item]) => [id, withoutLines(item)])),
    before.base,
    new Map([...after.definitions].map(([id, item]) => [id, withoutLines(item)])),
    after.base,
    DEFINITION_FIELDS,
    out,
  );
  diffItems(before.settings, before.base, after.settings, after.base, SETTING_FIELDS, out);
  return sortedDiff(out);
}

/**
 * Hits of the `models` class: a definition added, changed in what the file says or what the
 * agent does with it, or running on another model because a setting changed; a model setting
 * set, changed or removed. Removing a setting changes what runs, such as every subagent going
 * back to its own model, so unlike other classes it trips. Removing a definition does not.
 */
function modelHits(before: IndexedAgents, after: IndexedAgents): GateHit[] {
  const hits: GateHit[] = [];
  for (const [id, definition] of after.definitions) {
    const old = before.definitions.get(id);
    const change = changeOf(old, definition);
    if (change !== undefined) {
      hits.push({ class: 'models', id, change, summary: definitionSummary(definition, old) });
    } else if (old !== undefined && effectiveText(old) !== effectiveText(definition)) {
      const name = `${text(definition.name ?? definition.file)} for ${AGENT_NAMES[definition.agent]}`;
      hits.push({
        class: 'models',
        id,
        change: 'changed',
        summary: `${name} (runs on ${effectiveText(definition)}, was ${effectiveText(old)})`,
      });
    }
  }
  const settingHit = (id: string, setting: ModelSetting, what: string, was: string): GateHit => ({
    class: 'models',
    id,
    change: before.settings.has(id) ? 'changed' : 'added',
    summary: `${text(setting.key)} ${what} for ${AGENT_NAMES[setting.agent]} (${was})`,
    kind: 'model-setting',
  });
  for (const [id, setting] of after.settings) {
    const old = before.settings.get(id);
    if (changeOf(old, setting) === undefined) continue;
    const was = old === undefined ? 'was not set' : `was ${text(old.value)}`;
    hits.push(settingHit(id, setting, `set to ${text(setting.value)}`, was));
  }
  for (const [id, old] of before.settings) {
    if (!after.settings.has(id)) {
      hits.push(settingHit(id, old, 'removed', `was ${text(old.value)}`));
    }
  }
  return hits;
}

/** The model a definition runs on, as one line: its value, or where it is chosen. */
function effectiveText(definition: AgentDefinition): string {
  const { value, overridden } = definition.effective;
  const model =
    value === undefined
      ? 'a model set outside the repository'
      : text(typeof value === 'string' ? value : value.join(', '));
  return overridden === undefined ? model : `${model}, its own ignored`;
}

/** A model value as one line, a list joined with `, `, or `not set`. */
function modelText(model: AgentDefinition['model']): string {
  if (model === undefined) return 'not set';
  return text(typeof model.value === 'string' ? model.value : model.value.join(', '));
}

/**
 * `reviewer for Claude Code (model sonnet)` for a new definition; for a changed one, what changed,
 * as in `reviewer for Claude Code (model haiku → opus, effort not set → high)`. The gate label
 * says whether it is new or changed.
 */
function definitionSummary(definition: AgentDefinition, old: AgentDefinition | undefined): string {
  const name = `${text(definition.name ?? definition.file)} for ${AGENT_NAMES[definition.agent]}`;
  if (old === undefined) {
    const status =
      definition.status === 'loads'
        ? ''
        : `, ${definition.status === 'unknown' ? 'may not load' : definition.status}`;
    // A file the agent may read differently may set a model agentcheckup cannot see.
    const model =
      definition.model !== undefined
        ? `model ${modelText(definition.model)}`
        : definition.status === 'unknown'
          ? 'model not known'
          : 'no model';
    return `${name} (${model}${status})`;
  }
  const changes: string[] = [];
  const change = (what: string, before: string, after: string): void => {
    if (before !== after) changes.push(`${what} ${before} → ${after}`);
  };
  change('model', modelText(old.model), modelText(definition.model));
  if (
    definition.model !== undefined &&
    modelText(old.model) === modelText(definition.model) &&
    (old.model?.form === 'not-documented') !== (definition.model.form === 'not-documented')
  ) {
    const documented = definition.model.form === 'not-documented' ? 'not documented' : 'documented';
    changes.push(`model ${modelText(definition.model)} now ${documented}`);
  }
  change(
    'effort',
    text(old.effort?.value ?? 'not set'),
    text(definition.effort?.value ?? 'not set'),
  );
  if (old.status !== definition.status) changes.push(`${old.status} → ${definition.status}`);
  change('tools', old.tools, definition.tools);
  change(
    'permissionMode',
    text(old.permissionMode ?? 'not set'),
    text(definition.permissionMode ?? 'not set'),
  );
  // The digest differs in what no field above shows, such as the text of a file read as unknown.
  return `${name} (${changes.length === 0 ? 'details changed' : changes.join(', ')})`;
}

// MCP ------------------------------------------------------------------------------------------

const PINNED: ReadonlySet<string> = new Set(['exact', 'digest', 'local']);
const REMOTE_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'sse', 'ws']);

/**
 * True when the server's code is not pinned. A remote server without a package runs no local
 * code, so it has no pin; a local server without a package spec cannot be shown to be pinned.
 * The `mcp-unpinned` gate class uses it, and so do the corpus statistics (scripts/corpus).
 */
export function isUnpinned(server: McpServerItem): boolean {
  if (server.package !== undefined) return !PINNED.has(server.package.pin);
  return server.url === undefined && !REMOTE_TRANSPORTS.has(server.transport);
}

const PIN_LABELS: Readonly<Record<NonNullable<McpServerItem['package']>['pin'], string>> = {
  exact: 'pinned',
  digest: 'pinned by digest',
  local: 'local',
  range: 'version range, not pinned',
  tag: 'moving tag, not pinned',
  none: 'not pinned',
  unknown: 'pin unknown',
};

function serverSummary(server: McpServerItem, change: GateHit['change']): string {
  const details: string[] = [server.transport];
  if (server.command !== undefined) details.push(commandLine(server));
  if (server.url !== undefined) {
    details.push(
      text(server.url.origin) + (server.url.tls || server.url.loopback ? '' : ', no TLS'),
    );
  }
  if (server.package !== undefined) details.push(PIN_LABELS[server.package.pin]);
  else if (isUnpinned(server)) details.push(PIN_LABELS.unknown);
  if (server.scope === 'subagent') details.push(SCOPE_NOTES.subagent);
  return `${change === 'added' ? 'New' : 'Changed'} MCP server ${text(server.name)} (${details.join(', ')})`;
}

function unpinnedSummary(server: McpServerItem, change: GateHit['change']): string {
  const spec = server.package;
  const what = text(
    spec?.name ?? (server.command === undefined ? 'its command' : program(server.command)),
  );
  const version =
    spec?.version === undefined || spec.version === '' ? '' : ` ${text(spec.version, 40)}`;
  const pin = spec?.pin;
  const detail =
    pin === 'none'
      ? `${what}, no version`
      : pin === 'range'
        ? `${what}${version}, a version range`
        : pin === 'tag'
          ? `${what}${version}, a moving tag`
          : `cannot tell which version of ${what} runs`;
  const launcher = spec !== undefined && spec.launcher !== 'unknown' ? `${spec.launcher} ` : '';
  return `${change === 'added' ? 'New' : 'Changed'} MCP server ${text(server.name)} is not pinned (${launcher}${detail})`;
}

const SECRET_FLAG = /token|key|secret|passw|auth|credential|bearer|header|cookie/i;

/**
 * `command` plus its arguments up to the package name, with `name=value` arguments and the value
 * after a credential-like flag masked. Arguments after the package are server configuration and
 * are shown as "…".
 */
function commandLine(server: McpServerItem): string {
  const args = server.args ?? [];
  const name = server.package?.name;
  let end = Math.min(args.length, 4);
  if (name !== undefined) {
    const at = args.findIndex((arg) => arg.includes(name));
    if (at >= 0) end = at + 1;
  }
  const shown: string[] = [program(server.command ?? '', false)];
  for (let i = 0; i < end; i++) {
    const arg = args[i] ?? '';
    const previous = i > 0 ? (args[i - 1] ?? '') : '';
    shown.push(maskArg(arg, previous.startsWith('-') && SECRET_FLAG.test(previous)));
  }
  if (end < args.length) shown.push('…');
  return text(shown.join(' '), 80);
}

function maskArg(arg: string, afterSecretFlag: boolean): string {
  if (afterSecretFlag) return '…';
  const equals = arg.indexOf('=');
  return equals < 0 ? arg : `${arg.slice(0, equals + 1)}…`;
}

/** The program a command runs, without leading `NAME=value` assignments or arguments. */
function program(command: string, markRest = true): string {
  const words = command.trim().split(/\s+/);
  let index = 0;
  while (index < words.length - 1 && isAssignment(words[index] ?? '')) index++;
  const word = words[index] ?? '';
  const name = isAssignment(word) ? '…' : clip(word, 60);
  return markRest && index < words.length - 1 ? `${name} …` : name;
}

function isAssignment(word: string): boolean {
  const equals = word.indexOf('=');
  return equals > 0 && !word.startsWith('-');
}

/** Prefixes of inventory `incomplete` entries for files that do not parse. */
const INVALID_PREFIXES = ['invalid-json:', 'invalid-toml:'] as const;

/** An `incomplete` entry split into its path and the format it is not valid in, if any. */
function incompletePath(entry: string): { readonly path: string; readonly invalid?: string } {
  for (const prefix of INVALID_PREFIXES) {
    if (entry.startsWith(prefix)) {
      return {
        path: entry.slice(prefix.length),
        invalid: prefix === 'invalid-json:' ? 'JSON' : 'TOML',
      };
    }
  }
  return { path: entry };
}

/**
 * An inventory `incomplete` entry for a file that declares MCP servers: the kinds whose servers
 * src/platforms/mcp.ts reads (`.codex/config.toml` among them), any `mcp.json`, and a Claude Code
 * subagent or Copilot custom agent, whose frontmatter can declare servers.
 */
function isMcpConfig(entry: string): boolean {
  const { path } = incompletePath(entry);
  if (path === 'mcp.json' || path.endsWith('/mcp.json')) return true;
  const kind = classify(path)?.kind;
  return (
    kind !== undefined &&
    (MCP_KINDS.has(kind) || kind === 'claude-agent' || kind === 'copilot-agent')
  );
}

/**
 * Files whose frontmatter can declare hooks: skills, commands, subagents and Copilot custom
 * agents. One in `incomplete` is past a parser limit or was skipped by the walk, or declares
 * hooks agentcheckup cannot read, and the agent may still read it.
 */
const FRONTMATTER_HOOK_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'skill',
  'claude-command',
  'claude-agent',
  'copilot-agent',
]);

/**
 * Hook files whose agent is documented to run none of their hooks when the file does not parse
 * as agentcheckup parses it (rules/json/invalid-syntax.ts cites each): Claude Code skips a
 * settings file with a Settings Error, Codex skips a `hooks.json` with a warning, and Gemini CLI
 * does not start.
 */
const INERT_WHEN_INVALID: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'claude-settings',
  'codex-hooks',
  'gemini-settings',
]);

/**
 * An inventory `incomplete` entry for a file whose hooks the inventory cannot list: a hook file
 * it could not analyze, unless its agent is known to ignore such a file ({@link
 * INERT_WHEN_INVALID}). That covers Copilot's and Devin Local's hook and settings files, whose
 * readers' parsers are not documented (VS Code reads its own settings as JSONC), and a
 * `.codex/config.toml`, which declares hooks next to MCP servers, and a Claude Code plugin's
 * manifest and `hooks/hooks.json`. Also Cascade's `.devin/hooks.json`, the files in Cline's hook
 * and plugin folders, which have no documented format, and a skill, command or subagent whose
 * frontmatter could not be read.
 */
function isHookConfig(entry: string): boolean {
  const { path, invalid } = incompletePath(entry);
  const kind = classify(path)?.kind;
  if (
    kind === 'codex-config' ||
    kind === 'devin-hooks' ||
    kind === 'claude-plugin-hooks' ||
    kind === 'claude-plugin-manifest'
  ) {
    return true;
  }
  if (kind !== undefined && FRONTMATTER_HOOK_KINDS.has(kind)) return true;
  if (kind !== undefined && hookSourceOf({ kind, path }) !== undefined) {
    return invalid === undefined || !INERT_WHEN_INVALID.has(kind);
  }
  const role = clinePlace(path)?.role;
  return role === 'hook' || role === 'plugin';
}

function incompleteSummary(entry: string, what: 'MCP' | 'hooks'): string {
  const { path, invalid } = incompletePath(entry);
  const items = what === 'MCP' ? 'servers' : 'hooks';
  const reason = invalid === undefined ? 'is not analyzed' : `is not valid ${invalid}`;
  return `New ${what} config ${text(path)} ${reason}, so its ${items} cannot be checked`;
}

// Permissions ------------------------------------------------------------------------------------

const lastSegment = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

/**
 * The settings that trip the gate whenever they are set or changed, whatever their value
 * (settingSummary): a permission mode, `permissions.defaultMode` in settings or a subagent's
 * `permissionMode`, and the `agent` every Claude Code session starts as.
 */
function settingKind(permission: PermissionItem): GateHit['kind'] {
  if (permission.key === 'agent') return 'agent';
  const key = lastSegment(permission.key);
  return key === 'defaultMode' || key === 'permissionMode' ? 'mode' : undefined;
}

/** What setting `agent` does, for its summary (SOURCES.claudeSubagents). */
const AGENT_EFFECT =
  ': every session starts as this subagent, with its prompt, tools, model, hooks and MCP servers';

/** Kinds of auto-approval, by the last segment of the permission key. */
function autoApproval(permission: PermissionItem): string | undefined {
  switch (lastSegment(permission.key)) {
    case 'enableAllProjectMcpServers':
      return permission.value === 'true'
        ? 'every project MCP server starts without asking'
        : undefined;
    case 'enabledMcpjsonServers':
      return 'the server starts without asking';
    case 'trust':
      return permission.value === 'true' ? 'tool calls skip confirmation' : undefined;
    default:
      return undefined;
  }
}

/**
 * True when the entry lets an agent do something without asking: every `permissions.allow` and
 * `permissions.additionalDirectories` entry, every tool in a skill's `allowed-tools`, every
 * `enabledMcpjsonServers` entry, and `enableAllProjectMcpServers` or Gemini CLI's `trust` when
 * true. A narrow entry such as `Bash(curl:*)` widens too: a reviewer must see every new command
 * the agent may run unasked, not only the broadest. `deny` and `ask` entries narrow what the
 * agent may do, however broad they are. Modes and `agent` are handled on their own
 * (settingSummary). Keys not listed here widen, so a new kind of entry fails closed: Codex's
 * `approval_policy`, `sandbox_mode`, `network_access`, `writable_roots` and tool approval modes,
 * which the inventory lists only for values that let Codex act without asking, widen this way.
 */
function widens(permission: PermissionItem): boolean {
  switch (lastSegment(permission.key)) {
    case 'deny':
    case 'ask':
      return false;
    case 'enableAllProjectMcpServers':
    case 'trust':
      return autoApproval(permission) !== undefined;
    default:
      return true;
  }
}

/**
 * A changed entry (same key and value, another digest) that lets the agent do no more than it
 * did: it already widened, already took effect if it does now, and was already broad if it is
 * now.
 */
function alreadyAsWide(old: PermissionItem, permission: PermissionItem): boolean {
  return (
    widens(old) && (old.effective || !permission.effective) && (old.broad || !permission.broad)
  );
}

/** Keys whose values are tool rules that {@link coveredBy} can compare. */
const TOOL_RULE_KEYS: ReadonlySet<string> = new Set(['permissions.allow', 'allowed-tools']);

/**
 * True when an added `permissions.allow` or `allowed-tools` entry lets the agent do nothing that
 * an entry the same change removes from the same key of the same file did not, as
 * {@link coveredBy} proves: `Bash` replaced by `Bash(git status *)`. The removed entry must have
 * taken effect if the added one does, and must not hold a masked credential, which could hide
 * what it allowed. Anything else trips the gate.
 */
function replacesWider(
  permission: PermissionItem,
  before: IndexedInventory,
  after: IndexedInventory,
): boolean {
  if (!TOOL_RULE_KEYS.has(permission.key)) return false;
  const file = stripPath(permission.file, after.base);
  for (const [id, old] of before.permissions) {
    if (
      !after.permissions.has(id) &&
      old.key === permission.key &&
      stripPath(old.file, before.base) === file &&
      (old.effective || !permission.effective) &&
      !old.value.includes(REDACTED) &&
      coveredBy(permission.value, old.value)
    ) {
      return true;
    }
  }
  return false;
}

const ADDITIONAL_DIRECTORIES = 'additionalDirectories';

/**
 * ` (broad: …)` for an entry that grants everything of its kind: any shell command, any file
 * write or edit, or the file system root or home directory as an extra directory.
 */
function broadNote(permission: PermissionItem): string {
  if (!permission.broad) return '';
  const grant = broadGrant(permission.value);
  if (grant !== undefined) return ` (broad: ${grant.capability})`;
  const key = lastSegment(permission.key);
  if (key === ADDITIONAL_DIRECTORIES || key === 'writable_roots') {
    return ' (broad: the file system root or home directory)';
  }
  return CODEX_BROAD_NOTES.get(permission.key) ?? ' (broad)';
}

/** What a broad Codex setting lets Codex do (SOURCES.codexConfigReference). */
const CODEX_BROAD_NOTES: ReadonlyMap<string, string> = new Map([
  ['approval_policy', ' (broad: never asks before running a command)'],
  ['sandbox_mode', ' (broad: commands run without a sandbox)'],
]);

function permissionSummary(
  permission: PermissionItem,
  change: GateHit['change'],
  old: PermissionItem | undefined,
): string {
  const key = text(permission.key);
  const value = text(permission.value);
  const effect = autoApproval(permission);
  const broad = broadNote(permission);
  let summary: string;
  if (change === 'changed') {
    // Same key and value: it either takes effect now, or it became broad (alreadyAsWide).
    const nowEffective = old !== undefined && !old.effective && permission.effective;
    summary = nowEffective
      ? `${key} ${value}${broad} now takes effect`
      : `${key} ${value} widened${broad}`;
  } else if (effect === undefined) summary = `${key} adds ${value}${broad}`;
  else if (lastSegment(permission.key) === 'enabledMcpjsonServers') {
    summary = `${key} adds ${value}: ${effect}`;
  } else summary = `${key} set to ${value}: ${effect}`;
  return permission.effective ? summary : `${summary} (ignored where set)`;
}

function settingSummary(
  permission: PermissionItem,
  change: GateHit['change'],
  previous: readonly string[],
): string {
  const key = text(permission.key);
  const value = text(permission.value);
  const notes: string[] = [];
  if (change === 'added') {
    const others = [...new Set(previous)].filter((mode) => mode !== permission.value);
    notes.push(
      others.length === 0
        ? 'was not set'
        : `was ${others
            .sort(compareStrings)
            .map((mode) => text(mode))
            .join(', ')}`,
    );
  }
  if (!permission.effective) notes.push('ignored where set');
  const head = change === 'added' ? `${key} set to ${value}` : `${key} ${value} changed`;
  return notes.length === 0 ? head : `${head} (${notes.join('; ')})`;
}

// Hooks and env ----------------------------------------------------------------------------------

/** When an item from frontmatter applies, for its summary. */
const SCOPE_NOTES: Readonly<Record<NonNullable<HookItem['scope']>, string>> = {
  subagent: 'while the subagent runs',
  skill: 'once the skill or command is invoked',
};

function hookSummary(hook: HookItem, change: GateHit['change'], base: string): string {
  const target =
    hook.script !== undefined
      ? text(stripPath(hook.script, base))
      : hook.command !== undefined
        ? text(program(hook.command))
        : text(hook.type ?? 'no command');
  const trigger =
    hook.matcher === undefined || hook.matcher === '' ? '' : ` ${text(hook.matcher, 40)}`;
  const notes: string[] = [];
  if (hook.scope !== undefined) notes.push(SCOPE_NOTES[hook.scope]);
  if (!hook.known) notes.push('unknown event, never runs');
  if (hook.failsOpen) notes.push('fails open');
  if (hook.remoteScript) notes.push('downloads and runs a remote script');
  // Claude Code runs a subagent's Stop hook when the subagent finishes, as SubagentStop.
  const event =
    hook.scope === 'subagent' && hook.event === 'Stop' ? 'Stop (SubagentStop)' : text(hook.event);
  const summary = `${change === 'added' ? 'New' : 'Changed'} hook ${event}${trigger} → ${target}`;
  return notes.length === 0 ? summary : `${summary} (${notes.join(', ')})`;
}

function envSummary(item: EnvItem, change: GateHit['change']): string {
  const head = `${change === 'added' ? 'Env override' : 'Changed env override'} ${text(item.key)}`;
  switch (item.class) {
    case 'endpoint':
      return `${head} → ${item.shown === undefined ? 'another endpoint' : text(item.shown)}`;
    case 'credential':
      return `${head} sets a credential (value not shown)`;
    case 'tls':
      return `${head}${item.shown === undefined ? '' : ` → ${text(item.shown)}`} changes TLS certificate checks`;
    case 'code-exec':
      return `${head} can run code`;
    case 'other':
      return head;
  }
}

// ---------------------------------------------------------------------------------------------
// Load plans
// ---------------------------------------------------------------------------------------------

function indexPlans(plans: readonly BaselinePlan[], base: string): Map<string, BaselinePlan> {
  const map = new Map<string, BaselinePlan>();
  for (const plan of plans) {
    const key = `${plan.agent}\u0000${stripPath(plan.cwd, base)}`;
    if (!map.has(key)) map.set(key, plan);
  }
  return map;
}

function diffPlans(
  beforePlans: readonly BaselinePlan[],
  beforeBase: string,
  afterPlans: readonly BaselinePlan[],
  afterBase: string,
): PlanDelta[] {
  const before = indexPlans(beforePlans, beforeBase);
  const deltas: PlanDelta[] = [];
  for (const [key, after] of indexPlans(afterPlans, afterBase)) {
    const old = before.get(key);
    if (old === undefined) continue;
    deltas.push({
      agent: after.agent,
      cwd: stripPath(after.cwd, afterBase),
      entries: diffById(old.entries, beforeBase, after.entries, afterBase, entryFields),
      skipped: diffById(old.skipped, beforeBase, after.skipped, afterBase, skippedFields),
      startupTokens: { before: old.totals.startup.tokens, after: after.totals.startup.tokens },
      calls: diffCalls(old.entries, beforeBase, after.entries, afterBase),
      limits: diffLimits(old.limits, beforeBase, after.limits, afterBase),
    });
  }
  return deltas.sort((a, b) => compareStrings(a.agent, b.agent) || compareStrings(a.cwd, b.cwd));
}

function diffById<T extends { readonly id: string; readonly path: string }>(
  beforeList: readonly T[],
  beforeBase: string,
  afterList: readonly T[],
  afterBase: string,
  fieldsOf: (old: T, item: T) => string[],
): ItemDiff {
  const index = (list: readonly T[], base: string): Map<string, T> => {
    const map = new Map<string, T>();
    for (const item of list) {
      const id = rootId(item.id, item.path, base);
      if (!map.has(id)) map.set(id, item);
    }
    return map;
  };
  const before = index(beforeList, beforeBase);
  const after = index(afterList, afterBase);
  const out: MutableItemDiff = { added: [], removed: [], changed: [] };
  for (const [id, item] of after) {
    const old = before.get(id);
    if (old === undefined) {
      out.added.push(id);
      continue;
    }
    const fields = fieldsOf(old, item);
    if (fields.length > 0) out.changed.push({ id, fields });
  }
  for (const id of before.keys()) if (!after.has(id)) out.removed.push(id);
  return sortedDiff(out);
}

/**
 * Subagents whose own context differs, by id. A CLAUDE.md edit changes every Claude Code
 * subagent's call, which is why this is a list of its own and not a changed field of each entry.
 */
function diffCalls(
  beforeList: readonly BaselineLoadEntry[],
  beforeBase: string,
  afterList: readonly BaselineLoadEntry[],
  afterBase: string,
): CallDelta[] {
  // Every subagent entry, measured or not, so that one still listed is not taken as removed.
  const index = (list: readonly BaselineLoadEntry[], base: string) => {
    const map = new Map<string, BaselineLoadEntry>();
    for (const entry of list) {
      if (entry.ownContext === undefined && !entry.id.startsWith('subagent:')) continue;
      const id = rootId(entry.id, entry.path, base);
      if (!map.has(id)) map.set(id, entry);
    }
    return map;
  };
  const before = index(beforeList, beforeBase);
  const after = index(afterList, afterBase);
  const calls: CallDelta[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const now = after.get(id);
    const was = old?.ownContext?.size.tokens ?? null;
    const is = now?.ownContext?.size.tokens ?? null;
    if (was === is) continue;
    const name = now?.name ?? old?.name;
    calls.push({
      id,
      ...(name === undefined ? {} : { name }),
      before: was,
      after: is,
      ...(is === null && now !== undefined ? { unmeasured: true as const } : {}),
    });
  }
  return calls.sort((a, b) => compareStrings(a.id, b.id));
}

/** Position-only changes are not listed: they show in the plans themselves. */
function entryFields(old: BaselineLoadEntry, entry: BaselineLoadEntry): string[] {
  const fields: string[] = [];
  if (old.certainty !== entry.certainty) fields.push('certainty');
  if (old.size?.chars !== entry.size?.chars) fields.push('size.chars');
  if (old.trigger !== entry.trigger) fields.push('trigger');
  if (!sameValue(old.truncated, entry.truncated)) fields.push('truncated');
  return fields;
}

function skippedFields(old: BaselineSkippedLoad, skip: BaselineSkippedLoad): string[] {
  const fields: string[] = [];
  if (old.certainty !== skip.certainty) fields.push('certainty');
  if (old.code !== skip.code) fields.push('code');
  if (old.ruleId !== skip.ruleId) fields.push('ruleId');
  return fields;
}

function diffLimits(
  beforeList: readonly BaselineLimitUsage[],
  beforeBase: string,
  afterList: readonly BaselineLimitUsage[],
  afterBase: string,
): PlanDelta['limits'] {
  // Matched by key and subject; the label is display text only.
  const rows = new Map<
    string,
    { key: string; subject: string; before?: BaselineLimitUsage; after?: BaselineLimitUsage }
  >();
  const add = (
    list: readonly BaselineLimitUsage[],
    base: string,
    side: 'before' | 'after',
  ): void => {
    for (const usage of list) {
      const subject = stripPath(usage.subject, base);
      const key = `${usage.key}\u0000${subject}`;
      const row = rows.get(key) ?? { key: usage.key, subject };
      row[side] ??= usage;
      rows.set(key, row);
    }
  };
  add(beforeList, beforeBase, 'before');
  add(afterList, afterBase, 'after');
  return [...rows.values()]
    .map((row) => {
      const label = row.after?.label ?? row.before?.label;
      return {
        key: row.key,
        subject: row.subject,
        ...(label === undefined ? {} : { label }),
        before: row.before?.used ?? null,
        after: row.after?.used ?? null,
        limit: row.after !== undefined ? row.after.limit : (row.before?.limit ?? null),
      };
    })
    .sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject));
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** One line of at most `max` code points: whitespace runs collapsed, the rest cut with "…". */
function text(value: string, max = 80): string {
  return clip(value.trim().replace(/\s+/g, ' '), max);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  // Code points, so a cut never splits a surrogate pair. Reads at most max + 1 of them.
  const chars: string[] = [];
  for (const char of value) {
    chars.push(char);
    if (chars.length > max) return `${chars.slice(0, max - 1).join('')}…`;
  }
  return value;
}
