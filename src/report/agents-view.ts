/**
 * The agent definitions and model settings of a result as `agentcheckup agents` shows them,
 * shared by the terminal (agents-text.ts) and Markdown (agents-markdown.ts) output, so both say
 * the same. Pure. Strings are raw: each formatter sanitizes them for its channel.
 */
import type { AgentDefinition, EffectiveModel, ModelSetting } from '../agents/types.js';
import { compareStrings } from '../core/compare.js';
import type { ScanResult } from '../core/engine.js';
import { stripPathBase } from '../core/rebase.js';
import { AGENT_NAMES, ALL_CONTEXT_AGENTS } from '../platforms/load/types.js';
import { toJsonAgents } from './json.js';
import { plural } from './text.js';

/** One definition as one agent reads it. */
export interface DefinitionRow {
  /** The agent's name, such as `Copilot CLI`. */
  readonly agent: string;
  /** The name the agent knows it by; empty when the file gives none. */
  readonly name: string;
  /** The model as written: `opus`, `inherit`, `no model`; empty for a skipped file without one. */
  readonly model: string;
  /**
   * Where the model it runs with comes from when that is not the file, such as
   * `sonnet (session model, .claude/settings.json)` or `set outside the repository`; empty when
   * the file's own model applies or the agent does not load the file.
   */
  readonly runsOn: string;
  /** Effort as written, or empty. */
  readonly effort: string;
  /** Why the agent does not load it, or may not; empty when it loads. */
  readonly status: string;
  /** Something a reader should look at: the agent skips it, or ignores or may not read a value. */
  readonly warn: boolean;
  /** Neither documentation nor source code confirms how the agent reads the file. */
  readonly unverified: boolean;
}

export interface FileGroup {
  readonly file: string;
  /** In agent report order. */
  readonly rows: readonly DefinitionRow[];
}

export interface SettingRow {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly value: string;
  /** What it sets: `Claude Code subagents, forced`. */
  readonly applies: string;
}

export interface AgentsView {
  /** The scanned directory as the report's paths were rebased onto it; `''` when they were not. */
  readonly pathBase: string;
  /** Files in path order. */
  readonly files: readonly FileGroup[];
  readonly settings: readonly SettingRow[];
  readonly counts: {
    readonly definitions: number;
    readonly loads: number;
    readonly skipped: number;
    readonly shadowed: number;
    readonly unknown: number;
  };
  readonly unverified: boolean;
}

/** What the output says it cannot see. */
export const NOT_VISIBLE_NOTE =
  'Not visible here: the model a call passes, user and managed settings, and the environment. ' +
  '"Set outside the repository" marks a model chosen there.';

export const NO_DEFINITIONS = 'No agent definitions or model settings in this report.';

const AGENT_ORDER: ReadonlyMap<string, number> = new Map(
  ALL_CONTEXT_AGENTS.map((agent, index) => [agent, index]),
);

