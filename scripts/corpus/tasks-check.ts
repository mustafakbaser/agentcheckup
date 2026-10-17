/**
 * `run.ts --tasks-check`: builds the `agentcheckup tasks` prompt and JSON for every corpus
 * repository, scanned as `--untrusted` scans it, and checks what a user handing the prompt to an
 * agent relies on:
 *
 * - the JSON follows schemas/tasks.schema.json;
 * - neither output holds a character the terminal sanitizer would escape, or anything
 *   mcp/literal-secret's detector reports as a credential;
 * - every `~~~~untrusted` block is closed by its own fence, and no line inside could close it;
 * - every command is a fixed `npx agentcheckup@<version> tasks|fix …` command;
 * - `tasks --check` agrees: as many open tasks as the list counts, and each listed task open;
 * - the default prompt (`--max 20`) stays under {@link MAX_PROMPT_CHARS}.
 *
 * It prints aggregate counts (tasks by rule, template coverage, prompt sizes) and every
 * violation. Violations name repositories, so the output is for local review only, like
 * corpus/REPORT.md. Nothing is written.
 *
 *   npx tsx scripts/corpus/run.ts --tasks-check [--only owner/name]
 */
import { parseArgs } from 'node:util';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { allRuleMeta } from '../../src/cli/common.js';
import { compareStrings } from '../../src/core/compare.js';
import { analyze, runRules, type ScanOptions } from '../../src/core/engine.js';
import type { Snapshot } from '../../src/core/types.js';
import { formatTasksJson } from '../../src/report/tasks-json.js';
import { formatTasksMarkdown } from '../../src/report/tasks-markdown.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { findSecret } from '../../src/rules/mcp/secrets.js';
import { builtinRules } from '../../src/rules/index.js';
import {
  buildTasks,
  checkTasks,
  DEFAULT_MAX_TASKS,
  MAX_TASKS,
  openTasks,
  type TaskScan,
} from '../../src/tasks/index.js';
import { TASKS_JSON_SCHEMA } from '../../src/tasks/schema.js';
import { loadRepos, log, type RepoEntry, repoLabel } from './common.js';
import { percentile } from './fix-replay.js';
import { loadSnapshot } from './snapshot.js';

/** The largest default prompt (`--max 20`) that is still reasonable to paste into an agent. */
export const MAX_PROMPT_CHARS = 128 * 1024;

const COMMAND = /^npx agentcheckup@\S+ (?:tasks|fix)(?: \S+)*$/;

export interface RepoTasks {
  readonly label: string;
  readonly open: number;
  readonly steps: number;
  readonly forYou: number;
  /** Open tasks by rule id, and whether the rule has its own template. */
  readonly byRule: ReadonlyMap<string, { readonly tasks: number; readonly own: boolean }>;
  /** Characters of the default prompt. */
  readonly promptChars: number;
  readonly violations: readonly string[];
}

/**
 * True when the terminal sanitizer would change nothing: no control, bidirectional, zero-width
 * or tag character is left unescaped. A zero-width joiner between two emoji is kept, as the
 * sanitizer keeps it everywhere.
 */
function neutral(text: string): boolean {
  return forTerminal(text, { multiline: true }) === text;
}

/** Why the `~~~~untrusted` blocks of a prompt are not well-formed, or undefined. */
export function fenceProblem(markdown: string): string | undefined {
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    if (fence === undefined) {
      if (line.startsWith('~~~~') && line.endsWith('untrusted')) {
        fence = line.slice(0, -'untrusted'.length);
      }
    } else if (line === fence) {
      fence = undefined;
    } else if (line.trimStart().startsWith(fence)) {
      return 'a line inside an untrusted block could close it';
    }
  }
  return fence === undefined ? undefined : 'an untrusted block is not closed';
}

