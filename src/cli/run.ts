import { relative, resolve, sep } from 'node:path';
import { compareWithBaseline } from '../core/baseline.js';
import { type BaselineReport, validateBaseline } from '../core/baseline-input.js';
import type { GateClass } from '../core/baseline-types.js';
import { ConfigError } from '../core/config.js';
import {
  type ContextOptions,
  type ScanOptions,
  scanSnapshot,
  type ScanResult,
  scanWithContext,
} from '../core/engine.js';
import { rebaseResult } from '../core/rebase.js';
import { ruleDocsUrl } from '../core/meta.js';
import { PLATFORM_IDS, type RuleMeta, SEVERITIES, type Snapshot } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { OutputError } from '../io/output.js';
import { relativeInsideRoot } from '../io/paths.js';
import { InputFileError, readJsonInput } from '../io/read-file.js';
import { walk, WalkError } from '../io/walk.js';
import { contextAgentsOf } from '../platforms/load/index.js';
import { CONTEXT_AGENTS, CONTEXT_PLATFORM } from '../platforms/load/types.js';
import { badgeMarkdown } from '../report/badge.js';
import { formatBaselineMarkdown } from '../report/baseline-markdown.js';
import { formatBaselineText } from '../report/baseline-text.js';
import { formatContextMarkdown } from '../report/context-markdown.js';
import { formatContextText } from '../report/context-text.js';
import { format } from '../report/index.js';
import { formatJson } from '../report/json.js';
import { forTerminal } from '../report/sanitize.js';
import {
  type ContextCommandOptions,
  type FailOn,
  parseCommand,
  type ScanCommandOptions,
  UsageError,
} from './args.js';
import {
  allRuleMeta,
  emit,
  errorMessage,
  EXIT,
  type ExitCode,
  type Io,
  loadConfig,
  scanOptionsFor,
  styleFor,
} from './common.js';
import { fix } from './fix.js';
import { CONTEXT_HELP, FIX_HELP, HELP, TASKS_HELP } from './help.js';
import { loadPolicy, policyFailure, PolicyFileError, withPolicy } from './policy.js';
import { ansiStyle } from './style.js';
import { tasks } from './tasks.js';

export { EXIT, type ExitCode, type Io, type Prompt } from './common.js';

const HELP_TOPICS = {
  main: HELP,
  context: CONTEXT_HELP,
  fix: FIX_HELP,
  tasks: TASKS_HELP,
} as const;

/** Entry point with injected I/O, so the whole CLI is testable without spawning processes. */
export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  try {
    const command = parseCommand(argv);
    switch (command.kind) {
      case 'help':
        io.stdout(HELP_TOPICS[command.topic ?? 'main']);
        return EXIT.ok;
      case 'version':
        io.stdout(`${VERSION}\n`);
        return EXIT.ok;
      case 'rules':
        io.stdout(command.format === 'json' ? listRulesJson() : listRulesText());
        return EXIT.ok;
      case 'explain':
        return explain(command.ruleId, io);
      case 'scan':
        return await scan(command.options, io);
      case 'context':
        return await context(command.options, io);
      case 'fix':
        return await fix(command.options, io);
      case 'tasks':
        return await tasks(command.options, io);
    }
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      // The first argument that is not a flag names the command, as in parseCommand.
      const first = argv.find((arg) => !arg.startsWith('-'));
      const help =
        first === 'context' || first === 'fix' || first === 'tasks'
          ? `agentcheckup ${first} --help`
          : 'agentcheckup --help';
      io.stderr(`${forTerminal(errorMessage(error))}\n\nRun "${help}" for usage.\n`);
      return EXIT.usage;
    }
    if (error instanceof PolicyFileError) {
      for (const line of error.lines) io.stderr(`${forTerminal(line)}\n`);
      return EXIT.usage;
    }
    if (
      error instanceof ConfigError ||
      error instanceof WalkError ||
      error instanceof InputFileError ||
      error instanceof OutputError
    ) {
      io.stderr(`${forTerminal(errorMessage(error))}\n`);
      return EXIT.usage;
    }
    io.stderr(
      `Internal error: ${forTerminal(errorMessage(error))}\n` +
        'Please report it at https://github.com/mustafakbaser/agentcheckup/issues\n',
    );
    return EXIT.internal;
  }
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  );
}