function joined(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

/** Where the model a definition runs with comes from, when not from its own file. */
function source(effective: EffectiveModel): string {
  if (effective.source === 'not-visible' || effective.value === undefined) {
    return 'set outside the repository';
  }
  const where = effective.file === undefined ? '' : `, ${effective.file}`;
  const what = effective.source === 'setting' ? 'subagent setting' : 'session model';
  return `${joined(effective.value)} (${what}${where})`;
}

function declaredText(definition: AgentDefinition): string {
  const { model } = definition;
  if (model === undefined) return 'no model';
  const note =
    model.form === 'not-documented'
      ? ` (not a value ${AGENT_NAMES[definition.agent]} documents)`
      : '';
  return `${joined(model.value)}${note}`;
}

function runsOnText(effective: EffectiveModel): string {
  if (effective.source === 'definition') return '';
  const ignored =
    effective.overridden === undefined
      ? ''
      : `; its own is ignored: ${effective.overridden.file} sets ${effective.overridden.key}`;
  return `${source(effective)}${ignored}`;
}

function statusText(definition: AgentDefinition): string {
  switch (definition.status) {
    case 'loads':
      return '';
    case 'skipped':
      return `skipped: ${definition.reason ?? 'not loaded'}`;
    case 'shadowed':
      return definition.shadowedBy === undefined
        ? `shadowed: ${definition.reason ?? 'another definition wins'}`
        : `shadowed by ${definition.shadowedBy}`;
    case 'unknown':
      return definition.reason === undefined
        ? 'may not load'
        : `may not load: ${definition.reason}`;
  }
}

function definitionRow(definition: AgentDefinition): DefinitionRow {
  // What a skipped or shadowed definition would run with does not matter.
  const runs = definition.status === 'loads' || definition.status === 'unknown';
  return {
    agent: AGENT_NAMES[definition.agent],
    name: definition.name ?? '',
    model: runs || definition.model !== undefined ? declaredText(definition) : '',
    runsOn: runs ? runsOnText(definition.effective) : '',
    effort: definition.effort?.value ?? '',
    status: statusText(definition),
    warn:
      definition.status === 'skipped' ||
      definition.model?.form === 'not-documented' ||
      definition.effective.overridden !== undefined,
    unverified: definition.certainty === 'unverified',
  };
}

const APPLIES: Readonly<Record<ModelSetting['applies'], string>> = {
  session: 'sessions',
  subagents: 'subagents',
  allowed: 'models allowed',
  alias: 'alias target',
};

function settingRow(setting: ModelSetting): SettingRow {
  return {
    file: setting.file,
    line: setting.line,
    key: setting.key,
    value: setting.value,
    applies: `${AGENT_NAMES[setting.agent]} ${APPLIES[setting.applies]}${setting.forced === true ? ', forced' : ''}`,
  };
}

/** The view of a result's definitions and settings, with paths relative to the scanned directory. */
export function agentsView(result: ScanResult): AgentsView {
  const pathBase = result.pathBase === undefined || result.pathBase === '.' ? '' : result.pathBase;
  const agents = stripPathBase(result).agents;
  const { definitions, settings } = toJsonAgents(agents ?? { definitions: [], settings: [] });
  const byFile = new Map<string, AgentDefinition[]>();
  for (const definition of definitions) {
    const list = byFile.get(definition.file);
    if (list === undefined) byFile.set(definition.file, [definition]);
    else list.push(definition);
  }
  const files = [...byFile.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([file, list]) => ({
      file,
      rows: [...list]
        .sort(
          (a, b) =>
            (AGENT_ORDER.get(a.agent) ?? 0) - (AGENT_ORDER.get(b.agent) ?? 0) ||
            compareStrings(a.id, b.id),
        )
        .map(definitionRow),
    }));
  const count = (status: AgentDefinition['status']): number =>
    definitions.filter((definition) => definition.status === status).length;
  return {
    pathBase,
    files,
    settings: [...settings]
      .sort(
        (a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.key, b.key),
      )
      .map(settingRow),
    counts: {
      definitions: definitions.length,
      loads: count('loads'),
      skipped: count('skipped'),
      shadowed: count('shadowed'),
      unknown: count('unknown'),
    },
    unverified: definitions.some((definition) => definition.certainty === 'unverified'),
  };
}

/** `11 agent definitions in 5 files (9 loaded, 1 skipped, 1 shadowed)`, or that there are none. */
export function summaryText(view: AgentsView): string {
  const { counts } = view;
  if (counts.definitions === 0) return 'No agent definitions';
  const states = [
    `${counts.loads} loaded`,
    counts.skipped > 0 ? `${counts.skipped} skipped` : '',
    counts.shadowed > 0 ? `${counts.shadowed} shadowed` : '',
    counts.unknown > 0 ? `${counts.unknown} may not load` : '',
  ].filter((part) => part !== '');
  return (
    `${plural(counts.definitions, 'agent definition')} in ${plural(view.files.length, 'file')} ` +
    `(${states.join(', ')})`
  );
}
