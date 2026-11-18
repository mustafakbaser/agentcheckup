/**
 * How Devin Desktop (formerly Windsurf) treats rule and configuration files, shared by the
 * instr/windsurf-* rules, ./readers.ts, the security inventory and the Devin Local load plans:
 * when a workspace rule applies, the character limit of Cascade in the Windsurf JetBrains
 * plugin, which other agents' files Devin Local imports (`read_config_from`), and what the
 * `permissions` and `requiredPlugins` of `.devin/config.json` grant.
 *
 * Sources: Devin Local customizations (SOURCES.windsurfRules), Devin CLI rules
 * (SOURCES.devinCliRules), `read_config_from` (SOURCES.devinReadConfigFrom), permissions
 * (SOURCES.devinCliPermissions) and plugins (SOURCES.devinCliPlugins).
 */
import type { Artifact, ArtifactKind, ParseServices } from '../core/types.js';
import { isObject, own } from '../parse/json-access.js';
import type { FrontmatterResult } from '../parse/types.js';
import { globList } from './cursor-rules.js';
import { joinPath, selfAndAncestors } from './paths.js';

// ---------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------

/**
 * A workspace rule's `trigger`. Devin Desktop documents `always_on`, `model_decision`, `glob` and
 * `manual`; Devin CLI also lists `agent`. `unknown`: no frontmatter, no `trigger`, a value that is
 * not one of these, or frontmatter that does not parse. Neither documents what Devin does then.
 */
export type WindsurfRuleMode =
  'always_on' | 'model_decision' | 'glob' | 'manual' | 'agent' | 'unknown';

const MODES: ReadonlySet<string> = new Set([
  'always_on',
  'model_decision',
  'glob',
  'manual',
  'agent',
]);

export interface WindsurfActivation {
  readonly mode: WindsurfRuleMode;
  /** Patterns from `globs`: a comma-separated string split at commas, or list items. */
  readonly globs: readonly string[];
  /** The frontmatter has a `description` with text. */
  readonly described: boolean;
  /**
   * False when the mode or the patterns rest on a form the documentation does not show:
   * `unknown`, `agent` (Devin CLI names it without saying what it does), or `globs` that is not
   * one string.
   */
  readonly documented: boolean;
}

/**
 * When the agent adds a rule of each mode to the context: `always_on` at session start, `glob`
 * when it reads or edits a matching file, `model_decision` and `agent` when the model judges the
 * description relevant, `manual` when the user @-mentions it.
 */
export const WINDSURF_MODE_TRIGGER = {
  always_on: 'startup',
  glob: 'on-path',
  model_decision: 'model-selected',
  agent: 'model-selected',
  manual: 'manual',
  unknown: 'unknown',
} as const satisfies Readonly<Record<WindsurfRuleMode, string>>;

const UNKNOWN: WindsurfActivation = {
  mode: 'unknown',
  globs: [],
  described: false,
  documented: false,
};

/** When Devin Desktop applies a workspace rule in `.devin/rules` or `.windsurf/rules`. */
export function windsurfActivation(frontmatter: FrontmatterResult): WindsurfActivation {
  if (frontmatter.kind !== 'valid') return UNKNOWN;
  const { values } = frontmatter.data;
  const trigger = values['trigger'];
  const globs = values['globs'];
  const description = values['description'];
  const described = typeof description === 'string' && description.trim() !== '';
  if (typeof trigger !== 'string' || !MODES.has(trigger)) return { ...UNKNOWN, described };
  const mode = trigger as Exclude<WindsurfRuleMode, 'unknown'>;
  return {
    mode,
    globs: globList(globs) ?? [],
    described,
    documented:
      mode !== 'agent' && (globs === undefined || globs === null || typeof globs === 'string'),
  };
}

// ---------------------------------------------------------------------------------------------
// Character limit
// ---------------------------------------------------------------------------------------------

/**
 * The limit of Cascade in the Windsurf JetBrains plugin for each rules file
 * (src/rules/instructions/sources.ts). What happens above it is not documented, and Devin Desktop
 * documents no limit.
 */
export const WINDSURF_WORKSPACE_RULE_MAX_CHARS = 12_000;

export interface WindsurfLength {
  /** Unicode characters from `start` on, a CRLF line break counting as one. */
  readonly chars: number;
  /** Offset of the first character past the limit, or -1 when the text is within it. */
  readonly overflow: number;
}

/**
 * The length of a rule as agentcheckup measures it against Cascade's limit: characters after
 * the frontmatter (`start`), counting a surrogate pair and a CRLF pair as one each, so that only
 * text over the limit however it is counted is reported.
 */
export function windsurfRuleLength(text: string, start: number, limit: number): WindsurfLength {
  let chars = 0;
  let overflow = -1;
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // The second half of a surrogate pair and the CR of a CRLF pair are not counted.
    if (code >= 0xdc00 && code <= 0xdfff && i > start) {
      const previous = text.charCodeAt(i - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) continue;
    }
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue;
    chars++;
    if (chars === limit + 1) overflow = i;
  }
  return { chars, overflow };
}

// ---------------------------------------------------------------------------------------------
// read_config_from
// ---------------------------------------------------------------------------------------------

