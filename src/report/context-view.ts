/**
 * What the context formatters show, computed once for the text and the Markdown output so both
 * say the same thing. Strings here are raw: paths, names, commands and assumption values come
 * from the scanned repository, so each formatter passes every string through its own sanitizer
 * when it writes it. Numbers stay numbers; formatters print them with formatInteger.
 *
 * The view is built from the canonical copy of the report (see toJsonContext), so its order
 * does not depend on the order the loaders produced things in.
 */
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import type { HookItem, Inventory, McpServerItem, PackageSpec } from '../inventory/types.js';
import type {
  Assumption,
  ContextAgent,
  ContextReport,
  HiddenScope,
  LoadEntry,
  LoadPlan,
  MatrixCell,
  Size,
  SkipCode,
} from '../platforms/load/types.js';
import { toJsonContext, toJsonInventory } from './json.js';

export const AGENT_NAMES: Readonly<Record<ContextAgent, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** The agent as the subject of a sentence: "when Claude opens src/**". */
const AGENT_SUBJECTS: Readonly<Record<ContextAgent, string>> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** Why an agent skips a file, as a clause. */
export const SKIP_LABELS: Readonly<Record<SkipCode, string>> = {
  'shadowed-by-claude-md': 'a CLAUDE.md on the path is read instead',
  'shadowed-by-override': 'AGENTS.override.md in this directory is read instead',
  'over-byte-budget': 'past the byte limit',
  'empty-override': 'an empty AGENTS.override.md in this directory wins',
  'blank-file': 'the file is blank',
  'not-mdc': 'only .mdc files are read here',
  'no-frontmatter': 'no frontmatter',
  'invalid-frontmatter': 'frontmatter is not valid YAML',
  bom: 'a byte order mark comes before the frontmatter',
  'no-description': 'no description',
  'invalid-subagent': 'invalid subagent definition',
  'import-unresolved': 'the import does not resolve',
  'import-too-deep': 'the import is nested too deep',
  'import-outside-root': 'the import points outside the repository',
  'url-without-type': '"url" without "type"',
  'unknown-event': 'unknown hook event',
  'invalid-json': 'not valid JSON',
  'not-utf8': 'not valid UTF-8',
  'case-mismatch': 'the file name has the wrong case',
  'materialized-symlink': 'a symlink checked out as a text file',
  'not-read': 'not read by this agent',
};

export const MATRIX_CELL_LABELS: Readonly<Record<MatrixCell, string>> = {
  startup: 'startup',
  'on-path': 'on-path',
  'start-dir': 'start-dir',
  listed: 'listed',
  'model-selected': 'model-selected',
  manual: 'manual',
  partial: 'partial',
  skipped: 'skipped',
  unknown: 'unknown',
  'not-read': '—',
};

const ORIGIN_LABELS: Readonly<Record<Assumption['origin'], string>> = {
  default: 'default',
  'rule-option': 'rule option',
  repository: 'from the repository',
  flag: 'from a flag',
};

const INCOMPLETE_LABELS: Readonly<Record<string, string>> = {
  'markdown-budget': "not analyzed: the scan's Markdown budget ran out",
  unparsed: 'not analyzed: agentcheckup does not parse this format',
  unread: 'not analyzed: the scan did not read the file',
  'invalid-json': 'not analyzed: not valid JSON',
};

/**
 * One piece of a detail line. `warn` marks what a reviewer should look at; `arrow` asks the
 * formatter to put its arrow symbol in front ("→ scripts/guard.sh"); `attach` joins the part to
 * the previous one with a single space instead of a column separator.
 */
export interface Part {
  readonly text: string;
  readonly warn?: boolean;
  readonly arrow?: boolean;
  readonly attach?: boolean;
}

export interface StartupRow {
  readonly position?: number;
  readonly kind: 'file' | 'import' | 'skills';
  /** For `skills`: the number of skills in the listing. Otherwise the path. */
  readonly path: string;
  readonly skills?: number;
  /** Set when the agent reaches the file through a symlink alias. */
  readonly realPath?: string;
  /** Import depth, 1 for a file imported by an instruction file. */
  readonly depth: number;
  readonly via: readonly string[];
  readonly size?: Size;
  readonly truncated?: { readonly atByte: number; readonly line: number };
  readonly unverified: boolean;
}

export interface ServiceRow {
  readonly kind: 'mcp' | 'hook';
  /** `MCP, asks first`, `Hooks`. */
  readonly group: string;
  readonly parts: readonly Part[];
  readonly unverified: boolean;
}

export interface OnDemandRow {
  readonly path: string;
  readonly size?: Size;
  /** True when `size` is a skill body rather than the whole entry. */
  readonly body: boolean;
  readonly when: string;
  readonly unverified: boolean;
}

export interface SkipRow {
  readonly path: string;
  readonly name?: string;
  readonly reason: string;
  readonly ruleId?: string;
  readonly unverified: boolean;
}

export interface IncompleteRow {
  readonly subject: string;
  readonly reason: string;
}

