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
import type {
  BaselineFinding,
  BaselineLimitUsage,
  BaselineLoadEntry,
  BaselinePlan,
  BaselineReport,
  BaselineSkippedLoad,
} from './baseline-input.js';
import type { BaselineDiff, GateClass, GateHit, ItemDiff, PlanDelta } from './baseline-types.js';
import { compareStrings } from './compare.js';
import type { ScanResult } from './engine.js';
import type { ArtifactKind, Finding, RuleMeta } from './types.js';

// ---------------------------------------------------------------------------------------------
// Gate classes
// ---------------------------------------------------------------------------------------------

const GATE_TABLE: Readonly<Record<GateClass, true>> = {
  mcp: true,
  'mcp-unpinned': true,
  permissions: true,
  hooks: true,
  env: true,
  unicode: true,
};

/** Every gate class, in documentation order. `--gate security` selects all of them. */
export const GATE_CLASSES: readonly GateClass[] = Object.keys(GATE_TABLE) as GateClass[];

export type GateParseResult =
  | { readonly ok: true; readonly classes: readonly GateClass[] }
  | { readonly ok: false; readonly message: string };

function isGateClass(name: string): name is GateClass {
  return Object.hasOwn(GATE_TABLE, name);
}

/**
 * Parses a `--gate` value: a comma-separated list of gate classes, `security` for all of them,
 * or `none` alone. The classes come back sorted, without duplicates.
 */
