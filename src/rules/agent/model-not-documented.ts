import { buildAgents } from '../../agents/index.js';
import type { AgentDefinition } from '../../agents/types.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { lineSpan } from '../../core/text.js';
import type { Artifact, PlatformId } from '../../core/types.js';
import { viewOf } from '../../platforms/load/view.js';
import {
  AGENT_NAMES,
  ALL_CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type ContextAgent,
} from '../../platforms/load/types.js';
import { defineRule } from '../define.js';
import { joinNames, quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { artifactsByReading, inOwnFormat } from './readings.js';

const ID = 'agent/model-not-documented';

const COPILOT_FORMS = 'a model id, or a model name as the model picker shows it';

/** The `model` values each agent documents in its own agent files. */
const OWN_FORMS: Readonly<Record<ContextAgent, string>> = {
  'claude-code': 'sonnet, opus, haiku, fable, a full model id such as claude-opus-5-5, or inherit',
  codex: "a model id; leave model out to use the parent session's model",
  cursor: 'inherit or a Cursor model id',
  gemini: 'inherit or a model id',
  'copilot-cli': COPILOT_FORMS,
  'copilot-vscode': COPILOT_FORMS,
  'copilot-cloud': COPILOT_FORMS,
  windsurf: "a value of Devin Local's --model flag, such as opus, sonnet, swe or codex",
  cline: 'no model field',
};

function valueText(definition: AgentDefinition): string {
  const value = definition.model?.value ?? '';
  return typeof value === 'string' ? value : value.join(', ');
}

/** `"X" is not a model value Claude Code documents. Claude Code takes …. What it does …` */
function message(group: readonly AgentDefinition[]): string {
  const [first] = group;
  const names = joinNames(group.map((definition) => AGENT_NAMES[definition.agent]));
  const plural = group.length > 1;
  const value = first === undefined ? '' : valueText(first);
  const byForms = new Map<string, string[]>();
  for (const definition of group) {
    const forms = OWN_FORMS[definition.agent];
    byForms.set(forms, [...(byForms.get(forms) ?? []), AGENT_NAMES[definition.agent]]);
  }
  const forms = [...byForms]
    .map(
      ([text, agents]) => `${joinNames(agents)} ${agents.length === 1 ? 'takes' : 'take'} ${text}.`,
    )
    .join(' ');
  return (
    `${quote(value)} is not a model value ${names} ${plural ? 'document' : 'documents'}. ` +
    `${forms} What ${plural ? 'they do' : 'it does'} with it is not documented.`
  );
}

export const modelNotDocumentedRule = defineRule({
  meta: {
    id: ID,
    title: 'Agent definition sets a model value the agent does not document',
    rationale: [
      'Each agent documents the values its agent files take for `model`. Claude Code takes an alias (`sonnet`, `opus`, `haiku`, `fable`), a full model id or `inherit`; Cursor takes `inherit` or one of its model ids; Gemini CLI takes `inherit` or a model id; Codex takes a model id; GitHub Copilot takes a model id or the name its model picker shows; Devin Local takes the values of its `--model` flag. A value outside them, such as `Claude Sonnet 4` for Claude Code, may run the agent on another model than the one you meant, or none: what the agent does with it is not documented.',
      "The rule judges a file by the agent whose format it is. Cursor and the Copilot CLI read Claude Code's `.claude/agents` too, where a Claude alias is not a value they document, though Copilot in VS Code maps it; `agentcheckup agents` shows that, and the file is right for Claude Code, so it is not reported. A file `.claude/agents` reaches through a symlink is judged as Claude Code's too.",
      'Set a value the agent documents, or remove `model` to use the default.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'warn',
    appliesTo: [
      'claude-agent',
      'codex-agent',
      'cursor-agent',
      'gemini-agent',
      'copilot-agent',
      'devin-agent',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf'],
    sources: [
      SOURCES.claudeSubagents,
      SOURCES.claudeModelConfig,
      SOURCES.codexSubagents,
      SOURCES.cursorSubagents,
      SOURCES.geminiSubagents,
      SOURCES.vscodeCustomAgents,
      SOURCES.vscodeCustomAgentFile,
      SOURCES.copilotCliAgents,
      SOURCES.devinSubagents,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    const artifacts = artifactsByReading(context.artifacts);
    if (artifacts.size === 0) return;
    // One finding per model value, naming every agent that does not document it.
    const groups = new Map<string, { artifact: Artifact; group: AgentDefinition[] }>();
    for (const definition of buildAgents(viewOf(context)).definitions) {
      const artifact = artifacts.get(definition.file);
      const { model } = definition;
      if (artifact === undefined || model?.form !== 'not-documented') continue;
      if (!inOwnFormat(definition)) continue;
      // A file the agent skips, or loses to another one, runs on no model at all.
      if (definition.status !== 'loads' && definition.status !== 'unknown') continue;
      if (!context.targets.has(CONTEXT_PLATFORM[definition.agent])) continue;
      const key = `${definition.file}\u0000${model.line}`;
      const entry = groups.get(key) ?? { artifact, group: [] };
      entry.group.push(definition);
      groups.set(key, entry);
    }
    for (const { artifact, group: found } of groups.values()) {
      // In the order agentcheckup lists agents.
      const group = [...found].sort(
        (a, b) => ALL_CONTEXT_AGENTS.indexOf(a.agent) - ALL_CONTEXT_AGENTS.indexOf(b.agent),
      );
      const [first] = group;
      if (first?.model === undefined) continue;
      const platforms: PlatformId[] = [
        ...new Set(group.map((definition) => CONTEXT_PLATFORM[definition.agent])),
      ];
      const agents = joinNames(group.map((definition) => AGENT_NAMES[definition.agent]));
      context.report({
        artifact,
        span: lineSpan(artifact.decoded, first.model.line),
        message: message(group),
        platforms,
        guidance: `set model to a value ${agents} ${group.length === 1 ? 'documents' : 'document'}, or remove it`,
      });
    }
  },
});
