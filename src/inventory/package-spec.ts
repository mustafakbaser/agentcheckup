/**
 * Which package an MCP server's command line fetches and runs, and how firmly its version is
 * pinned. Pure string reading of the launcher's documented command-line syntax:
 *
 * - npm: `npx`, `pnpm dlx` (and `pnpx`), `bunx` (and `bun x`), `yarn dlx`. The package is the
 *   `--package`/`-p` value, else the first positional argument: `name`, `@scope/name`,
 *   `name@version`, `name@tag`, `name@range`.
 * - PyPI: `uvx` (and `uv tool run`) with `--from`, `name@version` or a PEP 440 specifier;
 *   `pipx run` with `--spec` or a PEP 440 specifier.
 * - OCI: `docker run` and `podman run`; `image@sha256:…` is a digest, any other `:tag` moves.
 * - Local: a script in the repository, run directly or through an interpreter.
 *
 * Anything else is `unknown`. The input is the redacted argument list, so names and versions
 * never carry credentials.
 */
import type { PackageSpec } from './types.js';

type Launcher = PackageSpec['launcher'];

/** Options that take a value, per launcher. Options written as `--name=value` need no entry. */
const NPX_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-p',
  '--package',
  '-c',
  '--call',
  '--registry',
  '--cache',
  '--userconfig',
  '--prefix',
  '-w',
  '--workspace',
  '--loglevel',
]);
const PNPM_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--package',
  '--allow-build',
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--reporter',
  '--loglevel',
]);
const BUNX_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-p', '--package', '--cwd']);
const YARN_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-p', '--package', '--cwd']);
const UV_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--from',
  '--with',
  '--with-editable',
  '--with-requirements',
  '-p',
  '--python',
  '--index',
  '--index-url',
  '-i',
  '--extra-index-url',
  '--default-index',
  '--find-links',
  '-f',
  '--cache-dir',
  '--directory',
  '--project',
  '--config-file',
  '--env-file',
  '--exclude-newer',
  '--constraints',
  '-c',
  '--overrides',
  '--refresh-package',
  '--upgrade-package',
  '-P',
  '--reinstall-package',
  '--prerelease',
  '--resolution',
  '--index-strategy',
  '--keyring-provider',
  '--link-mode',
  '--python-platform',
  '--color',
  '--allow-insecure-host',
]);
const PIPX_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--spec',
  '--python',
  '--index-url',
  '-i',
  '--pip-args',
  '--backend',
]);
const DOCKER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-a',
  '--attach',
  '--add-host',
  '--annotation',
  '--blkio-weight',
  '-c',
  '--cpu-shares',
  '--cap-add',
  '--cap-drop',
  '--cgroup-parent',
  '--cgroupns',
  '--cidfile',
  '--cpus',
  '--cpuset-cpus',
  '--cpuset-mems',
  '--detach-keys',
  '--device',
  '--dns',
  '--dns-option',
  '--dns-search',
  '--domainname',
  '-e',
  '--env',
  '--env-file',
  '--entrypoint',
  '--expose',
  '--gpus',
  '--group-add',
  '--health-cmd',
  '--health-interval',
  '--health-retries',
  '--health-timeout',
  '-h',
  '--hostname',
  '--ip',
  '--ip6',
  '--ipc',
  '--isolation',
  '-l',
  '--label',
  '--label-file',
  '--link',
  '--log-driver',
  '--log-opt',
  '--mac-address',
  '-m',
  '--memory',
  '--memory-reservation',
  '--memory-swap',
  '--mount',
  '--name',
  '--network',
  '--net',
  '--network-alias',
  '-p',
  '--publish',
  '--pid',
  '--pids-limit',
  '--platform',
  '--pull',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--storage-opt',
  '--sysctl',
  '--tmpfs',
  '-u',
  '--user',
  '--ulimit',
  '--userns',
  '--uts',
  '-v',
  '--volume',
  '--volumes-from',
  '-w',
  '--workdir',
]);
/** Options of `pnpm` and `uv` that may come before the subcommand and take a value. */
const PNPM_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '--dir', '--filter', '-F']);
const UV_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--directory',
  '--project',
  '--cache-dir',
  '--config-file',
  '--color',
]);

