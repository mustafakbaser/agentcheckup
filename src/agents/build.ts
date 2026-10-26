/**
 * Builds the agent definitions (src/agents/types.ts) from a scan's analysis: every custom agent
 * and subagent file, once for each agent that reads it from the repository root, with the model
 * it runs with as far as the repository tells. Pure: it reads only the snapshot and the parses the
 * rules already made. See docs/adr/0013-list-agent-definitions-and-their-models.md.
 *
 * Each agent's reading follows its documentation, cited per definition:
 * - Claude Code reads `.claude/agents/**`; whether it loads a file is checkSubagent's answer, the
 *   one the load plan and instr/subagent-invalid give. Of two files in one folder with the same
 *   name it loads one, in an order that is not documented; of nested folders, the one closest to
 *   the working directory.
 * - Codex reads `.codex/agents/**.toml` in a trusted project; a file needs `name`, `description`
 *   and `developer_instructions`, or Codex ignores it with a warning, and a role `config.toml`
 *   declares wins over a file of the same name (source code).
 * - Cursor reads `.cursor/agents`, `.claude/agents` and the Markdown in `.codex/agents`, and on a
 *   name used twice takes `.cursor` over the others.
 * - Gemini CLI reads `.gemini/agents/*.md`, which need a `name` of lowercase letters, digits,
 *   hyphens and underscores, and a `description`.
 * - GitHub Copilot reads `.github/agents`: in VS Code the folder itself, with or without a header,
 *   on the CLI subfolders too, as the cloud agent `*.agent.md`. The CLI knows an agent by its path
 *   below `agents` (`team--reviewer`) and loads `.github/agents` before `.claude/agents`, the first
 *   of an id winning. VS Code and the CLI read `.claude/agents` as well, in Claude's format.
 * - Devin Local reads `.devin/agents` and `.agents/agents` (experimental).
 * A file an agent reaches through a symlink is read at the symlink's path, as what it is there.
 */
import { compareStrings } from '../core/compare.js';
import { hash53 } from '../core/fingerprint.js';
import { dirnamePosix, joinRelative, pathStatus } from '../core/paths.js';
import { positionAt } from '../core/text.js';
import type { Artifact, ArtifactKind, Span } from '../core/types.js';
import { redactShown } from '../inventory/redact.js';
import { issueKind, isTable, own, type SpannedDocument } from '../parse/json-access.js';
import type { FrontmatterData, FrontmatterResult } from '../parse/types.js';
import {
  claudeFrontmatterConfig,
  type FrontmatterReading,
  hasMergeKey,
} from '../platforms/frontmatter-config.js';
import { canonicalJson } from '../platforms/inventory-ids.js';
import type { LoadView } from '../platforms/load/view.js';
import type { Certainty, ContextAgent, SourceKey } from '../platforms/load/types.js';
import { basename, inClaudeFolder } from '../platforms/paths.js';
import { readingsOf } from '../platforms/readings.js';
import { checkSubagent, type SubagentIssue } from '../platforms/subagents.js';
import { modelForm } from './models.js';
import { buildModelSettings, isTruthy, isUnsetModel, rootSetting } from './settings.js';
import type {
  AgentDefinition,
  AgentsReport,
  EffectiveModel,
  ModelSetting,
  ModelValue,
} from './types.js';

/**
 * One report per artifact list. The engine and the rules that read definitions share a scan's
 * list, and its parses, so they share one build.
 */
const CACHE = new WeakMap<readonly Artifact[], AgentsReport>();

/** Builds the report: definitions and settings, each sorted by id. */
export function buildAgents(view: LoadView): AgentsReport {
  const cached = CACHE.get(view.artifacts);
  if (cached !== undefined) return cached;
  const report = build(view);
  CACHE.set(view.artifacts, report);
  return report;
}

function build(view: LoadView): AgentsReport {
  const settings = buildModelSettings(view);
  const context = new Resolver(settings);
  const definitions: Unsorted[] = [];
  const roles = declaredCodexRoles(view);
  const declaredFiles = new Map(
    roles.flatMap((role) => (role.file === undefined ? [] : [[role.file, role] as const])),
  );
  // A file an agent reaches through a symlink is read at the symlink's path, as what it is there.
  const readings = view.artifacts.flatMap((artifact) =>
    readingsOf(artifact).map((reading) => ({ artifact, ...reading })),
  );
  for (const { artifact, kind, path } of readings) {
    if (kind === 'codex-agent') {
      definitions.push(...codexAgentFile(view, artifact, path, declaredFiles.get(path)));
    } else {
      definitions.push(...(READERS_BY_KIND[kind]?.(view, artifact, path) ?? []));
    }
  }
  const agentFiles = new Set(
    readings.filter((reading) => reading.kind === 'codex-agent').map((reading) => reading.path),
  );
  for (const role of roles) {
    if (role.file === undefined || !agentFiles.has(role.file)) {
      definitions.push(codexConfigRole(view, role));
    }
  }
  const switches = agentSwitches(view);
  const finished = shadowRepeats(
    definitions.map((definition) => switchedOff(definition, switches)),
  ).map((definition) => finish(definition, context));
  return {
    definitions: finished.sort((a, b) => compareStrings(a.id, b.id)),
    settings,
  };
}