/** The tasks of one repository, checked. Pure apart from the schema validator it is given. */
export function checkRepoTasks(
  label: string,
  snapshot: Snapshot,
  validate: ValidateFunction,
): RepoTasks {
  const options: ScanOptions = { rules: builtinRules, trustDirectives: false };
  const analysis = analyze(snapshot, options);
  const result = runRules(analysis, options);
  const violations: string[] = result.ruleFailures.map(
    (failure) => `rule ${failure.ruleId} crashed: ${forTerminal(failure.message)}`,
  );
  const scan: TaskScan = { findings: result.findings, rules: allRuleMeta(), analysis };
  const list = buildTasks(scan, { untrusted: true, max: MAX_TASKS });
  const markdown = formatTasksMarkdown(list);
  const json = formatTasksJson(list);

  if (!validate(JSON.parse(json))) {
    violations.push(`schema: ${new Ajv2020().errorsText(validate.errors)}`);
  }
  for (const [name, text] of [
    ['markdown', markdown],
    ['json', json],
  ] as const) {
    if (!neutral(text)) violations.push(`${name} holds a character the sanitizer escapes`);
    if (findSecret(text) !== undefined) violations.push(`${name} holds a credential`);
  }
  const fence = fenceProblem(markdown);
  if (fence !== undefined) violations.push(fence);
  const commands = [
    list.check.command,
    ...list.steps.map((step) => step.command),
    ...list.tasks.map((task) => task.check.command),
  ];
  for (const command of commands) {
    if (!COMMAND.test(command)) violations.push(`unexpected command: ${forTerminal(command)}`);
  }
  if (openTasks(scan).length !== list.open) {
    violations.push(
      `tasks --check counts ${openTasks(scan).length} open tasks, the list ${list.open}`,
    );
  }
  const statuses = checkTasks(
    scan,
    list.tasks.map((task) => task.id),
  );
  for (const status of statuses) {
    if (status.open.length === 0) violations.push(`${status.id} is listed but --check says done`);
  }
  const prompt = formatTasksMarkdown(buildTasks(scan, { untrusted: true, max: DEFAULT_MAX_TASKS }));
  if (prompt.length > MAX_PROMPT_CHARS) {
    violations.push(`the default prompt has ${prompt.length} characters`);
  }

  const byRule = new Map<string, { tasks: number; own: boolean }>();
  for (const task of list.tasks) {
    const entry = byRule.get(task.ruleId) ?? { tasks: 0, own: task.template === 'rule' };
    entry.tasks += 1;
    byRule.set(task.ruleId, entry);
  }
  return {
    label,
    open: list.open,
    steps: list.readyFixes.safe + list.readyFixes.review,
    forYou: list.forYou.length + list.forYouOmitted,
    byRule,
    promptChars: prompt.length,
    violations,
  };
}

/** The aggregate report and every violation, for the terminal. */
export function renderTasksCheck(repos: readonly RepoTasks[]): {
  readonly text: string;
  readonly violations: number;
} {
  const rules = new Map<string, { tasks: number; repos: number; own: boolean }>();
  for (const repo of repos) {
    for (const [id, entry] of repo.byRule) {
      const total = rules.get(id) ?? { tasks: 0, repos: 0, own: entry.own };
      total.tasks += entry.tasks;
      total.repos += 1;
      rules.set(id, total);
    }
  }
  const tasks = repos.reduce((sum, repo) => sum + repo.open, 0);
  const own = [...rules.values()].reduce((sum, rule) => sum + (rule.own ? rule.tasks : 0), 0);
  const sizes = repos.map((repo) => repo.promptChars).sort((a, b) => a - b);
  const lines = [
    `${repos.length} repositories: ${tasks} open tasks (${own} with a template of their own), ` +
      `${repos.reduce((sum, repo) => sum + repo.steps, 0)} findings with a ready fix, ` +
      `${repos.reduce((sum, repo) => sum + repo.forYou, 0)} "For you" items.`,
    `Default prompt: median ${percentile(sizes, 0.5)}, p90 ${percentile(sizes, 0.9)}, ` +
      `max ${sizes.at(-1) ?? 0} characters.`,
    '',
    'Tasks by rule:',
    ...[...rules]
      .sort(([a, x], [b, y]) => y.tasks - x.tasks || compareStrings(a, b))
      .map(
        ([id, rule]) =>
          `  ${id.padEnd(36)} ${String(rule.tasks).padStart(5)} in ${String(rule.repos).padStart(3)} repositories${rule.own ? '' : ' (generic)'}`,
      ),
  ];
  const violations = repos.flatMap((repo) =>
    repo.violations.map((violation) => `  ${repo.label}: ${violation}`),
  );
  lines.push(
    '',
    violations.length === 0 ? 'No violations.' : `${violations.length} violations:`,
    ...violations,
  );
  return { text: `${lines.join('\n')}\n`, violations: violations.length };
}

/** `run.ts --tasks-check [--only owner/name]`: exit status 0, 1 (violations) or 2 (no cache). */
export async function tasksCheckMain(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'tasks-check': { type: 'boolean' },
      only: { type: 'string', multiple: true, default: [] },
    },
    strict: true,
  });
  const only = new Set(values.only.map((name) => name.toLowerCase()));
  const repos = (await loadRepos()).filter(
    (entry: RepoEntry) => only.size === 0 || only.has(entry.repo.toLowerCase()),
  );
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    JSON.parse(JSON.stringify(TASKS_JSON_SCHEMA)) as object,
  );
  const checked: RepoTasks[] = [];
  const incomplete: string[] = [];
  for (const entry of repos) {
    const loaded = await loadSnapshot(entry);
    if ('problem' in loaded) {
      incomplete.push(`${repoLabel(entry)}: ${loaded.problem}`);
      continue;
    }
    checked.push(checkRepoTasks(repoLabel(entry), loaded.snapshot, validate));
  }
  if (incomplete.length > 0) {
    log(
      `The cache is incomplete; run \`npx tsx scripts/corpus/fetch.ts\` first:\n${incomplete.map((line) => `- ${line}`).join('\n')}`,
    );
    return 2;
  }
  const rendered = renderTasksCheck(checked);
  process.stdout.write(rendered.text);
  return rendered.violations > 0 ? 1 : 0;
}
