/**
 * Bash rules for a skill's `allowed-tools`, derived from the commands its body shows, for the
 * `#narrow` fix of skill/broad-allowed-tools. The only input is the code of the parsed Markdown.
 *
 * Sources:
 * - fenced code blocks tagged bash, sh, shell, zsh, console or terminal, and blocks Claude Code
 *   runs while it renders the skill (```` ```! ````); in console and terminal blocks, and in
 *   shell blocks that show a `$ ` prompt, only the lines with the prompt;
 * - lines that start with `$ ` in code blocks without a language;
 * - inline code of two or more words whose first word is a program the blocks run or one of a
 *   few well-known tools, and inline code Claude Code runs (`` !`git status` ``).
 *
 * Each line is split at `&&`, `||`, `;`, `|` and `&`. A part is left out when it uses a
 * substitution, a backtick or a redirection; sits in a heredoc, a line continuation or a string
 * that spans lines; starts with a shell keyword or builtin, an assignment, a shell, a program
 * that runs another command (sudo, env, xargs, timeout, …) or a denylisted program (curl, rm,
 * …); or runs code it is given inline. An interpreter or package runner (python, node, npx,
 * `uv run`, `docker run`, …) must be followed by the script or command it runs, else the part
 * is left out: `Bash(npx *)` would allow any package.
 *
 * A rule keeps the program and the stable words that follow it, at most three: subcommands
 * (`git status`), and the script or package an interpreter or runner runs
 * (`uv run scripts/convert.py`). It stops at the first flag, placeholder, variable, quote, URL or
 * other argument, and ends in ` *` when more words follow. Rules another derived rule covers
 * are dropped, and at most 20 are kept, in the order the skill shows them. Pure.
 */
import type { Code, InlineCode, Nodes } from 'mdast';
import { coveredBy } from '../../platforms/tool-rules.js';

/** Most rules one fix writes. */
export const MAX_DERIVED_RULES = 20;
/** Most words of a command a rule keeps. */
export const MAX_RULE_WORDS = 3;

export type CodeNode = Code | InlineCode;

/** A rule and where the skill shows the command it came from. */
export interface DerivedRule {
  /** `Bash(<prefix> *)` or `Bash(<exact command>)`. */
  readonly rule: string;
  /** 1-based line of the command in the file. */
  readonly line: number;
  /** The command line as written, without its prompt, trimmed. */
  readonly source: string;
}

export interface DeriveOptions {
  /** Start offsets of inline code that Claude Code runs as a command (`` !`cmd` ``). */
  readonly injected?: ReadonlySet<number>;
}

// ---------------------------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------------------------

const SHELL_LANGUAGES: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'zsh']);
const PROMPT_LANGUAGES: ReadonlySet<string> = new Set(['console', 'terminal']);

/** Programs whose inline code counts without a block that runs them. */
const INLINE_PROGRAMS: ReadonlySet<string> = new Set([
  'git',
  'gh',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'uv',
  'python',
  'python3',
  'pytest',
  'cargo',
  'go',
  'make',
  'docker',
]);

/** Shell keywords and builtins: a part that starts with one is not a program run. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'alias',
  'bg',
  'break',
  'builtin',
  'case',
  'cd',
  'command',
  'continue',
  'declare',
  'disown',
  'do',
  'done',
  'echo',
  'elif',
  'else',
  'esac',
  'exit',
  'export',
  'false',
  'fg',
  'fi',
  'for',
  'function',
  'getopts',
  'hash',
  'history',
  'if',
  'in',
  'jobs',
  'kill',
  'let',
  'local',
  'popd',
  'printf',
  'pushd',
  'read',
  'readonly',
  'return',
  'select',
  'set',
  'shift',
  'shopt',
  'source',
  'test',
  'then',
  'time',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'until',
  'wait',
  'while',
]);

/**
 * Programs never pre-approved: privilege changes, wrappers that run any command, shells,
 * downloads, remote access and destructive file commands.
 */
