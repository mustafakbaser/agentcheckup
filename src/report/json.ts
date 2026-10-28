/**
 * JSON report: the ScanResult, described by schemas/report.schema.json (`schemaVersion`).
 *
 * The result is rebuilt field by field before serializing, so key order is fixed by this file
 * rather than by how the engine happened to construct its objects, and stray runtime properties
 * cannot leak into a published format. Adding a required field to ScanResult fails type
 * checking here, which is the reminder to update the schema too.
 *
 * Lists whose order carries no meaning (load-plan entries, inventory items, baseline ids) are
 * sorted here with `compareStrings`, so the same scan gives byte-identical JSON whatever order
 * the loaders, the inventory builder or the baseline engine produced them in. Lists whose order
 * is data (an import chain, command arguments) keep it.
 */
import type {
  BaselineDiff,
  GateClass,
  GateHit,
  ItemDiff,
  PlanDelta,
} from '../core/baseline-types.js';
import { compareStrings } from '../core/compare.js';
import type { ScanResult } from '../core/engine.js';
import type { CategoryTally, ScoreReport } from '../core/score.js';
import {
  CATEGORIES,
  PLATFORM_IDS,
  type Category,
  type FileChange,
  type Finding,
  type Fix,
  type FixInput,
  type PlatformId,
  type Position,
  type Range,
  type RuleMeta,
  type RuleSource,
} from '../core/types.js';
import type { AgentDefinition, AgentsReport, ModelSetting, ModelValue } from '../agents/types.js';
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PackageSpec,
  PermissionItem,
} from '../inventory/types.js';
import type {
  Assumption,
  ContextAgent,
  ContextReport,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  LoadRole,
  LoadTrigger,
  MatrixCell,
  OutOfScope,
  OwnContext,
  Size,
  SkippedLoad,
} from '../platforms/load/types.js';
import { ALL_CONTEXT_AGENTS, TRIGGER_RANK } from '../platforms/load/types.js';
import { toJsonPolicy } from './policy-json.js';
import { forJsonOutput } from './sanitize.js';

function position(value: Position): Position {
  return { line: value.line, column: value.column };
}

function range(value: Range): Range {
  return { start: position(value.start), end: position(value.end) };
}

function fileChange(value: FileChange): FileChange {
  switch (value.kind) {
    case 'edit':
      return {
        kind: 'edit',
        path: value.path,
        edits: value.edits.map((edit) => ({
          offset: edit.offset,
          length: edit.length,
          text: edit.text,
        })),
      };
    case 'create':
      return { kind: 'create', path: value.path, text: value.text };
    case 'rename':
      return { kind: 'rename', from: value.from, to: value.to };
    case 'encoding':
      return { kind: 'encoding', path: value.path, to: value.to, bom: value.bom };
  }
}

/** A canonical copy of a fix. Changes, notes and alternatives keep their order: it is data. */
export function toJsonFix(value: Fix): Fix {
  return {
    id: value.id,
    class: value.class,
    title: value.title,
    changes: value.changes.map(fileChange),
    ...(value.notes === undefined ? {} : { notes: [...value.notes] }),
    ...(value.warning === undefined ? {} : { warning: value.warning }),
    ...(value.alternatives === undefined
      ? {}
      : { alternatives: value.alternatives.map(toJsonFix) }),
    ...(value.input === undefined ? {} : { input: toJsonInput(value.input) }),
  };
}

/** A canonical copy of a fix's input. */
function toJsonInput(value: FixInput): FixInput {
  const { target } = value;
  return {
    field: value.field,
    question: value.question,
    label: value.label,
    ...(value.initial === undefined ? {} : { initial: value.initial }),
    target:
      target.kind === 'frontmatter'
        ? {
            kind: 'frontmatter',
            path: target.path,
            key: target.key,
            ...(target.prefix === undefined ? {} : { prefix: target.prefix }),
            ...(target.suffix === undefined ? {} : { suffix: target.suffix }),
          }
        : { kind: 'directive', path: target.path, line: target.line, ruleId: target.ruleId },
  };
}

