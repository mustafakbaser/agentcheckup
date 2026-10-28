/**
 * Repository settings that pick a model or an effort for an agent's sessions or subagents
 * (src/agents/types.ts, ModelSetting). Only documented keys of files an agent reads from the
 * repository. Values are shown as written, but with credentials removed: a model name is not a
 * secret, a URL someone puts there may carry one.
 */
import { compareStrings } from '../core/compare.js';
import { hash53 } from '../core/fingerprint.js';
import { positionAt } from '../core/text.js';
import type { Artifact, Span } from '../core/types.js';
import { redactShown } from '../inventory/redact.js';
import { canonicalJson } from '../platforms/inventory-ids.js';
import {
  isTable,
  type JsonPath,
  keySpanOf,
  type SpannedDocument,
  spanOf,
} from '../parse/json-access.js';
import type { LoadView } from '../platforms/load/view.js';
import {
  CLAUDE_PROJECT_SETTINGS,
  claudeProjectSettings,
  isTruthy,
  lastSetting,
  settingAt,
} from '../platforms/root-settings.js';
import type { ContextAgent } from '../platforms/load/types.js';
import type { ModelSetting } from './types.js';

function lineOf(artifact: Artifact, span: Span | undefined): number {
  return span === undefined ? 1 : positionAt(artifact.decoded, span.offset).line;
}

/**
 * A string, a number or a boolean as text (an environment value becomes a string), or a list of
 * strings joined with `, `; undefined otherwise.
 */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(', ');
  }
  return undefined;
}

export { isTruthy } from '../platforms/root-settings.js';

/**
 * `inherit` or nothing: `CLAUDE_CODE_SUBAGENT_MODEL` set so is the same as unset
 * (SOURCES.claudeSubagents).
 */
export function isUnsetModel(value: string): boolean {
  const text = value.trim();
  return text === '' || text === 'inherit';
}

interface Wanted {
  readonly path: JsonPath;
  readonly applies: ModelSetting['applies'];
}

/**
 * Claude Code settings (SOURCES.claudeModelConfig, SOURCES.claudeSubagents): the session's model
 * (`env.ANTHROPIC_MODEL`, then `model`, then the default `env.ANTHROPIC_DEFAULT_MODEL`), its
 * effort, the subagents' model, the models allowed, and what the `opus`, `sonnet`, `haiku` and
 * `fable` aliases resolve to. `env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE` makes Claude Code ignore
 * every subagent's own `model`.
 */
const CLAUDE_KEYS: readonly Wanted[] = [
  { path: ['model'], applies: 'session' },
  { path: ['env', 'ANTHROPIC_MODEL'], applies: 'session' },
  { path: ['env', 'ANTHROPIC_DEFAULT_MODEL'], applies: 'session' },
  { path: ['effortLevel'], applies: 'session' },
  { path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'], applies: 'subagents' },
  { path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'], applies: 'subagents' },
  { path: ['availableModels'], applies: 'allowed' },
  { path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], applies: 'alias' },
  { path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], applies: 'alias' },
  { path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], applies: 'alias' },
  { path: ['env', 'ANTHROPIC_DEFAULT_FABLE_MODEL'], applies: 'alias' },
];

/**
 * Codex `config.toml` (SOURCES.codexConfigReference, SOURCES.codexSubagents): a project file may
 * set the session's model and effort, and the subagents' defaults in `[agents]`.
 */
const CODEX_KEYS: readonly Wanted[] = [
  { path: ['model'], applies: 'session' },
  { path: ['model_reasoning_effort'], applies: 'session' },
  { path: ['agents', 'default_subagent_model'], applies: 'subagents' },
  { path: ['agents', 'default_subagent_reasoning_effort'], applies: 'subagents' },
];

/** Gemini CLI's session model (`model.name`). Per-agent overrides are read on their own. */
const GEMINI_KEYS: readonly Wanted[] = [{ path: ['model', 'name'], applies: 'session' }];

/**
 * GitHub Copilot CLI's repository settings, `.github/copilot/settings.json`, which may set the
 * session's model and effort in a trusted folder (SOURCES.copilotCliAgents).
 */
const COPILOT_KEYS: readonly Wanted[] = [
  { path: ['model'], applies: 'session' },
  { path: ['effortLevel'], applies: 'session' },
];

