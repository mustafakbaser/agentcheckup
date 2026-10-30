/**
 * Builds the agent definitions (src/agents/types.ts) from a scan's analysis: every custom agent
 * and subagent file, once for each agent that reads it from the repository root, with the model
 * it runs with as far as the repository tells. Pure: it reads only the snapshot and the parses the
 * rules already made. See docs/adr/0013-list-agent-definitions-and-their-models.md.
 *
 * Which agent reads which file, and what it does with it, is src/platforms/agent-files.ts, which
 * the load plans share. This module reads each definition's model, effort, tools and permission
 * mode, resolves the model it runs with, and digests it.
 */
import { compareStrings } from '../core/compare.js';
import { hash53 } from '../core/fingerprint.js';
import { positionAt } from '../core/text.js';
import type { Artifact, Span } from '../core/types.js';
import { redactShown } from '../inventory/redact.js';
import { isTable, own, type SpannedDocument } from '../parse/json-access.js';
import {
  type AgentFile,
  definitionFiles,
  type FileFields,
  stringField,
} from '../platforms/agent-files.js';
import { canonicalJson } from '../platforms/inventory-ids.js';
import type { LoadView } from '../platforms/load/view.js';
import type { ContextAgent } from '../platforms/load/types.js';
import { modelForm } from './models.js';
import { buildModelSettings, isTruthy, isUnsetModel } from './settings.js';
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
  const finished = definitionFiles(view).map((file) => finish(file, context));
  return {
    definitions: finished.sort((a, b) => compareStrings(a.id, b.id)),
    settings,
  };
}

// ---------------------------------------------------------------------------------------------
// What a definition says: model, effort, tools, permission mode
// ---------------------------------------------------------------------------------------------

/** The fields of a definition that come from its file, before its effective model. */
type Details = Pick<AgentDefinition, 'model' | 'effort' | 'tools' | 'permissionMode'>;