function finding(value: Finding): Finding {
  return {
    ruleId: value.ruleId,
    severity: value.severity,
    category: value.category,
    message: value.message,
    path: value.path,
    range: range(value.range),
    related: value.related.map((related) => ({
      path: related.path,
      message: related.message,
      ...(related.range ? { range: range(related.range) } : {}),
    })),
    platforms: [...value.platforms],
    fingerprint: value.fingerprint,
    ...(value.fix === undefined ? {} : { fix: toJsonFix(value.fix) }),
    ...(value.guidance === undefined ? {} : { guidance: value.guidance }),
    ...(value.suppressed
      ? { suppressed: { kind: value.suppressed.kind, reason: value.suppressed.reason } }
      : {}),
    ...(value.baseline === undefined ? {} : { baseline: value.baseline }),
  };
}

function tally(value: CategoryTally): CategoryTally {
  return { errors: value.errors, warnings: value.warnings, infos: value.infos };
}

function score(value: ScoreReport): ScoreReport {
  return {
    formula: value.formula,
    score: value.score,
    grade: value.grade,
    capped: value.capped,
    categories: Object.fromEntries(
      CATEGORIES.map((category) => [category, tally(value.categories[category])]),
    ) as Record<Category, CategoryTally>,
    artifacts: value.artifacts.map((artifact) => ({ path: artifact.path, score: artifact.score })),
  };
}

function source(value: RuleSource): RuleSource {
  return { title: value.title, url: value.url, checked: value.checked, status: value.status };
}

function rule(value: RuleMeta): RuleMeta {
  const [first, ...rest] = value.sources;
  return {
    id: value.id,
    title: value.title,
    rationale: value.rationale,
    category: value.category,
    severity: value.severity,
    appliesTo: [...value.appliesTo],
    platforms: [...value.platforms],
    sources: [source(first), ...rest.map(source)],
    since: value.since,
    ...(value.fix === undefined
      ? {}
      : { fix: { classes: [...value.fix.classes], summary: value.fix.summary } }),
  };
}

// ---------------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------------

type SortKey<T> = (item: T) => string | number;

/** A comparator from sort keys, compared in turn: numbers numerically, strings by code unit. */
function compareBy<T>(...keys: readonly SortKey<T>[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const left = key(a);
      const right = key(b);
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : compareStrings(String(left), String(right));
      if (order !== 0) return order;
    }
    return 0;
  };
}

function sortedBy<T>(items: readonly T[], ...keys: readonly SortKey<T>[]): T[] {
  return [...items].sort(compareBy(...keys));
}

function sortedStrings(items: readonly string[]): string[] {
  return [...items].sort(compareStrings);
}

/** Rank of each member of a fixed list; unknown values (malformed input) sort last. */
function ranks<T extends string>(order: Readonly<Record<T, number>>): (value: T) => number {
  // Read as a partial table: a report built at runtime may hold values the types rule out.
  const table: Readonly<Partial<Record<string, number>>> = order;
  return (value) => table[value] ?? Number.MAX_SAFE_INTEGER;
}

const platformRank = ranks(
  Object.fromEntries(PLATFORM_IDS.map((id, index) => [id, index])) as Record<PlatformId, number>,
);

const agentRank = ranks(
  Object.fromEntries(ALL_CONTEXT_AGENTS.map((agent, index) => [agent, index])) as Record<
    ContextAgent,
    number
  >,
);

/** Assembly order of triggers: what is in the prompt first, then what can join later. */
const triggerRank = ranks<LoadTrigger>(TRIGGER_RANK);

const roleRank = ranks<LoadRole>({
  instructions: 0,
  import: 1,
  rule: 2,
  skill: 3,
  subagent: 4,
  command: 5,
  'mcp-server': 6,
  hook: 7,
});

const scopeRank = ranks<HiddenScope['scope']>({
  managed: 0,
  user: 1,
  global: 2,
  team: 3,
  account: 4,
  plugin: 5,
});

/** GateClass in the order of its documentation. */
export const GATE_CLASS_ORDER: Readonly<Record<GateClass, number>> = {
  mcp: 0,
  'mcp-unpinned': 1,
  permissions: 2,
  hooks: 3,
  env: 4,
  unicode: 5,
  models: 6,
};
const gateRank = ranks(GATE_CLASS_ORDER);

