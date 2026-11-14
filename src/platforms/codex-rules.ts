/**
 * Codex's exec-policy rules: the `*.rules` files directly in the `rules` folder of every trusted
 * config layer, the project's `.codex/rules/` included (`policy_files` and
 * `collect_policy_files` in codex-rs/core/src/exec_policy.rs at openai/codex 5943d7a,
 * SOURCES.codexExecPolicy). Codex evaluates them as Starlark with three built-ins
 * (codex-rs/execpolicy/src/parser.rs, SOURCES.codexExecPolicyParser):
 *
 * - `prefix_rule(pattern, decision, match, not_match, justification, canonical_matching)`:
 *   commands that start with `pattern` get `decision`, `allow` when it is left out. `allow` runs
 *   them without asking; `prompt` asks; `forbidden` blocks them.
 * - `network_rule(host, protocol, decision, justification)`: `allow` lets commands reach `host`.
 * - `host_executable(name, paths)`: the absolute paths that count as the program `name`, so the
 *   rules for `name` also match them.
 *
 * agentcheckup reads only files made of such calls with literal arguments
 * (src/parse/codex-rules.ts) and returns the rules that let Codex do more without asking. Any
 * other file, and a call it does not recognize, is `unread`: the inventory lists such a file as
 * not analyzed, so `--gate permissions` fails closed on it. Pure.
 */
import type { Span } from '../core/types.js';
import {
  readStarlarkCalls,
  type StarlarkCall,
  type StarlarkLiteral,
} from '../parse/codex-rules.js';

/** Where the files are, relative to a config layer's directory. */
export const CODEX_RULES_FOLDER = '.codex/rules';

export interface CodexGrant {
  /** The built-in: `prefix_rule`, `network_rule` or `host_executable`. */
  readonly call: 'prefix_rule' | 'network_rule' | 'host_executable';
  /**
   * What it grants, as reports show it: the command prefix (`git push`, an alternative as
   * `[a|b]`), `<protocol> <host>`, or `<name>=<path>,<path>`.
   */
  readonly value: string;
  /** True for a `prefix_rule` that allows every command of a shell or interpreter. */
  readonly broad: boolean;
  readonly span: Span;
}

export type CodexRulesReading =
  | { readonly ok: true; readonly grants: readonly CodexGrant[] }
  | { readonly ok: false; readonly offset: number };

/**
 * Programs whose every command is any command: shells, interpreters and launchers. A
 * `prefix_rule` of one of these alone allows anything.
 */
const ANY_COMMAND: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'env',
  'sudo',
  'xargs',
]);

const DECISIONS: ReadonlySet<string> = new Set(['allow', 'prompt', 'forbidden']);

const SIGNATURES: Readonly<Record<CodexGrant['call'], readonly string[]>> = {
  prefix_rule: ['pattern', 'decision', 'match', 'not_match', 'justification', 'canonical_matching'],
  network_rule: ['host', 'protocol', 'decision', 'justification'],
  host_executable: ['name', 'paths'],
};

const isCall = (name: string): name is CodexGrant['call'] => Object.hasOwn(SIGNATURES, name);

/** The call's arguments by parameter name, or undefined when Starlark would reject the call. */
function bind(
  call: StarlarkCall,
  params: readonly string[],
): Map<string, StarlarkLiteral> | undefined {
  if (call.args.length > params.length) return undefined;
  const bound = new Map<string, StarlarkLiteral>();
  call.args.forEach((value, index) => bound.set(params[index] ?? '', value));
  for (const { name, value } of call.kwargs) {
    if (!params.includes(name) || bound.has(name)) return undefined;
    bound.set(name, value);
  }
  return bound;
}

const isString = (value: StarlarkLiteral | undefined): value is string => typeof value === 'string';
const isStringList = (value: StarlarkLiteral | undefined): value is readonly string[] =>
  Array.isArray(value) && value.every(isString);
const absent = (value: StarlarkLiteral | undefined): boolean =>
  value === undefined || value === null;

