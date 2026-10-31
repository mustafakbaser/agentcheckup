import type { Nodes } from 'mdast';
import { RULESET_VERSION } from '../../core/meta.js';
import type { Span } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quote } from '../shared/format.js';
import { loadableSkills, reached, resolveImpacts } from './shared.js';
import { SKILL_SOURCES } from './sources.js';

/** A command Claude Code runs while it renders the skill. */
export interface InjectedCommand {
  readonly command: string;
  /** The whole placeholder: `` !`cmd` `` or the ```` ```! ```` block. */
  readonly span: Span;
}

const isBlank = (char: string | undefined): boolean =>
  char === undefined || char === ' ' || char === '\t' || char === '\n' || char === '\r';

const INJECTED = new WeakMap<
  Nodes,
  { readonly text: string; readonly commands: readonly InjectedCommand[] }
>();

/**
 * Finds the documented forms: `` !`command` `` where `!` starts a line or follows whitespace,
 * and fenced code blocks opened with ```` ```! ````. Commands inside other code blocks are not
 * the documented syntax and are left out.
 *
 * Found once per parsed document: three rules ask, in every scan that `fix` runs to verify its
 * fixes, and a file the fixes leave alone keeps its parse.
 */
export function injectedCommands(text: string, root: Nodes): readonly InjectedCommand[] {
  const cached = INJECTED.get(root);
  if (cached?.text === text) return cached.commands;
  const commands = findInjectedCommands(text, root);
  INJECTED.set(root, { text, commands });
  return commands;
}

function findInjectedCommands(text: string, root: Nodes): InjectedCommand[] {
  const found: InjectedCommand[] = [];
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (
        node.type === 'inlineCode' &&
        text.charAt(start) === '`' &&
        text.charAt(start + 1) !== '`' &&
        text.charAt(start - 1) === '!' &&
        isBlank(start >= 2 ? text.charAt(start - 2) : undefined)
      ) {
        found.push({ command: node.value, span: { offset: start - 1, length: end - start + 1 } });
      } else if (
        node.type === 'code' &&
        node.lang?.startsWith('!') === true &&
        text.slice(start, end).trimStart().startsWith('```')
      ) {
        found.push({ command: node.value, span: { offset: start, length: end - start } });
      }
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
  return found.sort((a, b) => a.span.offset - b.span.offset);
}

// ---------------------------------------------------------------------------------------------
// Dangerous commands
// ---------------------------------------------------------------------------------------------

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const FETCHERS: ReadonlySet<string> = new Set(['curl', 'wget']);
const PREFIXES: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'command',
  'exec',
  'env',
  'time',
  'nohup',
]);

const ASSIGNMENT = /^[a-z_]\w*=/i;

/** The words of one simple command, without environment assignments and wrappers. */
function commandWords(simple: string): string[] {
  const words = simple
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  let i = 0;
  let afterWrapper = false;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (ASSIGNMENT.test(word) || PREFIXES.has(word)) {
      afterWrapper = afterWrapper || PREFIXES.has(word);
    } else if (!(afterWrapper && word.startsWith('-'))) {
      break;
    }
    i++;
  }
  return words.slice(i);
}

/** `/usr/bin/bash` -> `bash`. */
function programName(word: string | undefined): string {
  if (word === undefined) return '';
  return word.slice(word.lastIndexOf('/') + 1);
}

interface Stage {
  readonly words: string[];
  /** True when this stage is piped into the next one with `|`. */
  readonly pipesOn: boolean;
}

/** Splits a command line into simple commands at `;`, `&&`, `||`, `|`, `&`, newlines and parentheses. */
function stages(command: string): Stage[] {
  const result: Stage[] = [];
  let current = '';
  const flush = (pipesOn: boolean) => {
    result.push({ words: commandWords(current), pipesOn });
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    const next = command.charAt(i + 1);
    if (char === '|' && next !== '|') {
      flush(true);
    } else if ((char === '|' && next === '|') || (char === '&' && next === '&')) {
      flush(false);
      i++;
    } else if (
      char === ';' ||
      char === '&' ||
      char === '\n' ||
      char === '(' ||
      char === ')' ||
      char === '`'
    ) {
      flush(false);
    } else {
      current += char;
    }
  }
  flush(false);
  return result;
}