export interface PlanView {
  readonly agent: ContextAgent;
  readonly agentName: string;
  /** Root-relative working directory, `''` for the root. */
  readonly cwd: string;
  readonly assumptions: readonly string[];
  readonly hidden: readonly string[];
  readonly startup: readonly StartupRow[];
  readonly total: Size;
  readonly services: readonly ServiceRow[];
  readonly onDemand: readonly OnDemandRow[];
  readonly skipped: readonly SkipRow[];
  /** Files and items the agent does not read at all (`not-read`). */
  readonly notRead: readonly { readonly path: string; readonly name?: string }[];
  readonly incomplete: readonly IncompleteRow[];
  /** True when any row is unverified, so the "?" needs its footnote. */
  readonly unverified: boolean;
}

export interface MatrixView {
  readonly agents: readonly string[];
  readonly rows: readonly { readonly path: string; readonly cells: readonly MatrixCell[] }[];
}

function assumptionText(assumption: Assumption): string {
  const value =
    typeof assumption.value === 'number' && Number.isSafeInteger(assumption.value)
      ? formatInteger(assumption.value)
      : String(assumption.value);
  return `${assumption.key} = ${value} (${ORIGIN_LABELS[assumption.origin]})`;
}

function hiddenText(hidden: HiddenScope): string {
  return `${hidden.locations.join(', ')} (${hidden.scope})`;
}

function incompleteRow(entry: string): IncompleteRow {
  const colon = entry.indexOf(':');
  const label = colon < 0 ? undefined : INCOMPLETE_LABELS[entry.slice(0, colon)];
  if (label === undefined) return { subject: entry, reason: 'not analyzed' };
  return { subject: entry.slice(colon + 1), reason: label };
}

/** `pinned`, `not pinned`, or nothing when the launcher is not known. */
function pinPart(spec: PackageSpec | undefined): Part | undefined {
  if (spec === undefined) return undefined;
  switch (spec.pin) {
    case 'exact':
    case 'digest':
      return { text: '(pinned)', attach: true };
    case 'local':
      return { text: '(local)', attach: true };
    case 'range':
    case 'tag':
    case 'none':
      return { text: '(not pinned)', warn: true, attach: true };
    case 'unknown':
      return undefined;
  }
}

function mcpParts(entry: LoadEntry, item: McpServerItem | undefined): Part[] {
  if (item === undefined) return [{ text: entry.name ?? entry.path }];
  const parts: Part[] = [{ text: item.name }, { text: item.transport }];
  if (item.url !== undefined) {
    parts.push({ text: item.url.origin });
    if (!item.url.tls && !item.url.loopback) {
      parts.push({ text: '(no TLS)', warn: true, attach: true });
    }
  } else if (item.command !== undefined) {
    parts.push({ text: [item.command, ...(item.args ?? [])].join(' ') });
  }
  const pin = pinPart(item.package);
  if (pin !== undefined) parts.push(pin);
  return parts;
}

function hookParts(entry: LoadEntry, item: HookItem | undefined): Part[] {
  if (item === undefined) return [{ text: entry.name ?? entry.path }];
  const target = item.script ?? item.command ?? item.type ?? '?';
  const parts: Part[] = [
    { text: item.matcher === undefined ? item.event : `${item.event} ${item.matcher}` },
    { text: target, arrow: true, attach: true },
  ];
  if (item.failsOpen) parts.push({ text: '(fails open)', warn: true, attach: true });
  if (item.remoteScript) {
    parts.push({ text: '(runs a downloaded script)', warn: true, attach: true });
  }
  return parts;
}

function serviceGroup(entry: LoadEntry): string {
  const base = entry.role === 'mcp-server' ? 'MCP' : 'Hooks';
  switch (entry.trigger) {
    case 'startup':
      return base;
    case 'on-approval':
      return `${base}, asks first`;
    case 'on-path':
      return `${base}, on path`;
    case 'model-selected':
      return `${base}, when picked`;
    case 'manual':
      return `${base}, manual`;
    case 'unknown':
      return `${base}, when is not known`;
  }
}

/** Skill entries whose listing text is in the prompt from the start. */
function inListing(entry: LoadEntry): boolean {
  return (
    entry.role === 'skill' && (entry.trigger === 'startup' || entry.trigger === 'model-selected')
  );
}

function whenText(entry: LoadEntry, agent: ContextAgent): string {
  switch (entry.trigger) {
    case 'on-path': {
      const patterns = entry.patterns ?? [];
      return patterns.length === 0
        ? `when ${AGENT_SUBJECTS[agent]} opens a matching file`
        : `when ${AGENT_SUBJECTS[agent]} opens ${patterns.join(', ')}`;
    }
    case 'startup':
    case 'model-selected':
      return 'when the model picks it';
    case 'manual':
      return entry.role === 'command' && entry.name !== undefined
        ? `when you run /${entry.name}`
        : 'only when you ask for it';
    case 'on-approval':
      return 'after you approve it';
    case 'unknown':
      return 'when is not documented';
  }
}