const DENIED: ReadonlySet<string> = new Set([
  'sudo',
  'su',
  'doas',
  'env',
  'xargs',
  'eval',
  'exec',
  'sh',
  'bash',
  'zsh',
  'curl',
  'wget',
  'ssh',
  'scp',
  'nc',
  'rm',
  'chmod',
  'chown',
  'dd',
  // Other shells, and programs that run the command they are given.
  'csh',
  'dash',
  'fish',
  'ksh',
  'tcsh',
  'caffeinate',
  'chroot',
  'entr',
  'flock',
  'ionice',
  'nice',
  'nocorrect',
  'noglob',
  'nohup',
  'nsenter',
  'parallel',
  'pkexec',
  'runuser',
  'setsid',
  'stdbuf',
  'strace',
  'systemd-run',
  'timeout',
  'unbuffer',
  'unshare',
  'watch',
  // Programs that run code given on their command line.
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'sed',
]);

/**
 * Programs that run the script, module or package named after them: python, node, npx. Their
 * rule must name it. Matched without a version suffix (`python3.12` is `python`).
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'bun',
  'bunx',
  'deno',
  'groovy',
  'irb',
  'java',
  'lua',
  'luajit',
  'node',
  'nodejs',
  'npx',
  'osascript',
  'perl',
  'php',
  'pnpx',
  'powershell',
  'pwsh',
  'pypy',
  'python',
  'rscript',
  'ruby',
  'ts-node',
  'tsx',
  'uvx',
]);

/** Subcommands that run the command or package named after them: `uv run`, `docker exec`. */
const RUNNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['conda', new Set(['run'])],
  ['devbox', new Set(['run'])],
  ['direnv', new Set(['exec'])],
  ['docker', new Set(['exec', 'run'])],
  ['go', new Set(['run'])],
  ['hatch', new Set(['run'])],
  ['kubectl', new Set(['exec', 'run'])],
  ['mamba', new Set(['run'])],
  ['mise', new Set(['exec', 'x'])],
  ['nix', new Set(['develop', 'run', 'shell'])],
  ['npm', new Set(['exec', 'x'])],
  ['pdm', new Set(['run'])],
  ['pipenv', new Set(['run'])],
  ['pipx', new Set(['run'])],
  ['pnpm', new Set(['dlx', 'exec'])],
  ['podman', new Set(['exec', 'run'])],
  ['poetry', new Set(['run'])],
  ['rye', new Set(['run'])],
  ['uv', new Set(['run', 'tool'])],
  ['yarn', new Set(['dlx', 'exec'])],
]);

/** Words that run what follows them wherever a command runner puts them (`bun run`, `uv tool run`). */
const RUNNER_WORDS: ReadonlySet<string> = new Set(['dlx', 'exec', 'run', 'x']);

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** A program by name: lowercase first letter, no quotes, variables or placeholders. */
const PROGRAM_NAME = /^[a-z][\w+.-]*$/;
/** A program by relative path that stays inside the working directory: `./scripts/run.sh`. */
const PROGRAM_PATH = /^(?:\.\/)?[\w@][\w+.@-]*(?:\/[\w@][\w+.@-]*)*$/;
/** A subcommand: `status`, `run`, `test:unit`. */
const SUBCOMMAND = /^[a-z][a-z\d]*(?:[-:_][a-z\d]+)*$/;
/** A placeholder written in capitals: `FILE`, `PR_NUMBER`. */
const CAPITALS = /^[A-Z][\dA-Z_]*$/;

function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** The program's name in lowercase without a version suffix: `python3.12` is `python`. */
function interpreterName(word: string): string {
  const name = baseName(word).toLowerCase();
  let end = name.length;
  while (end > 0 && '0123456789.'.includes(name.charAt(end - 1))) end--;
  return name.slice(0, end);
}

/** A program, or the script or command a runner runs: a name or a relative path. */
function isCommandWord(word: string, first: boolean): boolean {
  if (CAPITALS.test(word)) return false;
  if (first && PROGRAM_NAME.test(word)) return true;
  if (!PROGRAM_PATH.test(word)) return false;
  return !first || (word.includes('/') && !word.startsWith('@'));
}