function sortedPlatforms<T extends PlatformId>(platforms: readonly T[]): T[] {
  return sortedBy(platforms, platformRank, (id) => id);
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

function size(value: Size): Size {
  return { bytes: value.bytes, chars: value.chars, tokens: value.tokens };
}

function loadEntry(value: LoadEntry): LoadEntry {
  return {
    id: value.id,
    role: value.role,
    trigger: value.trigger,
    ...(value.position === undefined ? {} : { position: value.position }),
    path: value.path,
    realPath: value.realPath,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.via === undefined ? {} : { via: [...value.via] }),
    ...(value.patterns === undefined ? {} : { patterns: sortedStrings(value.patterns) }),
    ...(value.size === undefined ? {} : { size: size(value.size) }),
    ...(value.deferred === undefined ? {} : { deferred: size(value.deferred) }),
    ...(value.truncated === undefined
      ? {}
      : { truncated: { atByte: value.truncated.atByte, line: value.truncated.line } }),
    ...(value.inventoryId === undefined ? {} : { inventoryId: value.inventoryId }),
    ...(value.ownContext === undefined ? {} : { ownContext: ownContext(value.ownContext) }),
    certainty: value.certainty,
    evidence: sortedStrings(value.evidence),
  };
}

/** Parts in the order they were measured: the prompt, the instructions, then each skill. */
function ownContext(value: OwnContext): OwnContext {
  const { memory } = value;
  return {
    size: size(value.size),
    parts: value.parts.map((part) => ({
      kind: part.kind,
      ...(part.path === undefined ? {} : { path: part.path }),
      ...(part.name === undefined ? {} : { name: part.name }),
      size: size(part.size),
      certainty: part.certainty,
      evidence: sortedStrings(part.evidence),
    })),
    ...(value.notLoaded === undefined
      ? {}
      : { notLoaded: value.notLoaded.map((item) => ({ name: item.name, reason: item.reason })) }),
    ...(value.overLimit === undefined ? {} : { overLimit: value.overLimit }),
    ...(value.unmeasured === undefined ? {} : { unmeasured: sortedStrings(value.unmeasured) }),
    ...(memory === undefined
      ? {}
      : {
          memory: {
            scope: memory.scope,
            ...(memory.path === undefined ? {} : { path: memory.path }),
            ...(memory.exists === undefined ? {} : { exists: memory.exists }),
          },
        }),
    notVisible: [...value.notVisible],
  };
}

function skippedLoad(value: SkippedLoad): SkippedLoad {
  return {
    id: value.id,
    role: value.role,
    path: value.path,
    ...(value.name === undefined ? {} : { name: value.name }),
    code: value.code,
    ...(value.ruleId === undefined ? {} : { ruleId: value.ruleId }),
    ...(value.size === undefined ? {} : { size: size(value.size) }),
    ...(value.fix === undefined ? {} : { fix: value.fix }),
    ...(value.ownContext === undefined ? {} : { ownContext: ownContext(value.ownContext) }),
    certainty: value.certainty,
    evidence: sortedStrings(value.evidence),
  };
}

function assumption(value: Assumption): Assumption {
  return {
    key: value.key,
    value: value.value,
    origin: value.origin,
    evidence: sortedStrings(value.evidence),
  };
}

function hiddenScope(value: HiddenScope): HiddenScope {
  return {
    scope: value.scope,
    locations: sortedStrings(value.locations),
    roles: sortedBy(value.roles, roleRank, (role) => role),
  };
}

function limitUsage(value: LimitUsage): LimitUsage {
  return {
    key: value.key,
    unit: value.unit,
    limit: value.limit,
    used: value.used,
    subject: value.subject,
    ...(value.label === undefined ? {} : { label: value.label }),
    effect: value.effect,
    evidence: sortedStrings(value.evidence),
  };
}