/** Programs that run a script file given as their first argument. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'bash',
  'sh',
  'zsh',
  'ruby',
  'perl',
]);

/** Variables that stand for the project or plugin root in MCP configuration files. */
const ROOT_VARIABLES: readonly string[] = [
  '${CLAUDE_PLUGIN_ROOT}',
  '${CLAUDE_PROJECT_DIR}',
  '$CLAUDE_PROJECT_DIR',
  '${workspaceFolder}',
];

const UNKNOWN: PackageSpec = { launcher: 'unknown', pin: 'unknown' };

/** `npx.cmd`, `/usr/bin/NPX.exe` -> `npx`. */
function programName(word: string): string {
  const name = word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase();
  for (const suffix of ['.cmd', '.exe', '.bat']) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

function isAssignment(word: string): boolean {
  const equals = word.indexOf('=');
  return equals > 0 && !word.startsWith('-');
}

/** The argument list without leading `env`, `NAME=value` assignments and `cmd /c`. */
function stripWrappers(argv: readonly string[]): readonly string[] {
  let index = 0;
  for (let round = 0; round < 4; round++) {
    const word = argv[index] ?? '';
    const program = programName(word);
    if (program === 'env') index++;
    else if (program === 'cmd' && (argv[index + 1] ?? '').toLowerCase() === '/c') index += 2;
    else if (isAssignment(word)) index++;
    else break;
    while (isAssignment(argv[index] ?? '')) index++;
  }
  return argv.slice(index);
}

interface Scan {
  /** First positional argument, if any. */
  readonly positional?: string;
  /** Index of the positional argument. */
  readonly index: number;
  /** Values of options, by option name (the last one wins). */
  readonly values: ReadonlyMap<string, string>;
}

/** Reads options up to the first positional argument. `--` ends the options. */
function scanOptions(args: readonly string[], valueOptions: ReadonlySet<string>): Scan {
  const values = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const word = args[i] ?? '';
    if (word === '--') {
      const next = args[i + 1];
      return next === undefined
        ? { index: i + 1, values }
        : { positional: next, index: i + 1, values };
    }
    if (!word.startsWith('-') || word === '-') return { positional: word, index: i, values };
    const equals = word.indexOf('=');
    if (equals > 0) {
      values.set(word.slice(0, equals), word.slice(equals + 1));
      i++;
    } else if (valueOptions.has(word)) {
      const value = args[i + 1];
      if (value !== undefined) values.set(word, value);
      i += 2;
    } else {
      i++;
    }
  }
  return { index: i, values };
}

/** The first positional word and the rest, skipping options (and their values) before it. */
function subcommand(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
): { word: string; rest: readonly string[] } | undefined {
  const scan = scanOptions(args, valueOptions);
  if (scan.positional === undefined) return undefined;
  return { word: scan.positional, rest: args.slice(scan.index + 1) };
}

// ---------------------------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------------------------

const EXACT_SEMVER = /^[=v]?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** How an npm version string pins: exact version, range or dist-tag. */
export function npmPin(version: string): PackageSpec['pin'] {
  const text = version.trim();
  if (text === '') return 'none';
  if (EXACT_SEMVER.test(text)) return 'exact';
  const first = text.charAt(0);
  if ('0123456789^~<>=*'.includes(first) || /^v\d/.test(text) || text === 'x' || text === 'X')
    return 'range';
  return 'tag';
}

function isPathSpec(spec: string): boolean {
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec === '.' ||
    spec === '..' ||
    spec.startsWith('/') ||
    spec.startsWith('~') ||
    spec.startsWith('file:')
  );
}

/** `.`, `./pkg`, `file:./pkg`: below the working directory, without a `..` segment. */
function isRelativePath(spec: string): boolean {
  const path = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  return (path === '.' || path.startsWith('./')) && !path.split('/').includes('..');
}