/** A script path or a package such as `@scope/tool` or `tool@1.2`: its arguments follow. */
function namesFile(word: string): boolean {
  return word.includes('/') || word.includes('.') || word.includes('@');
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

type Quote = '"' | "'";

interface Part {
  readonly words: readonly string[];
  /** A substitution, backtick, redirection, heredoc, or text that continues on the next line. */
  readonly tainted: boolean;
}

interface ScannedLine {
  readonly parts: readonly Part[];
  /** The quote still open at the end of the line. */
  readonly quote?: Quote;
  /** True when the line ends with a backslash. */
  readonly continues: boolean;
  /** The delimiter of a heredoc that starts on this line; empty when it cannot be read. */
  readonly heredoc?: string;
}

const HEREDOC = /^-?[\t ]*(?:'([^']*)'|"([^"]*)"|\\?(\w+))/;

function heredocDelimiter(rest: string): string {
  const match = HEREDOC.exec(rest);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

/** Length of the run of `char` that starts at `start`. */
function runLength(line: string, start: number, char: string): number {
  let end = start;
  while (line.charAt(end) === char) end++;
  return end - start;
}

/** Splits a line into parts and words, as a shell would, without expanding anything. */
function scanLine(line: string, openQuote: Quote | undefined): ScannedLine {
  const parts: Part[] = [];
  let words: string[] = [];
  // Words keep their quotes, so a word is never empty.
  let word = '';
  let tainted = false;
  // After a command substitution starts, separators may sit inside it: every later part is out.
  let substituted = false;
  let quote = openQuote;
  let continues = false;
  let heredoc: string | undefined;
  const endWord = (): void => {
    if (word !== '') words.push(word);
    word = '';
  };
  const endPart = (): void => {
    endWord();
    if (words.length > 0 || tainted) parts.push({ words, tainted });
    words = [];
    tainted = substituted;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    const next = line.charAt(i + 1);
    if (quote !== "'" && (char === '`' || (char === '$' && next === '('))) {
      substituted = true;
      tainted = true;
    }
    if (quote === "'") {
      word += char;
      if (char === "'") quote = undefined;
    } else if (quote === '"') {
      word += char;
      if (char === '\\') {
        word += next;
        i++;
      } else if (char === '"') {
        quote = undefined;
      }
    } else if (char === '\\') {
      if (i === line.length - 1) {
        continues = true;
        tainted = true;
        break;
      }
      word += char + next;
      i++;
    } else if (char === "'" || char === '"') {
      quote = char;
      word += char;
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === '#' && word === '') {
      // A comment runs to the end of the line.
      break;
    } else if (char === '&' || char === '|' || char === ';') {
      endPart();
      if (next === char || (char === '|' && next === '&')) i++;
    } else if (char === '<') {
      // `<<` starts a heredoc; `<<<` is a here-string on one line.
      const run = runLength(line, i, '<');
      tainted = true;
      if (run === 2) heredoc = heredocDelimiter(line.slice(i + 2));
      word += line.slice(i, i + run);
      i += run - 1;
    } else {
      if (char === '>') tainted = true;
      word += char;
    }
  }
  if (quote !== undefined) tainted = true;
  endPart();
  return {
    parts,
    ...(quote === undefined ? {} : { quote }),
    continues,
    ...(heredoc === undefined ? {} : { heredoc }),
  };
}

/** Flags that only print a version or help: `git --version` stays an exact rule. */
const INFO_FLAGS: ReadonlySet<string> = new Set(['--help', '--version', '-V', '-h', '-v']);

/** A program that may start a rule: not a keyword, a denylisted program or a placeholder. */
function isProgram(word: string): boolean {
  const name = baseName(word);
  return isCommandWord(word, true) && !DENIED.has(name) && !KEYWORDS.has(name);
}

/** The rule for one part of a command line, or undefined when the part is left out. */
function ruleOf(words: readonly string[]): string | undefined {
  // `node --version` only prints a version, even for an interpreter.
  const [head, flag] = words;
  if (words.length === 2 && head !== undefined && isProgram(head) && INFO_FLAGS.has(flag ?? '')) {
    return `Bash(${words.join(' ')})`;
  }
  const kept: string[] = [];
  let expectCommand = true;
  // The last program kept, and whether the word before was that program.
  let program = '';
  let afterProgram = false;
  for (const word of words) {
    if (kept.length === MAX_RULE_WORDS) break;
    const first = kept.length === 0;
    if (expectCommand) {
      const name = baseName(word);
      if (first ? !isProgram(word) : !isCommandWord(word, false) || DENIED.has(name)) {
        return undefined;
      }
      kept.push(word);
      program = name;
      afterProgram = true;
      if (!first && RUNNER_WORDS.has(word)) continue;
      if (INTERPRETERS.has(interpreterName(word))) continue;
      expectCommand = false;
      // A script path: what follows are its arguments.
      if (word.includes('/') || (!first && namesFile(word))) break;
      continue;
    }
    if (word === 'eval') return undefined;
    if (!SUBCOMMAND.test(word)) break;
    kept.push(word);
    if (afterProgram && RUNNERS.get(program)?.has(word) === true) expectCommand = true;
    afterProgram = false;
  }
  // A runner without the command it runs, or nothing at all.
  if (expectCommand || kept.length === 0) return undefined;
  const prefix = kept.join(' ');
  return kept.length === words.length ? `Bash(${prefix})` : `Bash(${prefix} *)`;
}

interface Found extends DerivedRule {
  readonly program: string;
}

/** The rules of one command line. */
function rulesOfLine(text: string, line: number, scanned: ScannedLine): Found[] {
  const found: Found[] = [];
  for (const part of scanned.parts) {
    if (part.tainted) continue;
    const rule = ruleOf(part.words);
    const program = part.words[0];
    if (rule !== undefined && program !== undefined) {
      found.push({ rule, line, source: text.trim(), program: baseName(program) });
    }
  }
  return found;
}

function stripPrompt(line: string): string | undefined {
  const trimmed = line.trimStart();
  return trimmed.startsWith('$ ') ? trimmed.slice(2) : undefined;
}

/** First line of a code block's content: after the opening fence, or the block's own line. */
function firstContentLine(node: Code, lines: number): number | undefined {
  const start = node.position?.start.line;
  const end = node.position?.end.line;
  if (start === undefined || end === undefined) return undefined;
  // An indented block spans exactly its content lines; a fenced one also its fence lines.
  return end - start + 1 === lines ? start : start + 1;
}

/** How a block's lines are read, or undefined when it shows no commands. */
function blockMode(node: Code, lines: readonly string[]): 'all' | 'prompt' | undefined {
  const lang = node.lang?.toLowerCase();
  if (lang?.startsWith('!') === true) return 'all';
  if (lang === undefined || PROMPT_LANGUAGES.has(lang)) return 'prompt';
  if (!SHELL_LANGUAGES.has(lang)) return undefined;
  return lines.some((line) => stripPrompt(line) !== undefined) ? 'prompt' : 'all';
}

function rulesOfBlock(node: Code): Found[] {
  const lines = node.value.split('\n');
  const mode = blockMode(node, lines);
  const first = firstContentLine(node, lines.length);
  if (mode === undefined || first === undefined) return [];
  const found: Found[] = [];
  let quote: Quote | undefined;
  let continued = false;
  let heredoc: string | undefined;
  lines.forEach((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (heredoc !== undefined) {
      if (heredoc !== '' && line.trim() === heredoc) heredoc = undefined;
      return;
    }
    const inside = continued || quote !== undefined;
    let text: string | undefined = line;
    if (!inside) {
      const command = stripPrompt(line);
      if (mode === 'prompt' && command === undefined) return;
      text = command ?? line;
    }
    const scanned = scanLine(text, quote);
    quote = scanned.quote;
    continued = scanned.continues;
    heredoc = scanned.heredoc;
    if (!inside) found.push(...rulesOfLine(text, first + index, scanned));
  });
  return found;
}

function rulesOfInline(
  node: InlineCode,
  programs: ReadonlySet<string>,
  injected: boolean,
): Found[] {
  const line = node.position?.start.line;
  if (line === undefined) return [];
  const text = stripPrompt(node.value) ?? node.value;
  const scanned = scanLine(text, undefined);
  if (scanned.quote !== undefined || scanned.continues || scanned.heredoc !== undefined) return [];
  if (!injected) {
    const words = scanned.parts[0]?.words ?? [];
    const program = words[0];
    if (words.length < 2 || program === undefined) return [];
    if (!INLINE_PROGRAMS.has(program) && !programs.has(program)) return [];
  }
  return rulesOfLine(text, line, scanned);
}

/** The code nodes of a Markdown tree, in document order. */
export function codeNodes(root: Nodes): CodeNode[] {
  const found: CodeNode[] = [];
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'code' || node.type === 'inlineCode') found.push(node);
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return found;
}

