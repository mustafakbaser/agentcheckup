/**
 * The walker's file and directory policies as small pure functions, shared with tools that replay
 * the walk without a checkout (scripts/corpus). No I/O here.
 */
import { classify, isCandidateBasename } from '../platforms/classify.js';

/**
 * Directories the walker never lists. An entry without `/` matches a directory name at any depth,
 * except below agent configuration (see isHardExcludedDirectory); an entry with `/` matches a
 * path ending in it.
 *
 * They hold version control internals, dependencies, virtualenvs, caches and build output.
 * Vendored and generated copies of agent configs (a package's own AGENTS.md or SKILL.md under
 * node_modules, a whole checkout under .claude/worktrees) would bury the user's own files in
 * findings they cannot act on, and linting build output is pointless. The directory itself still
 * appears in `paths` and in `opaqueDirectories`; nothing below it is listed.
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
const AGENT_CONFIG_NAMES: ReadonlySet<string> = new Set(AGENT_CONFIG_DIRECTORIES);

/**
 * Excluded even below agent configuration. A repository cannot commit a `.git` entry (git refuses
 * the path), so nothing can be hidden there, and skills are often git clones.
 */
const ALWAYS_EXCLUDED_NAMES: ReadonlySet<string> = new Set(['.git']);

/**
 * Whether the walker never lists the directory at `relativePath` (root-relative POSIX; a trailing
 * slash is allowed), because it or one of its ancestors is hard-excluded. Read top-down:
 * - an entry of HARD_EXCLUDED_DIRECTORIES matching a directory name, unless an agent-config
 *   directory (AGENT_CONFIG_DIRECTORIES) is above it: `.claude/skills/build/` is listed, while
 *   `node_modules/x/.claude/` is not, because `node_modules` comes first;
 * - `.git` and multi-segment entries (`.claude/worktrees`), everywhere.
 * Names match exactly (case-sensitive).
 */
export function isHardExcludedDirectory(relativePath: string): boolean {
  const directory = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
  let prefix = '';
  let belowAgentConfig = false;
  for (const name of directory.split('/')) {
    prefix = prefix === '' ? name : `${prefix}/${name}`;
    if (EXCLUDED_SUFFIXES.some((suffix) => prefix === suffix || prefix.endsWith(`/${suffix}`))) {
      return true;
    }
    if (EXCLUDED_NAMES.has(name) && (!belowAgentConfig || ALWAYS_EXCLUDED_NAMES.has(name))) {
      return true;
    }
    if (AGENT_CONFIG_NAMES.has(name)) belowAgentConfig = true;
  }
  return false;
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
 * agent configuration that `classify()` recognizes. `isCandidateBasename` is checked first as a
 * cheap pre-filter, so most paths never reach the classifier's patterns.
 */
export function defaultIsCandidate(relativePath: string): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return isCandidateBasename(name) && classify(relativePath) !== undefined;
}