/** How each kind of agent file is read at `path`, and by which agents. */
const READERS_BY_KIND: Readonly<
  Partial<Record<ArtifactKind, (view: LoadView, artifact: Artifact, path: string) => Unsorted[]>>
> = {
  'claude-agent': claudeAgentFile,
  'cursor-agent': (view, artifact, path) => markdownFile(view, artifact, path, ['cursor'], false),
  'gemini-agent': (view, artifact, path) => markdownFile(view, artifact, path, ['gemini'], false),
  'copilot-agent': (view, artifact, path) =>
    markdownFile(view, artifact, path, copilotReaders(path), false),
  'devin-agent': (view, artifact, path) => markdownFile(view, artifact, path, ['windsurf'], false),
};

// ---------------------------------------------------------------------------------------------
// One definition before its effective model and digest
// ---------------------------------------------------------------------------------------------

type Unsorted = Omit<AgentDefinition, 'id' | 'effective' | 'digest'> & {
  /**
   * Definitions of one agent collide when they share `scope` (the directory that owns the agent
   * folder: nested folders serve sessions started there) and `key` (the name, or the id or file
   * name the agent goes by); the lowest `rank` wins, then the first in path order.
   */
  readonly scope: string;
  readonly key: string;
  readonly rank: number;
  /** The agent documents that a lower `rank` wins; otherwise which one wins is unverified. */
  readonly ranked: boolean;
  /** Hash of text the agent may read and agentcheckup cannot: any change of it is a change. */
  readonly opaque?: string;
};

function lineOf(artifact: Artifact, span: Span | undefined): number {
  return span === undefined ? 1 : positionAt(artifact.decoded, span.offset).line;
}

/** The fields of a frontmatter block, with the spans of its keys and values in the file. */
interface Fields {
  readonly values: Readonly<Record<string, unknown>>;
  /** Span of the value of `key`, else of the key. */
  span(key: string): Span | undefined;
  keySpan(key: string): Span | undefined;
}

function fieldsOf(data: FrontmatterData): Fields {
  return {
    values: data.values,
    span: (key) => data.valueSpan(key) ?? data.keySpan(key),
    keySpan: (key) => data.keySpan(key),
  };
}

/** The fields of a reading: its spans already point into the file. */
function readingFields(reading: FrontmatterReading): Fields {
  const values = reading.doc.value;
  return {
    values: isTable(values) ? values : {},
    span: (key) => reading.doc.valueSpan([key]) ?? reading.doc.keySpan([key]),
    keySpan: (key) => reading.doc.keySpan([key]),
  };
}

/** The text of a field as one string, or undefined for other types. */
function stringField(fields: Fields, key: string): string | undefined {
  const value = own(fields.values, key);
  return typeof value === 'string' ? value : undefined;
}

/** A value an agent reads as no model at all: YAML null, or blank text. */
function isNoModel(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

/** A model value as shown: as written, with credentials removed. */
function modelValue(
  agent: ContextAgent,
  value: string | readonly string[],
  claudeFormat: boolean,
  line: number,
): ModelValue {
  if (typeof value === 'string') {
    const shown = redactShown(value);
    return { value: shown, form: modelForm(agent, shown, claudeFormat), line };
  }
  const shown = value.map(redactShown);
  const forms = shown.map((item) => modelForm(agent, item, claudeFormat));
  return {
    value: shown,
    form: forms.includes('not-documented') ? 'not-documented' : (forms[0] ?? 'id'),
    line,
  };
}

/** A non-empty list of strings, or undefined. */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const list: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string') return undefined;
    list.push(item);
  }
  return list;
}

/** `model` of a frontmatter block, in the form the agent documents. */
function frontmatterModel(
  artifact: Artifact,
  fields: Fields,
  agent: ContextAgent,
  claudeFormat: boolean,
): ModelValue | undefined {
  // The Copilot CLI tries `models` in order, and it overrides `model` (SOURCES.copilotCliAgents).
  const models =
    agent === 'copilot-cli' && !claudeFormat ? stringList(own(fields.values, 'models')) : undefined;
  if (models !== undefined) {
    return modelValue(agent, models, false, lineOf(artifact, fields.span('models')));
  }
  if (!Object.hasOwn(fields.values, 'model')) return undefined;
  const value = own(fields.values, 'model');
  if (isNoModel(value)) return undefined;
  const line = lineOf(artifact, fields.span('model'));
  if (typeof value === 'string') return modelValue(agent, value, claudeFormat, line);
  // GitHub Copilot in VS Code takes a list of models to try in order.
  const list = agent === 'copilot-vscode' && !claudeFormat ? stringList(value) : undefined;
  if (list !== undefined) return modelValue(agent, list, false, line);
  return { value: redactShown(JSON.stringify(value)), form: 'not-documented', line };
}

function effortField(
  artifact: Artifact,
  fields: Fields,
  keys: readonly string[],
): AgentDefinition['effort'] {
  for (const key of keys) {
    const value = own(fields.values, key);
    if (typeof value === 'string' || typeof value === 'number') {
      return { value: String(value), line: lineOf(artifact, fields.span(key)) };
    }
  }
  return undefined;
}

