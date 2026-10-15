/**
 * Git submodules, from the scan root's `.gitmodules`.
 *
 * A submodule is another repository mounted at a path. Uninitialized, it is an empty directory, so
 * a link into it would look "missing" although the file exists upstream; initialized, its files
 * belong to the other repository, like vendored code. Either way the walker marks it opaque.
 *
 * Parsed with plain string operations (never git: see gitignore.ts), covering the subset of git
 * config syntax a .gitmodules uses: `[submodule "name"]` sections, case-insensitive keys, quoted
 * values with escapes, and `#`/`;` comments.
 */
import path from 'node:path';

import { compareStrings } from '../core/compare.js';

/** Larger .gitmodules files are skipped (reported as `too-large`) and not applied. */
export const MAX_GITMODULES_BYTES = 64 * 1024;

/**
 * The `path` of every `[submodule]` section, as normalized root-relative POSIX paths, sorted and
 * without duplicates. Entries that are absolute, climb with `..`, contain a backslash (a separator
 * on Windows, so `..\x` would climb there) or cannot be parsed are dropped.
 */
export function parseGitmodules(text: string): string[] {
  const paths = new Set<string>();
  let inSubmodule = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inSubmodule = isSubmoduleSection(line);
      continue;
    }
    const equals = line.indexOf('=');
    if (!inSubmodule || equals === -1) continue;
    if (line.slice(0, equals).trim().toLowerCase() !== 'path') continue;
    const value = parseValue(line.slice(equals + 1));
    const submodulePath = value === undefined ? undefined : normalizeSubmodulePath(value);
    if (submodulePath !== undefined) paths.add(submodulePath);
  }
  return [...paths].sort(compareStrings);
}

/** `[submodule "name"]` (or the legacy `[submodule.name]`); section names are case-insensitive. */
function isSubmoduleSection(line: string): boolean {
  const header = line.slice(1).trimStart().toLowerCase();
  const next = header.charAt('submodule'.length);
  return (
    header.startsWith('submodule') &&
    (next === ' ' || next === '\t' || next === '"' || next === '.')
  );
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  b: '\b',
  '"': '"',
  '\\': '\\',
};

/**
 * A git config value: quotes removed, escapes applied, unquoted leading and trailing whitespace
 * and comments dropped. Undefined for what git rejects: unknown escapes, a trailing backslash
 * (line continuation, not supported here) and unterminated quotes.
 */
function parseValue(raw: string): string | undefined {
  let value = '';
  let pendingSpace = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw.charAt(index);
    if (char === '\\') {
      index += 1;
      const escaped = ESCAPES[raw.charAt(index)];
      if (escaped === undefined) return undefined;
      value += pendingSpace + escaped;
      pendingSpace = '';
    } else if (char === '"') {
      value += pendingSpace;
      pendingSpace = '';
      quoted = !quoted;
    } else if (quoted) {
      value += char;
    } else if (char === '#' || char === ';') {
      break;
    } else if (char === ' ' || char === '\t') {
      if (value !== '') pendingSpace += char;
    } else {
      value += pendingSpace + char;
      pendingSpace = '';
    }
  }
  return quoted ? undefined : value;
}

function normalizeSubmodulePath(value: string): string | undefined {
  if (value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return undefined;
  }
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments.join('/');
}

/**
 * Whether the directory at a declared submodule path, containing `entryNames`, is left unlisted.
 *
 * - Empty: an uninitialized submodule (git's placeholder). Opaque: its files exist upstream.
 * - Has a `.git` entry: an initialized checkout of another repository. Opaque, like vendored code,
 *   unless it lies in a hidden directory (`.claude/skills`, `.cursor/rules`, `.github/...`), where
 *   agents load configuration from: sharing that through a submodule is a real pattern, and an
 *   opaque `.claude` would let a hostile repository hide its config from the scan.
 * - Anything else is not a checkout (a stale or bogus `.gitmodules` entry) and is walked: a
 *   repository cannot commit a `.git` entry itself, so declaring `path = .claude` hides nothing.
 */
export function isOpaqueSubmodule(relativePath: string, entryNames: readonly string[]): boolean {
  if (entryNames.length === 0) return true;
  if (!entryNames.includes('.git')) return false;
  return !relativePath.split('/').some((segment) => segment.startsWith('.'));
}
