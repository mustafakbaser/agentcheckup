/**
 * A deliberately small reading of the first words of a hook `command`. It understands quoting,
 * backslash escapes and the project-directory variables; anything else that a shell would expand
 * (other variables, command substitution, globs, `~`) makes the word unresolvable, and callers
 * then report nothing.
 */
import { joinRelative, pathStatus } from '../core/paths.js';
import type { Snapshot } from '../core/types.js';
import { type JsonObject, type JsonPath, own } from '../parse/json-access.js';
import type { HookPlatform } from './hooks.js';
import { basename } from './paths.js';

/** Marks "the project root" at the start of a resolved word. */
export const ROOT = '\u0000';

export interface Word {
  readonly text: string;
  readonly resolvable: boolean;
}

export interface CommandSyntax {
  /** Environment variables that hold the project root, e.g. `CLAUDE_PROJECT_DIR`. */
  readonly rootVariables: readonly string[];
  /** Whether `$(git rev-parse --show-toplevel)` names the project root. */
  readonly gitTopLevel: boolean;
}

const GIT_TOP_LEVEL = '$(git rev-parse --show-toplevel)';
const MAX_WORDS = 3;
const MAX_COMMAND = 4096;

function isBlank(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isNameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f
  );
}

/** Reads `$NAME`, `${NAME}` or the git form at `i`. Returns the replacement and next index. */
function readDollar(
  command: string,
  i: number,
  syntax: CommandSyntax,
): { text: string; next: number } | undefined {
  if (syntax.gitTopLevel && command.startsWith(GIT_TOP_LEVEL, i)) {
    return { text: ROOT, next: i + GIT_TOP_LEVEL.length };
  }
  let name: string;
  let next: number;
  if (command.charAt(i + 1) === '{') {
    const close = command.indexOf('}', i + 2);
    if (close === -1) return undefined;
    name = command.slice(i + 2, close);
    next = close + 1;
  } else {
    let end = i + 1;
    while (end < command.length && isNameChar(command.charAt(end))) end++;
    name = command.slice(i + 1, end);
    next = end;
  }
  return syntax.rootVariables.includes(name) ? { text: ROOT, next } : undefined;
}

/** The first words of `command`, up to the first shell operator. */
export function firstWords(command: string, syntax: CommandSyntax): Word[] {
  const words: Word[] = [];
  const text = command.slice(0, MAX_COMMAND);
  let i = 0;
  while (words.length < MAX_WORDS) {
    while (i < text.length && isBlank(text.charAt(i))) i++;
    if (i >= text.length) break;
    let word = '';
    let resolvable = true;
    let ended = false;
    while (i < text.length && !isBlank(text.charAt(i))) {
      const char = text.charAt(i);
      if (';&|<>()'.includes(char)) {
        ended = true;
        break;
      }
      if (char === '\\') {
        word += text.charAt(i + 1);
        i += 2;
      } else if (char === "'") {
        const close = text.indexOf("'", i + 1);
        if (close === -1) return [...words, { text: word, resolvable: false }];
        word += text.slice(i + 1, close);
        i = close + 1;
      } else if (char === '"') {
        i++;
        while (i < text.length && text.charAt(i) !== '"') {
          const inner = text.charAt(i);
          if (inner === '\\' && '"\\$`'.includes(text.charAt(i + 1))) {
            word += text.charAt(i + 1);
            i += 2;
          } else if (inner === '$') {
            const expansion = readDollar(text, i, syntax);
            if (expansion === undefined) resolvable = false;
            word += expansion?.text ?? '$';
            i = expansion?.next ?? i + 1;
          } else {
            if (inner === '`') resolvable = false;
            word += inner;
            i++;
          }
        }
        if (i >= text.length) resolvable = false;
        i++;
      } else if (char === '$') {
        const expansion = readDollar(text, i, syntax);
        if (expansion === undefined) resolvable = false;
        word += expansion?.text ?? '$';
        i = expansion?.next ?? i + 1;
      } else {
        if ('`*?[{~'.includes(char) && !(char === '~' && word !== '')) resolvable = false;
        word += char;
        i++;
      }
    }
    words.push({ text: word, resolvable: resolvable && !word.slice(1).includes(ROOT) });
    if (ended) break;
  }
  return words;
}

const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'bash',
  'sh',
  'zsh',
  'ruby',
  'perl',
  'tsx',
  'ts-node',
  'bun',
]);