function itemsById<T extends { readonly id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function planView(plan: LoadPlan, inventory: Inventory | undefined): PlanView {
  const servers = itemsById(inventory?.mcpServers ?? []);
  const hooks = itemsById(inventory?.hooks ?? []);
  const startup: StartupRow[] = [];
  const services: ServiceRow[] = [];
  const onDemand: OnDemandRow[] = [];
  const listing = plan.entries.filter((entry) => inListing(entry) && entry.size !== undefined);
  let listingShown = false;

  for (const entry of plan.entries) {
    const unverified = entry.certainty === 'unverified';
    if (entry.role === 'mcp-server' || entry.role === 'hook') {
      const id = entry.inventoryId;
      services.push({
        kind: entry.role === 'mcp-server' ? 'mcp' : 'hook',
        group: serviceGroup(entry),
        parts:
          entry.role === 'mcp-server'
            ? mcpParts(entry, id === undefined ? undefined : servers.get(id))
            : hookParts(entry, id === undefined ? undefined : hooks.get(id)),
        unverified,
      });
      continue;
    }
    if (inListing(entry)) {
      if (!listingShown && listing.length > 0) {
        listingShown = true;
        const position = listing.find((skill) => skill.position !== undefined)?.position;
        startup.push({
          ...(position === undefined ? {} : { position }),
          kind: 'skills',
          path: '',
          skills: listing.length,
          depth: 0,
          via: [],
          size: sumSizes(listing.map((skill) => skill.size)),
          unverified: listing.some((skill) => skill.certainty === 'unverified'),
        });
      }
      onDemand.push({
        path: entry.path,
        ...(entry.deferred === undefined ? {} : { size: entry.deferred }),
        body: entry.deferred !== undefined,
        when: whenText(entry, plan.agent),
        unverified,
      });
      continue;
    }
    if (entry.trigger === 'startup') {
      const isImport = entry.role === 'import';
      startup.push({
        ...(entry.position === undefined ? {} : { position: entry.position }),
        kind: isImport ? 'import' : 'file',
        path: entry.path,
        ...(entry.realPath === entry.path ? {} : { realPath: entry.realPath }),
        depth: isImport ? Math.max(1, entry.via?.length ?? 1) : 0,
        via: entry.via ?? [],
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(entry.truncated === undefined ? {} : { truncated: entry.truncated }),
        unverified,
      });
      continue;
    }
    const size = entry.role === 'skill' ? (entry.deferred ?? entry.size) : entry.size;
    onDemand.push({
      path: entry.path,
      ...(size === undefined ? {} : { size }),
      body: entry.role === 'skill' && entry.deferred !== undefined,
      when: whenText(entry, plan.agent),
      unverified,
    });
  }

  const skipped: SkipRow[] = [];
  const notRead: { path: string; name?: string }[] = [];
  for (const entry of plan.skipped) {
    if (entry.code === 'not-read') {
      notRead.push({
        path: entry.path,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      });
      continue;
    }
    skipped.push({
      path: entry.path,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      reason: SKIP_LABELS[entry.code],
      ...(entry.ruleId === undefined ? {} : { ruleId: entry.ruleId }),
      unverified: entry.certainty === 'unverified',
    });
  }

  return {
    agent: plan.agent,
    agentName: AGENT_NAMES[plan.agent],
    cwd: plan.cwd,
    assumptions: plan.assumptions.map(assumptionText),
    hidden: plan.hidden.map(hiddenText),
    startup,
    total: plan.totals.startup,
    // MCP servers first, then hooks; each group keeps the plan's order.
    services: [
      ...services.filter((row) => row.kind === 'mcp'),
      ...services.filter((row) => row.kind === 'hook'),
    ],
    onDemand,
    skipped,
    notRead,
    incomplete: plan.incomplete.map(incompleteRow),
    unverified:
      startup.some((row) => row.unverified) ||
      services.some((row) => row.unverified) ||
      onDemand.some((row) => row.unverified) ||
      skipped.some((row) => row.unverified),
  };
}

function sumSizes(sizes: readonly (Size | undefined)[]): Size {
  let bytes = 0;
  let chars = 0;
  let tokens = 0;
  for (const size of sizes) {
    bytes += size?.bytes ?? 0;
    chars += size?.chars ?? 0;
    tokens += size?.tokens ?? 0;
  }
  return { bytes, chars, tokens };
}

/** One view per plan, in canonical order. Empty when the result has no context. */
export function planViews(result: ScanResult): PlanView[] {
  if (result.context === undefined) return [];
  const context = toJsonContext(result.context);
  const inventory = toJsonInventory(result.inventory);
  return context.plans.map((plan) => planView(plan, inventory));
}

/** The matrix in canonical order, or undefined when the report has none. */
export function matrixView(context: ContextReport | undefined): MatrixView | undefined {
  if (context?.matrix === undefined) return undefined;
  const canonical = toJsonContext(context);
  return {
    agents: canonical.agents.map((agent) => AGENT_NAMES[agent]),
    rows: (canonical.matrix?.rows ?? []).map((row) => ({ path: row.path, cells: row.cells })),
  };
}