/**
 * Reads and checks the `--baseline` report. Read before the scan, so a bad baseline fails fast.
 * Throws InputFileError (exit 2) for a file that cannot be read, is not JSON, or is not a report
 * this version can compare with.
 */
async function loadBaseline(
  file: string | undefined,
  cwd: string,
): Promise<BaselineReport | undefined> {
  if (file === undefined) return undefined;
  const value = await readJsonInput(resolve(cwd, file), { label: 'Baseline file' });
  const checked = validateBaseline(value);
  if (!checked.ok) {
    throw new InputFileError(`Cannot use ${file} as a baseline. ${checked.message}`);
  }
  return checked.baseline;
}

/**
 * Marks each finding new or unchanged and adds the comparison. Runs on the scan before rebasing,
 * so the comparison's paths are rebased together with the rest of the result.
 */
function withBaseline(
  scanned: ScanResult,
  baseline: BaselineReport | undefined,
  gate: readonly GateClass[],
): ScanResult {
  if (baseline === undefined) return scanned;
  const comparison = compareWithBaseline(scanned, baseline, { gate });
  return { ...scanned, findings: comparison.findings, baseline: comparison.diff };
}

/** Formats a person reads: they show what each agent misses unless `--compact`. */
const HUMAN_FORMATS: ReadonlySet<string> = new Set(['stylish', 'markdown', 'github']);

/** The format puts the comparison's ruleset notice in the report itself. */
const SHOWS_RULESET_NOTICE: ReadonlySet<string> = new Set([
  'stylish',
  'markdown',
  'github',
  'text',
]);

function warn(result: ScanResult, format: string, io: Io): void {
  for (const warning of result.configWarnings) io.stderr(`Warning: ${forTerminal(warning)}\n`);
  const diff = result.baseline;
  if (diff !== undefined && !diff.against.sameRuleset && !SHOWS_RULESET_NOTICE.has(format)) {
    io.stderr(
      `Warning: The baseline was written with ruleset ${forTerminal(diff.against.ruleset)}, ` +
        `this is ruleset ${forTerminal(result.ruleset)}. Findings from rules it did not run ` +
        'count as new.\n',
    );
  }
  const policy = policyFailure(result);
  if (policy !== undefined && !HUMAN_FORMATS.has(format)) io.stderr(`${forTerminal(policy)}\n`);
}

/**
 * The prefix for report paths, which are relative to the scanned directory until rebased.
 *
 * GitHub resolves annotation and SARIF paths against the repository root. In GitHub Actions
 * ($GITHUB_WORKSPACE set) and with the scanned directory inside the workspace, those two formats
 * use paths relative to the workspace, so a scan run from $RUNNER_TEMP on "$GITHUB_WORKSPACE"
 * maps to the right files. Everything else, and those formats outside Actions, use paths
 * relative to the working directory, as terminal users expect.
 */
function pathPrefix(root: string, io: Io, format: string): string {
  if (format === 'github' || format === 'sarif') {
    const workspace = io.env['GITHUB_WORKSPACE'];
    if (workspace !== undefined && workspace !== '') {
      const inside = relativeInsideRoot(resolve(io.cwd, workspace), root);
      if (inside !== undefined) return inside;
    }
  }
  return relative(io.cwd, root).split(sep).join('/');
}

/**
 * The scan with root load plans, for the summary of what each agent misses. The plans only add
 * to the report: if a loader crashes, the findings are reported without them, with a warning.
 */
function scanWithRootPlans(snapshot: Snapshot, scanOptions: ScanOptions, io: Io): ScanResult {
  try {
    return scanWithContext(snapshot, { ...scanOptions, matrix: false });
  } catch (error) {
    io.stderr(
      `Warning: Could not work out what each agent loads, so the report leaves it out: ` +
        `${forTerminal(errorMessage(error))}\n`,
    );
    return scanSnapshot(snapshot, scanOptions);
  }
}