function lineOf(artifact: Artifact, span: Span | undefined): number {
  return span === undefined ? 1 : positionAt(artifact.decoded, span.offset).line;
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
  fields: FileFields,
  agent: ContextAgent,
  claudeFormat: boolean,
): ModelValue | undefined {
  // The Copilot CLI tries `models` in order, and it overrides `model`, in `.claude/agents` too
  // (SOURCES.copilotCliAgents).
  const models = agent === 'copilot-cli' ? stringList(own(fields.values, 'models')) : undefined;
  if (models !== undefined) {
    return modelValue(agent, models, claudeFormat, lineOf(artifact, fields.span('models')));
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

/** The keys each agent reads a reasoning effort from. */
const EFFORT_KEYS: Readonly<Partial<Record<ContextAgent, readonly string[]>>> = {
  'claude-code': ['effort'],
  'copilot-vscode': ['reasoning-effort'],
  'copilot-cli': ['reasoningEffort'],
};

function effortField(
  artifact: Artifact,
  fields: FileFields,
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

function toolsOf(agent: ContextAgent, fields: FileFields): AgentDefinition['tools'] {
  if (agent === 'cursor') {
    return own(fields.values, 'readonly') === true ? 'read-only' : 'inherited';
  }
  const keys = agent === 'windsurf' ? ['allowed-tools', 'tools'] : ['tools'];
  return keys.some((key) => Object.hasOwn(fields.values, key)) ? 'listed' : 'inherited';
}

function codexModel(artifact: Artifact, doc: SpannedDocument): ModelValue | undefined {
  const value = isTable(doc.value) ? own(doc.value, 'model') : undefined;
  if (value === undefined) return undefined;
  const line = lineOf(artifact, doc.valueSpan(['model']));
  return typeof value === 'string'
    ? modelValue('codex', value, false, line)
    : { value: redactShown(JSON.stringify(value)), form: 'not-documented', line };
}

/** The model, effort, tools and permission mode the file gives the agent. */
function detailsOf(file: AgentFile): Details {
  const { source, agent } = file;
  switch (source.kind) {
    case 'none':
      return { tools: 'inherited' };
    case 'toml': {
      const { artifact, doc } = source;
      const model = codexModel(artifact, doc);
      const effort = isTable(doc.value) ? own(doc.value, 'model_reasoning_effort') : undefined;
      return {
        ...(model === undefined ? {} : { model }),
        ...(typeof effort === 'string' && effort.trim() !== ''
          ? {
              effort: {
                value: redactShown(effort),
                line: lineOf(artifact, doc.valueSpan(['model_reasoning_effort'])),
              },
            }
          : {}),
        tools: 'inherited',
      };
    }
    case 'frontmatter': {
      const { artifact, fields, claudeFormat } = source;
      const model = frontmatterModel(artifact, fields, agent, claudeFormat);
      const effort = effortField(artifact, fields, EFFORT_KEYS[agent] ?? []);
      // Claude Code's `permissionMode`; the agents that read its folder do not document it.
      const mode = agent === 'claude-code' ? stringField(fields, 'permissionMode') : undefined;
      return {
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        tools: toolsOf(agent, fields),
        ...(mode === undefined ? {} : { permissionMode: redactShown(mode) }),
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Effective models and digests
// ---------------------------------------------------------------------------------------------

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

/**
 * The model a definition runs with, as the agent's documented order picks it. `unseen`: the agent
 * may read a model from the file that agentcheckup cannot see, such as behind a `<<` merge key or
 * in a file the scan did not read; then only a setting that overrides every definition's own
 * model tells which one it runs on.
 */
function effectiveModel(
  definition: Pick<AgentDefinition, 'agent' | 'name' | 'model'>,
  context: Resolver,
  unseen: boolean,
): EffectiveModel {
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
        return own === undefined && !unseen
          ? fallback
          : { ...fallback, overridden: { key: force.key, file: force.file } };
      }
      if (unseen) return NOT_VISIBLE;
      if (ownModel !== undefined) return ownModel;
      if (own?.form === 'inherit') {
        return session === undefined ? NOT_VISIBLE : fromSetting(session, 'session');
      }
      return fallback;
    }
    case 'codex': {
      if (unseen) return NOT_VISIBLE;
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
        return own === undefined && !unseen
          ? fromSetting(override, 'setting')
          : {
              ...fromSetting(override, 'setting'),
              overridden: { key: override.key, file: override.file },
            };
      }
      if (unseen) return NOT_VISIBLE;
      if (ownModel !== undefined) return ownModel;
      const session = context.get('gemini', 'model.name');
      return session === undefined ? NOT_VISIBLE : fromSetting(session, 'session');
    }
    case 'copilot-cli': {
      if (unseen) return NOT_VISIBLE;
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
function finish(file: AgentFile, context: Resolver): AgentDefinition {
  const {
    rank: _rank,
    ranked: _ranked,
    scope: _scope,
    key: _key,
    source: _source,
    skip: _skip,
    description: _description,
    opaque,
    line,
    ...rest
  } = file;
  const said = { ...rest, ...detailsOf(file) };
  const unseen = opaque !== undefined && said.model === undefined;
  const effective = effectiveModel(said, context, unseen);
  const withoutLine = <T extends { readonly line: number }>(value: T | undefined) => {
    if (value === undefined) return undefined;
    const { line: _line, ...other } = value;
    return other;
  };
  const digested = {
    ...said,
    model: withoutLine(said.model),
    effort: withoutLine(said.effort),
    ...(opaque === undefined ? {} : { opaque }),
  };
  // A role `config.toml` declares has no file of its own: several share the config's path.
  const role = file.file.endsWith('.codex/config.toml') ? `#${file.name ?? ''}` : '';
  return {
    id: `agent:${file.file}${role}@${file.agent}`,
    line,
    ...said,
    effective,
    digest: hash53(canonicalJson(digested)),
  };
}