export function parseGateClasses(text: string): GateParseResult {
  const expected = `Use a comma-separated list of ${GATE_CLASSES.join(', ')}, or "security" for all of them, or "none".`;
  const classes = new Set<GateClass>();
  let none = false;
  for (const raw of text.split(',')) {
    const name = raw.trim();
    if (name === 'none') none = true;
    else if (name === 'security') for (const gate of GATE_CLASSES) classes.add(gate);
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

/** The parts of the current scan a comparison reads. */
export type CurrentScan = Pick<
  ScanResult,
  'ruleset' | 'rules' | 'findings' | 'pathBase' | 'inventory' | 'context'
>;

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

  const classes = [...new Set(options.gate ?? [])].sort(compareStrings);
  const selected: ReadonlySet<GateClass> = new Set(classes);
  const hits = gateHits(before, after, findings, currentBase).filter((hit) =>
    selected.has(hit.class),
  );

  const against = {
    version: baseline.tool.version,
    ruleset: baseline.ruleset,
    sameRuleset: baseline.ruleset === current.ruleset,
  };
  const fresh = findings.filter((finding) => finding.baseline === 'new').length;
  return {
    diff: {
      against,
      findings: { new: fresh, unchanged: findings.length - fresh, resolved },
      inventory: diffInventory(before, after),
      context: diffPlans(
        baseline.context?.plans ?? [],
        baselineBase,
        current.context?.plans ?? [],
        currentBase,
      ),
      gate: { classes, hits },
    },
    findings,
    newRules: newRuleIds(current.rules, against),
  };
}

/**
 * Ids of rules whose `since` rule set is later than the baseline's, so the baseline could not
 * have run them. Empty when both reports use the same rule set, or when either version is not a
 * calendar version such as `2026.10`.
 */
export function newRuleIds(
  rules: readonly Pick<RuleMeta, 'id' | 'since'>[],
  against: BaselineDiff['against'],
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
 * The root-relative form of an id `<prefix>:<path>`, `<prefix>:<path>#...`, where `path` is the
 * item's own path field. Strips `base` only when the id embeds the prefixed path, so ids that a
 * rebase left untouched stay as they are.
 */
function rootId(id: string, path: string, base: string): string {
  const root = stripPath(path, base);
  if (root === path) return id;
  const start = id.indexOf(':') + 1;
  if (start === 0 || !id.startsWith(path, start)) return id;
  const end = start + path.length;
  if (end !== id.length && id.charAt(end) !== '#') return id;
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
  const hit = (gate: GateClass, id: string, change: GateHit['change'], summary: string): void => {
    const key = `${gate}\u0000${id}\u0000${change}`;
    if (!hits.has(key)) hits.set(key, { class: gate, id, change, summary });
  };

  for (const [id, server] of after.mcpServers) {
    const change = changeOf(before.mcpServers.get(id), server);
    if (change === undefined) continue;
    hit('mcp', id, change, serverSummary(server, change));
    if (isUnpinned(server)) hit('mcp-unpinned', id, change, unpinnedSummary(server, change));
  }
  for (const entry of after.incomplete) {
    if (!before.incomplete.has(entry) && isMcpConfig(entry)) {
      hit('mcp', entry, 'added', incompleteSummary(entry));
    }
  }

  const previousModes = new Map<string, string[]>();
  for (const permission of before.permissions.values()) {
    if (!isDefaultMode(permission)) continue;
    const file = stripPath(permission.file, before.base);
    previousModes.set(file, [...(previousModes.get(file) ?? []), permission.value]);
  }
  for (const [id, permission] of after.permissions) {
    const old = before.permissions.get(id);
    const change = changeOf(old, permission);
    if (change === undefined) continue;
    if (isDefaultMode(permission)) {
      const previous = previousModes.get(stripPath(permission.file, after.base)) ?? [];
      hit('permissions', id, change, modeSummary(permission, change, previous));
    } else if (widens(permission) && !(old !== undefined && alreadyAsWide(old, permission))) {
      hit('permissions', id, change, permissionSummary(permission, change));
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

  return [...hits.values()].sort(
    (a, b) =>
      compareStrings(a.class, b.class) ||
      compareStrings(a.id, b.id) ||
      compareStrings(a.change, b.change),
  );
}

// MCP ------------------------------------------------------------------------------------------

const PINNED: ReadonlySet<string> = new Set(['exact', 'digest', 'local']);
const REMOTE_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'sse', 'ws']);

/**
 * True when the server's code is not pinned. A remote server without a package runs no local
 * code, so it has no pin; a local server without a package spec cannot be shown to be pinned.
 */
function isUnpinned(server: McpServerItem): boolean {
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

const MCP_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'mcp-json',
  'cursor-mcp',
  'gemini-settings',
  'claude-plugin-manifest',
]);
const INVALID_JSON = 'invalid-json:';

/**
 * An inventory `incomplete` entry for a file that declares MCP servers: the kinds whose
 * `mcpServers` src/rules/mcp/servers.ts reads, any `mcp.json` (such as `.vscode/mcp.json`), and
 * `.codex/config.toml`, where Codex declares servers in TOML that is not parsed.
 */
function isMcpConfig(entry: string): boolean {
  const path = entry.startsWith(INVALID_JSON) ? entry.slice(INVALID_JSON.length) : entry;
  if (path === 'mcp.json' || path.endsWith('/mcp.json')) return true;
  if (path === '.codex/config.toml' || path.endsWith('/.codex/config.toml')) return true;
  const kind = classify(path)?.kind;
  return kind !== undefined && MCP_KINDS.has(kind);
}

function incompleteSummary(entry: string): string {
  if (entry.startsWith(INVALID_JSON)) {
    return `New MCP config ${text(entry.slice(INVALID_JSON.length))} is not valid JSON, so its servers cannot be checked`;
  }
  return `New MCP config ${text(entry)} is not analyzed, so its servers cannot be checked`;
}

// Permissions ------------------------------------------------------------------------------------

const lastSegment = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

function isDefaultMode(permission: PermissionItem): boolean {
  return lastSegment(permission.key) === 'defaultMode';
}

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

/** `deny` and `ask` entries narrow what the agent may do, however broad they are. */
function widens(permission: PermissionItem): boolean {
  const segment = lastSegment(permission.key);
  if (segment === 'deny' || segment === 'ask') return false;
  return permission.broad || autoApproval(permission) !== undefined;
}

/** A changed entry that was already as wide, and already took effect if it does now. */
function alreadyAsWide(old: PermissionItem, permission: PermissionItem): boolean {
  return widens(old) && (old.effective || !permission.effective);
}

function permissionSummary(permission: PermissionItem, change: GateHit['change']): string {
  const key = text(permission.key);
  const value = text(permission.value);
  const effect = autoApproval(permission);
  let summary: string;
  if (change === 'changed') summary = `${key} ${value} widened`;
  else if (effect === undefined) summary = `${key} adds ${value}`;
  else if (lastSegment(permission.key) === 'enabledMcpjsonServers') {
    summary = `${key} adds ${value}: ${effect}`;
  } else summary = `${key} set to ${value}: ${effect}`;
  return permission.effective ? summary : `${summary} (ignored where set)`;
}

function modeSummary(
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
  if (!hook.known) notes.push('unknown event, never runs');
  if (hook.failsOpen) notes.push('fails open');
  if (hook.remoteScript) notes.push('downloads and runs a remote script');
  const summary = `${change === 'added' ? 'New' : 'Changed'} hook ${text(hook.event)}${trigger} → ${target}`;
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
      return `${head} changes TLS certificate checks`;
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
    .map((row) => ({
      key: row.key,
      subject: row.subject,
      before: row.before?.used ?? null,
      after: row.after?.used ?? null,
      limit: row.after !== undefined ? row.after.limit : (row.before?.limit ?? null),
    }))
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