function shownToken(token: string): string {
  return token === '' || /[\s"'[\]|\\]/u.test(token) ? JSON.stringify(token) : token;
}

/** A `pattern` as `git [status|diff]`, or undefined when Codex would reject it. */
function patternOf(
  value: StarlarkLiteral | undefined,
): { text: string; heads: string[] } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const words: string[] = [];
  let heads: string[] = [];
  for (const [index, token] of (value as readonly StarlarkLiteral[]).entries()) {
    const alternatives = isString(token) ? [token] : isStringList(token) ? [...token] : undefined;
    if (alternatives === undefined || alternatives.length === 0) return undefined;
    if (index === 0) heads = alternatives;
    words.push(
      alternatives.length === 1
        ? shownToken(alternatives[0] ?? '')
        : `[${alternatives.map(shownToken).join('|')}]`,
    );
  }
  return { text: words.join(' '), heads };
}

/** `decision` as Codex reads it; undefined when it would reject the value. */
function decisionOf(value: StarlarkLiteral | undefined, deny: boolean): string | undefined {
  if (absent(value)) return deny ? undefined : 'allow';
  if (!isString(value)) return undefined;
  if (deny && value === 'deny') return 'forbidden';
  return DECISIONS.has(value) ? value : undefined;
}

function examplesOk(value: StarlarkLiteral | undefined): boolean {
  if (absent(value)) return true;
  if (!Array.isArray(value)) return false;
  const items: readonly StarlarkLiteral[] = value;
  return items.every((item) => isString(item) || isStringList(item));
}

function justificationOk(value: StarlarkLiteral | undefined): boolean {
  return absent(value) || (isString(value) && value.trim() !== '');
}

/**
 * What one call grants: a list of zero or one grant, or undefined for a call agentcheckup does
 * not read as Codex would.
 */
function grantsOf(call: StarlarkCall): CodexGrant[] | undefined {
  if (!isCall(call.name)) return undefined;
  const args = bind(call, SIGNATURES[call.name]);
  if (args === undefined) return undefined;
  const { span } = call;
  switch (call.name) {
    case 'prefix_rule': {
      const pattern = patternOf(args.get('pattern'));
      const decision = decisionOf(args.get('decision'), false);
      const canonical = args.get('canonical_matching');
      if (
        pattern === undefined ||
        decision === undefined ||
        !examplesOk(args.get('match')) ||
        !examplesOk(args.get('not_match')) ||
        !justificationOk(args.get('justification')) ||
        !(absent(canonical) || typeof canonical === 'boolean')
      ) {
        return undefined;
      }
      if (decision !== 'allow') return [];
      const broad =
        (args.get('pattern') as readonly StarlarkLiteral[]).length === 1 &&
        pattern.heads.some((head) => ANY_COMMAND.has(head));
      return [{ call: call.name, value: pattern.text, broad, span }];
    }
    case 'network_rule': {
      const host = args.get('host');
      const protocol = args.get('protocol');
      const decision = decisionOf(args.get('decision'), true);
      if (
        !isString(host) ||
        !isString(protocol) ||
        decision === undefined ||
        !justificationOk(args.get('justification'))
      ) {
        return undefined;
      }
      if (decision !== 'allow') return [];
      return [{ call: call.name, value: `${protocol} ${host}`, broad: false, span }];
    }
    case 'host_executable': {
      const name = args.get('name');
      const paths = args.get('paths');
      if (!isString(name) || !isStringList(paths)) return undefined;
      return [{ call: call.name, value: `${name}=${paths.join(',')}`, broad: false, span }];
    }
  }
}

/**
 * The grants of one rules file's text, in document order, or the offset where agentcheckup stopped
 * reading it. Never throws.
 */
export function codexRuleGrants(text: string): CodexRulesReading {
  const read = readStarlarkCalls(text);
  if (!read.ok) return { ok: false, offset: read.offset };
  const grants: CodexGrant[] = [];
  for (const call of read.calls) {
    const found = grantsOf(call);
    if (found === undefined) return { ok: false, offset: call.span.offset };
    grants.push(...found);
  }
  return { ok: true, grants };
}
