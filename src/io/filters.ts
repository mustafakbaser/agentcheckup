/**
 * The walker's file and directory policies as small pure functions, shared with tools that replay
 * the walk without a checkout (scripts/corpus). No I/O here.
 */
import { classify, isCandidateBasename } from '../platforms/classify.js';
import { mayBeClineHookFile } from '../platforms/cline-hooks.js';
import { TEXT_EXTENSIONS } from '../platforms/load/imports.js';

/**
 * Directories a trusted scan never lists. An entry without `/` matches a directory name at any
 * depth, except below agent configuration (see isHardExcludedDirectory); an entry with `/`
 * matches a path ending in it.
 *
 * They hold version control internals, dependencies, virtualenvs, caches and build output.
 * Vendored and generated copies of agent configs (a package's own AGENTS.md or SKILL.md under
 * node_modules, a whole checkout under .claude/worktrees) would bury the user's own files in
 * findings they cannot act on, and linting build output is pointless. The directory itself still
 * appears in `paths` and in `opaqueDirectories`; nothing below it is listed.
 *
 * Two groups: {@link BUILD_DIRECTORIES}, which a repository commits often enough (`vendor/` in Go
 * and PHP, `dist/` in GitHub Actions) that an untrusted scan lists them
 * (WalkOptions.scanBuildDirectories), and the rest, dependency and cache directories that no scan
 * lists (see {@link isHardExcludedDirectory}).
 */
export const HARD_EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.pnpm-store',
  '.yarn',
  '.mcpb-cache',
  '.claude/worktrees',
];

/**
 * The build output and vendored code among {@link HARD_EXCLUDED_DIRECTORIES}. A trusted scan
 * leaves them out and counts the agent configuration in them (Snapshot.unscannedConfig); an
 * untrusted scan lists them like any other directory, because a repository can commit agent
 * configuration there and agents load it from there: a session started in `vendor/x` reads its
 * `.claude/settings.json` and `.mcp.json`, and Claude Code finds the skills of a nested
 * `.claude/skills` when it works on files below it.
 */
export const BUILD_DIRECTORIES: readonly string[] = [
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
];

/**
 * Directories agents load configuration from, at any depth below them: `.claude/skills/build/
 * SKILL.md` is a skill. Below one of these (or a `skills/` directory) names are not hard-excluded,
 * or a repository could hide configuration from the scan in `.claude/skills/build/`.
 */
export const AGENT_CONFIG_DIRECTORIES: readonly string[] = [
  '.claude',
  '.agents',
  '.cursor',
  '.github',
  '.gemini',
  '.codex',
  '.devin',
  '.windsurf',
  '.clinerules',
  '.cline',
  '.claude-plugin',
  'skills',
];

const EXCLUDED_NAMES: ReadonlySet<string> = new Set(
  HARD_EXCLUDED_DIRECTORIES.filter((entry) => !entry.includes('/')),
);
const EXCLUDED_SUFFIXES: readonly string[] = HARD_EXCLUDED_DIRECTORIES.filter((entry) =>
  entry.includes('/'),
);
const BUILD_NAMES: ReadonlySet<string> = new Set(BUILD_DIRECTORIES);
const AGENT_CONFIG_NAMES: ReadonlySet<string> = new Set(AGENT_CONFIG_DIRECTORIES);

/**
 * Excluded even below agent configuration. A repository cannot commit a `.git` entry (git refuses
 * the path), so nothing can be hidden there, and skills are often git clones.
 */
const ALWAYS_EXCLUDED_NAMES: ReadonlySet<string> = new Set(['.git']);

/** Which group of {@link HARD_EXCLUDED_DIRECTORIES} leaves a directory out. */
export type ExclusionGroup = 'always' | 'build';

/**
 * The group of the exclusion that leaves the directory at `relativePath` (root-relative POSIX; a
 * trailing slash is allowed) unlisted, or undefined when the walker lists it. Read top-down:
 * - an entry of HARD_EXCLUDED_DIRECTORIES matching a directory name, unless an agent-config
 *   directory (AGENT_CONFIG_DIRECTORIES) is above it: `.claude/skills/build/` is listed, while
 *   `node_modules/x/.claude/` is not, because `node_modules` comes first;
 * - `.git` and multi-segment entries (`.claude/worktrees`), everywhere.
 * With `scanBuildDirectories`, {@link BUILD_DIRECTORIES} names exclude nothing, while dependency
 * and cache directories below them still do. Names match exactly (case-sensitive).
 */
export function exclusionOf(
  relativePath: string,
  scanBuildDirectories = false,
): ExclusionGroup | undefined {
  const directory = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
  let prefix = '';
  let belowAgentConfig = false;
  for (const name of directory.split('/')) {
    prefix = prefix === '' ? name : `${prefix}/${name}`;
    if (EXCLUDED_SUFFIXES.some((suffix) => prefix === suffix || prefix.endsWith(`/${suffix}`))) {
      return 'always';
    }
    if (EXCLUDED_NAMES.has(name) && (!belowAgentConfig || ALWAYS_EXCLUDED_NAMES.has(name))) {
      if (!BUILD_NAMES.has(name)) return 'always';
      if (!scanBuildDirectories) return 'build';
    }
    if (AGENT_CONFIG_NAMES.has(name)) belowAgentConfig = true;
  }
  return undefined;
}

/**
 * Whether a trusted walk never lists the directory at `relativePath`, because it or one of its
 * ancestors is hard-excluded ({@link exclusionOf}).
 */
export function isHardExcludedDirectory(relativePath: string): boolean {
  return exclusionOf(relativePath) !== undefined;
}

/**
 * Whether the directory at `relativePath` (root-relative POSIX; a trailing slash is allowed) is
 * an agent configuration directory or lies below one: one of its names is in
 * AGENT_CONFIG_DIRECTORIES. Names match exactly (case-sensitive).
 */
export function isAgentConfigDirectory(relativePath: string): boolean {
  const directory = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
  return directory.split('/').some((name) => AGENT_CONFIG_NAMES.has(name));
}

/**
 * Whether the walker reads an import target at `relativePath` (root-relative POSIX): a text file
 * by its extension (TEXT_EXTENSIONS: Markdown, plain text, or no extension such as `README`).
 * Dotfiles (`.env`, `.npmrc`) never are: they typically hold local secrets, not instructions.
 */
export function isTextImportTarget(relativePath: string): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  if (name === '' || name.startsWith('.')) return false;
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

/** How many leading bytes looksBinary inspects: the same window as git. */
export const BINARY_SNIFF_BYTES = 8000;

/**
 * Git's binary heuristic: a NUL byte within the first BINARY_SNIFF_BYTES bytes. Text with a UTF-16
 * byte order mark (FF FE or FE FF) is never binary, although it is full of NUL bytes.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const first = bytes[0];
  const second = bytes[1];
  const utf16Bom = (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
  return !utf16Bom && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * The walker's default `isCandidate`: whether the file at `relativePath` (root-relative POSIX) is
 * agent configuration that `classify()` recognizes, or a script Cline runs as a hook, which the
 * security inventory digests (src/platforms/cline-hooks.ts). `isCandidateBasename` is checked
 * first as a cheap pre-filter, so most paths never reach the classifier's patterns.
 */
export function defaultIsCandidate(relativePath: string): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return (
    (isCandidateBasename(name) && classify(relativePath) !== undefined) ||
    mayBeClineHookFile(relativePath)
  );
}
