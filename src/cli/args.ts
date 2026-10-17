import { parseArgs } from 'node:util';
import { parseGateClasses } from '../core/baseline.js';
import type { GateClass } from '../core/baseline-types.js';
import { PLATFORM_IDS, type PlatformId, type Severity } from '../core/types.js';
import { CONTEXT_AGENTS, type ContextAgent } from '../platforms/load/types.js';
import type { DetailLevel } from '../report/feedback.js';
import { DEFAULT_MAX_TASKS, MAX_TASKS, TASK_ID_PATTERN } from '../tasks/index.js';

export const OUTPUT_FORMATS = ['stylish', 'json', 'sarif', 'github', 'markdown', 'badge'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const CONTEXT_FORMATS = ['text', 'json', 'markdown'] as const;
export type ContextFormat = (typeof CONTEXT_FORMATS)[number];
export const FIX_FORMATS = ['diff', 'json', 'suggestions'] as const;
export type FixFormat = (typeof FIX_FORMATS)[number];
export const TASKS_FORMATS = ['markdown', 'json'] as const;
export type TasksFormat = (typeof TASKS_FORMATS)[number];
export type FailOn = Severity | 'none';

export const SKILL_DIRS = ['claude', 'agents'] as const;
export type SkillDir = (typeof SKILL_DIRS)[number];

export type Command =
  | { readonly kind: 'help'; readonly topic?: 'context' | 'fix' | 'tasks' | 'skill' }
  | { readonly kind: 'skill'; readonly options: SkillCommandOptions }
  | { readonly kind: 'version' }
  | { readonly kind: 'rules'; readonly format: 'text' | 'json' }
  | { readonly kind: 'explain'; readonly ruleId: string }
  | { readonly kind: 'scan'; readonly options: ScanCommandOptions }
  | { readonly kind: 'context'; readonly options: ContextCommandOptions }
  | { readonly kind: 'fix'; readonly options: FixCommandOptions }
  | { readonly kind: 'tasks'; readonly options: TasksCommandOptions };

/** Options both the scan and the context command take. */
export interface SharedCommandOptions {
  readonly path: string;
  readonly output: string | undefined;
  readonly config: string | undefined;
  readonly useConfig: boolean;
  readonly untrusted: boolean;
  readonly gitignore: boolean;
  readonly color: boolean | undefined;
  /** `--baseline`: a JSON report to compare with. */
  readonly baseline: string | undefined;
  /** `--gate`: classes that turn changes since the baseline into exit 1. Needs `baseline`. */
  readonly gate: readonly GateClass[];
  /** `--context-window`: the model's context window in tokens. */
  readonly contextWindow: number | undefined;
}

export interface ScanCommandOptions extends SharedCommandOptions {
  readonly format: OutputFormat;
  readonly targets: readonly PlatformId[] | undefined;
  readonly failOn: FailOn;
  readonly minScore: number | undefined;
  readonly showSuppressed: boolean;
  /** `--context`: add load plans and the matrix to the report. */
  readonly context: boolean;
  /** `--compact`, `--verbose` or neither: how much stylish, markdown and github output show. */
  readonly level: DetailLevel;
  /** `--policy`: an organization policy file to check the scan against. Implies untrusted. */
  readonly policy: string | undefined;
}

export interface ContextCommandOptions extends SharedCommandOptions {
  readonly format: ContextFormat;
  /** `--agent`; undefined means every modeled agent among the targets. */
  readonly agents: readonly ContextAgent[] | undefined;
  /** Root-relative POSIX directory, normalized; `''` is the scanned directory. */
  readonly cwd: string;
  readonly matrix: boolean;
}

/**
 * `agentcheckup fix`. Shares the scan's configuration options; `baseline`, `gate` and
 * `contextWindow` are always unset, `gitignore` always true.
 */
export interface FixCommandOptions extends SharedCommandOptions {
  readonly format: FixFormat;
  readonly targets: readonly PlatformId[] | undefined;
  /** `--write`: apply the selected fixes. */
  readonly write: boolean;
  /** `--review`: with `--write`, also apply fixes of class `review`. */
  readonly review: boolean;
  /** `-i`: ask about each fix, then write the accepted ones. */
  readonly interactive: boolean;
  /** `--rule`: only fixes of these rules, deduplicated. Checked against the rules in run.ts. */
  readonly rules: readonly string[] | undefined;
  /** `--diff`: the pull request's unified diff, for `--format suggestions` (see suggest.ts). */
  readonly diff: string | undefined;
}

/**
 * `agentcheckup tasks`. The scan's configuration comes from the repository, as for `tasks
 * --check`, which takes no options: `config`, `baseline`, `gate` and `contextWindow` are always
 * unset, `gitignore` always true, and every platform is targeted unless the configuration says
 * otherwise.
 */
export interface TasksCommandOptions extends SharedCommandOptions {
  readonly format: TasksFormat;
  /** `--rule`: only these rules, deduplicated. Checked against the rules in src/cli/tasks.ts. */
  readonly rules: readonly string[] | undefined;
  /** `--max`: the most tasks to list. */
  readonly max: number;
  /**
   * `--check`: the task ids to check, `[]` for every task. Undefined lists the tasks. With
   * `--check`, every other option is a usage error.
   */
  readonly check: readonly string[] | undefined;
}

/**
 * `agentcheckup skill install`. The repository's configuration file decides the default
 * directory; the other shared options are always unset, and `untrusted` is always false.
 */
export interface SkillCommandOptions extends SharedCommandOptions {
  /** `--dir`: the skills directory; undefined picks it from the configured targets. */
  readonly dir: SkillDir | undefined;
  /** `--yes`: install without asking, for scripts. */
  readonly yes: boolean;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

const FAIL_ON = ['error', 'warn', 'info', 'none'] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}. Got "${value}".`);
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseTargets(value: string | undefined): PlatformId[] | undefined {
  if (value === undefined) return undefined;
  const ids = list(value);
  if (ids.length === 0) throw new UsageError('--targets needs at least one platform.');
  return ids.map((id) => oneOf(id, PLATFORM_IDS, '--targets'));
}

function isContextAgent(id: string): id is ContextAgent {
  return (CONTEXT_AGENTS as readonly string[]).includes(id);
}

function parseAgents(value: string | undefined): ContextAgent[] | undefined {
  if (value === undefined) return undefined;
  const ids = list(value);
  if (ids.length === 0) throw new UsageError('--agent needs at least one agent.');
  const modeled = CONTEXT_AGENTS.join(', ');
  const agents = new Set<ContextAgent>();
  for (const id of ids) {
    if (isContextAgent(id)) {
      agents.add(id);
    } else if ((PLATFORM_IDS as readonly string[]).includes(id)) {
      throw new UsageError(
        `agentcheckup does not model what ${id} loads yet. --agent takes: ${modeled}.`,
      );
    } else {
      throw new UsageError(`Unknown agent "${id}". --agent takes: ${modeled}.`);
    }
  }
  // In the order agentcheckup lists agents, so output does not depend on the flag's order.
  return CONTEXT_AGENTS.filter((agent) => agents.has(agent));
}

function parseMinScore(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const score = Number(value);
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new UsageError(`--min-score must be an integer from 0 to 100. Got "${value}".`);
  }
  return score;
}

function parseContextWindow(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const tokens = /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new UsageError(
      `--context-window must be a positive whole number of tokens, such as 200000. Got "${value}".`,
    );
  }
  return tokens;
}

function parseGate(value: string | undefined, baseline: string | undefined): readonly GateClass[] {
  if (value === undefined) return [];
  if (baseline === undefined) {
    throw new UsageError(
      '--gate needs --baseline: the gate looks at what changed since the baseline report.',
    );
  }
  const parsed = parseGateClasses(value);
  if (!parsed.ok) throw new UsageError(`--gate: ${parsed.message}`);
  return parsed.classes;
}

/**
 * `--cwd` as a normalized root-relative POSIX path. Rejects absolute paths and `..`, so the
 * working directory can only name a directory inside the scanned one. Whether it exists is
 * checked after the walk.
 */
export function parseWorkingDirectory(value: string | undefined): string {
  if (value === undefined) return '';
  if (value.includes('\0')) throw new UsageError('--cwd must not contain a NUL character.');
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z]:/i.test(value)) {
    throw new UsageError(
      `--cwd must be a directory relative to the scanned path, not an absolute path. Got "${value}".`,
    );
  }
  // Both separators: a Windows user may type either.
  const parts = value.split(/[/\\]/);
  if (parts.includes('..')) {
    throw new UsageError(
      `--cwd must name a directory inside the scanned path; ".." is not allowed. Got "${value}".`,
    );
  }
  return parts.filter((part) => part !== '' && part !== '.').join('/');
}

type Values = Record<string, string | boolean | undefined>;

/** Flags that only one command takes, with the command that does. */
const SCAN_ONLY = [
  'fail-on',
  'min-score',
  'show-suppressed',
  'context',
  'compact',
  'verbose',
  'policy',
] as const;
const CONTEXT_ONLY = ['agent', 'cwd', 'matrix'] as const;
const FIX_ONLY = ['write', 'review', 'interactive', 'rule', 'diff'] as const;
/** Scan and context flags `fix` does not take. */
const NOT_FOR_FIX = ['baseline', 'gate', 'context-window', 'no-gitignore'] as const;
const TASKS_ONLY = ['check', 'max'] as const;
const TASKS_ONLY_MESSAGE = 'works only with the tasks command: agentcheckup tasks.';
/** Flags `tasks` does not take: `tasks --check` could not repeat them. */
const NOT_FOR_TASKS = [
  ...NOT_FOR_FIX,
  'targets',
  'config',
  'no-config',
  'color',
  'no-color',
] as const;

function rejectFlags(values: Values, flags: readonly string[], message: string): void {
  for (const flag of flags) {
    if (values[flag] !== undefined) throw new UsageError(`--${flag} ${message}`);
  }
}

function sharedOptions(values: Values, path: string | undefined): SharedCommandOptions {
  if (values['config'] !== undefined && values['no-config'] === true) {
    throw new UsageError('--config and --no-config cannot be combined.');
  }
  if (values['color'] === true && values['no-color'] === true) {
    throw new UsageError('--color and --no-color cannot be combined.');
  }
  const baseline = values['baseline'] as string | undefined;
  return {
    path: path ?? '.',
    output: values['output'] as string | undefined,
    config: values['config'] as string | undefined,
    // --untrusted implies the repository's own configuration is ignored.
    useConfig: values['no-config'] !== true && values['untrusted'] !== true,
    untrusted: values['untrusted'] === true,
    gitignore: values['no-gitignore'] !== true,
    color: values['color'] === true ? true : values['no-color'] === true ? false : undefined,
    baseline,
    gate: parseGate(values['gate'] as string | undefined, baseline),
    contextWindow: parseContextWindow(values['context-window'] as string | undefined),
  };
}

function contextCommand(values: Values, rest: readonly string[]): Command {
  if (values['help'] === true) return { kind: 'help', topic: 'context' };
  if (values['version'] === true) return { kind: 'version' };
  if (rest.length > 1) {
    throw new UsageError(`"context" takes at most one path, got ${rest.length}.`);
  }
  rejectFlags(values, [...SCAN_ONLY, 'targets'], 'does not apply to the context command.');
  rejectFlags(values, FIX_ONLY, 'works only with the fix command: agentcheckup fix.');
  rejectFlags(values, TASKS_ONLY, TASKS_ONLY_MESSAGE);
  const cwd = parseWorkingDirectory(values['cwd'] as string | undefined);
  const matrix = values['matrix'] === true;
  if (matrix && cwd !== '') {
    throw new UsageError(
      '--matrix covers the whole repository, so it cannot be combined with --cwd.',
    );
  }
  return {
    kind: 'context',
    options: {
      ...sharedOptions(values, rest[0]),
      format: oneOf(
        (values['format'] as string | undefined) ?? 'text',
        CONTEXT_FORMATS,
        '--format',
      ),
      agents: parseAgents(values['agent'] as string | undefined),
      cwd,
      matrix,
    },
  };
}

function scanCommand(values: Values, positionals: readonly string[]): Command {
  if (positionals.length > 1) {
    throw new UsageError(`Expected at most one path, got ${positionals.length}.`);
  }
  rejectFlags(values, CONTEXT_ONLY, 'works only with the context command: agentcheckup context.');
  rejectFlags(values, FIX_ONLY, 'works only with the fix command: agentcheckup fix.');
  rejectFlags(values, TASKS_ONLY, TASKS_ONLY_MESSAGE);
  const policy = values['policy'] as string | undefined;
  if (policy !== undefined && values['config'] !== undefined) {
    throw new UsageError(
      '--policy ignores configuration files, so it cannot be combined with --config.',
    );
  }
  // A policy run is untrusted: the change under review cannot turn checks off or hide files.
  const shared = {
    ...sharedOptions(values, positionals[0]),
    ...(policy === undefined ? {} : { useConfig: false, untrusted: true }),
  };
  const context = values['context'] === true;
  if (shared.contextWindow !== undefined && !context) {
    throw new UsageError('--context-window needs --context, or use the context command.');
  }
  if (values['compact'] === true && values['verbose'] === true) {
    throw new UsageError('--compact and --verbose cannot be combined.');
  }
  return {
    kind: 'scan',
    options: {
      ...shared,
      format: oneOf(
        (values['format'] as string | undefined) ?? 'stylish',
        OUTPUT_FORMATS,
        '--format',
      ),
      targets: parseTargets(values['targets'] as string | undefined),
      failOn: oneOf((values['fail-on'] as string | undefined) ?? 'error', FAIL_ON, '--fail-on'),
      minScore: parseMinScore(values['min-score'] as string | undefined),
      showSuppressed: values['show-suppressed'] === true,
      context,
      level:
        values['compact'] === true ? 'compact' : values['verbose'] === true ? 'verbose' : 'default',
      policy,
    },
  };
}

function parseRules(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = list(value);
  if (ids.length === 0) throw new UsageError('--rule needs at least one rule id.');
  return [...new Set(ids)];
}

function fixCommand(values: Values, rest: readonly string[]): Command {
  if (values['help'] === true) return { kind: 'help', topic: 'fix' };
  if (values['version'] === true) return { kind: 'version' };
  if (rest.length > 1) throw new UsageError(`"fix" takes at most one path, got ${rest.length}.`);
  rejectFlags(values, [...SCAN_ONLY, ...NOT_FOR_FIX], 'does not apply to the fix command.');
  rejectFlags(values, CONTEXT_ONLY, 'works only with the context command: agentcheckup context.');
  rejectFlags(values, TASKS_ONLY, TASKS_ONLY_MESSAGE);
  const write = values['write'] === true;
  const review = values['review'] === true;
  const interactive = values['interactive'] === true;
  if (review && !write) {
    throw new UsageError(
      '--review needs --write: "agentcheckup fix --write --review" applies the fixes that need ' +
        'review too. A dry run already shows them.',
    );
  }
  const untrusted = values['untrusted'] === true;
  if (untrusted && (write || interactive)) {
    throw new UsageError(
      `--untrusted allows only a dry run, so it cannot be combined with ${write ? '--write' : '-i'}.`,
    );
  }
  const format = oneOf((values['format'] as string | undefined) ?? 'diff', FIX_FORMATS, '--format');
  if (interactive && format === 'json' && values['output'] === undefined) {
    throw new UsageError(
      '-i asks its questions on stdout, so -i --format json needs --output <file>.',
    );
  }
  return {
    kind: 'fix',
    options: {
      ...sharedOptions(values, rest[0]),
      format,
      targets: parseTargets(values['targets'] as string | undefined),
      write,
      review,
      interactive,
      rules: parseRules(values['rule'] as string | undefined),
      diff: values['diff'] as string | undefined,
    },
  };
}

function parseMax(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TASKS;
  const max = /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!(max >= 1 && max <= MAX_TASKS)) {
    throw new UsageError(`--max must be a whole number from 1 to ${MAX_TASKS}. Got "${value}".`);
  }
  return max;
}

/**
 * `tasks --check [ids…]`. Takes no other option: a permission rule that allows
 * `agentcheckup tasks --check *` must never let an agent write a file (`--output`) or change
 * what is checked. Arguments that start with `ac-` are task ids; at most one other argument
 * names the repository root (`./ac-…` for a directory with such a name).
 */
function tasksCheckCommand(values: Values, rest: readonly string[]): Command {
  const other = Object.keys(values).find((key) => key !== 'check' && values[key] !== undefined);
  if (other !== undefined) {
    throw new UsageError(`--check takes only task ids, so it cannot be combined with --${other}.`);
  }
  const ids: string[] = [];
  const paths: string[] = [];
  for (const arg of rest) {
    if (!arg.startsWith('ac-')) paths.push(arg);
    else if (TASK_ID_PATTERN.test(arg)) ids.push(arg);
    else throw new UsageError(`"${arg}" is not a task id: ac- followed by 8 hex digits.`);
  }
  if (paths.length > 1) {
    throw new UsageError(`"tasks --check" takes at most one path, got ${paths.length}.`);
  }
  return {
    kind: 'tasks',
    options: {
      ...sharedOptions({}, paths[0]),
      format: 'markdown',
      rules: undefined,
      max: DEFAULT_MAX_TASKS,
      check: [...new Set(ids)],
    },
  };
}

function tasksCommand(values: Values, rest: readonly string[]): Command {
  if (values['help'] === true) return { kind: 'help', topic: 'tasks' };
  if (values['check'] === true) return tasksCheckCommand(values, rest);
  if (values['version'] === true) return { kind: 'version' };
  if (rest.length > 1) throw new UsageError(`"tasks" takes at most one path, got ${rest.length}.`);
  rejectFlags(values, [...SCAN_ONLY, ...NOT_FOR_TASKS], 'does not apply to the tasks command.');
  rejectFlags(values, CONTEXT_ONLY, 'works only with the context command: agentcheckup context.');
  rejectFlags(
    values,
    ['write', 'review', 'interactive', 'diff'],
    'works only with the fix command: agentcheckup fix.',
  );
  return {
    kind: 'tasks',
    options: {
      ...sharedOptions(values, rest[0]),
      format: oneOf(
        (values['format'] as string | undefined) ?? 'markdown',
        TASKS_FORMATS,
        '--format',
      ),
      rules: parseRules(values['rule'] as string | undefined),
      max: parseMax(values['max'] as string | undefined),
      check: undefined,
    },
  };
}

/**
 * `agentcheckup skill install [path] [--dir claude|agents] [--yes]`, parsed on its own: no other
 * command takes these flags, and `skill` takes none of theirs.
 */
function skillCommand(argv: readonly string[]): Command {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      dir: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      untrusted: { type: 'boolean' },
    },
  });
  if (values.help === true) return { kind: 'help', topic: 'skill' };
  const [, action, ...rest] = positionals;
  if (action !== 'install') {
    throw new UsageError(
      action === undefined
        ? '"skill" needs an action: agentcheckup skill install [path].'
        : `Unknown skill action "${action}". Use: agentcheckup skill install [path].`,
    );
  }
  if (rest.length > 1) {
    throw new UsageError(`"skill install" takes at most one path, got ${rest.length}.`);
  }
  if (values.untrusted === true) {
    throw new UsageError(
      'skill install writes to the repository, so it cannot be combined with --untrusted. ' +
        'Install the skill only in a repository you trust.',
    );
  }
  return {
    kind: 'skill',
    options: {
      ...sharedOptions({}, rest[0]),
      dir: values.dir === undefined ? undefined : oneOf(values.dir, SKILL_DIRS, '--dir'),
      yes: values.yes === true,
    },
  };
}

export function parseCommand(argv: readonly string[]): Command {
  // The first argument that is not a flag names the command, as in run.ts.
  if (argv.find((arg) => !arg.startsWith('-')) === 'skill') return skillCommand(argv);
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      format: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      targets: { type: 'string', short: 't' },
      'fail-on': { type: 'string' },
      'min-score': { type: 'string' },
      config: { type: 'string', short: 'c' },
      'no-config': { type: 'boolean' },
      untrusted: { type: 'boolean' },
      'no-gitignore': { type: 'boolean' },
      'show-suppressed': { type: 'boolean' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      json: { type: 'boolean' },
      context: { type: 'boolean' },
      baseline: { type: 'string' },
      gate: { type: 'string' },
      agent: { type: 'string' },
      cwd: { type: 'string' },
      matrix: { type: 'boolean' },
      'context-window': { type: 'string' },
      compact: { type: 'boolean' },
      verbose: { type: 'boolean' },
      write: { type: 'boolean' },
      review: { type: 'boolean' },
      interactive: { type: 'boolean', short: 'i' },
      rule: { type: 'string' },
      check: { type: 'boolean' },
      max: { type: 'string' },
      diff: { type: 'string' },
      policy: { type: 'string' },
    },
  });

  const [first, ...rest] = positionals;
  if (first === 'context') return contextCommand(values, rest);
  if (first === 'fix') return fixCommand(values, rest);
  if (first === 'tasks') return tasksCommand(values, rest);
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  if (first === 'rules') {
    if (rest.length > 0) throw new UsageError('"rules" takes no arguments.');
    return { kind: 'rules', format: values.json ? 'json' : 'text' };
  }
  if (first === 'explain') {
    const [ruleId, ...extra] = rest;
    if (ruleId === undefined || extra.length > 0) {
      throw new UsageError('Usage: agentcheckup explain <rule-id>');
    }
    return { kind: 'explain', ruleId };
  }
  return scanCommand(values, positionals);
}
