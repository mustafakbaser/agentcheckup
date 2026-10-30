/**
 * What the commands of the CLI share: the injected I/O, exit codes, configuration loading, color
 * and the report writer.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { ConfigError, resolveConfig, type ResolvedConfig } from '../core/config.js';
import { DIRECTIVE_RULES } from '../core/directive-rules.js';
import type { ScanOptions } from '../core/engine.js';
import { CONFIG_FILE_NAME } from '../core/meta.js';
import type { AnyRule, PlatformId, RuleMeta, Snapshot } from '../core/types.js';
import { readConfigFile } from '../io/config-file.js';
import { entryIdentity, OutputError, realParentPath, writeOutputFile } from '../io/output.js';
import { relativeInsideRoot } from '../io/paths.js';
import { type FileIdentity, sameFile } from '../io/safe-read.js';
import type { CheckedRoot } from '../io/walk.js';
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
  /**
   * Ends the questions and gives the terminal back, so that Ctrl+C reaches the process again.
   * `fix -i` calls it after the last answer, before it writes.
   */
  readonly close?: () => void;
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
  /**
   * Aborted, with the signal's name as its reason, when the user interrupts (Ctrl+C, SIGTERM,
   * SIGHUP) work run through {@link interruptible}. src/cli/interrupt.ts.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Runs `work` with interrupts turned into an abort of {@link signal}, so that it can finish
   * what must not be cut short. Without it, `work` simply runs.
   */
  readonly interruptible?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
}

/** Runs `work` through {@link Io.interruptible}: an interrupt aborts `io.signal` meanwhile. */
export function interruptible<T>(io: Io, work: () => Promise<T>): Promise<T> {
  return io.interruptible === undefined ? work() : io.interruptible(work);
}

/**
 * - 0: clean. `context` without `--gate` always exits 0 unless something fails. `fix`: nothing to
 *   change in a dry run, or every selected fix was applied and verified.
 * - 1: (new) findings at or above `--fail-on`, a score below `--min-score`, a tripped gate, or a
 *   policy violation that fails the run. `fix`: a dry run found changes, or a selected fix was
 *   not applied.
 * - 2: invalid arguments, configuration, `--cwd`, `--agent`, `--rule`, baseline or policy file;
 *   a configuration file that cannot be read; an unusable root; an unwritable output.
 *
 * A reader that stops early (`| head`) changes none of them: see src/cli/streams.ts.
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
  // `--config /`: no file name at all.
  if (fileName === '') throw new ConfigError(`Refusing to read ${explicit}: it is not a file`);
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

/**
 * The scanned directory relative to `directory` (POSIX, `''` for the directory itself), or
 * undefined when the root is not inside it. The root is tried as given and as its real path:
 * spelled through a symlink, as macOS's /tmp and a logical `$PWD` are, it is still below the
 * physical working directory that process.cwd() returns.
 */
export function rootInside(directory: string, root: CheckedRoot): string | undefined {
  return relativeInsideRoot(directory, root.path) ?? relativeInsideRoot(directory, root.real);
}

/**
 * The prefix of the paths a command shows: the scanned directory relative to the working
 * directory when it is inside it, else `''`, so that paths are relative to the scanned
 * directory. Never `..` or absolute, which would name directories outside the repository.
 */
export function pathBase(root: CheckedRoot, io: Pick<Io, 'cwd'>): string {
  return rootInside(io.cwd, root) ?? '';
}

/** The configuration file {@link loadConfig} reads, or undefined with `--no-config`. */
function configPath(
  options: Pick<SharedCommandOptions, 'config' | 'useConfig'>,
  root: string,
  cwd: string,
): string | undefined {
  if (!options.useConfig) return undefined;
  return options.config === undefined ? join(root, CONFIG_FILE_NAME) : resolve(cwd, options.config);
}

/** The git files that steer the walk, which it reads wherever it lists a directory. */
const GIT_CONTROL_FILES: ReadonlySet<string> = new Set(['.gitignore', '.gitmodules']);

/**
 * Throws an OutputError when `--output` would replace a file the run read, so that the report
 * would replace the configuration it describes: a file the walk read, the configuration file,
 * a `.gitignore` or `.gitmodules` in the tree, or one of `written` (the paths `fix` writes).
 *
 * A file at the path is compared by device and inode, which sees through every other name for it:
 * a symlinked directory, /tmp for /private/tmp, or another case or Unicode normalization on a file
 * system that ignores them. Where nothing is, the report replaces nothing, unless `fix` creates
 * the file first: then the path, with the symlinks of its directory resolved, is compared with
 * the files `fix` creates, without case, as the default file systems of macOS and Windows
 * compare names.
 */
export async function checkOutput(
  options: Pick<SharedCommandOptions, 'output' | 'config' | 'useConfig'>,
  io: Pick<Io, 'cwd'>,
  root: CheckedRoot,
  snapshot: Pick<Snapshot, 'files' | 'paths' | 'ignoredFiles'>,
  written: readonly string[] = [],
): Promise<void> {
  const { output } = options;
  if (output === undefined) return;
  const target = resolve(io.cwd, output);
  const refuse = (what: string): OutputError =>
    new OutputError(`agentcheckup ${what} ${output}; choose another --output.`);
  const inRoot = (path: string): string => join(root.real, path);

  const identity = await entryIdentity(target);
  if (identity === undefined) {
    if (written.length === 0) return;
    const real = await realParentPath(target);
    const inside = real === undefined ? undefined : relativeInsideRoot(root.real, real);
    if (inside === undefined) return;
    for (const path of written) {
      const created = (await entryIdentity(inRoot(path))) === undefined;
      if (created && foldName(path) === foldName(inside)) throw refuse('fix writes');
    }
    return;
  }
  const isTarget = (other: FileIdentity | undefined): boolean =>
    other !== undefined && sameFile(identity, other);

  for (const file of snapshot.files) {
    const known = file.identity ?? (await entryIdentity(inRoot(file.symlinkTarget ?? file.path)));
    if (isTarget(known)) throw refuse('scanned');
  }
  const config = configPath(options, root.path, io.cwd);
  if (config !== undefined && isTarget(await entryIdentity(config))) throw refuse('read');
  // Another name for one of them keeps its last component, but for case and normalization.
  const name = foldName(basename(target));
  if (GIT_CONTROL_FILES.has(name)) {
    for (const path of [...snapshot.paths, ...snapshot.ignoredFiles]) {
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (foldName(last) === name && isTarget(await entryIdentity(inRoot(path)))) {
        throw refuse('read');
      }
    }
  }
  for (const path of written) {
    if (isTarget(await entryIdentity(inRoot(path)))) throw refuse('fix writes');
  }
}

function foldName(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** ANSI color for output to stdout when the flag, the environment and the terminal allow it. */
export function styleFor(options: Pick<SharedCommandOptions, 'output' | 'color'>, io: Io): Style {
  const color =
    options.output === undefined &&
    shouldUseColor({ flag: options.color, env: io.env, isTTY: io.isTTY });
  return color ? ansiStyle : plainStyle;
}

/**
 * Writes the report to stdout, or with `--output` through the safe output writer, which an
 * interrupt does not cut short.
 */
export async function emit(
  report: string,
  options: Pick<SharedCommandOptions, 'output'>,
  io: Io,
): Promise<void> {
  const { output } = options;
  if (output === undefined) io.stdout(report);
  else await interruptible(io, () => writeOutputFile(resolve(io.cwd, output), report));
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
