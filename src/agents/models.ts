/**
 * The forms of model values each agent documents (src/agents/types.ts, ModelForm). A value in a
 * form the agent that reads it does not document is `not-documented`: what the agent does with it
 * is not documented either, so rules report it as a warning or, for a file another agent reads
 * too, as information, never as an error.
 *
 * Kept deliberately permissive where agents take any id: a custom model provider can make any
 * single word a valid model, so only values no form covers are `not-documented`.
 */
import type { ContextAgent } from '../platforms/load/types.js';
import type { ModelForm } from './types.js';

/**
 * Claude Code's model aliases, which `/model`, settings, skills and subagents accept, each also
 * with `[1m]` (SOURCES.claudeModelConfig, SOURCES.claudeSubagents). `default` clears an override.
 */
const CLAUDE_ALIASES: ReadonlySet<string> = new Set([
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'best',
  'opusplan',
  'default',
]);

/** The aliases of Claude's agent format, which Copilot in VS Code maps in `.claude/agents`. */
const CLAUDE_FORMAT_ALIASES: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku']);

/** One word of letters, digits and `._:/@-`, as model ids are written. */
const MODEL_WORD = /^[\w.:/@-]+$/;

/** Cursor's options after an id: `claude-opus-5[effort=high,context=300k]`. */
const CURSOR_OPTIONS = /^([\w.:/@-]+)\[[\w.=,-]*\]$/;

const ONE_M = '[1m]';

function withoutOneM(value: string): string {
  return value.endsWith(ONE_M) ? value.slice(0, -ONE_M.length) : value;
}

/**
 * A Claude model id: one word that names Claude, as the Anthropic API, Amazon Bedrock and Google
 * Cloud write them (`claude-opus-5-5`, `us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
 * `claude-sonnet-4-5@20250929`), or a Bedrock inference profile ARN, which need not name it.
 */
function isClaudeModelId(value: string): boolean {
  return (
    MODEL_WORD.test(value) &&
    (value.toLowerCase().includes('claude') || value.startsWith('arn:aws:bedrock:'))
  );
}

/** Claude Code: `inherit`, an alias, or a Claude model id, each optionally with `[1m]`. */
export function claudeModelForm(value: string): ModelForm {
  if (value === 'inherit') return 'inherit';
  const base = withoutOneM(value);
  if (CLAUDE_ALIASES.has(base)) return 'alias';
  return isClaudeModelId(base) ? 'id' : 'not-documented';
}

/**
 * Cursor: `inherit` or a Cursor model id, optionally with options in brackets
 * (SOURCES.cursorSubagents). Claude Code's aliases are not Cursor ids.
 */
export function cursorModelForm(value: string): ModelForm {
  if (value === 'inherit') return 'inherit';
  const id = CURSOR_OPTIONS.exec(value)?.[1] ?? value;
  if (CLAUDE_ALIASES.has(withoutOneM(id))) return 'not-documented';
  return MODEL_WORD.test(id) ? 'id' : 'not-documented';
}

/** Codex: a model id (SOURCES.codexSubagents). `inherit` is not one: leaving `model` out is. */
export function codexModelForm(value: string): ModelForm {
  return value !== 'inherit' && MODEL_WORD.test(value) ? 'id' : 'not-documented';
}

/** Gemini CLI: `inherit` or a model id (SOURCES.geminiSubagents). */
export function geminiModelForm(value: string): ModelForm {
  if (value === 'inherit') return 'inherit';
  return MODEL_WORD.test(value) ? 'id' : 'not-documented';
}

/**
 * GitHub Copilot's own agent files: a model id or the name the model picker shows, such as
 * `Claude Sonnet 4.5` or `GPT-5 (copilot)` (SOURCES.vscodeCustomAgentFile).
 */
export function copilotModelForm(value: string): ModelForm {
  if (value.trim() === '') return 'not-documented';
  return MODEL_WORD.test(value) ? 'id' : 'name';
}

/**
 * GitHub Copilot in VS Code reading a `.claude/agents` file: Claude's agent format, where `model`
 * is `sonnet`, `opus`, `haiku` or `inherit`, which it maps to its own models
 * (SOURCES.vscodeCustomAgentFile).
 */
export function copilotClaudeFormatModelForm(value: string): ModelForm {
  if (value === 'inherit') return 'inherit';
  return CLAUDE_FORMAT_ALIASES.has(value) ? 'alias' : 'not-documented';
}

/**
 * The Copilot CLI, in its own files and in `.claude/agents`: a model, as in its own files. It
 * documents no mapping of Claude Code's aliases, in any case, so in `.claude/agents` an alias is
 * not a value it documents. A model it cannot use runs the subagent on the session's model,
 * unless the definition sets `modelPolicy: "required"`, which refuses the call; that is what
 * `inherit` asks for, in either folder (SOURCES.copilotCliAgents).
 */
export function copilotCliModelForm(value: string, claudeFormat: boolean): ModelForm {
  if (value === 'inherit') return 'inherit';
  if (claudeFormat && CLAUDE_ALIASES.has(withoutOneM(value).toLowerCase())) {
    return 'not-documented';
  }
  return copilotModelForm(value);
}

/**
 * Devin Local: the values of the CLI's `--model` flag, such as `opus`, `sonnet`, `swe` or
 * `codex` (SOURCES.devinSubagents). The list is not closed, so any one word passes.
 */
export function devinModelForm(value: string): ModelForm {
  return MODEL_WORD.test(value) ? 'alias' : 'not-documented';
}

/** The form of `value` for an agent reading a file of its own format or Claude's. */
export function modelForm(agent: ContextAgent, value: string, claudeFormat: boolean): ModelForm {
  switch (agent) {
    case 'claude-code':
      return claudeModelForm(value);
    case 'cursor':
      return cursorModelForm(value);
    case 'codex':
      return codexModelForm(value);
    case 'gemini':
      return geminiModelForm(value);
    case 'copilot-cli':
      return copilotCliModelForm(value, claudeFormat);
    case 'copilot-vscode':
    case 'copilot-cloud':
      return claudeFormat ? copilotClaudeFormatModelForm(value) : copilotModelForm(value);
    case 'windsurf':
      return devinModelForm(value);
    case 'cline':
      return 'not-documented';
  }
}