function isRecursiveForceRemove(words: readonly string[]): boolean {
  if (programName(words[0]) !== 'rm') return false;
  let recursive = false;
  let force = false;
  for (const word of words.slice(1)) {
    if (word === '--') break;
    if (word === '--recursive') recursive = true;
    else if (word === '--force') force = true;
    else if (word.startsWith('-') && !word.startsWith('--')) {
      if (word.includes('r') || word.includes('R')) recursive = true;
      if (word.includes('f')) force = true;
    }
  }
  return recursive && force;
}

/** What makes the command dangerous, as a verb phrase, or undefined. */
export function dangerousCommand(command: string): string | undefined {
  const all = stages(command);
  let fetching = false;
  for (const stage of all) {
    const program = programName(stage.words[0]);
    if (fetching && SHELLS.has(program)) return 'pipes downloaded content into a shell';
    if (FETCHERS.has(program)) fetching = stage.pipesOn;
    else if (!stage.pipesOn) fetching = false;
  }
  const runsShell = all.some((stage) => {
    const program = programName(stage.words[0]);
    return SHELLS.has(program) || program === 'source' || program === '.';
  });
  if (runsShell && /[$<]\(\s*(?:curl|wget)\b/.test(command)) {
    return 'runs downloaded content in a shell';
  }
  if (all.some((stage) => programName(stage.words[0]) === 'eval')) return 'runs text through eval';
  if (all.some((stage) => isRecursiveForceRemove(stage.words)))
    return 'deletes files recursively without confirmation';
  return undefined;
}

/** Joins lines that continue on the next one: a trailing backslash, `|`, `&&` or `||`. */
function logicalLines(command: string): string[] {
  const lines: string[] = [];
  let pending = '';
  for (const line of command.split('\n')) {
    const joined = pending === '' ? line : `${pending} ${line.trimStart()}`;
    const end = joined.trimEnd();
    if (end.endsWith('\\')) {
      pending = end.slice(0, -1).trimEnd();
    } else if (end.endsWith('|') || end.endsWith('&&')) {
      pending = end;
    } else {
      pending = '';
      if (end.trim() !== '') lines.push(end.trim());
    }
  }
  if (pending.trim() !== '') lines.push(pending.trim());
  return lines;
}

/**
 * The part of an injected command to show: the first line of a multi-line block that is
 * dangerous on its own, else the whole command.
 */
export function offendingCommand(command: string): string {
  const lines = logicalLines(command);
  if (lines.length > 1) {
    for (const line of lines) if (dangerousCommand(line) !== undefined) return line;
  }
  return command.trim();
}

export const shellPreprocessingRule = defineRule({
  meta: {
    id: 'skill/shell-preprocessing',
    title: 'Skill runs a risky shell command before Claude reads it',
    rationale: `In a skill, a code span that follows an exclamation mark at the start of a line or after whitespace, such as \`\` !\`git status\` \`\`, and a fenced code block opened with \`\` \`\`\`! \`\`, are shell commands. Claude Code runs them when the skill is invoked, before Claude sees the skill, and replaces them with their output. They never prompt: Claude Code checks each command against your permission rules, and outside auto mode a command that is not allowed aborts the skill. A command that your rules or the skill's \`allowed-tools\` allow runs without asking.

This rule reports injected commands that pipe downloaded content into a shell, run \`eval\`, or delete files with \`rm -rf\`. Ordinary commands such as \`git status\` are not reported.

Review these commands before you invoke the skill, or set \`disableSkillShellExecution\` to \`true\` in managed settings to replace them with a placeholder.`,
    category: 'risk',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSkills, SKILL_SOURCES.claudePermissions],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      if (reached(context, artifact, ['claude-code']).length === 0) continue;
      const commands = injectedCommands(artifact.decoded.text, context.markdown(artifact).root);
      for (const injected of commands) {
        const reason = dangerousCommand(injected.command);
        if (reason === undefined) continue;
        const resolved = resolveImpacts(context, artifact, [
          { platform: 'claude-code', severity: 'warn' },
        ]);
        if (resolved === undefined) continue;
        context.report({
          artifact,
          message: `Injected command ${quote(offendingCommand(injected.command))} ${reason}. Claude Code runs it without asking when the skill is invoked, before Claude sees the skill, if your permission rules or the skill's \`allowed-tools\` allow it.`,
          severity: resolved.severity,
          platforms: resolved.platforms,
          span: injected.span,
          guidance:
            'replace the injected command with a pinned, reviewed one, or remove the "!" so that Claude Code shows the command instead of running it',
        });
      }
    }
  },
});
