/**
 * What one tool rule allows compared with another. Shared by the permissions gate and the fix
 * that narrows a skill's `allowed-tools` (skill/broad-allowed-tools).
 *
 * Claude Code's syntax (https://code.claude.com/docs/en/permissions): a rule is `Tool` or
 * `Tool(specifier)`, and parentheses inside the specifier are literal. A bare tool name matches
 * every use of the tool; `Bash(*)` is the same as `Bash`. A Bash specifier matches the whole
 * command: without `*`, one exact command; with one trailing `*`, every command that starts with
 * the text before it, which with a space before the `*` also matches the bare command
 * (`Bash(ls *)` matches `ls`). The legacy `:*` suffix is the same as ` *`.
 *
 * Fail-closed: whatever these cases do not describe, such as a `*` in the middle of a command, a
 * path pattern, a domain or an MCP tool glob, is never proven covered. Pure.
 */

export interface ToolRule {
  readonly tool: string;
  /** The text between the parentheses, as written; undefined for a bare tool name. */
  readonly specifier?: string;
}

const TOOL_NAME = /^[a-z_][\w-]*$/i;

/** `Bash(git status *)` as tool and specifier; undefined when it is not one well-formed rule. */
export function parseToolRule(rule: string): ToolRule | undefined {
  const open = rule.indexOf('(');
  if (open === -1) return TOOL_NAME.test(rule) ? { tool: rule } : undefined;
  const tool = rule.slice(0, open);
  if (!TOOL_NAME.test(tool) || !rule.endsWith(')')) return undefined;
  return { tool, specifier: rule.slice(open + 1, -1) };
}

/** Tools whose `(*)` matches every use, as the bare name does. */
const STAR_MATCHES_ALL: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/** True when the rule matches every use of its tool. */
function matchesAll(rule: ToolRule): boolean {
  return (
    rule.specifier === undefined || (STAR_MATCHES_ALL.has(rule.tool) && rule.specifier === '*')
  );
}

/** The commands a Bash specifier matches, in the two shapes this module understands. */
type BashPattern =
  | { readonly kind: 'exact'; readonly command: string }
  /** Every command that starts with `prefix`, and `bare` itself when set. */
  | { readonly kind: 'prefix'; readonly prefix: string; readonly bare?: string };

function bashPattern(specifier: string): BashPattern | undefined {
  const first = specifier.indexOf('*');
  if (first === -1) return { kind: 'exact', command: specifier };
  // Only one `*`, at the end.
  if (first !== specifier.length - 1) return undefined;
  const before = specifier.slice(0, -1);
  if (before.endsWith(':')) {
    const bare = before.slice(0, -1);
    return bare === '' ? undefined : { kind: 'prefix', prefix: `${bare} `, bare };
  }
  if (before.endsWith(' ')) {
    const bare = before.slice(0, -1);
    return bare.trim() === '' ? undefined : { kind: 'prefix', prefix: before, bare };
  }
  return before === '' ? undefined : { kind: 'prefix', prefix: before };
}

function patternMatches(pattern: BashPattern, command: string): boolean {
  if (pattern.kind === 'exact') return command === pattern.command;
  return command.startsWith(pattern.prefix) || command === pattern.bare;
}

/**
 * True when tool rule `narrow` lets an agent do nothing that rule `broad` does not already let it
 * do: `Bash(git status *)` is covered by `Bash`, `Bash(*)` and `Bash(git *)`, but not by
 * `Bash(git status)`; `Write(docs/**)` only by `Write`. Tool names are compared exactly.
 */
export function coveredBy(narrow: string, broad: string): boolean {
  if (narrow === broad) return parseToolRule(narrow) !== undefined;
  const small = parseToolRule(narrow);
  const large = parseToolRule(broad);
  if (small === undefined || large === undefined) return false;
  if (small.tool !== large.tool) return false;
  if (matchesAll(large)) return true;
  if (
    small.specifier === undefined ||
    large.specifier === undefined ||
    large.tool !== 'Bash' ||
    matchesAll(small)
  ) {
    return false;
  }
  const inner = bashPattern(small.specifier);
  const outer = bashPattern(large.specifier);
  if (inner === undefined || outer === undefined) return false;
  if (inner.kind === 'exact') return patternMatches(outer, inner.command);
  if (outer.kind === 'exact' || !inner.prefix.startsWith(outer.prefix)) return false;
  return inner.bare === undefined || patternMatches(outer, inner.bare);
}

/**
 * True when Bash rule `rule` matches the simple command `command` (one command, no `&&`, `;` or
 * `|`), by the shapes above. False for any other tool and for a pattern it does not understand.
 */
export function bashRuleMatches(rule: string, command: string): boolean {
  const parsed = parseToolRule(rule);
  if (parsed?.tool !== 'Bash') return false;
  if (matchesAll(parsed)) return true;
  const pattern = parsed.specifier === undefined ? undefined : bashPattern(parsed.specifier);
  return pattern !== undefined && patternMatches(pattern, command);
}
