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
import {
  AGENT_NAMES,
  type Assumption,
  type ContextAgent,
  type ContextReport,
  type HiddenScope,
  type LoadEntry,
  type LoadPlan,
  type MatrixCell,
  type OwnContext,
  type OwnContextHidden,
  type OwnContextPart,
  type PreloadNotLoaded,
  type Size,
  type SkipCode,
  type SkipFix,
} from '../platforms/load/types.js';
import { joinNames } from '../rules/shared/format.js';
import { toJsonContext, toJsonInventory } from './json.js';

export { AGENT_NAMES };

/**
 * Short labels for a matrix too wide for {@link AGENT_NAMES}: `group` names the product, and
 * `surface`, when a product has several agents, names one of them under the group.
 */
export const AGENT_COLUMNS: Readonly<
  Record<ContextAgent, { readonly group: string; readonly surface?: string }>
> = {
  'claude-code': { group: 'Claude' },
  codex: { group: 'Codex' },
  cursor: { group: 'Cursor' },
  'copilot-cli': { group: 'Copilot', surface: 'CLI' },
  'copilot-vscode': { group: 'Copilot', surface: 'VSC' },
  'copilot-cloud': { group: 'Copilot', surface: 'Cloud' },
  gemini: { group: 'Gemini' },
  windsurf: { group: 'Devin' },
  cline: { group: 'Cline' },
};

/** The agent as the subject of a sentence: "when Claude opens src/**". */
const AGENT_SUBJECTS: Readonly<Record<ContextAgent, string>> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  'copilot-cli': 'Copilot',
  'copilot-vscode': 'Copilot',
  'copilot-cloud': 'Copilot',
  gemini: 'Gemini CLI',
  windsurf: 'Devin',
  cline: 'Cline',
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
  'wrong-location': 'not in a location this agent reads',
  'no-apply-to': 'no valid "applyTo"',
  'shadowed-by-preferred': 'a preferred file is read instead',
  disabled: 'turned off in the configuration',
  'never-active': 'its settings keep it from ever applying',
  'invalid-toml': 'not valid TOML',
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

/**
 * One-letter matrix cells, for a matrix too wide for {@link MATRIX_CELL_LABELS}. `not-read` keeps
 * its dash, which formatters may replace (ASCII output).
 */