const SCRIPT_EXTENSIONS = [
  '.sh',
  '.bash',
  '.zsh',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.py',
  '.rb',
  '.pl',
];

function hasScriptExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isInterpreter(word: string): boolean {
  return INTERPRETERS.has(basename(word));
}

/**
 * The script a command runs: the first word when it is a path, or the script argument of an
 * interpreter (`node x.js`, `bash ./x.sh`). Undefined when the command runs a program from PATH,
 * passes options to the interpreter, or anything is unresolvable.
 */
export function scriptWord(words: readonly Word[]): Word | undefined {
  const first = words[0];
  if (first === undefined || !first.resolvable || first.text.includes('=')) return undefined;
  if (isInterpreter(first.text)) {
    const script = words[1];
    if (script === undefined || !script.resolvable || script.text.startsWith('-')) return undefined;
    return script.text.includes('/') || hasScriptExtension(script.text) ? script : undefined;
  }
  return first.text.includes('/') ? first : undefined;
}

// ---------------------------------------------------------------------------------------------
// The script a hook runs
// ---------------------------------------------------------------------------------------------

/**
 * How a platform's hook commands name the project root: `$CLAUDE_PROJECT_DIR` in Claude Code,
 * `$CURSOR_PROJECT_DIR` (or the Claude variable) in Cursor, and `$(git rev-parse --show-toplevel)`
 * in a `.codex/hooks.json` at the root of a git checkout.
 */
export function hookCommandSyntax(
  snapshot: Snapshot,
  platform: HookPlatform,
  root: string,
): CommandSyntax {
  return {
    rootVariables:
      platform === 'claude-code'
        ? ['CLAUDE_PROJECT_DIR']
        : platform === 'cursor'
          ? ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']
          : [],
    gitTopLevel: platform === 'codex' && root === '' && pathStatus(snapshot, '.git') === 'exists',
  };
}

export interface ScriptCandidate {
  readonly word: Word;
  /** JSON path of the string the word came from. */
  readonly path: JsonPath;
}

/** The script word of a hook handler and the JSON path of the string it came from. */
export function scriptCandidate(
  handler: JsonObject,
  path: JsonPath,
  syntax: CommandSyntax,
): ScriptCandidate | undefined {
  const command = own(handler, 'command');
  if (typeof command !== 'string') return undefined;
  const args = own(handler, 'args');
  if (!Array.isArray(args)) {
    const word = scriptWord(firstWords(command, syntax));
    return word === undefined ? undefined : { word, path: [...path, 'command'] };
  }
  // Claude Code exec form: `command` is the executable, run without a shell.
  const placeholder = (text: string): Word => {
    for (const variable of syntax.rootVariables) {
      const token = `\${${variable}}`;
      if (text.startsWith(token)) {
        const rest = text.slice(token.length);
        return { text: ROOT + rest, resolvable: !rest.includes('$') };
      }
    }
    return { text, resolvable: !text.includes('$') && !text.startsWith('~') };
  };
  if (isInterpreter(command)) {
    const first: unknown = args[0];
    if (typeof first !== 'string' || first.startsWith('-')) return undefined;
    const word = placeholder(first);
    return word.resolvable ? { word, path: [...path, 'args', 0] } : undefined;
  }
  const word = placeholder(command);
  return word.resolvable && word.text.includes('/')
    ? { word, path: [...path, 'command'] }
    : undefined;
}

/**
 * The root-relative path a script word names. `plain` is true for a relative path without a
 * root variable, which Cursor resolves against the project root and Claude Code against the
 * session's working directory. Undefined for absolute paths, Windows paths, paths that leave the
 * scan root, and relative paths in Codex, which runs hooks in the session's working directory.
 */
export function resolveScript(
  word: Word,
  platform: HookPlatform,
  root: string,
): { path: string; plain: boolean } | undefined {
  const text = word.text;
  if (text.startsWith(ROOT)) {
    if (text.charAt(1) !== '/') return undefined;
    const path = joinRelative(root, text.slice(2));
    return path === undefined ? undefined : { path, plain: false };
  }
  // Codex runs hooks in the session's working directory, which may be any subdirectory.
  if (platform === 'codex' || text.startsWith('/') || text.includes('\\')) return undefined;
  const path = joinRelative(root, text);
  return path === undefined ? undefined : { path, plain: true };
}