/** The name a file gives an agent that does not read `name`: the file name without suffixes. */
function fileStem(path: string): string {
  const file = basename(path);
  const lower = file.toLowerCase();
  if (lower === 'agent.md' || lower === 'agents.md') return basename(dirnamePosix(path));
  for (const suffix of ['.agent.md', '.md', '.toml']) {
    if (lower.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  return file;
}

/**
 * True when a folder of the path sits between the agent folder and the file. Devin Local's
 * `agents/<name>/AGENT.md` is its own documented layout, not a subfolder.
 */
function inSubfolder(path: string, folder: string): boolean {
  const marker = `${folder}/`;
  const index = path.lastIndexOf(marker);
  if (index === -1) return false;
  const below = path.slice(index + marker.length);
  const devinLayout =
    (folder === '.devin/agents' || folder === '.agents/agents') &&
    below.split('/').length === 2 &&
    ['agent.md', 'agents.md'].includes(basename(below).toLowerCase());
  return below.includes('/') && !devinLayout;
}

/** The directory that owns the agent folder: `a/.github/agents/x.md` -> `a`. */
function ownerOf(path: string, folder: string): string | undefined {
  const marker = `${folder}/`;
  if (path.startsWith(marker)) return '';
  const index = path.indexOf(`/${marker}`);
  return index === -1 ? undefined : path.slice(0, index);
}

/** The digest of text agentcheckup cannot read for an agent, so that any change shows. */
function opaqueOf(artifact: Artifact): string {
  return hash53(artifact.decoded.text);
}

// ---------------------------------------------------------------------------------------------
// Claude Code's folder: Claude Code, and Cursor and Copilot reading it
// ---------------------------------------------------------------------------------------------

const SKIP_REASONS: Readonly<Record<SubagentIssue['code'], string>> = {
  'misplaced-frontmatter': 'the frontmatter does not start on line 1',
  'unclosed-frontmatter': 'the frontmatter has no closing line',
  'unsupported-frontmatter': 'the frontmatter is not YAML',
  'invalid-yaml': 'the frontmatter is not valid YAML',
  'name-missing': 'no name',
  'name-empty': 'an empty name',
  'name-leading-dash': 'the name starts with "-"',
  'name-colon': 'the name contains ":"',
  'name-too-long': 'the name is too long',
  'description-missing': 'no description',
  'description-empty': 'an empty description',
};

/**
 * Why Claude Code may not load a file checkSubagent calls `unknown`: its own reader may accept
 * what the documented form rejects (src/platforms/skill-repair.ts).
 */
const UNKNOWN_REASONS: Readonly<Partial<Record<FrontmatterResult['kind'], string>>> = {
  absent: "only Claude Code's own reader finds the frontmatter",
  unclosed: "only Claude Code's own reader finds the frontmatter",
  invalid: "the frontmatter is not valid YAML, which Claude Code's reader may accept",
  valid: 'the frontmatter uses a << merge key',
};

function claudeAgentFile(view: LoadView, artifact: Artifact, path: string): Unsorted[] {
  const frontmatter = view.frontmatter(artifact);
  const check = checkSubagent(artifact.decoded.text, frontmatter);
  // Cursor and the Copilot CLI and VS Code agent read the folder too, in their own way, whether
  // or not Claude Code calls the file documentation.
  const others = markdownFile(
    view,
    artifact,
    path,
    ['cursor', 'copilot-cli', 'copilot-vscode'],
    true,
  );
  if (check.status === 'documentation') return others;
  const owner = inClaudeFolder(path, 'agents')?.owner ?? '';
  // The fields Claude Code reads: the documented parse, else the block its reader finds or
  // repairs (src/platforms/frontmatter-config.ts). A block it may read and agentcheckup cannot,
  // such as one with a `<<` merge key or past a parser limit, may set any field.
  const config = claudeFrontmatterConfig(artifact.decoded.text, frontmatter);
  const [reading] = config.readings;
  const fields = reading === undefined ? undefined : readingFields(reading);
  const firstIssue = check.status === 'skipped' ? check.issues[0] : undefined;
  const merged = config.readings.some((item) => hasMergeKey(item.doc.value));
  const unreadable = config.unreadable && check.status !== 'skipped';
  const reason =
    firstIssue !== undefined
      ? SKIP_REASONS[firstIssue.code]
      : unreadable
        ? merged
          ? 'the frontmatter uses a << merge key'
          : "the frontmatter is past agentcheckup's parser limits"
        : check.status === 'unknown'
          ? UNKNOWN_REASONS[frontmatter.kind]
          : undefined;
  const status =
    check.status === 'skipped'
      ? 'skipped'
      : check.status === 'loads' && !unreadable
        ? 'loads'
        : 'unknown';
  const model =
    fields === undefined ? undefined : frontmatterModel(artifact, fields, 'claude-code', false);
  const effort = fields === undefined ? undefined : effortField(artifact, fields, ['effort']);
  const mode = fields === undefined ? undefined : stringField(fields, 'permissionMode');
  const name = fields === undefined ? undefined : nameOf(fields);
  const claude: Unsorted = {
    file: path,
    line: fields === undefined ? 1 : lineOf(artifact, fields.keySpan('name')),
    agent: 'claude-code',
    ...(name === undefined ? {} : { name }),
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    tools: fields !== undefined && Object.hasOwn(fields.values, 'tools') ? 'listed' : 'inherited',
    ...(mode === undefined ? {} : { permissionMode: redactShown(mode) }),
    certainty: owner === '' ? 'documented' : 'unverified',
    evidence: ['claudeSubagents'],
    scope: owner,
    key: name ?? '',
    rank: 0,
    ranked: false,
    ...(unreadable ? { opaque: opaqueOf(artifact) } : {}),
  };
  return [claude, ...others];
}

/** `name` as written, when it is a non-empty string. */
function nameOf(fields: Fields): string | undefined {
  const name = stringField(fields, 'name')?.trim();
  return name === undefined || name === '' ? undefined : name;
}

// ---------------------------------------------------------------------------------------------
// Markdown agent files: Cursor, Gemini CLI, GitHub Copilot, Devin Local
// ---------------------------------------------------------------------------------------------

/** The Copilot surfaces that read a `.github/agents` file (SOURCES.vscodeCustomAgents etc.). */
function copilotReaders(path: string): ContextAgent[] {
  const readers: ContextAgent[] = ['copilot-cli'];
  if (!inSubfolder(path, '.github/agents')) readers.push('copilot-vscode');
  if (path.toLowerCase().endsWith('.agent.md')) readers.push('copilot-cloud');
  return readers;
}

/** Fields each agent requires; a file without one is skipped. */
const REQUIRED: Readonly<Partial<Record<ContextAgent, readonly string[]>>> = {
  gemini: ['name', 'description'],
  'copilot-cli': ['description'],
  'copilot-cloud': ['description'],
};

/** Gemini CLI's names: lowercase letters, digits, hyphens and underscores (SOURCES.geminiSubagents). */
const GEMINI_NAME = /^[\d_a-z-]+$/;

/**
 * The `target` that keeps a Copilot surface from reading a file: the CLI reads both
 * (SOURCES.copilotCustomAgents: unset means both environments).
 */
const OTHER_TARGET: Readonly<Partial<Record<ContextAgent, string>>> = {
  'copilot-vscode': 'github-copilot',
  'copilot-cloud': 'vscode',
};

const EVIDENCE: Readonly<Record<ContextAgent, readonly SourceKey[]>> = {
  'claude-code': ['claudeSubagents'],
  codex: ['codexSubagents'],
  cursor: ['cursorSubagents'],
  gemini: ['geminiSubagents'],
  'copilot-cli': ['copilotCliAgents'],
  'copilot-vscode': ['vscodeCustomAgents'],
  'copilot-cloud': ['copilotCustomAgents'],
  windsurf: ['devinSubagents'],
  cline: [],
};

/** The folder of each agent's own files, for its name, owner and subfolders. */
function agentFolder(path: string): string {
  for (const folder of [
    '.cursor/agents',
    '.claude/agents',
    '.codex/agents',
    '.gemini/agents',
    '.github/agents',
    '.devin/agents',
    '.agents/agents',
  ]) {
    if (path.startsWith(`${folder}/`) || path.includes(`/${folder}/`)) return folder;
  }
  return '';
}

/**
 * Where a definition stands among the agent's folders and what it is known by:
 * - Cursor takes `.cursor/agents` over `.claude/agents` and `.codex/agents`, by name
 *   (SOURCES.cursorSubagents); which of the last two wins is not documented.
 * - The Copilot CLI goes by the path below `agents`, loading `.github/agents` before
 *   `.claude/agents`, the first of an id winning; the same name under two ids loads twice
 *   (SOURCES.copilotCliAgents).
 * - The Copilot cloud agent deduplicates by file name (SOURCES.copilotCustomAgents).
 * - The others go by name, in an order that is not documented.
 */
function placeOf(
  agent: ContextAgent,
  path: string,
  name: string,
): Pick<Unsorted, 'key' | 'rank' | 'ranked'> {
  if (agent === 'cursor') {
    return { key: name, rank: path.includes('.cursor/agents/') ? 0 : 1, ranked: true };
  }
  if (agent === 'copilot-cli') {
    return { key: name, rank: path.includes('.github/agents/') ? 0 : 1, ranked: true };
  }
  if (agent === 'copilot-cloud') return { key: fileStem(path), rank: 0, ranked: false };
  return { key: name, rank: 0, ranked: false };
}

function markdownFile(
  view: LoadView,
  artifact: Artifact,
  path: string,
  agents: readonly ContextAgent[],
  claudeFormat: boolean,
): Unsorted[] {
  const frontmatter = view.frontmatter(artifact);
  if (frontmatter.kind === 'unsupported') return [];
  const folder = agentFolder(path);
  const owner = ownerOf(path, folder) ?? '';
  const nested = inSubfolder(path, folder);
  const definitions: Unsorted[] = [];
  for (const agent of agents) {
    // A file without frontmatter is an agent only for VS Code, in its own format: its header is
    // optional (SOURCES.vscodeCustomAgents). The Copilot CLI and cloud agent need a description.
    if (frontmatter.kind === 'absent' && (claudeFormat || !agent.startsWith('copilot-'))) continue;
    const certainty: Certainty =
      owner === '' && !(nested && agent !== 'copilot-cli') ? 'documented' : 'unverified';
    const name = copilotId(agent, path) ?? fileStem(path);
    const base = {
      file: path,
      agent,
      certainty,
      evidence: EVIDENCE[agent],
      scope: owner,
    };
    if (frontmatter.kind === 'absent') {
      const loads = agent === 'copilot-vscode';
      definitions.push({
        ...base,
        line: 1,
        name,
        status: loads ? 'loads' : 'skipped',
        ...(loads ? {} : { reason: 'no description' }),
        tools: 'inherited',
        ...placeOf(agent, path, name),
      });
      continue;
    }
    if (frontmatter.kind !== 'valid') {
      // How these agents read a block that does not parse is not documented.
      definitions.push({
        ...base,
        line: 1,
        name,
        status: 'unknown',
        reason: 'the frontmatter is not valid YAML',
        tools: 'inherited',
        certainty: 'unverified',
        ...placeOf(agent, path, name),
        opaque: opaqueOf(artifact),
      });
      continue;
    }
    const fields = fieldsOf(frontmatter.data);
    const named = copilotId(agent, path) ?? nameOf(fields) ?? fileStem(path);
    const reason = skipReason(agent, fields);
    const model = frontmatterModel(artifact, fields, agent, claudeFormat);
    const effort = effortField(artifact, fields, EFFORT_KEYS[agent] ?? []);
    definitions.push({
      ...base,
      line: lineOf(artifact, fields.keySpan('name')),
      name: named,
      status: reason === undefined ? 'loads' : 'skipped',
      ...(reason === undefined ? {} : { reason }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      tools: toolsOf(agent, fields),
      ...placeOf(agent, path, named),
    });
  }
  return definitions;
}

/** Why `agent` skips a file with these fields, or undefined when it loads it. */
function skipReason(agent: ContextAgent, fields: Fields): string | undefined {
  const missing = (REQUIRED[agent] ?? []).find(
    (key) => (stringField(fields, key)?.trim() ?? '') === '',
  );
  if (missing !== undefined) return `no ${missing}`;
  const target = stringField(fields, 'target')?.trim();
  if (target !== undefined && target === OTHER_TARGET[agent]) return `its target is ${target}`;
  if (agent === 'gemini' && !GEMINI_NAME.test(nameOf(fields) ?? '')) {
    return 'the name is not lowercase letters, digits, hyphens and underscores';
  }
  return undefined;
}

/** The keys each agent reads a reasoning effort from. */
const EFFORT_KEYS: Readonly<Partial<Record<ContextAgent, readonly string[]>>> = {
  'copilot-vscode': ['reasoning-effort'],
  'copilot-cli': ['reasoningEffort'],
};

function toolsOf(agent: ContextAgent, fields: Fields): AgentDefinition['tools'] {
  if (agent === 'cursor') {
    return own(fields.values, 'readonly') === true ? 'read-only' : 'inherited';
  }
  const keys = agent === 'windsurf' ? ['allowed-tools', 'tools'] : ['tools'];
  return keys.some((key) => Object.hasOwn(fields.values, key)) ? 'listed' : 'inherited';
}

/**
 * The id the Copilot CLI gives a file in `.github/agents` or `.claude/agents`: its path below the
 * folder without `.agent.md` or `.md`, with `--` for each `/` (SOURCES.copilotCliAgents).
 * Undefined for other agents, which name an agent by its `name`.
 */
function copilotId(agent: ContextAgent, path: string): string | undefined {
  if (agent !== 'copilot-cli') return undefined;
  for (const marker of ['.github/agents/', '.claude/agents/']) {
    const index = path.lastIndexOf(marker);
    if (index === -1) continue;
    const relative = path.slice(index + marker.length);
    const stem = fileStem(relative);
    const folder = dirnamePosix(relative);
    return (folder === '' ? stem : `${folder}/${stem}`).replaceAll('/', '--');
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Codex agent files
// ---------------------------------------------------------------------------------------------

/**
 * A role a `.codex/config.toml` declares in `[agents.<name>]` (SOURCES.codexConfigReference):
 * its own description, and the agent file `config_file` names, relative to the `.codex` folder.
 */
interface DeclaredRole {
  readonly name: string;
  readonly config: Artifact;
  readonly line: number;
  readonly description?: string;
  /** True when the role names a `config_file`, wherever it points. */
  readonly configFile: boolean;
  /** The agent file, root-relative; undefined without `config_file` or outside the scan. */
  readonly file?: string;
}

/**
 * The roles each `.codex/config.toml` declares: the tables under `[agents]`; its other keys are
 * settings (codex-rs/agent-roles/src/loader.rs).
 */
function declaredCodexRoles(view: LoadView): DeclaredRole[] {
  const roles: DeclaredRole[] = [];
  for (const config of view.artifacts) {
    if (config.kind !== 'codex-config') continue;
    const doc = view.toml(config);
    const agents = doc.ok && isTable(doc.value) ? own(doc.value, 'agents') : undefined;
    if (!doc.ok || !isTable(agents)) continue;
    for (const name of Object.keys(agents)) {
      const role = agents[name];
      if (!isTable(role)) continue;
      const description = own(role, 'description');
      const configFile = own(role, 'config_file');
      // An absolute path or one that leaves the repository is a file agentcheckup cannot read.
      const file =
        typeof configFile === 'string' && !configFile.startsWith('/')
          ? joinRelative(dirnamePosix(config.path), configFile)
          : undefined;
      roles.push({
        name,
        config,
        line: lineOf(config, doc.keySpan(['agents', name])),
        ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}),
        configFile: configFile !== undefined,
        ...(file === undefined || file.startsWith('..') ? {} : { file }),
      });
    }
  }
  return roles;
}

/** The directory that owns a `.codex` folder: `a/.codex/agents/x.toml` -> `a`. */
function codexOwner(path: string): string {
  const index = path.lastIndexOf('.codex/');
  return index <= 0 ? '' : path.slice(0, index - 1);
}

/**
 * A Codex agent file (codex-rs/agent-roles/src/agent_role_config.rs, loader.rs). A file Codex
 * finds in `.codex/agents` needs a `name`, a `description` and `developer_instructions`; a file a
 * role in `config.toml` names takes the role's name and description when it has none, and needs
 * no `developer_instructions`, though one it has may not be blank. Codex ignores a file that does
 * not meet them, or whose fields do not have their types, with a warning.
 */
function codexAgentFile(
  view: LoadView,
  artifact: Artifact,
  path: string,
  declared: DeclaredRole | undefined,
): Unsorted[] {
  const owner = ownerOf(path, '.codex/agents');
  const base = {
    file: path,
    agent: 'codex' as const,
    tools: 'inherited' as const,
    evidence: ['codexSubagents'],
    scope: codexOwner(path),
    // A role config.toml declares wins over a file of the same name Codex finds (loader.rs).
    rank: declared === undefined ? 1 : 0,
    ranked: true,
  };
  const doc = view.toml(artifact);
  if (!doc.ok) {
    const name = declared?.name ?? fileStem(path);
    const [issue] = doc.errors;
    // Past agentcheckup's own limits, or UTF-16: Codex may still read it.
    const unread = issue !== undefined && issueKind(issue) !== 'other';
    return [
      {
        ...base,
        line: 1,
        name,
        key: name,
        status: unread ? 'unknown' : 'skipped',
        reason: unread
          ? "the file is past agentcheckup's parser limits"
          : 'the file is not valid TOML',
        certainty: unread ? 'unverified' : 'source-code',
        ...(unread ? { opaque: opaqueOf(artifact) } : {}),
      },
    ];
  }
  const root = doc.value;
  const raw = (key: string): unknown => (isTable(root) ? own(root, key) : undefined);
  const text = (key: string): string | undefined => {
    const value = raw(key);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const name = text('name') ?? declared?.name;
  const description = text('description') ?? declared?.description;
  const instructions = raw('developer_instructions');
  const blankInstructions = typeof instructions === 'string' && instructions.trim() === '';
  const modelRaw = raw('model');
  const reason =
    name === undefined
      ? 'no name'
      : description === undefined
        ? 'no description'
        : blankInstructions || (declared === undefined && instructions === undefined)
          ? 'no developer_instructions'
          : modelRaw !== undefined && typeof modelRaw !== 'string'
            ? 'model is not a string'
            : undefined;
  const model = codexModel(artifact, doc);
  const effort = text('model_reasoning_effort');
  return [
    {
      ...base,
      line: lineOf(artifact, doc.keySpan(['name'])),
      name: name ?? fileStem(path),
      key: name ?? '',
      status: reason === undefined ? 'loads' : 'skipped',
      ...(reason === undefined ? {} : { reason }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined
        ? {}
        : {
            effort: {
              value: redactShown(effort),
              line: lineOf(artifact, doc.valueSpan(['model_reasoning_effort'])),
            },
          }),
      // Codex reads project agent files only in a trusted project, from the root down to the
      // working directory.
      certainty:
        reason === undefined ? (owner === '' ? 'documented' : 'unverified') : 'source-code',
    },
  ];
}

/**
 * A role `config.toml` declares without an agent file agentcheckup reads. Without `config_file`
 * it is the role itself; with one that does not exist, Codex drops the role (loader.rs); with one
 * agentcheckup does not read, such as an absolute path, its model is not known.
 */
function codexConfigRole(view: LoadView, role: DeclaredRole): Unsorted {
  const base = {
    file: role.config.path,
    line: role.line,
    agent: 'codex' as const,
    name: role.name,
    tools: 'inherited' as const,
    evidence: ['codexConfigReference'],
    scope: codexOwner(role.config.path),
    key: role.name,
    rank: 0,
    ranked: true,
  };
  if (!role.configFile) {
    return role.description === undefined
      ? { ...base, status: 'unknown', reason: 'no description', certainty: 'unverified' }
      : { ...base, status: 'loads', certainty: 'unverified' };
  }
  if (role.file !== undefined && pathStatus(view.snapshot, role.file) === 'missing') {
    return {
      ...base,
      status: 'skipped',
      reason: 'its config_file does not exist',
      certainty: 'source-code',
    };
  }
  return {
    ...base,
    status: 'unknown',
    reason: 'its config_file is not a file agentcheckup reads',
    certainty: 'unverified',
  };
}

function codexModel(artifact: Artifact, doc: SpannedDocument): ModelValue | undefined {
  const value = isTable(doc.value) ? own(doc.value, 'model') : undefined;
  if (value === undefined) return undefined;
  const line = lineOf(artifact, doc.valueSpan(['model']));
  return typeof value === 'string'
    ? modelValue('codex', value, false, line)
    : { value: redactShown(JSON.stringify(value)), form: 'not-documented', line };
}

// ---------------------------------------------------------------------------------------------
// Switches that turn custom agents off
// ---------------------------------------------------------------------------------------------

interface Switches {
  /** Codex's multi-agent tools are off: `agents.enabled` or `features.multi_agent` is false. */
  readonly codexOff: boolean;
  /** Gemini CLI's subagents are off: `experimental.enableAgents` is false. */
  readonly geminiOff: boolean;
  /** Gemini CLI agents turned off one by one: `agents.overrides.<name>.enabled` is false. */
  readonly geminiAgentsOff: ReadonlySet<string>;
}

/**
 * The repository root's switches (SOURCES.codexConfigReference, SOURCES.geminiSubagents). Both
 * default to on; a session started elsewhere reads the files on its path too.
 */
function agentSwitches(view: LoadView): Switches {
  const off = (file: string, path: readonly string[]): boolean =>
    rootSetting(view, file, path)?.value === false;
  const overrides = rootSetting(view, '.gemini/settings.json', ['agents', 'overrides'])?.value;
  const geminiAgentsOff = new Set<string>();
  if (isTable(overrides)) {
    for (const name of Object.keys(overrides)) {
      const entry = overrides[name];
      if (isTable(entry) && own(entry, 'enabled') === false) geminiAgentsOff.add(name);
    }
  }
  return {
    codexOff:
      off('.codex/config.toml', ['agents', 'enabled']) ||
      off('.codex/config.toml', ['features', 'multi_agent']),
    geminiOff: off('.gemini/settings.json', ['experimental', 'enableAgents']),
    geminiAgentsOff,
  };
}

/** The definition, skipped when a root switch turns its agent's custom agents off. */
function switchedOff(definition: Unsorted, switches: Switches): Unsorted {
  if (definition.status !== 'loads' && definition.status !== 'unknown') return definition;
  if (definition.scope !== '') return definition;
  let reason: string | undefined;
  if (definition.agent === 'codex' && switches.codexOff) {
    reason = "multi-agent tools are off in the root's .codex/config.toml";
  } else if (definition.agent === 'gemini' && switches.geminiOff) {
    reason = "subagents are off in the root's .gemini/settings.json";
  } else if (
    definition.agent === 'gemini' &&
    definition.name !== undefined &&
    switches.geminiAgentsOff.has(definition.name)
  ) {
    reason = "the agent is turned off in the root's .gemini/settings.json";
  }
  return reason === undefined
    ? definition
    : { ...definition, status: 'skipped', reason, certainty: 'documented' };
}

// ---------------------------------------------------------------------------------------------
// Name collisions, effective models, digests
// ---------------------------------------------------------------------------------------------

const SHADOW_REASONS: Readonly<Partial<Record<ContextAgent, string>>> = {
  'copilot-cli': 'another agent file has the same id',
  'copilot-cloud': 'another agent file has the same file name',
};

/**
 * Marks the definitions another of the same agent, scope and key wins over: the lowest rank,
 * then the first in path order. Where the agent does not document that order, the loser's status
 * is unverified. Definitions in different scopes never collide: a nested agent folder serves
 * sessions started there, where it wins over the root's.
 */
function shadowRepeats(definitions: readonly Unsorted[]): Unsorted[] {
  const winners = new Map<string, Unsorted>();
  const keyOf = (definition: Unsorted): string =>
    `${definition.agent}\u0000${definition.scope}\u0000${definition.key}`;
  const ordered = [...definitions].sort(
    (a, b) => a.rank - b.rank || compareStrings(a.file, b.file),
  );
  for (const definition of ordered) {
    if (definition.status !== 'loads' || definition.key === '') continue;
    if (!winners.has(keyOf(definition))) winners.set(keyOf(definition), definition);
  }
  return definitions.map((definition) => {
    if (definition.status !== 'loads' || definition.key === '') return definition;
    const winner = winners.get(keyOf(definition));
    if (winner === undefined || winner === definition) return definition;
    const documentedOrder = definition.ranked && winner.rank < definition.rank;
    return {
      ...definition,
      status: 'shadowed',
      reason: SHADOW_REASONS[definition.agent] ?? 'another definition has the same name',
      shadowedBy: winner.file,
      certainty: documentedOrder ? definition.certainty : 'unverified',
    };
  });
}

/** Model settings by agent and key, from the root's files, a local file over a shared one. */
class Resolver {
  readonly #settings = new Map<string, ModelSetting>();

  constructor(settings: readonly ModelSetting[]) {
    // Files at the repository root only; `.local.json` wins over the shared file.
    const ordered = [...settings]
      .filter((setting) => ROOT_FILE.test(setting.file))
      .sort((a, b) => compareStrings(a.file, b.file));
    for (const setting of ordered) {
      const key = `${setting.agent}\u0000${setting.key}`;
      const known = this.#settings.get(key);
      if (known === undefined || setting.file.includes('.local.')) this.#settings.set(key, setting);
    }
  }

  get(agent: ContextAgent, key: string): ModelSetting | undefined {
    return this.#settings.get(`${agent}\u0000${key}`);
  }
}

/** Settings files at the root: `.claude/`, `.codex/`, `.gemini/` and `.github/copilot/`. */
const ROOT_FILE = /^\.(?:claude|codex|gemini|github\/copilot)\/[^/]+$/;

function fromSetting(setting: ModelSetting, source: EffectiveModel['source']): EffectiveModel {
  return { value: setting.value, source, file: setting.file };
}

const NOT_VISIBLE: EffectiveModel = { source: 'not-visible' };

/** The model a definition runs with, as the agent's documented order picks it. */
function effectiveModel(definition: Unsorted, context: Resolver): EffectiveModel {
  const own = definition.model;
  // `inherit` where the agent documents it; elsewhere it is a value like any other.
  const declared = own !== undefined && own.form !== 'inherit' ? own : undefined;
  const ownModel: EffectiveModel | undefined =
    declared === undefined ? undefined : { value: declared.value, source: 'definition' };
  switch (definition.agent) {
    case 'claude-code': {
      // Per call, then the file's `model` (ignored under FORCE), then
      // CLAUDE_CODE_SUBAGENT_MODEL, then the session's model (SOURCES.claudeSubagents): the
      // ANTHROPIC_MODEL variable, the `model` setting, then the default for new sessions
      // (SOURCES.claudeModelConfig). CLAUDE_CODE_SUBAGENT_MODEL set to `inherit` is unset.
      const session =
        context.get('claude-code', 'env.ANTHROPIC_MODEL') ??
        context.get('claude-code', 'model') ??
        context.get('claude-code', 'env.ANTHROPIC_DEFAULT_MODEL');
      const setting = context.get('claude-code', 'env.CLAUDE_CODE_SUBAGENT_MODEL');
      const subagents = setting === undefined || isUnsetModel(setting.value) ? undefined : setting;
      const force = context.get('claude-code', 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
      const fallback =
        subagents !== undefined
          ? fromSetting(subagents, 'setting')
          : session !== undefined
            ? fromSetting(session, 'session')
            : NOT_VISIBLE;
      if (force !== undefined && isTruthy(force.value)) {
        // Every subagent runs on CLAUDE_CODE_SUBAGENT_MODEL, or the session's model without it.
        return own === undefined
          ? fallback
          : { ...fallback, overridden: { key: force.key, file: force.file } };
      }
      if (ownModel !== undefined) return ownModel;
      if (own?.form === 'inherit') {
        return session === undefined ? NOT_VISIBLE : fromSetting(session, 'session');
      }
      return fallback;
    }
    case 'codex': {
      if (ownModel !== undefined) return ownModel;
      const subagents = context.get('codex', 'agents.default_subagent_model');
      if (subagents !== undefined) return fromSetting(subagents, 'setting');
      const session = context.get('codex', 'model');
      return session === undefined ? NOT_VISIBLE : fromSetting(session, 'session');
    }
    case 'gemini': {
      const name = definition.name;
      const override =
        name === undefined
          ? undefined
          : context.get('gemini', `agents.overrides.${name}.modelConfig.model`);
      if (override !== undefined) {
        return own === undefined
          ? fromSetting(override, 'setting')
          : {
              ...fromSetting(override, 'setting'),
              overridden: { key: override.key, file: override.file },
            };
      }
      if (ownModel !== undefined) return ownModel;
      const session = context.get('gemini', 'model.name');
      return session === undefined ? NOT_VISIBLE : fromSetting(session, 'session');
    }
    case 'copilot-cli': {
      if (ownModel !== undefined) return ownModel;
      const session = context.get('copilot-cli', 'model');
      return session === undefined ? NOT_VISIBLE : fromSetting(session, 'session');
    }
    case 'cursor':
    case 'copilot-vscode':
    case 'copilot-cloud':
    case 'windsurf':
    case 'cline':
      // The session's model, or Devin Local's default subagent model, is the user's choice.
      return ownModel ?? NOT_VISIBLE;
  }
}

/**
 * The definition with its effective model and digest. The digest covers what the file says and
 * what the agent does with it. It leaves out every line, so a line inserted above changes
 * nothing, and the effective model, which settings decide: a changed setting is a changed
 * setting, not a change of every definition that inherits it. For a file the agent may read and
 * agentcheckup cannot, it covers the file's text too.
 */
function finish(definition: Unsorted, context: Resolver): AgentDefinition {
  const {
    rank: _rank,
    ranked: _ranked,
    scope: _scope,
    key: _key,
    opaque,
    line,
    ...rest
  } = definition;
  const effective = effectiveModel(definition, context);
  const fields = { ...rest, effective };
  const withoutLine = <T extends { readonly line: number }>(value: T | undefined) => {
    if (value === undefined) return undefined;
    const { line: _line, ...other } = value;
    return other;
  };
  const digested = {
    ...rest,
    model: withoutLine(rest.model),
    effort: withoutLine(rest.effort),
    ...(opaque === undefined ? {} : { opaque }),
  };
  // A role `config.toml` declares has no file of its own: several share the config's path.
  const role = definition.file.endsWith('.codex/config.toml') ? `#${definition.name ?? ''}` : '';
  return {
    id: `agent:${definition.file}${role}@${definition.agent}`,
    line,
    ...fields,
    digest: hash53(canonicalJson(digested)),
  };
}