function loadPlan(value: LoadPlan): LoadPlan {
  return {
    agent: value.agent,
    cwd: value.cwd,
    entries: sortedBy(
      value.entries,
      (entry) => entry.position ?? Number.MAX_SAFE_INTEGER,
      (entry) => triggerRank(entry.trigger),
      (entry) => entry.path,
      (entry) => entry.id,
    ).map(loadEntry),
    skipped: sortedBy(
      value.skipped,
      (entry) => entry.path,
      (entry) => entry.id,
    ).map(skippedLoad),
    outOfScope: sortedBy(
      value.outOfScope,
      (entry) => entry.path,
      (entry) => entry.because,
    ).map((entry): OutOfScope => ({ path: entry.path, because: entry.because })),
    assumptions: sortedBy(value.assumptions, (entry) => entry.key).map(assumption),
    hidden: sortedBy(
      value.hidden.map(hiddenScope),
      (entry) => scopeRank(entry.scope),
      (entry) => entry.locations.join('\n'),
    ),
    limits: sortedBy(
      value.limits,
      (entry) => entry.key,
      (entry) => entry.subject,
    ).map(limitUsage),
    totals: { startup: size(value.totals.startup), onDemand: size(value.totals.onDemand) },
    incomplete: sortedStrings(value.incomplete),
    ...(value.ignored === undefined ? {} : { ignored: value.ignored }),
  };
}

/**
 * A canonical copy of a context report: fixed key order and the sort orders of the design
 * (plans by agent then working directory, entries by position, trigger, path and id, and so
 * on). `agents` is put in report order and every matrix row's cells are permuted with it,
 * so `cells[i]` stays the state for `agents[i]`.
 */
export function toJsonContext(context: ContextReport): ContextReport {
  const columns = context.agents
    .map((agent, index) => ({ agent, index }))
    .sort(
      compareBy(
        (column) => agentRank(column.agent),
        (column) => column.index,
      ),
    );
  const sources = Object.keys(context.sources).sort(compareStrings);
  return {
    agents: columns.map((column): ContextAgent => column.agent),
    sources: Object.fromEntries(
      sources.flatMap((key) => {
        const value = context.sources[key];
        return value === undefined ? [] : [[key, source(value)]];
      }),
    ),
    plans: sortedBy(
      context.plans,
      (plan) => agentRank(plan.agent),
      (plan) => plan.cwd,
    ).map(loadPlan),
    ...(context.directories === undefined
      ? {}
      : {
          directories: {
            planned: sortedBy(context.directories.planned, (directory) => directory.cwd).map(
              (directory) => ({
                cwd: directory.cwd,
                agents: sortedBy(directory.agents, (row) => agentRank(row.agent)).map((row) => ({
                  agent: row.agent,
                  startup: size(row.startup),
                  unverified: row.unverified,
                })),
              }),
            ),
            notPlanned: context.directories.notPlanned,
          },
        }),
    ...(context.matrix === undefined
      ? {}
      : {
          matrix: {
            rows: sortedBy(
              context.matrix.rows,
              (row) => row.path,
              (row) => row.kind,
            ).map((row) => ({
              path: row.path,
              kind: row.kind,
              // A missing cell (malformed input) reads as "could not be analyzed".
              cells: columns.map((column): MatrixCell => row.cells[column.index] ?? 'unknown'),
            })),
          },
        }),
  };
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

function packageSpec(value: PackageSpec): PackageSpec {
  return {
    launcher: value.launcher,
    ...(value.ecosystem === undefined ? {} : { ecosystem: value.ecosystem }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.version === undefined ? {} : { version: value.version }),
    pin: value.pin,
  };
}

function mcpServer(value: McpServerItem): McpServerItem {
  return {
    id: value.id,
    file: value.file,
    line: value.line,
    platforms: sortedPlatforms(value.platforms),
    digest: value.digest,
    name: value.name,
    transport: value.transport,
    ...(value.declaredType === undefined ? {} : { declaredType: value.declaredType }),
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.args === undefined ? {} : { args: [...value.args] }),
    ...(value.package === undefined ? {} : { package: packageSpec(value.package) }),
    ...(value.url === undefined
      ? {}
      : {
          url: { origin: value.url.origin, tls: value.url.tls, loopback: value.url.loopback },
        }),
    envKeys: sortedStrings(value.envKeys),
    headerKeys: sortedStrings(value.headerKeys),
    status: Object.fromEntries(
      PLATFORM_IDS.flatMap((platform) => {
        const status = value.status[platform];
        return status === undefined ? [] : [[platform, status]];
      }),
    ),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
  };
}