export const MATRIX_CELL_LETTERS: Readonly<Record<MatrixCell, string>> = {
  startup: 'S',
  'on-path': 'P',
  'start-dir': 'D',
  listed: 'L',
  'model-selected': 'M',
  manual: 'U',
  partial: 'C',
  skipped: 'X',
  unknown: '?',
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
 * are shown; unknown keys follow as `key = value (origin)`, in key order. A phrase of
 * undefined adds nothing to the plan's heading, such as the Copilot surface the heading names;
 * JSON output keeps the assumption.
 */
interface AssumptionPhrase {
  readonly key: string;
  readonly phrase: (value: string | number | boolean) => string | undefined;
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
  { key: 'copilot.surface', phrase: (value) => surfaceText(value) },
  { key: 'copilot-cli.trusted_folder', phrase: (value) => trusted(value, 'folder') },
  {
    key: 'vscode.agent_harness',
    phrase: (value) => (value === 'local' ? 'Local agent harness' : `${valueText(value)} harness`),
  },
  {
    key: 'vscode.github.copilot.chat.codeGeneration.useInstructionFiles',
    phrase: (value) => `instruction files ${onOff(value)}`,
    setting: true,
  },
  {
    key: 'vscode.chat.useAgentsMdFile',
    phrase: (value) => `AGENTS.md ${onOff(value)}`,
    setting: true,
  },
  {
    key: 'vscode.chat.useNestedAgentsMdFiles',
    phrase: (value) => `nested AGENTS.md files ${onOff(value)}`,
    setting: true,
  },
  {
    key: 'vscode.chat.useClaudeMdFile',
    phrase: (value) => `CLAUDE.md ${onOff(value)}`,
    setting: true,
  },
  {
    key: 'vscode.chat.useClaudeHooks',
    phrase: (value) => `Claude Code hooks ${onOff(value)}`,
    setting: true,
  },
  { key: 'vscode.workspace_trusted', phrase: (value) => trusted(value, 'workspace') },
  {
    key: 'gemini.context.fileName',
    phrase: (value) => contextFilesText(value),
    setting: true,
  },
  {
    key: 'gemini.folder_trust',
    phrase: (value) => `folder trust ${onOff(value)}`,
    setting: true,
  },
  { key: 'gemini.access', phrase: (value) => `access through ${valueText(value)}` },
  {
    key: 'devin.agent',
    phrase: (value) =>
      value === 'devin-local' ? 'Devin Local, not Cascade' : `${valueText(value)} agent`,
  },
  {
    key: 'devin.restrictedMode',
    phrase: (value) => `Restricted Mode ${onOff(value)}`,
    setting: true,
  },
  ...(
    [
      ['agents_standard', 'AGENTS.md standard'],
      ['claude', 'Claude Code'],
      ['copilot', 'Copilot'],
      ['cursor', 'Cursor'],
      ['windsurf', 'Windsurf'],
    ] as const
  ).map(([source, name]): AssumptionPhrase => ({
    key: `devin.read_config_from.${source}`,
    phrase: (value) => importText(value, name),
    setting: true,
  })),
  {
    key: 'cline.surface',
    phrase: (value) => (value === 'vscode' ? 'VS Code extension' : `${valueText(value)} surface`),
  },
  {
    key: 'cline.ruleToggles',
    phrase: (value) =>
      value === 'all on' ? 'every rule toggle on' : `rule toggles ${valueText(value)}`,
    setting: true,
  },
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
  fallback: 'not followed: a project_doc_fallback_filenames file',
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
  /**
   * `skills` and `subagents`: the names and descriptions the model picks from, one row for each
   * listing; the files load only when the model picks one.
   */
  readonly kind: 'file' | 'import' | 'skills' | 'subagents';
  /** For a listing, `''`. Otherwise the path. */
  readonly path: string;
  /** For `skills`: the number of skills in the listing. */
  readonly skills?: number;
  /** For `subagents`: the number of subagents in the listing. */
  readonly subagents?: number;
  /**
   * For `subagents`: the ≈tokens past which the agent warns at startup about the listing, set
   * when the listing passes them (Claude Code's 15,000).
   */
  readonly warnsPast?: number;
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

/**
 * A subagent call: what its own context window starts with, as far as the repository shows.
 * `parts` are `prompt ≈375`-style labels with sizes; `notes` say what it names and does not get.
 */
export interface CallRow {
  readonly path: string;
  readonly name?: string;
  /** Absent when nothing of the call can be measured, as for a file agentcheckup cannot read. */
  readonly size?: Size;
  readonly parts: readonly { readonly label: string; readonly size: Size }[];
  readonly notes: readonly string[];
  readonly unverified: boolean;
}

export interface SkipRow {
  readonly path: string;
  readonly name?: string;
  readonly reason: string;
  readonly ruleId?: string;
  /** How the fix that removes the skip is applied (`SkippedLoad.fix`). */
  readonly fix?: SkipFix;
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
  /** Subagent calls, each in a context window of its own, in plan order. */
  readonly calls: readonly CallRow[];
  /** What a call also starts with that no file shows, as phrases, in a fixed order. */
  readonly callsHidden: readonly string[];
  readonly skipped: readonly SkipRow[];
  /** Files and items the agent does not read at all (`not-read`). */
  readonly notRead: readonly { readonly path: string; readonly name?: string }[];
  readonly incomplete: readonly IncompleteRow[];
  /** Files left out because the configuration's `ignore` matches them (`plan.ignored`), or 0. */
  readonly ignored: number;
  /** True when any row is unverified, so the "?" needs its footnote. */
  readonly unverified: boolean;
  /**
   * True when the agent loads nothing from the repository, skips nothing, and nothing was left
   * unanalyzed or ignored: formatters show such a plan in one line. Files it does not read at
   * all may be listed in `notRead`.
   */
  readonly empty: boolean;
}

/**
 * `3 of 4 skips can be fixed`, counting the skipped rows of every plan, or undefined when none
 * can be.
 */
export function fixableNote(views: readonly Pick<PlanView, 'skipped'>[]): string | undefined {
  const rows = views.flatMap((view) => view.skipped);
  const fixable = rows.filter((row) => row.fix !== undefined).length;
  if (fixable === 0) return undefined;
  return `${formatInteger(fixable)} of ${formatInteger(rows.length)} ${rows.length === 1 ? 'skip' : 'skips'} can be fixed`;
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

/** One column of the matrix: an agent with its full name and its short, grouped labels. */
export interface MatrixColumn {
  readonly agent: ContextAgent;
  /** {@link AGENT_NAMES}. */
  readonly name: string;
  /** {@link AGENT_COLUMNS}. */
  readonly group: string;
  readonly surface?: string;
}

/**
 * The matrix as text and Markdown show it: only the columns of agents that read at least one of
 * the files. JSON keeps every column.
 */
export interface MatrixView {
  readonly columns: readonly MatrixColumn[];
  /** Cells follow `columns`. */
  readonly rows: readonly { readonly path: string; readonly cells: readonly MatrixCell[] }[];
  /** Names of the agents left out because every cell of theirs is `not-read`, in report order. */
  readonly omitted: readonly string[];
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

/** `on` and `off` for a boolean setting; anything else as it is. */
function onOff(value: string | number | boolean): string {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return valueText(value);
}

/** The Copilot surfaces the loaders model, each an agent whose name heads its plan. */
const COPILOT_SURFACES: ReadonlySet<string | number | boolean> = new Set([
  'cli',
  'vscode',
  'cloud-agent',
]);

/** Nothing for a surface the plan's heading names already; anything else as it is. */
function surfaceText(value: string | number | boolean): string | undefined {
  return COPILOT_SURFACES.has(value) ? undefined : `surface ${valueText(value)}`;
}

/** Devin Local's `read_config_from`: whether it imports the files of `name`. */
function importText(value: string | number | boolean, name: string): string {
  if (value === true) return `${name} files imported`;
  if (value === false) return `${name} files not imported`;
  return `${name} files ${valueText(value)}`;
}

/**
 * Gemini CLI's context file names, which the loader joins with `, `: `context file GEMINI.md`,
 * `context files GEMINI.md and AGENTS.md`. Not joined with commas: the phrase is one item of a
 * comma-separated list.
 */
function contextFilesText(value: string | number | boolean): string {
  const names = valueText(value).split(', ');
  return `context file${names.length === 1 ? '' : 's'} ${names.join(' and ')}`;
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
    .flatMap((assumption) => {
      const entry = known.get(assumption.key);
      const origin = ORIGIN_LABELS[assumption.origin];
      if (entry === undefined) {
        return [`${assumption.key} = ${valueText(assumption.value)} (${origin})`];
      }
      const phrase = entry.phrase(assumption.value);
      if (phrase === undefined) return [];
      const marked = assumption.origin !== 'default' || entry.setting === true;
      return [`${phrase}${marked ? ` (${origin})` : ''}`];
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

/** Subagents in the listing the model picks from: in the prompt from the start. */
function inAgentListing(entry: LoadEntry): boolean {
  return entry.role === 'subagent' && entry.trigger === 'startup';
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
      // Claude Code runs a command, or a skill the model cannot pick, with /name.
      return entry.name !== undefined &&
        (entry.role === 'command' || (entry.role === 'skill' && agent === 'claude-code'))
        ? `when you run /${entry.name}`
        : 'only when you ask for it';
    case 'on-approval':
      return 'after you approve it';
    case 'unknown':
      return 'when is not documented';
  }
}

const PART_LABELS: Readonly<Record<OwnContextPart['kind'], string>> = {
  prompt: 'prompt',
  instructions: 'instructions',
  skill: 'skill',
  listing: 'skills listing',
  memory: 'memory',
};

const NOT_LOADED_LABELS: Readonly<Record<PreloadNotLoaded['reason'], string>> = {
  'not-found': "not in this session's skills",
  'not-model-invocable': 'the model cannot invoke it',
  off: 'turned off',
};

/** Phrases for what a subagent call starts with that no file shows, in this order. */
const HIDDEN_PHRASES: Readonly<Record<OwnContextHidden, string>> = {
  prompt: 'a prompt from outside the repository',
  environment: 'environment details',
  task: 'the task message',
  tools: 'tool definitions',
  'git-status': 'git status',
  'user-instructions': "the user's CLAUDE.md",
  'managed-instructions': 'managed CLAUDE.md',
  instructions: 'whether instruction files reach it (not documented)',
};

const HIDDEN_ORDER = Object.keys(HIDDEN_PHRASES) as OwnContextHidden[];

function callRow(entry: LoadEntry, context: OwnContext): CallRow {
  const parts = context.parts.map((part) => ({
    label:
      part.kind === 'skill' && part.name !== undefined
        ? `skill ${part.name}`
        : PART_LABELS[part.kind],
    size: part.size,
  }));
  const notes: string[] = [];
  const items = (context.notLoaded ?? []).map(
    (item) => `${item.name} (${NOT_LOADED_LABELS[item.reason]})`,
  );
  const overLimit = context.overLimit ?? 0;
  if (overLimit > 0) {
    const skills = `${formatInteger(overLimit)} ${overLimit === 1 ? 'skill' : 'skills'}`;
    items.push(`${items.length === 0 ? '' : 'and '}${skills} past the first 32`);
  }
  if (items.length > 0) notes.push(`not preloaded: ${items.join(', ')}`);
  const unmeasured = context.unmeasured ?? [];
  if (unmeasured.length > 0) {
    notes.push(`not measured, so the call starts with more: ${unmeasured.join(', ')}`);
  }
  const { memory } = context;
  const measured = context.parts.some((part) => part.kind === 'memory');
  if (memory !== undefined && !measured) {
    if (memory.path === undefined) notes.push(`memory in the user's scope, not visible`);
    else if (memory.exists === false) notes.push(`memory ${memory.path}, none yet`);
    else if (!unmeasured.includes(memory.path)) {
      notes.push(`memory ${memory.path}, not measured`);
    }
  }
  return {
    path: entry.path,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    size: context.size,
    parts,
    notes,
    // The call's own certainty: the listing's, which the entry carries, is the startup row's.
    unverified: context.parts.some((part) => part.certainty === 'unverified'),
  };
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
  const agents = plan.entries.filter(inAgentListing);

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
    // The subagents listing goes after the other startup rows (below).
    if (inAgentListing(entry)) continue;
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

  // No agent documents where the subagents listing sits: after the other startup rows.
  if (agents.length > 0) {
    const warning = plan.limits.find(
      (limit) =>
        limit.key === 'claude-code.agent_descriptions_tokens' &&
        limit.limit !== null &&
        limit.used > limit.limit,
    );
    startup.push({
      kind: 'subagents',
      path: '',
      subagents: agents.length,
      ...(warning?.limit === undefined || warning.limit === null
        ? {}
        : { warnsPast: warning.limit }),
      depth: 0,
      via: [],
      size: sumSizes(agents.map((agent) => agent.size)),
      unverified: agents.some((agent) => agent.certainty === 'unverified'),
    });
  }

  const calls: CallRow[] = [];
  const hidden = new Set<OwnContextHidden>();
  for (const entry of plan.entries) {
    if (entry.role !== 'subagent') continue;
    if (entry.ownContext === undefined) {
      // A subagent the agent may load whose file agentcheckup cannot read.
      calls.push({
        path: entry.path,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        parts: [],
        notes: ['not measured: agentcheckup cannot read what it starts with'],
        unverified: true,
      });
      continue;
    }
    calls.push(callRow(entry, entry.ownContext));
    for (const key of entry.ownContext.notVisible) hidden.add(key);
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
      ...(entry.fix === undefined ? {} : { fix: entry.fix }),
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
    calls,
    callsHidden: HIDDEN_ORDER.filter((key) => hidden.has(key)).map((key) => HIDDEN_PHRASES[key]),
    skipped,
    notRead,
    incomplete: plan.incomplete.map(incompleteRow),
    ignored: plan.ignored ?? 0,
    empty:
      plan.entries.length === 0 &&
      skipped.length === 0 &&
      plan.incomplete.length === 0 &&
      (plan.ignored ?? 0) === 0,
    unverified:
      startup.some((row) => row.unverified) ||
      services.some((row) => row.unverified) ||
      onDemand.some((row) => row.unverified) ||
      calls.some((row) => row.unverified) ||
      skipped.some((row) => row.unverified),
  };
}

/** Sizes added up as the plan's totals add them: the characters first, then the estimate. */
function sumSizes(sizes: readonly (Size | undefined)[]): Size {
  let bytes = 0;
  let chars = 0;
  for (const size of sizes) {
    bytes += size?.bytes ?? 0;
    chars += size?.chars ?? 0;
  }
  return { bytes, chars, tokens: Math.ceil(chars / 4) };
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

/**
 * The matrix in canonical order without the columns of agents that read none of its files, or
 * undefined when the report has none.
 */
export function matrixView(context: ContextReport | undefined): MatrixView | undefined {
  if (context?.matrix === undefined) return undefined;
  const canonical = toJsonContext(context);
  const rows = canonical.matrix?.rows ?? [];
  const shown = canonical.agents.flatMap((_, index) =>
    rows.some((row) => (row.cells[index] ?? 'not-read') !== 'not-read') ? [index] : [],
  );
  return {
    columns: shown.flatMap((index) => {
      const agent = canonical.agents[index];
      return agent === undefined
        ? []
        : [{ agent, name: AGENT_NAMES[agent], ...AGENT_COLUMNS[agent] }];
    }),
    rows: rows.map((row) => ({
      path: row.path,
      cells: shown.map((index) => row.cells[index] ?? 'not-read'),
    })),
    omitted: canonical.agents
      .filter((_, index) => !shown.includes(index))
      .map((agent) => AGENT_NAMES[agent]),
  };
}

/**
 * The line under a matrix that leaves out agents: `Not shown: Gemini CLI reads none of these
 * files`. Undefined when no column is left out. Agent names only: no repository text.
 */
export function notShownNote(view: Pick<MatrixView, 'omitted'>): string | undefined {
  const names = view.omitted;
  if (names.length === 0) return undefined;
  return `Not shown: ${joinNames(names)} ${names.length === 1 ? 'reads' : 'read'} none of these files`;
}

/** The single line for a matrix without rows: no agent reads a configuration file here. */
export const EMPTY_MATRIX_NOTE = 'Files by agent: no agent reads a configuration file here';

/** What follows the heading of an empty plan ({@link PlanView.empty}), on the same line. */
export const EMPTY_PLAN_NOTE = 'loads nothing from this repository';