/**
 * The Bash rules for the commands that `nodes` show (see the module comment), in document
 * order, without duplicates or rules another one covers, at most {@link MAX_DERIVED_RULES}.
 */
export function deriveToolRules(
  nodes: readonly CodeNode[],
  options: DeriveOptions = {},
): DerivedRule[] {
  const byNode = new Map<CodeNode, Found[]>();
  const programs = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'code') continue;
    const found = rulesOfBlock(node);
    byNode.set(node, found);
    for (const item of found) programs.add(item.program);
  }
  const all: DerivedRule[] = [];
  for (const node of nodes) {
    const found =
      node.type === 'code'
        ? (byNode.get(node) ?? [])
        : rulesOfInline(
            node,
            programs,
            options.injected?.has(node.position?.start.offset ?? -1) === true,
          );
    for (const { rule, line, source } of found) all.push({ rule, line, source });
  }
  return settle(all);
}

/**
 * The simple commands of a command Claude Code runs (one per part of each line, its words joined
 * by one space), or undefined when a part could do more than its words show: a substitution, a
 * backtick, a redirection, a heredoc, a line continuation or a string that spans lines.
 */
export function simpleCommands(command: string): string[] | undefined {
  const commands: string[] = [];
  for (const line of command.split('\n')) {
    const scanned = scanLine(line.endsWith('\r') ? line.slice(0, -1) : line, undefined);
    if (scanned.quote !== undefined || scanned.continues || scanned.heredoc !== undefined) {
      return undefined;
    }
    for (const part of scanned.parts) {
      if (part.tainted) return undefined;
      commands.push(part.words.join(' '));
    }
  }
  return commands;
}

