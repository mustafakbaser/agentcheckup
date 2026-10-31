/**
 * `agentcheckup tasks` (docs/tasks.md): scans the repository as `fix` does, then lists the
 * findings that need judgment as tasks for a coding agent (src/tasks), or with `--check` says
 * which tasks are still open. Reads only: the one file it can write is the `--output` report,
 * through the safe output writer, and `--check` cannot take `--output`.
 */
import { relative, resolve, sep } from 'node:path';
import { analyze, runRules } from '../core/engine.js';
import { createParseCache } from '../core/parse-cache.js';
import { checkRoot, walk } from '../io/walk.js';
import { forTerminal, guardWorkflowCommands } from '../report/sanitize.js';
import { formatTasksJson } from '../report/tasks-json.js';
import { formatTasksMarkdown, UNTRUSTED_BANNER } from '../report/tasks-markdown.js';
import { SEVERITY_LABELS } from '../report/text.js';
import { redactSecrets } from '../tasks/redact.js';
import {
  buildTasks,
  checkTasks,
  openTasks,
  shellWord,
  type TaskScan,
  type TaskStatus,
} from '../tasks/index.js';
import { type TasksCommandOptions, UsageError } from './args.js';
import {
  allRuleMeta,
  checkOutput,
  emit,
  EXIT,
  type ExitCode,
  type Io,
  loadConfig,
  pathBase,
  rootInside,
  scanOptionsFor,
} from './common.js';

/** Open tasks `--check` lists without ids; the rest are counted. */
const MAX_LISTED = 50;

export async function tasks(options: TasksCommandOptions, io: Io): Promise<ExitCode> {
  const rules = checkedRuleIds(options.rules);
  const directory = await checkRoot(resolve(io.cwd, options.path));
  const root = directory.path;
  const config = await loadConfig(options, root, io.cwd);
  // The walk's import pass and the scan share their parses.
  const parseCache = createParseCache();
  const snapshot = await walk(root, {
    respectGitignore: true,
    scanIgnoredAgentConfig: options.untrusted,
    parseCache,
  });
  await checkOutput(options, io, directory, snapshot);
  const scanOptions = { ...scanOptionsFor(options, config, undefined), parseCache };
  const analysis = analyze(snapshot, scanOptions);
  const result = runRules(analysis, scanOptions);
  for (const warning of result.configWarnings) io.stderr(`Warning: ${forTerminal(warning)}\n`);
  if (result.ruleFailures.length > 0) {
    for (const failure of result.ruleFailures) {
      io.stderr(`Rule ${forTerminal(failure.ruleId)} crashed: ${forTerminal(failure.message)}\n`);
    }
    io.stderr('A scan with a crashed rule cannot tell which tasks are open.\n');
    return EXIT.internal;
  }
  const scan: TaskScan = { findings: result.findings, rules: allRuleMeta(), analysis };
  // Paths read relative to the working directory when the scanned directory is inside it.
  const base = pathBase(directory, io);
  if (options.check !== undefined) return check(scan, options.check, base, io);

  // Commands run from the working directory, so outside it they keep the path as given.
  const inside = rootInside(io.cwd, directory);
  const list = buildTasks(scan, {
    pathBase: base,
    commandPath: shellWord(inside ?? relative(io.cwd, root).split(sep).join('/')),
    untrusted: options.untrusted,
    rules,
    max: options.max,
  });
  const report = options.format === 'json' ? formatTasksJson(list) : formatTasksMarkdown(list);
  if (options.untrusted) io.stderr(`Warning: ${UNTRUSTED_BANNER}.\n`);
  await emit(report, options, io);
  return list.open > 0 ? EXIT.findings : EXIT.ok;
}

/** `--rule` as a set, or a UsageError naming the ids no rule has. */
function checkedRuleIds(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (ids === undefined) return undefined;
  const known = new Set(allRuleMeta().map((meta) => meta.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    const names = unknown.map((id) => `"${id}"`).join(', ');
    throw new UsageError(
      `--rule: unknown rule ${names}. Run "agentcheckup rules" to list the rules.`,
    );
  }
  return new Set(ids);
}

/** A path for the terminal: with the base in front, credentials redacted, escapes rendered. */
function shown(base: string, path: string): string {
  const text = redactSecrets(path).text;
  return forTerminal(base === '' ? text : `${base}/${text}`);
}

function statusLines(status: TaskStatus, base: string): string[] {
  if (status.open.length === 0) return [`${status.id}  done`];
  return status.open.map((reason) => {
    const what =
      reason.kind === 'guard'
        ? `guard ${reason.ruleId} (${SEVERITY_LABELS[reason.severity]})`
        : reason.ruleId;
    return `${status.id}  open  ${what}  ${shown(base, reason.path)}:${reason.line}`;
  });
}

function check(scan: TaskScan, ids: readonly string[], base: string, io: Io): ExitCode {
  const lines: string[] = [];
  let open: number;
  if (ids.length === 0) {
    const statuses = openTasks(scan);
    open = statuses.length;
    for (const status of statuses.slice(0, MAX_LISTED)) lines.push(...statusLines(status, base));
    if (open > MAX_LISTED) lines.push(`… and ${open - MAX_LISTED} more.`);
    lines.push(
      open === 0
        ? 'No open tasks.'
        : `${open} ${open === 1 ? 'task is' : 'tasks are'} open. Run "agentcheckup tasks" to see what to do.`,
    );
  } else {
    const statuses = checkTasks(scan, ids);
    open = statuses.filter((status) => status.open.length > 0).length;
    for (const status of statuses) lines.push(...statusLines(status, base));
    lines.push(`${open} of ${ids.length} ${ids.length === 1 ? 'task' : 'tasks'} open.`);
  }
  io.stdout(guardWorkflowCommands(`${lines.join('\n')}\n`));
  return open > 0 ? EXIT.findings : EXIT.ok;
}
