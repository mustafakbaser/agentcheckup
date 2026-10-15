import { writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { ConfigError, resolveConfig, type ResolvedConfig } from '../core/config.js';
import { scanSnapshot, type ScanResult } from '../core/engine.js';
import { rebaseResult } from '../core/rebase.js';
import { CONFIG_FILE_NAME, ruleDocsUrl } from '../core/meta.js';
import { SEVERITIES, type RuleMeta } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { readConfigFile } from '../io/config-file.js';
import { walk, WalkError } from '../io/walk.js';
import { badgeMarkdown } from '../report/badge.js';
import { format } from '../report/index.js';
import { forTerminal } from '../report/sanitize.js';
import { plainStyle, type Style } from '../report/stylish.js';
import { DIRECTIVE_RULES } from '../core/directive-rules.js';
import { builtinRules } from '../rules/index.js';
import { parseCommand, UsageError, type FailOn, type ScanCommandOptions } from './args.js';
import { HELP } from './help.js';
import { ansiStyle, shouldUseColor } from './style.js';

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
}

export const EXIT = { ok: 0, findings: 1, usage: 2, internal: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Entry point with injected I/O, so the whole CLI is testable without spawning processes. */
export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  try {
    const command = parseCommand(argv);
    switch (command.kind) {
      case 'help':
        io.stdout(HELP);
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
    }
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr(`${forTerminal(errorMessage(error))}\n\nRun "agentcheck --help" for usage.\n`);
      return EXIT.usage;
    }
    if (error instanceof ConfigError || error instanceof WalkError) {
      io.stderr(`${forTerminal(errorMessage(error))}\n`);
      return EXIT.usage;
    }
    io.stderr(
      `Internal error: ${forTerminal(errorMessage(error))}\n` +
        'Please report it at https://github.com/mustafakbaser/agentcheck/issues\n',
    );
    return EXIT.internal;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  );
}

async function loadConfig(
  options: ScanCommandOptions,
  root: string,
  cwd: string,
): Promise<ResolvedConfig | undefined> {
  if (!options.useConfig) return undefined;
  const explicit = options.config === undefined ? undefined : resolve(cwd, options.config);
  const directory = explicit === undefined ? root : dirname(explicit);
  const fileName = explicit === undefined ? CONFIG_FILE_NAME : basename(explicit);
  const text = await readConfigFile(directory, fileName);
  if (text === undefined) {
    if (explicit !== undefined) throw new ConfigError(`Config file not found: ${explicit}`);
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${fileName} is not valid JSON: ${errorMessage(error)}`);
  }
  return resolveConfig(raw, fileName);
}

async function scan(options: ScanCommandOptions, io: Io): Promise<ExitCode> {
  const root = resolve(io.cwd, options.path);
  const config = await loadConfig(options, root, io.cwd);
  const snapshot = await walk(root, { respectGitignore: options.gitignore });
  const scanned = scanSnapshot(snapshot, {
    rules: builtinRules,
    ...(config ? { config } : {}),
    ...(options.targets ? { targets: options.targets } : {}),
    trustDirectives: !options.untrusted,
  });
  // Report paths relative to the working directory, which in CI is the repository root:
  // SARIF and annotations resolve paths against it.
  const result = rebaseResult(scanned, relative(io.cwd, root).split(sep).join('/'));

  const color =
    options.output === undefined &&
    shouldUseColor({ flag: options.color, env: io.env, isTTY: io.isTTY });
  const style: Style = color ? ansiStyle : plainStyle;
  const report =
    options.format === 'badge'
      ? `${badgeMarkdown(result)}\n`
      : format(result, options.format, { style, showSuppressed: options.showSuppressed });

  for (const warning of result.configWarnings) io.stderr(`Warning: ${forTerminal(warning)}\n`);

  if (options.output === undefined) {
    io.stdout(report);
  } else {
    await writeFile(resolve(io.cwd, options.output), report, 'utf8');
  }

  return exitCodeFor(result, options.failOn, options.minScore);
}

export function exitCodeFor(
  result: ScanResult,
  failOn: FailOn,
  minScore: number | undefined,
): ExitCode {
  if (result.ruleFailures.length > 0) return EXIT.internal;
  if (failOn !== 'none') {
    const threshold = SEVERITIES.indexOf(failOn);
    const failing = result.findings.some(
      (finding) => !finding.suppressed && SEVERITIES.indexOf(finding.severity) >= threshold,
    );
    if (failing) return EXIT.findings;
  }
  if (minScore !== undefined && result.score.score !== null && result.score.score < minScore) {
    return EXIT.findings;
  }
  return EXIT.ok;
}

function allRuleMeta(): RuleMeta[] {
  return [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function listRulesText(): string {
  const rules = allRuleMeta();
  const width = Math.max(...rules.map((meta) => meta.id.length), 10);
  const lines = rules.map(
    (meta) => `${meta.id.padEnd(width)}  ${meta.severity.padEnd(5)}  ${meta.title}`,
  );
  return `${lines.join('\n')}\n\n${rules.length} rules. Run "agentcheck explain <rule-id>" for details.\n`;
}

function listRulesJson(): string {
  return `${JSON.stringify(allRuleMeta(), null, 2)}\n`;
}

function explain(ruleId: string, io: Io): ExitCode {
  const meta = allRuleMeta().find((candidate) => candidate.id === ruleId);
  if (!meta) {
    io.stderr(`Unknown rule "${forTerminal(ruleId)}". Run "agentcheck rules" to list rules.\n`);
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
      `Applies to: ${meta.appliesTo.join(', ')}\n\n` +
      `${meta.rationale}\n\nSources:\n${sources}\n\nDocs: ${ruleDocsUrl(meta.id)}\n`,
  );
  return EXIT.ok;
}
