/**
 * How Devin Desktop (formerly Windsurf) treats rule files, shared by the instr/windsurf-* rules,
 * ./readers.ts and the Devin Local load plans: when a workspace rule applies, the character
 * limits Cascade documents, and which other agents' files Devin Local imports
 * (`read_config_from`).
 *
 * Sources: Cascade memories and rules (SOURCES.windsurfRules), Devin CLI rules
 * (SOURCES.devinCliRules) and `read_config_from` (SOURCES.devinReadConfigFrom).
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
 * A workspace rule's `trigger`. Cascade documents `always_on`, `model_decision`, `glob` and
 * `manual`; Devin CLI also lists `agent`. `unknown`: no frontmatter, no `trigger`, a value that is
 * not one of these, or frontmatter that does not parse. Neither agent documents what it does
 * then.
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
// Character limits
// ---------------------------------------------------------------------------------------------

/** Cascade's limit for each workspace rule file. What happens above it is not documented. */
export const WINDSURF_WORKSPACE_RULE_MAX_CHARS = 12_000;

/** Cascade's limit for the global rules file. */
export const WINDSURF_GLOBAL_RULES_MAX_CHARS = 6_000;

export interface WindsurfLength {
  /** Unicode characters from `start` on, a CRLF line break counting as one. */
  readonly chars: number;
  /** Offset of the first character past the limit, or -1 when the text is within it. */
  readonly overflow: number;
}

/**
 * The length of a rule as agentcheckup measures it against Cascade's limits: characters after
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
  'opencode',
  'zed',
] as const;
export type DevinConfigSource = (typeof DEVIN_CONFIG_SOURCES)[number];

/** Devin Local's project configuration, relative to the workspace root. */
export const DEVIN_CONFIG_FILE = '.devin/config.json';

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
 * `.cursor/mcp.json`; `windsurf` `.windsurf/rules` and `.windsurf/skills`; `claude` CLAUDE.md,
 * `.claude/skills`, `.claude/commands` and `.mcp.json`; `copilot` `.github/skills`.
 */
export function devinSourceOf(
  artifact: Pick<Artifact, 'kind' | 'path'>,
): DevinConfigSource | undefined {
  if (artifact.kind === 'windsurf-rule') {
    return configFolder(artifact.path, '.windsurf') === 'rules' ? 'windsurf' : undefined;
  }
  if (artifact.kind === 'skill') {
    if (configFolder(artifact.path, '.windsurf') === 'skills') return 'windsurf';
    if (configFolder(artifact.path, '.claude') === 'skills') return 'claude';
    if (configFolder(artifact.path, '.github') === 'skills') return 'copilot';
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
  'claude-command': 'claude',
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