/**
 * Whether `env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on for a session at the root: in
 * `.claude/settings.local.json` when it sets the switch, else in `.claude/settings.json`.
 */
function rootForce(view: LoadView): boolean {
  return isTruthy(
    lastSetting(claudeProjectSettings(view, ''), ['env', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']),
  );
}

/** Every model setting the repository's settings files declare, sorted by id. */
export function buildModelSettings(view: LoadView): ModelSetting[] {
  const out: ModelSetting[] = [];
  const add = (
    artifact: Artifact,
    doc: SpannedDocument,
    agent: ContextAgent,
    wanted: Wanted,
    extra: Partial<Pick<ModelSetting, 'forced'>> = {},
  ): void => {
    const raw = textOf(settingAt(doc, wanted.path));
    if (raw === undefined) return;
    const key = wanted.path.join('.');
    const fields = { agent, key, value: redactShown(raw), applies: wanted.applies, ...extra };
    out.push({
      id: `model:${artifact.path}#${key}`,
      file: artifact.path,
      line: lineOf(artifact, spanOf(doc, wanted.path) ?? keySpanOf(doc, wanted.path)),
      ...fields,
      digest: hash53(canonicalJson(fields)),
    });
  };

  const forcedAtRoot = rootForce(view);
  for (const artifact of view.artifacts) {
    const { kind } = artifact;
    if (kind === 'claude-settings') {
      const doc = view.json(artifact);
      if (!doc.ok) continue;
      // At the root, the local file's switch counts for the shared file's model too.
      const forced = CLAUDE_PROJECT_SETTINGS.includes(artifact.path)
        ? forcedAtRoot
        : isTruthy(settingAt(doc, ['env', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']));
      for (const wanted of CLAUDE_KEYS) {
        const subagentModel = wanted.path[1] === 'CLAUDE_CODE_SUBAGENT_MODEL';
        add(artifact, doc, 'claude-code', wanted, subagentModel && forced ? { forced } : {});
      }
    } else if (kind === 'codex-config') {
      const doc = view.toml(artifact);
      if (doc.ok) for (const wanted of CODEX_KEYS) add(artifact, doc, 'codex', wanted);
    } else if (kind === 'gemini-settings') {
      const doc = view.json(artifact);
      if (!doc.ok) continue;
      for (const wanted of GEMINI_KEYS) add(artifact, doc, 'gemini', wanted);
      // `agents.overrides.<name>.modelConfig.model` picks one agent's model.
      const overrides = settingAt(doc, ['agents', 'overrides']);
      if (isTable(overrides)) {
        for (const name of Object.keys(overrides)) {
          const path = ['agents', 'overrides', name, 'modelConfig', 'model'];
          add(artifact, doc, 'gemini', { path, applies: 'subagents' });
        }
      }
    } else if (kind === 'copilot-settings') {
      const doc = view.json(artifact);
      if (doc.ok) for (const wanted of COPILOT_KEYS) add(artifact, doc, 'copilot-cli', wanted);
    }
  }
  return out.sort((a, b) => compareStrings(a.id, b.id));
}

/** Keys whose value is a model, rather than an effort, a switch or a list of models allowed. */
const MODEL_KEYS: ReadonlySet<string> = new Set([
  'model',
  'env.ANTHROPIC_MODEL',
  'env.ANTHROPIC_DEFAULT_MODEL',
  'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
  'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
  'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'env.ANTHROPIC_DEFAULT_FABLE_MODEL',
  'env.CLAUDE_CODE_SUBAGENT_MODEL',
  'agents.default_subagent_model',
  'model.name',
]);

/**
 * True when `setting` picks a model: `model`, `env.CLAUDE_CODE_SUBAGENT_MODEL`, what an alias
 * resolves to, and the like. `CLAUDE_CODE_SUBAGENT_MODEL` set to `inherit` picks none.
 */
export function isModelChoice(setting: ModelSetting): boolean {
  if (setting.key === 'env.CLAUDE_CODE_SUBAGENT_MODEL' && isUnsetModel(setting.value)) {
    return false;
  }
  return (
    MODEL_KEYS.has(setting.key) ||
    (setting.agent === 'gemini' && setting.key.endsWith('.modelConfig.model'))
  );
}