const SEPARATOR = /[\s,]/u;

/**
 * Joins tool rules into one `allowed-tools` string with the separator `value` uses between its
 * first two rules: `, ` when that has a comma, else one space.
 */
export function joinToolRules(value: string, rules: readonly string[]): string {
  let inside = false;
  let seenRule = false;
  let separator = '';
  for (const char of value) {
    if (char === '(') inside = true;
    else if (char === ')') inside = false;
    if (!inside && SEPARATOR.test(char)) {
      if (seenRule) separator += char;
      continue;
    }
    if (separator !== '') break;
    seenRule = true;
  }
  return rules.join(separator.includes(',') ? ', ' : ' ');
}

/** First of each rule, without rules another one covers, capped. */
function settle(found: readonly DerivedRule[]): DerivedRule[] {
  const unique = new Map<string, DerivedRule>();
  for (const item of found) if (!unique.has(item.rule)) unique.set(item.rule, item);
  const list = [...unique.values()];
  const kept = list.filter((item, index) =>
    list.every(
      (other, otherIndex) =>
        otherIndex === index ||
        !coveredBy(item.rule, other.rule) ||
        (otherIndex > index && coveredBy(other.rule, item.rule)),
    ),
  );
  return kept.slice(0, MAX_DERIVED_RULES);
}