/** The sources `read_config_from` turns on and off, as documented. */
export const DEVIN_CONFIG_SOURCES = [
  'agents_standard',
  'cursor',
  'windsurf',
  'claude',
  'copilot',
  'codex',
  'kiro',
  'opencode',
  'zed',
] as const;
export type DevinConfigSource = (typeof DEVIN_CONFIG_SOURCES)[number];

/** Devin Local's project configuration, relative to the workspace root. */
export const DEVIN_CONFIG_FILE = '.devin/config.json';

/** The project's local overrides, gitignored, which outrank `.devin/config.json`. */
export const DEVIN_CONFIG_LOCAL_FILE = '.devin/config.local.json';

export interface DevinReadConfigFrom {
  /** Whether Devin Local imports each source. Every source is on unless the project turns it off. */
  readonly enabled: Readonly<Record<DevinConfigSource, boolean>>;
  /** `repository` for the sources the project configuration sets to a boolean. */
  readonly origin: Readonly<Record<DevinConfigSource, 'repository' | 'default'>>;
  /** The configuration file read, when the scan has it. */
  readonly config?: string;
}

/** What a `read_config_from` lookup reads: artifacts by path and their JSON. */
export type DevinConfigView = Pick<ParseServices, 'json'> & {
  readonly index: ReadonlyMap<string, Artifact>;
};

function allSources<T>(value: T): Record<DevinConfigSource, T> {
  const record = {} as Record<DevinConfigSource, T>;
  for (const source of DEVIN_CONFIG_SOURCES) record[source] = value;
  return record;
}

const DEFAULTS: DevinReadConfigFrom = { enabled: allSources(true), origin: allSources('default') };

/**
 * `read_config_from` of the project whose workspace root is `root` ('' for the scan root), from
 * `<root>/.devin/config.json`. It is an object of booleans; a source that is absent or not a
 * boolean keeps its default, on. User configuration is outside the repository, and the
 * documentation names no precedence between the two.
 */
export function devinReadConfigFrom(view: DevinConfigView, root: string): DevinReadConfigFrom {
  const artifact = view.index.get(joinPath(root, DEVIN_CONFIG_FILE));
  if (artifact?.kind !== 'devin-config') return DEFAULTS;
  const doc = view.json(artifact);
  const settings = doc.ok && isObject(doc.value) ? own(doc.value, 'read_config_from') : undefined;
  if (!isObject(settings)) return { ...DEFAULTS, config: artifact.path };
  const enabled = allSources(true);
  const origin = allSources<'repository' | 'default'>('default');
  for (const source of DEVIN_CONFIG_SOURCES) {
    const value = own(settings, source);
    if (typeof value !== 'boolean') continue;
    enabled[source] = value;
    origin[source] = 'repository';
  }
  return { enabled, origin, config: artifact.path };
}

/** The segment after the last one that names `folder`, in lower case. */
function configFolder(path: string, folder: string): string | undefined {
  const segments = path.toLowerCase().split('/');
  const index = segments.lastIndexOf(folder);
  return index === -1 ? undefined : segments[index + 1];
}

/**
 * The `read_config_from` source that controls whether Devin Local imports this file, or
 * undefined for Devin's own files and files no source names. Documented per source:
 * `agents_standard` AGENTS.md and `.windsurfrules`; `cursor` `.cursor/rules` and
 * `.cursor/mcp.json`; `windsurf` `.windsurf/rules`, `.windsurf/skills` and `.codeium/skills`;
 * `claude` CLAUDE.md, `.claude/skills`, `.mcp.json` and the settings files `.claude/settings.json`
 * and `.claude/settings.local.json`; `copilot` `.github/skills`; `codex` `.codex/skills`; `kiro`
 * `.kiro/skills`. `opencode` and `zed` name files agentcheckup does not classify (`opencode.json`,
 * `.zed/settings.json`). Devin no longer lists `.claude/commands` among the files it imports.
 */
export function devinSourceOf(
  artifact: Pick<Artifact, 'kind' | 'path'>,
): DevinConfigSource | undefined {
  if (artifact.kind === 'devin-instructions') {
    // `AGENTS.local.md` and `AGENT.md` are standard project rules, `.windsurf/global_rules.md`
    // is Windsurf's, and `.devin/global_rules.md` is Devin's own: it "still load[s] with
    // `read_config_from.windsurf = false`" (SOURCES.devinCliChangelog, v3000.11.92).
    if (!isGlobalRules(artifact.path)) return 'agents_standard';
    return globalRulesFolder(artifact.path) === '.windsurf' ? 'windsurf' : undefined;
  }
  if (artifact.kind === 'windsurf-rule') {
    return configFolder(artifact.path, '.windsurf') === 'rules' ? 'windsurf' : undefined;
  }
  if (artifact.kind === 'skill') {
    if (configFolder(artifact.path, '.windsurf') === 'skills') return 'windsurf';
    if (configFolder(artifact.path, '.codeium') === 'skills') return 'windsurf';
    if (configFolder(artifact.path, '.claude') === 'skills') return 'claude';
    if (configFolder(artifact.path, '.github') === 'skills') return 'copilot';
    if (configFolder(artifact.path, '.codex') === 'skills') return 'codex';
    if (configFolder(artifact.path, '.kiro') === 'skills') return 'kiro';
    return undefined;
  }
  return SOURCE_BY_KIND[artifact.kind];
}