/** `name`, `@scope/name@1.2.3`, `name@latest`, a path, a git or tarball URL. */
export function npmSpec(launcher: Launcher, spec: string): PackageSpec {
  const text = spec.startsWith('npm:') ? spec.slice('npm:'.length) : spec;
  if (isPathSpec(text)) {
    return isRelativePath(text)
      ? { launcher, ecosystem: 'npm', name: text, pin: 'local' }
      : { launcher, ecosystem: 'npm', name: text, pin: 'unknown' };
  }
  // Git, GitHub shorthand and tarball URLs: what they resolve to is not visible here.
  const slash = text.indexOf('/');
  if (
    text.includes(':') ||
    text.includes('#') ||
    (slash > 0 && !text.startsWith('@')) ||
    text === ''
  ) {
    return { launcher, ecosystem: 'npm', ...(text === '' ? {} : { name: text }), pin: 'unknown' };
  }
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  const name = at < 0 ? text : text.slice(0, at);
  if (name === '' || name === '@') return { launcher, ecosystem: 'npm', pin: 'unknown' };
  if (at < 0) return { launcher, ecosystem: 'npm', name, pin: 'none' };
  const version = text.slice(at + 1);
  return { launcher, ecosystem: 'npm', name, version, pin: npmPin(version) };
}

function npmLauncher(
  launcher: Launcher,
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
): PackageSpec {
  const scan = scanOptions(args, valueOptions);
  const spec = scan.values.get('--package') ?? scan.values.get('-p') ?? scan.positional;
  return spec === undefined
    ? { launcher, ecosystem: 'npm', pin: 'unknown' }
    : npmSpec(launcher, spec);
}

// ---------------------------------------------------------------------------------------------
// PyPI
// ---------------------------------------------------------------------------------------------

const NAME_END = '[=<>!~@;( ';
const EXACT_PEP440 = /^v?\d+(?:\.\d+)*(?:(?:a|b|rc|\.post|\.dev)\d+)*$/i;

/**
 * `name`, `name[extra]==1.2.3`, `name>=1,<2`, `name@1.2.3` (uvx only), a path or a URL. pipx
 * reads `name @ url` as a direct reference, so `@` is a version only for uvx.
 */
export function pypiSpec(launcher: Launcher, spec: string): PackageSpec {
  const text = spec.trim();
  if (isPathSpec(text)) {
    return isRelativePath(text)
      ? { launcher, ecosystem: 'pypi', name: text, pin: 'local' }
      : { launcher, ecosystem: 'pypi', name: text, pin: 'unknown' };
  }
  if (text.includes('://') || text.startsWith('git+') || text === '') {
    return { launcher, ecosystem: 'pypi', ...(text === '' ? {} : { name: text }), pin: 'unknown' };
  }
  let end = 0;
  while (end < text.length && !NAME_END.includes(text.charAt(end))) end++;
  const name = text.slice(0, end);
  let rest = text.slice(end).trim();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    rest = close < 0 ? '' : rest.slice(close + 1).trim();
  }
  if (name === '') return { launcher, ecosystem: 'pypi', pin: 'unknown' };
  if (rest === '') return { launcher, ecosystem: 'pypi', name, pin: 'none' };
  if (rest.startsWith('@')) {
    const version = rest.slice(1).trim();
    if (launcher !== 'uvx' || version === '') {
      return { launcher, ecosystem: 'pypi', name, pin: 'unknown' };
    }
    if (version === 'latest') return { launcher, ecosystem: 'pypi', name, version, pin: 'tag' };
    return {
      launcher,
      ecosystem: 'pypi',
      name,
      version,
      pin: EXACT_PEP440.test(version) ? 'exact' : 'unknown',
    };
  }
  if (rest.startsWith('==')) {
    const version = rest.slice(rest.startsWith('===') ? 3 : 2).trim();
    const exact = !version.includes('*') && !version.includes(',') && version !== '';
    return { launcher, ecosystem: 'pypi', name, version, pin: exact ? 'exact' : 'range' };
  }
  if ('<>!~'.includes(rest.charAt(0))) {
    return { launcher, ecosystem: 'pypi', name, version: rest, pin: 'range' };
  }
  return { launcher, ecosystem: 'pypi', name, pin: 'unknown' };
}

