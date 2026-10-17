/**
 * What the commands of the CLI share: the injected I/O, exit codes, configuration loading, color
 * and the report writer.
 */
import { basename, dirname, resolve } from 'node:path';
import { ConfigError, resolveConfig, type ResolvedConfig } from '../core/config.js';
import { DIRECTIVE_RULES } from '../core/directive-rules.js';
import type { ScanOptions } from '../core/engine.js';
import { CONFIG_FILE_NAME } from '../core/meta.js';
import type { AnyRule, PlatformId, RuleMeta } from '../core/types.js';
import { readConfigFile } from '../io/config-file.js';
import { writeOutputFile } from '../io/output.js';
import { plainStyle, type Style } from '../report/stylish.js';
import { builtinRules } from '../rules/index.js';
import type { SharedCommandOptions } from './args.js';
import { ansiStyle, shouldUseColor } from './style.js';

/** How {@link Prompt.ask} asks. */
export interface AskOptions {
  /**
   * Text put on the input line after the question, as if typed, for the user to edit or accept
   * with Enter. Only a terminal gets it, and only one line of plain text: no control,
   * bidirectional or invisible character.
   */
  readonly initial?: string | undefined;
}

/** Line input for `agentcheckup fix -i`. */
export interface Prompt {
  /** Whether input comes from a terminal. `fix -i` needs one. */
  readonly isTTY: boolean;
  /**
   * Writes `question` and resolves with the next line of input without its line ending, or with
   * undefined when input ends or the user interrupts it (Ctrl+C).
   */
  readonly ask: (question: string, options?: AskOptions) => Promise<string | undefined>;
}

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is a terminal. */
  readonly isTTY: boolean;
  /** Answers for `fix -i`. Absent when there is no input to ask. */
  readonly prompt?: Prompt | undefined;
  /**
   * Test hook: runs after `fix` verified its fixes in memory and just before it writes them,
   * the window in which a file can change since the scan.
   */
  readonly beforeWrite?: (() => void | Promise<void>) | undefined;
}

/**
 * - 0: clean. `context` without `--gate` always exits 0 unless something fails. `fix`: nothing to
 *   change in a dry run, or every selected fix was applied and verified.
 * - 1: (new) findings at or above `--fail-on`, a score below `--min-score`, a tripped gate, or a
 *   policy violation that fails the run. `fix`: a dry run found changes, or a selected fix was
 *   not applied.
 * - 2: invalid arguments, configuration, `--cwd`, `--agent`, `--rule`, baseline or policy file;
 *   an unwritable output.
 * - 3: internal error, including a rule or loader that crashed.
 */
export const EXIT = { ok: 0, findings: 1, usage: 2, internal: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadConfig(
  options: SharedCommandOptions,
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

/** ANSI color for output to stdout when the flag, the environment and the terminal allow it. */
export function styleFor(options: Pick<SharedCommandOptions, 'output' | 'color'>, io: Io): Style {
  const color =
    options.output === undefined &&
    shouldUseColor({ flag: options.color, env: io.env, isTTY: io.isTTY });
  return color ? ansiStyle : plainStyle;
}

/** Writes the report to stdout, or with `--output` through the safe output writer. */
export async function emit(
  report: string,
  options: Pick<SharedCommandOptions, 'output'>,
  io: Io,
): Promise<void> {
  if (options.output === undefined) io.stdout(report);
  else await writeOutputFile(resolve(io.cwd, options.output), report);
}

export function scanOptionsFor(
  options: Pick<SharedCommandOptions, 'untrusted'>,
  config: ResolvedConfig | undefined,
  targets: readonly PlatformId[] | undefined,
  rules: readonly AnyRule[] = builtinRules,
): ScanOptions {
  return {
    rules,
    ...(config ? { config } : {}),
    ...(targets ? { targets } : {}),
    trustDirectives: !options.untrusted,
  };
}

/** The built-in rules and the engine's directive rules, by id. */
export function allRuleMeta(): RuleMeta[] {
  return [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