async function scan(options: ScanCommandOptions, io: Io): Promise<ExitCode> {
  const root = resolve(io.cwd, options.path);
  const policy = await loadPolicy(options.policy, root, io.cwd);
  const baseline = await loadBaseline(options.baseline, io.cwd);
  const config = await loadConfig(options, root, io.cwd);
  const snapshot = await walk(root, {
    respectGitignore: options.gitignore,
    scanIgnoredAgentConfig: options.untrusted,
  });
  const scanOptions = scanOptionsFor(options, config, options.targets);
  // Human-readable reports show what each agent misses, from the root load plans (cheap: no
  // matrix). `--compact` shows findings only, and JSON, SARIF and the badge add plans only with
  // --context.
  const rootPlans = options.level !== 'compact' && HUMAN_FORMATS.has(options.format);
  const scanned = options.context
    ? scanWithContext(snapshot, {
        ...scanOptions,
        matrix: true,
        ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      })
    : rootPlans
      ? scanWithRootPlans(snapshot, scanOptions, io)
      : scanSnapshot(snapshot, scanOptions);
  const checked = withPolicy(scanned, policy, baseline, snapshot, scanOptions);
  const result = rebaseResult(
    withBaseline(checked, baseline, options.gate),
    pathPrefix(root, io, options.format),
  );

  const style = styleFor(options, io);
  const report =
    options.format === 'badge'
      ? `${badgeMarkdown(result)}\n`
      : format(result, options.format, {
          style,
          showSuppressed: options.showSuppressed,
          level: options.level,
          // OSC 8 links only where a terminal renders them: ANSI output to a TTY.
          hyperlinks: style === ansiStyle && io.isTTY,
        });
  warn(result, options.format, io);
  await emit(report, options, io);
  return exitCodeFor(result, options.failOn, options.minScore);
}

/**
 * Throws a UsageError unless `cwd` is a directory the walk listed: it exists, is a directory,
 * and neither it nor a directory above it was left unlisted (excluded, gitignored, too deep,
 * unreadable, a symlink out of the root). A plan for a directory agentcheckup did not look into
 * would claim things it cannot know.
 */
function checkListedDirectory(snapshot: Snapshot, cwd: string, path: string): void {
  if (cwd === '') return;
  const parts = cwd.split('/');
  for (let length = 1; length <= parts.length; length++) {
    const directory = `${parts.slice(0, length).join('/')}/`;
    if (snapshot.opaqueDirectories.has(directory)) {
      throw new UsageError(
        `--cwd ${cwd}: agentcheckup did not list ${directory} (it is excluded, gitignored, ` +
          'too deep, unreadable or a link out of the scanned directory), so it cannot plan a ' +
          'session there.',
      );
    }
  }
  if (snapshot.paths.has(`${cwd}/`)) return;
  if (snapshot.paths.has(cwd)) throw new UsageError(`--cwd ${cwd} is a file, not a directory.`);
  throw new UsageError(`--cwd ${cwd}: no such directory in ${path}.`);
}

async function context(options: ContextCommandOptions, io: Io): Promise<ExitCode> {
  const root = resolve(io.cwd, options.path);
  const baseline = await loadBaseline(options.baseline, io.cwd);
  const config = await loadConfig(options, root, io.cwd);
  const snapshot = await walk(root, {
    respectGitignore: options.gitignore,
    scanIgnoredAgentConfig: options.untrusted,
  });
  checkListedDirectory(snapshot, options.cwd, options.path);

  const configured = config?.targets ?? PLATFORM_IDS;
  const agents = options.agents ?? contextAgentsOf(configured);
  if (agents.length === 0) {
    throw new UsageError(
      `None of the targets (${configured.join(', ')}) has a load model. ` +
        `agentcheckup context models ${CONTEXT_AGENTS.join(', ')}; choose with --agent.`,
    );
  }
  // An agent named with --agent is planned even if the configuration does not target it, so
  // its rules run too: the plan reports a skip only where its rule reports a finding.
  const targets =
    options.agents === undefined
      ? undefined
      : [...new Set([...configured, ...agents.map((agent) => CONTEXT_PLATFORM[agent])])];
  const contextOptions: ContextOptions = {
    agents,
    cwd: options.cwd,
    matrix: options.matrix,
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  };
  const scanned = scanWithContext(snapshot, {
    ...scanOptionsFor(options, config, targets),
    ...contextOptions,
  });
  const result = rebaseResult(
    withBaseline(scanned, baseline, options.gate),
    pathPrefix(root, io, options.format),
  );

  let report: string;
  switch (options.format) {
    case 'text': {
      const style = styleFor(options, io);
      report = joinSections(
        formatContextText(result, { style }),
        formatBaselineText(result, { style }),
      );
      break;
    }
    case 'markdown':
      report = joinSections(formatContextMarkdown(result), formatBaselineMarkdown(result));
      break;
    case 'json':
      report = formatJson(result);
      break;
  }
  warn(result, options.format, io);
  await emit(report, options, io);
  return contextExitCode(result);
}