function uvxLauncher(args: readonly string[]): PackageSpec {
  const scan = scanOptions(args, UV_VALUE_OPTIONS);
  const spec = scan.values.get('--from') ?? scan.positional;
  return spec === undefined
    ? { launcher: 'uvx', ecosystem: 'pypi', pin: 'unknown' }
    : pypiSpec('uvx', spec);
}

function pipxLauncher(args: readonly string[]): PackageSpec {
  const scan = scanOptions(args, PIPX_VALUE_OPTIONS);
  const spec = scan.values.get('--spec') ?? scan.positional;
  return spec === undefined
    ? { launcher: 'pipx', ecosystem: 'pypi', pin: 'unknown' }
    : pypiSpec('pipx', spec);
}

// ---------------------------------------------------------------------------------------------
// OCI
// ---------------------------------------------------------------------------------------------

/** `image`, `registry:5000/org/image:tag`, `image@sha256:…`. */
export function imageSpec(image: string): PackageSpec {
  if (image === '') return { launcher: 'docker', ecosystem: 'oci', pin: 'unknown' };
  const at = image.indexOf('@');
  if (at >= 0) {
    const reference = image.slice(0, at);
    const digest = image.slice(at + 1);
    const slash = reference.lastIndexOf('/');
    const colon = reference.indexOf(':', slash + 1);
    const name = colon < 0 ? reference : reference.slice(0, colon);
    return {
      launcher: 'docker',
      ecosystem: 'oci',
      name,
      version: digest,
      pin: digest.includes(':') && digest.length > digest.indexOf(':') + 1 ? 'digest' : 'unknown',
    };
  }
  const slash = image.lastIndexOf('/');
  const colon = image.indexOf(':', slash + 1);
  if (colon < 0) return { launcher: 'docker', ecosystem: 'oci', name: image, pin: 'none' };
  const tag = image.slice(colon + 1);
  return {
    launcher: 'docker',
    ecosystem: 'oci',
    name: image.slice(0, colon),
    ...(tag === '' ? {} : { version: tag }),
    pin: tag === '' ? 'none' : 'tag',
  };
}

function dockerLauncher(args: readonly string[]): PackageSpec {
  let rest = args;
  const sub = subcommand(rest, DOCKER_VALUE_OPTIONS);
  if (sub?.word === 'container') {
    const inner = subcommand(sub.rest, DOCKER_VALUE_OPTIONS);
    if (inner?.word !== 'run') return UNKNOWN;
    rest = inner.rest;
  } else if (sub?.word === 'run') {
    rest = sub.rest;
  } else {
    return UNKNOWN;
  }
  const scan = scanOptions(rest, DOCKER_VALUE_OPTIONS);
  return scan.positional === undefined
    ? { launcher: 'docker', ecosystem: 'oci', pin: 'unknown' }
    : imageSpec(scan.positional);
}

// ---------------------------------------------------------------------------------------------
// Local scripts
// ---------------------------------------------------------------------------------------------

/**
 * A path inside the repository: relative (`./server.js`, `dist/index.js`), or below a variable
 * that names the project or plugin root. A `..` segment may leave the repository, so it does not
 * count.
 */
function repositoryPath(word: string): boolean {
  if (word === '' || word.startsWith('-') || word.includes('\\')) return false;
  if (word.split('/').includes('..')) return false;
  for (const variable of ROOT_VARIABLES) {
    if (word.startsWith(`${variable}/`)) return true;
  }
  if (word.startsWith('/') || word.startsWith('~') || word.includes('$') || word.includes(':'))
    return false;
  return word.includes('/') || word.includes('.');
}