/** The source of the kinds whose source does not depend on where the file sits. */
const SOURCE_BY_KIND: Readonly<Partial<Record<ArtifactKind, DevinConfigSource>>> = {
  'agents-md': 'agents_standard',
  'windsurf-legacy-rules': 'agents_standard',
  'cursor-rule': 'cursor',
  'cursor-rule-md': 'cursor',
  'cursor-mcp': 'cursor',
  'claude-md': 'claude',
  'claude-settings': 'claude',
  'mcp-json': 'claude',
};

/**
 * `read_config_from` for a file in `directory`: from the `.devin/config.json` of the nearest
 * directory at or above it that has one, taken as the workspace root, or the defaults.
 */
export function devinReadConfigFor(view: DevinConfigView, directory: string): DevinReadConfigFrom {
  const root = selfAndAncestors(directory).find(
    (candidate) => view.index.get(joinPath(candidate, DEVIN_CONFIG_FILE))?.kind === 'devin-config',
  );
  return root === undefined ? DEFAULTS : devinReadConfigFrom(view, root);
}

// ---------------------------------------------------------------------------------------------
// The global rules files
// ---------------------------------------------------------------------------------------------

/** The always-on rules file of `.devin/` and `.windsurf/` (SOURCES.devinCliRules). */
export const GLOBAL_RULES = 'global_rules.md';

/** `.devin` or `.windsurf` for a global rules file in it, written so; undefined otherwise. */
export function globalRulesFolder(path: string): '.devin' | '.windsurf' | undefined {
  const slash = path.lastIndexOf('/');
  if (slash === -1 || path.slice(slash + 1) !== GLOBAL_RULES) return undefined;
  const folder = path.slice(path.lastIndexOf('/', slash - 1) + 1, slash);
  return folder === '.devin' || folder === '.windsurf' ? folder : undefined;
}

/** True for `.devin/global_rules.md` or `.windsurf/global_rules.md`, in any directory. */
export function isGlobalRules(path: string): boolean {
  return globalRulesFolder(path) !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Permissions and plugins in .devin/config.json
// ---------------------------------------------------------------------------------------------

/**
 * The permission lists of `.devin/config.json` and `.devin/config.local.json`: "Deny rules — If
 * matched, the action is blocked immediately", "Ask rules — If matched, you're prompted unless an
 * equally or more specific command or MCP allow rule also matches", "Allow rules — If matched,
 * the action proceeds without prompting" (SOURCES.devinCliPermissions).
 */
export const DEVIN_PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const;

/**
 * What a Devin permission rule lets the agent do when it matches everything of its kind, or
 * undefined. From SOURCES.devinCliPermissions: the tool names `exec` ("Block all command
 * execution") and `edit` ("Block all file edits"); `mcp__*`, "All MCP tools everywhere";
 * `Write(**)`, where `**` is "Any characters across path segments (recursive)" and "A bare
 * `Read(**)` without a leading `/` is resolved relative to your current working directory", and
 * `Write(/**)` and `Write(~/**)` from the file system root or the home directory. From
 * SOURCES.devinCliChangelog (v3000.10.31): "`Exec(*)` in a permission rule matches every
 * command". The documentation writes scopes as `Exec(prefix)` and tool names in lower case;
 * other spellings are not documented, so they are not broad.
 */
export function devinBroadPermission(rule: string): string | undefined {
  switch (rule.trim()) {
    case 'exec':
    case 'Exec(*)':
      return 'runs any shell command';
    case 'edit':
      return 'edits any file';
    case 'Write(**)':
      return 'writes any file below the working directory';
    case 'Write(/**)':
      return 'writes any file';
    case 'Write(~/**)':
      return 'writes any file in the home directory';
    case 'mcp__*':
      return 'calls any MCP tool';
    default:
      return undefined;
  }
}

/**
 * The plugin a `requiredPlugins` entry names, on one line: the string shorthand as written
 * (`owner/repo` or a repository URL), or an object's `repo` or `url`, followed by `#<path>` for a
 * `git-subdir` source, as `devin plugins install` writes a plugin below the repository root, and
 * by its `sha` pin or `ref` (SOURCES.devinCliPlugins, "Dependencies"). The pin is part of the
 * value, so that a new pin is a new entry. Undefined for an entry that names no plugin.
 */
export function devinPluginSource(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() === '' ? undefined : entry;
  if (!isObject(entry)) return undefined;
  const text = (key: string): string | undefined => {
    const value = own(entry, key);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const base = text('repo') ?? text('url');
  if (base === undefined) return undefined;
  const path = text('path');
  const where = text('source') === 'git-subdir' && path !== undefined ? `${base}#${path}` : base;
  const sha = text('sha');
  if (sha !== undefined) return `${where} (sha ${sha})`;
  const ref = text('ref');
  return ref === undefined ? where : `${where} (ref ${ref})`;
}