function hook(value: HookItem): HookItem {
  return {
    id: value.id,
    file: value.file,
    line: value.line,
    platforms: sortedPlatforms(value.platforms),
    digest: value.digest,
    event: value.event,
    known: value.known,
    ...(value.matcher === undefined ? {} : { matcher: value.matcher }),
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.script === undefined ? {} : { script: value.script }),
    failsOpen: value.failsOpen,
    remoteScript: value.remoteScript,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
  };
}

function permission(value: PermissionItem): PermissionItem {
  return {
    id: value.id,
    file: value.file,
    line: value.line,
    platforms: sortedPlatforms(value.platforms),
    digest: value.digest,
    key: value.key,
    value: value.value,
    broad: value.broad,
    effective: value.effective,
  };
}

function envItem(value: EnvItem): EnvItem {
  return {
    id: value.id,
    file: value.file,
    line: value.line,
    platforms: sortedPlatforms(value.platforms),
    digest: value.digest,
    key: value.key,
    class: value.class,
    ...(value.shown === undefined ? {} : { shown: value.shown }),
  };
}

const byId = (item: { readonly id: string }): string => item.id;

/** A canonical copy of an inventory: fixed key order, every list sorted by id. */
export function toJsonInventory(inventory: Inventory): Inventory {
  return {
    mcpServers: sortedBy(inventory.mcpServers, byId).map(mcpServer),
    hooks: sortedBy(inventory.hooks, byId).map(hook),
    permissions: sortedBy(inventory.permissions, byId).map(permission),
    env: sortedBy(inventory.env, byId).map(envItem),
    incomplete: sortedStrings(inventory.incomplete),
  };
}

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

function modelValue(value: ModelValue): ModelValue {
  return {
    value: typeof value.value === 'string' ? value.value : [...value.value],
    form: value.form,
    line: value.line,
  };
}

function agentDefinition(value: AgentDefinition): AgentDefinition {
  const { effective } = value;
  return {
    id: value.id,
    file: value.file,
    line: value.line,
    agent: value.agent,
    ...(value.name === undefined ? {} : { name: value.name }),
    status: value.status,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.shadowedBy === undefined ? {} : { shadowedBy: value.shadowedBy }),
    ...(value.model === undefined ? {} : { model: modelValue(value.model) }),
    effective: {
      ...(effective.value === undefined
        ? {}
        : { value: typeof effective.value === 'string' ? effective.value : [...effective.value] }),
      source: effective.source,
      ...(effective.file === undefined ? {} : { file: effective.file }),
      ...(effective.overridden === undefined
        ? {}
        : { overridden: { key: effective.overridden.key, file: effective.overridden.file } }),
    },
    ...(value.effort === undefined
      ? {}
      : { effort: { value: value.effort.value, line: value.effort.line } }),
    tools: value.tools,
    ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode }),
    certainty: value.certainty,
    evidence: [...value.evidence],
    digest: value.digest,
  };
}

function modelSetting(value: ModelSetting): ModelSetting {
  return {
    id: value.id,
    agent: value.agent,
    file: value.file,
    line: value.line,
    key: value.key,
    value: value.value,
    applies: value.applies,
    ...(value.forced === undefined ? {} : { forced: value.forced }),
    digest: value.digest,
  };
}

/** A canonical copy of the agent definitions and model settings, sorted by id. */
export function toJsonAgents(agents: AgentsReport): AgentsReport {
  return {
    definitions: sortedBy(agents.definitions, byId).map(agentDefinition),
    settings: sortedBy(agents.settings, byId).map(modelSetting),
  };
}

// ---------------------------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------------------------

function itemDiff(value: ItemDiff): ItemDiff {
  return {
    added: sortedStrings(value.added),
    removed: sortedStrings(value.removed),
    changed: sortedBy(value.changed, byId).map((entry) => ({
      id: entry.id,
      fields: sortedStrings(entry.fields),
    })),
  };
}