function localScript(word: string): PackageSpec | undefined {
  return repositoryPath(word) ? { launcher: 'local', name: word, pin: 'local' } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * The package an MCP server's command line runs. `argv` is the command followed by its
 * arguments, already redacted.
 */
export function packageSpec(argv: readonly string[]): PackageSpec {
  const words = stripWrappers(argv);
  const first = words[0];
  if (first === undefined) return UNKNOWN;
  const rest = words.slice(1);
  const program = programName(first);
  switch (program) {
    case 'npx':
      return npmLauncher('npx', rest, NPX_VALUE_OPTIONS);
    case 'npm': {
      // `npm exec` (alias `npm x`) is what npx runs.
      const sub = subcommand(rest, NPX_VALUE_OPTIONS);
      return sub?.word === 'exec' || sub?.word === 'x'
        ? npmLauncher('npx', sub.rest, NPX_VALUE_OPTIONS)
        : UNKNOWN;
    }
    case 'pnpx':
      return npmLauncher('pnpm-dlx', rest, PNPM_VALUE_OPTIONS);
    case 'pnpm': {
      const sub = subcommand(rest, PNPM_GLOBAL_VALUE_OPTIONS);
      return sub?.word === 'dlx' ? npmLauncher('pnpm-dlx', sub.rest, PNPM_VALUE_OPTIONS) : UNKNOWN;
    }
    case 'bunx':
      return npmLauncher('bunx', rest, BUNX_VALUE_OPTIONS);
    case 'yarn': {
      const sub = subcommand(rest, new Set());
      return sub?.word === 'dlx' ? npmLauncher('yarn-dlx', sub.rest, YARN_VALUE_OPTIONS) : UNKNOWN;
    }
    case 'uvx':
      return uvxLauncher(rest);
    case 'uv': {
      const sub = subcommand(rest, UV_GLOBAL_VALUE_OPTIONS);
      if (sub?.word === 'tool') {
        const tool = subcommand(sub.rest, UV_GLOBAL_VALUE_OPTIONS);
        return tool?.word === 'run' ? uvxLauncher(tool.rest) : UNKNOWN;
      }
      if (sub?.word === 'run') {
        // `uv run server.py` or `uv run python server.py`: a script of the project.
        const target = subcommand(sub.rest, UV_VALUE_OPTIONS);
        const script =
          target !== undefined && INTERPRETERS.has(programName(target.word))
            ? interpreterScript(programName(target.word), target.rest)
            : target?.word;
        if (!script?.endsWith('.py')) return UNKNOWN;
        return localScript(script) ?? UNKNOWN;
      }
      return UNKNOWN;
    }
    case 'pipx': {
      const sub = subcommand(rest, new Set());
      return sub?.word === 'run' ? pipxLauncher(sub.rest) : UNKNOWN;
    }
    case 'docker':
    case 'podman':
      return dockerLauncher(rest);
    default:
      break;
  }
  if (program === 'bun') {
    const sub = subcommand(rest, BUNX_VALUE_OPTIONS);
    if (sub?.word === 'x') return npmLauncher('bunx', sub.rest, BUNX_VALUE_OPTIONS);
  }
  if (INTERPRETERS.has(program)) {
    const script = interpreterScript(program, rest);
    return script === undefined ? UNKNOWN : (localScript(script) ?? UNKNOWN);
  }
  return localScript(first) ?? UNKNOWN;
}

/** Interpreter options that run code given on the command line or a module from the path. */
const EVAL_OPTIONS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '-m',
  '-r',
  '--require',
  '--import',
]);

/**
 * The script an interpreter runs: its first positional argument, or the one after `run` for
 * `bun run` and `deno run`. Undefined when an option before it runs other code (`node -e`,
 * `python -m`, `node --require`).
 */
function interpreterScript(program: string, args: readonly string[]): string | undefined {
  let rest = args;
  let scan = scanOptions(rest, new Set());
  if ((program === 'bun' || program === 'deno') && scan.positional === 'run') {
    rest = rest.slice(scan.index + 1);
    scan = scanOptions(rest, new Set());
  }
  const options = rest.slice(0, scan.index);
  const evaluates = options.some((option) => {
    const equals = option.indexOf('=');
    return EVAL_OPTIONS.has(equals < 0 ? option : option.slice(0, equals));
  });
  return evaluates ? undefined : scan.positional;
}
