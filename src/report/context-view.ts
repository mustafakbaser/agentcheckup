/**
 * What the context formatters show, computed once for the text and the Markdown output so both
 * say the same thing. Strings here are raw: paths, names, commands and assumption values come
 * from the scanned repository, so each formatter passes every string through its own sanitizer
 * when it writes it. Numbers stay numbers; formatters print them with formatInteger.
 *
 * The view is built from the canonical copy of the report (see toJsonContext), so its order
 * does not depend on the order the loaders produced things in.
 */
import { compareStrings } from '../core/compare.js';
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import { stripPathBase } from '../core/rebase.js';
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

/** What each matrix state means, in the order a legend lists them. */
export const MATRIX_LEGEND: readonly { readonly cell: MatrixCell; readonly text: string }[] = [
  { cell: 'startup', text: 'loaded at session start' },
  { cell: 'on-path', text: 'loaded when the agent opens a file it covers' },
  { cell: 'start-dir', text: 'loaded when a session starts in its directory' },
  { cell: 'listed', text: 'in the skills listing; the body loads when used' },
  { cell: 'model-selected', text: 'loaded when the model picks it' },
  { cell: 'manual', text: 'loaded only when you ask for it' },
  { cell: 'partial', text: 'loaded, but cut by a limit' },
  { cell: 'skipped', text: 'not loaded; the plan says why' },
  { cell: 'unknown', text: 'not documented, or not analyzed' },
  { cell: 'not-read', text: 'not read by this agent' },
];

const ORIGIN_LABELS: Readonly<Record<Assumption['origin'], string>> = {
  default: 'default',
  'rule-option': 'rule option',
  repository: 'from the repository',
  flag: 'from a flag',
};

/**
 * How a known assumption reads in a sentence. `setting`: the value is an agent setting the
 * user can change, so a default is marked "(default)". Phrases are listed in the order they
 * are shown; unknown keys follow as `key = value (origin)`, in key order.
 */
interface AssumptionPhrase {
  readonly key: string;
  readonly phrase: (value: string | number | boolean) => string;
  readonly setting?: boolean;
}

const ASSUMPTION_PHRASES: readonly AssumptionPhrase[] = [
  {
    key: 'claude-code.instructions_mode',
    phrase: (value) => `instructions mode ${valueText(value)}`,
    setting: true,
  },
  { key: 'claude-code.min_version', phrase: (value) => `Claude Code ${valueText(value)} or later` },
  { key: 'claude-code.session', phrase: (value) => `${valueText(value)} session` },
  { key: 'claude-code.workspace_trusted', phrase: (value) => trusted(value, 'workspace') },
  {
    key: 'claude-code.memory_file_lines',
    phrase: (value) => `memory files advised under ${valueText(value)} lines`,
    setting: true,
  },
  { key: 'claude-code.context_window', phrase: (value) => contextWindowText(value) },
  {
    key: 'codex.project_doc_max_bytes',
    phrase: (value) => `AGENTS.md budget ${valueText(value)} bytes`,
    setting: true,
  },
  { key: 'codex.project_root_markers', phrase: (value) => listPhrase(value, 'root marker') },
  {
    key: 'codex.project_doc_fallback_filenames',
    phrase: (value) => listPhrase(value, 'fallback file name'),
  },
  {
    key: 'codex.trust_level',
    phrase: (value) =>
      value === 'trusted' ? 'trusted project' : `trust level ${valueText(value)}`,
  },
  { key: 'codex.context_window', phrase: (value) => contextWindowText(value) },
  {
    key: 'cursor.mode',
    phrase: (value) => (value === 'agent' ? 'Agent mode' : `${valueText(value)} mode`),
  },
  {
    key: 'cursor.thirdPartyConfigs',
    phrase: (value) =>
      `third-party configs ${value === true ? 'on' : value === false ? 'off' : valueText(value)}`,
  },
  { key: 'cursor.trustedWorkspace', phrase: (value) => trusted(value, 'workspace') },
];

const PHRASE_ORDER: ReadonlyMap<string, number> = new Map(
  ASSUMPTION_PHRASES.map((entry, index) => [entry.key, index]),
);

/**
 * Words for each hidden scope. Locations that are paths are summarized under these words, with
 * their home directories (`~/.claude`, `$CODEX_HOME`); system paths, which differ by operating
 * system, are left to the JSON and Markdown output. Named locations ("installed plugins") are
 * shown as they are.
 */