function planDelta(value: PlanDelta): PlanDelta {
  return {
    agent: value.agent,
    cwd: value.cwd,
    entries: itemDiff(value.entries),
    skipped: itemDiff(value.skipped),
    startupTokens: { before: value.startupTokens.before, after: value.startupTokens.after },
    calls: sortedBy(value.calls, (call) => call.id).map((call) => ({
      id: call.id,
      ...(call.name === undefined ? {} : { name: call.name }),
      before: call.before,
      after: call.after,
      ...(call.unmeasured === true ? { unmeasured: true } : {}),
    })),
    limits: sortedBy(
      value.limits,
      (entry) => entry.key,
      (entry) => entry.subject,
    ).map((entry) => ({
      key: entry.key,
      subject: entry.subject,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      before: entry.before,
      after: entry.after,
      limit: entry.limit,
    })),
  };
}

function gateHit(value: GateHit): GateHit {
  return {
    class: value.class,
    id: value.id,
    change: value.change,
    summary: value.summary,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
  };
}

/** A canonical copy of a baseline comparison: fixed key order, sorted lists. */
export function toJsonBaseline(diff: BaselineDiff): BaselineDiff {
  return {
    against: {
      version: diff.against.version,
      ruleset: diff.against.ruleset,
      sameRuleset: diff.against.sameRuleset,
      newRules: sortedStrings(diff.against.newRules),
    },
    findings: {
      new: diff.findings.new,
      unchanged: diff.findings.unchanged,
      resolved: sortedBy(
        diff.findings.resolved,
        (entry) => entry.path,
        (entry) => entry.ruleId,
        (entry) => entry.fingerprint,
      ).map((entry) => ({
        ruleId: entry.ruleId,
        path: entry.path,
        fingerprint: entry.fingerprint,
      })),
    },
    inventory: itemDiff(diff.inventory),
    ...(diff.agents === undefined ? {} : { agents: itemDiff(diff.agents) }),
    context: sortedBy(
      diff.context,
      (delta) => agentRank(delta.agent),
      (delta) => delta.cwd,
    ).map(planDelta),
    gate: {
      classes: sortedBy(diff.gate.classes, gateRank, (entry) => entry),
      hits: sortedBy(
        diff.gate.hits,
        (hit) => gateRank(hit.class),
        (hit) => hit.id,
        (hit) => hit.change,
        (hit) => hit.summary,
      ).map(gateHit),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

/** A canonical copy of `result`: fixed key order, only the documented properties. */
export function toJsonReport(result: ScanResult): ScanResult {
  return {
    schemaVersion: result.schemaVersion,
    tool: { name: result.tool.name, version: result.tool.version },
    ruleset: result.ruleset,
    fingerprintVersion: result.fingerprintVersion,
    targets: [...result.targets],
    artifacts: result.artifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      readers: [...artifact.readers],
    })),
    findings: result.findings.map(finding),
    score: score(result.score),
    summary: {
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      infos: result.summary.infos,
      suppressed: result.summary.suppressed,
    },
    rules: result.rules.map(rule),
    skipped: result.skipped.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    })),
    unresolvedSymlinks: result.unresolvedSymlinks.map((link) => ({
      path: link.path,
      target: link.target,
      problem: link.problem,
    })),
    ruleFailures: result.ruleFailures.map((failure) => ({
      ruleId: failure.ruleId,
      message: failure.message,
    })),
    configWarnings: [...result.configWarnings],
    ...(result.pathBase === undefined ? {} : { pathBase: result.pathBase }),
    inventory: toJsonInventory(result.inventory),
    ...(result.agents === undefined ? {} : { agents: toJsonAgents(result.agents) }),
    ...(result.context === undefined ? {} : { context: toJsonContext(result.context) }),
    ...(result.baseline === undefined ? {} : { baseline: toJsonBaseline(result.baseline) }),
    ...(result.policy === undefined ? {} : { policy: toJsonPolicy(result.policy) }),
  };
}

/**
 * Pretty JSON (2-space indent, trailing newline). Lossless: string values are exactly the
 * scanned data, with display-dangerous characters written as `\uXXXX` escapes (see
 * {@link forJsonOutput}).
 */
export function formatJson(result: ScanResult): string {
  return `${forJsonOutput(JSON.stringify(toJsonReport(result), null, 2))}\n`;
}