/** Sections that each end with a newline, separated by one blank line. */
function joinSections(...sections: readonly string[]): string {
  return sections.filter((section) => section !== '').join('\n');
}

/**
 * Exit code of a scan. With a baseline, `failOn` counts new findings only; the score still
 * covers every finding, and a tripped gate fails too. A policy violation that fails the run
 * fails it whatever `failOn` says.
 */
export function exitCodeFor(
  result: ScanResult,
  failOn: FailOn,
  minScore: number | undefined,
): ExitCode {
  if (result.ruleFailures.length > 0) return EXIT.internal;
  if (gateTripped(result)) return EXIT.findings;
  if (result.policy?.violations.some((violation) => violation.fails) === true) {
    return EXIT.findings;
  }
  if (failOn !== 'none') {
    const threshold = SEVERITIES.indexOf(failOn);
    const compared = result.baseline !== undefined;
    const failing = result.findings.some(
      (finding) =>
        !finding.suppressed &&
        (!compared || finding.baseline === 'new') &&
        SEVERITIES.indexOf(finding.severity) >= threshold,
    );
    if (failing) return EXIT.findings;
  }
  if (minScore !== undefined && result.score.score !== null && result.score.score < minScore) {
    return EXIT.findings;
  }
  return EXIT.ok;
}

/** Exit code of `agentcheckup context`: findings never fail it, a tripped gate does. */
export function contextExitCode(result: ScanResult): ExitCode {
  if (result.ruleFailures.length > 0) return EXIT.internal;
  return gateTripped(result) ? EXIT.findings : EXIT.ok;
}

function gateTripped(result: ScanResult): boolean {
  return (result.baseline?.gate.hits.length ?? 0) > 0;
}

function listRulesText(): string {
  const rules = allRuleMeta();
  const width = Math.max(...rules.map((meta) => meta.id.length), 10);
  const lines = rules.map(
    (meta) => `${meta.id.padEnd(width)}  ${meta.severity.padEnd(5)}  ${meta.title}`,
  );
  return `${lines.join('\n')}\n\n${rules.length} rules. Run "agentcheckup explain <rule-id>" for details.\n`;
}

function listRulesJson(): string {
  return `${JSON.stringify(allRuleMeta(), null, 2)}\n`;
}

function explain(ruleId: string, io: Io): ExitCode {
  const meta = allRuleMeta().find((candidate) => candidate.id === ruleId);
  if (!meta) {
    io.stderr(`Unknown rule "${forTerminal(ruleId)}". Run "agentcheckup rules" to list rules.\n`);
    return EXIT.usage;
  }
  const sources = meta.sources
    .map(
      (source) =>
        `  - ${source.title} (${source.status}, checked ${source.checked})\n    ${source.url}`,
    )
    .join('\n');
  io.stdout(
    `${meta.id}\n${meta.title}\n\n` +
      `Severity:   ${meta.severity}\n` +
      `Category:   ${meta.category}\n` +
      `Platforms:  ${meta.platforms.join(', ')}\n` +
      `Applies to: ${meta.appliesTo.join(', ')}\n` +
      `${fixLines(meta)}\n\n` +
      `${meta.rationale}\n\nSources:\n${sources}\n\nDocs: ${ruleDocsUrl(meta.id)}\n`,
  );
  return EXIT.ok;
}

/** `Fix:` and the classes a rule's fixes can have with its summary, or that it has none. */
function fixLines(meta: RuleMeta): string {
  if (meta.fix === undefined) return 'Fix:        No automatic fix; guidance only';
  return (
    `Fix:        ${meta.fix.classes.join(', ')} (agentcheckup fix --rule ${meta.id})\n` +
    `            ${meta.fix.summary}`
  );
}