const SCOPE_NOUNS: Readonly<Record<HiddenScope['scope'], string>> = {
  managed: 'managed settings',
  user: 'user settings',
  global: 'global settings',
  team: 'team settings',
  account: 'account settings',
  plugin: 'plugins',
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
  /** For an import: the file that imports it. */
  readonly importedBy?: string;
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

/** One hidden scope, with every location of that scope in the plan. */
export interface HiddenView {
  readonly scope: HiddenScope['scope'];
  readonly locations: readonly string[];
  /** Short items for one line: named locations, and `user settings (~/.claude)` for paths. */
  readonly summary: readonly string[];
}

export interface PlanView {
  readonly agent: ContextAgent;
  readonly agentName: string;
  /** Working directory relative to the scanned directory, `''` for the scanned directory. */
  readonly cwd: string;
  /** Readable phrases, such as `Claude Code 2.1.277 or later`. */
  readonly assumptions: readonly string[];
  /** In scope order: managed, user, global, team, account, plugin. */
  readonly hidden: readonly HiddenView[];
  readonly startup: readonly StartupRow[];
  readonly total: Size;
  readonly services: readonly ServiceRow[];
  readonly onDemand: readonly OnDemandRow[];
  readonly skipped: readonly SkipRow[];
  /** Files and items the agent does not read at all (`not-read`). */
  readonly notRead: readonly { readonly path: string; readonly name?: string }[];
  readonly incomplete: readonly IncompleteRow[];
  /** Files left out because the configuration's `ignore` matches them (`plan.ignored`), or 0. */
  readonly ignored: number;
  /** True when any row is unverified, so the "?" needs its footnote. */
  readonly unverified: boolean;
}

/**
 * The note for {@link PlanView.ignored}, without the label, or undefined when nothing was left
 * out. Example: `22 files are not shown; Cursor may still load them`.
 */
export function ignoredNote(view: Pick<PlanView, 'ignored' | 'agentName'>): string | undefined {
  if (view.ignored <= 0) return undefined;
  const one = view.ignored === 1;
  return (
    `${formatInteger(view.ignored)} ${one ? 'file is' : 'files are'} not shown; ` +
    `${view.agentName} may still load ${one ? 'it' : 'them'}`
  );
}

export interface MatrixView {
  readonly agents: readonly string[];
  readonly rows: readonly { readonly path: string; readonly cells: readonly MatrixCell[] }[];
}

function valueText(value: string | number | boolean): string {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? formatInteger(value)
    : String(value);
}

function trusted(value: string | number | boolean, what: string): string {
  if (value === true) return `trusted ${what}`;
  if (value === false) return `untrusted ${what}`;
  return `${what} trust ${valueText(value)}`;
}

function contextWindowText(value: string | number | boolean): string {
  return typeof value === 'number'
    ? `context window ${valueText(value)} tokens`
    : `context window ${valueText(value)}`;
}

/**
 * A list written as a JSON array of strings, such as `[".git"]`: `root marker .git`,
 * `no fallback file names`. Anything else is shown as it is.
 */
function listPhrase(value: string | number | boolean, noun: string): string {
  if (typeof value === 'string' && value.startsWith('[')) {
    let items: unknown;
    try {
      items = JSON.parse(value);
    } catch {
      items = undefined;
    }
    if (Array.isArray(items) && items.every((item) => typeof item === 'string')) {
      if (items.length === 0) return `no ${noun}s`;
      // Not joined with commas: the phrase is one item of a comma-separated list.
      return `${noun}${items.length === 1 ? '' : 's'} ${items.join(' and ')}`;
    }
  }
  return `${noun}s ${valueText(value)}`;
}

/** Known keys as phrases, in a fixed order; unknown keys as `key = value (origin)`. */
function assumptionTexts(assumptions: readonly Assumption[]): string[] {
  const known = new Map(ASSUMPTION_PHRASES.map((entry) => [entry.key, entry]));
  const rank = (assumption: Assumption): number =>
    PHRASE_ORDER.get(assumption.key) ?? ASSUMPTION_PHRASES.length;
  // A stable sort keeps the canonical key order among unknown keys.
  return [...assumptions]
    .sort((a, b) => rank(a) - rank(b))
    .map((assumption) => {
      const entry = known.get(assumption.key);
      const origin = ORIGIN_LABELS[assumption.origin];
      if (entry === undefined) {
        return `${assumption.key} = ${valueText(assumption.value)} (${origin})`;
      }
      const marked = assumption.origin !== 'default' || entry.setting === true;
      return `${entry.phrase(assumption.value)}${marked ? ` (${origin})` : ''}`;
    });
}

/** `~/…`, `$VAR/…`, `/…` and `C:\…` locations are paths; anything else is a name. */
function isPathLocation(location: string): boolean {
  return /^(?:[~$/\\]|[a-z]:[/\\])/i.test(location);
}

/** `~/.claude/skills/` → `~/.claude`, `$CODEX_HOME/AGENTS.md` → `$CODEX_HOME`; else undefined. */
function homeRoot(location: string): string | undefined {
  const parts = location.split('/');
  const first = parts[0] ?? '';
  if (first === '~') return parts.length > 1 && parts[1] !== '' ? `~/${parts[1]}` : '~';
  if (first.startsWith('$')) return first;
  return undefined;
}

/** Scopes merged in their canonical order, each with its compact summary. */
function hiddenViews(hidden: readonly HiddenScope[]): HiddenView[] {
  const scopes = new Map<HiddenScope['scope'], string[]>();
  for (const entry of hidden) {
    const locations = scopes.get(entry.scope) ?? [];
    for (const location of entry.locations) {
      if (!locations.includes(location)) locations.push(location);
    }
    scopes.set(entry.scope, locations);
  }
  return [...scopes].map(([scope, locations]) => {
    const names = locations.filter((location) => !isPathLocation(location));
    const paths = locations.filter(isPathLocation);
    const roots: string[] = [];
    for (const path of paths) {
      const root = homeRoot(path);
      if (root !== undefined && !roots.includes(root)) roots.push(root);
    }
    roots.sort(compareStrings);
    // Read as a partial table: a report built at runtime may hold scopes the types rule out.
    const nouns: Readonly<Partial<Record<string, string>>> = SCOPE_NOUNS;
    const noun = nouns[scope] ?? scope;
    const summary = [...names];
    if (paths.length > 0) summary.push(roots.length > 0 ? `${noun} (${roots.join(', ')})` : noun);
    return { scope, locations, summary };
  });
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
  const parts: Part[] = [{ text: item.name }];
  // A URL or a command says enough; "unknown" next to it reads as a problem.
  if (item.transport !== 'unknown' || (item.url === undefined && item.command === undefined)) {
    parts.push({ text: item.transport === 'unknown' ? 'transport unknown' : item.transport });
  }
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
    const importer = entry.role === 'import' ? entry.via?.at(-1) : undefined;
    onDemand.push({
      path: entry.path,
      ...(size === undefined ? {} : { size }),
      body: entry.role === 'skill' && entry.deferred !== undefined,
      when: whenText(entry, plan.agent),
      ...(importer === undefined ? {} : { importedBy: importer }),
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
    assumptions: assumptionTexts(plan.assumptions),
    hidden: hiddenViews(plan.hidden),
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
    ignored: plan.ignored ?? 0,
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

/**
 * Plans and matrix of a result, with paths relative to the scanned directory again: in a
 * subdirectory scan every path would otherwise repeat `pathBase`, while globs and hook scripts
 * are written relative to the scanned directory anyway. Reports state `pathBase` once.
 */
export interface ContextView {
  /** The scanned directory as the report's paths were rebased onto it; `''` when they were not. */
  readonly pathBase: string;
  readonly plans: readonly PlanView[];
  readonly matrix?: MatrixView;
}

/** The plans in canonical order and the matrix, relative to the scanned directory. */
export function contextView(result: ScanResult): ContextView {
  const pathBase = result.pathBase === undefined || result.pathBase === '.' ? '' : result.pathBase;
  const stripped = stripPathBase(result);
  if (stripped.context === undefined) return { pathBase, plans: [] };
  const context = toJsonContext(stripped.context);
  const inventory = toJsonInventory(stripped.inventory);
  const matrix = matrixView(context);
  return {
    pathBase,
    plans: context.plans.map((plan) => planView(plan, inventory)),
    ...(matrix === undefined ? {} : { matrix }),
  };
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
