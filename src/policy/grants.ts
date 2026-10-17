/**
 * What a tool grant lets an agent do without asking, for `permissions.denyTools` and
 * `permissions.denyCommands`. A grant is one tool rule, such as `Bash(curl:*)` in
 * `permissions.allow` or one rule of a skill's `allowed-tools` (split with splitToolRules).
 *
 * Fails closed: a shell grant counts as running a denied program when it allows every command,
 * when its first word is that program, or when its program cannot be told.
 */

/** Tools whose specifier is a command line: Claude Code's Bash and PowerShell, Copilot's shell. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell', 'shell']);

/**
 * Text that runs another command, or hides which one runs: substitution, separators, pipes,
 * background jobs, process substitution and line breaks.
 */
const UNSAFE_PARTS: readonly string[] = ['$(', '`', ';', '|', '&', '<(', '>(', '\n', '\r'];

/** Characters that make a first word expand to something else: variables, globs, quotes, escapes. */
const EXPANDING = /[$*?[\]{}'"\\=]/;

/**
 * Programs that run another program named in their arguments, so the grant's first word does not
 * tell what runs.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'bash',
  'builtin',
  'busybox',
  'cmd',
  'command',
  'dash',
  'doas',
  'env',
  'eval',
  'exec',
  'fish',
  'iex',
  'invoke-expression',
  'ionice',
  'ksh',
  'nice',
  'nohup',
  'powershell',
  'pwsh',
  'sh',
  'start-process',
  'stdbuf',
  'sudo',
  'time',
  'timeout',
  'watch',
  'xargs',
  'zsh',
]);

/** A tool rule split into its tool and specifier: `Bash(curl:*)` -> `Bash`, `curl:*`. */
export interface ToolRule {
  readonly tool: string;
  /** Absent for a bare tool name. Trimmed. */
  readonly specifier?: string;
}

/** Splits a rule the way broadGrant reads it. */
export function toolRule(rule: string): ToolRule {
  const open = rule.indexOf('(');
  if (open < 0) return { tool: rule.trim() };
  const end = rule.endsWith(')') ? rule.length - 1 : rule.length;
  return { tool: rule.slice(0, open).trim(), specifier: rule.slice(open + 1, end).trim() };
}

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool.toLowerCase());
}

/**
 * The program a shell grant runs:
 * - `any`: no specifier, or `*`.
 * - `unknown`: the program cannot be told (a leading `*`, substitution, a separator or pipe, an
 *   expanding first word, a wrapper such as `sudo` or `sh`, or an empty specifier).
 * - `program`: the first word's file name, lower case, without `.exe`, `.cmd`, `.bat` or `.com`.
 */
export type ShellProgram =
  | { readonly kind: 'any' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'program'; readonly name: string };

const UNKNOWN: ShellProgram = { kind: 'unknown' };

export function shellProgram(specifier: string | undefined): ShellProgram {
  if (specifier === undefined || specifier === '*') return { kind: 'any' };
  if (specifier === '' || specifier.startsWith('*')) return UNKNOWN;
  if (UNSAFE_PARTS.some((part) => specifier.includes(part))) return UNKNOWN;
  let end = 0;
  while (end < specifier.length && !/[\s:]/.test(specifier.charAt(end))) end++;
  const word = specifier.slice(0, end);
  // `curl:*` is the legacy prefix form; anything else after a colon is not a plain program.
  if (specifier.charAt(end) === ':' && specifier.slice(end + 1).trim() !== '*') return UNKNOWN;
  if (EXPANDING.test(word)) return UNKNOWN;
  let name = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase();
  for (const suffix of ['.exe', '.cmd', '.bat', '.com']) {
    if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  }
  if (name === '' || WRAPPERS.has(name)) return UNKNOWN;
  return { kind: 'program', name };
}

/** `mcp__server`: a grant of every tool of one MCP server. */
function isMcpServer(tool: string): boolean {
  return tool.startsWith('mcp__') && !tool.slice('mcp__'.length).includes('__');
}

/**
 * True when a grant of `granted` covers the denied tool. Tool names compare without case. A grant
 * ending in `*` covers every tool its prefix starts; a grant of an MCP server (`mcp__github`)
 * covers its tools, and denying a server denies every grant of its tools.
 */
export function grantsTool(granted: string, denied: string): boolean {
  const grant = granted.toLowerCase();
  const tool = denied.toLowerCase();
  if (grant === tool) return true;
  if (grant.endsWith('*')) return tool.startsWith(grant.slice(0, -1));
  if (isMcpServer(grant) && tool.startsWith(`${grant}__`)) return true;
  return isMcpServer(tool) && grant.startsWith(`${tool}__`);
}
