/**
 * Shared pieces of the real-world corpus harness (fetch.ts, run.ts, pin.ts).
 *
 * The cache under .corpus-cache/ holds untrusted third-party content. It is only ever handled as
 * bytes: nothing in it is executed, imported or interpreted, and git is never run inside it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareStrings } from '../../src/core/compare.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORPUS_DIR = path.join(ROOT, 'corpus');
export const REPOS_FILE = path.join(CORPUS_DIR, 'repos.json');
export const CACHE_DIR = path.join(ROOT, '.corpus-cache');

export interface RepoEntry {
  /** `owner/name` on github.com. */
  readonly repo: string;
  /** Full commit SHA the repository is pinned to. */
  readonly sha: string;
  /** Why it is in the corpus. */
  readonly why: string;
}

/** GitHub owner and repository name rules; `.` and `..` are rejected separately. */
const REPO_PATTERN = /^[\da-z][\da-z-]{0,38}\/[\w.-]{1,100}$/i;
export const SHA_PATTERN = /^[\da-f]{40}$/;

/** The order repos.json is kept in: case-insensitive by `owner/name`, then exact. */
export function compareRepos(a: string, b: string): number {
  return compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b);
}

export function isRepoName(value: string): boolean {
  if (!REPO_PATTERN.test(value)) return false;
  const name = value.slice(value.indexOf('/') + 1);
  return name !== '.' && name !== '..';
}

export interface LoadOptions {
  /** Accept an empty "sha" (not pinned yet) and any order. Used by pin.ts. */
  readonly unpinned?: boolean;
}

/** Reads and validates corpus/repos.json. Throws with every problem listed. */
export async function loadRepos(
  file = REPOS_FILE,
  options: LoadOptions = {},
): Promise<RepoEntry[]> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file}: expected an array`);
  const problems: string[] = [];
  const entries: RepoEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const where = `${file}[${String(index)}]`;
    if (typeof item !== 'object' || item === null) {
      problems.push(`${where}: expected an object`);
      return;
    }
    const { repo, sha, why } = item as Record<string, unknown>;
    if (typeof repo !== 'string' || !isRepoName(repo)) {
      problems.push(`${where}: "repo" must be owner/name`);
      return;
    }
    const unpinned = options.unpinned === true && sha === '';
    if (typeof sha !== 'string' || (!unpinned && !SHA_PATTERN.test(sha))) {
      problems.push(`${where} (${repo}): "sha" must be a full 40-character commit SHA`);
    }
    if (typeof why !== 'string' || why.trim() === '') {
      problems.push(`${where} (${repo}): "why" must be a non-empty string`);
    }
    const key = repo.toLowerCase();
    if (seen.has(key)) problems.push(`${where}: duplicate repository ${repo}`);
    seen.add(key);
    const previous = entries.at(-1);
    if (options.unpinned !== true && previous && compareRepos(previous.repo, repo) > 0) {
      problems.push(`${where}: not sorted (${repo} must come before ${previous.repo})`);
    }
    if (typeof sha === 'string' && typeof why === 'string') entries.push({ repo, sha, why });
  });
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return entries;
}

export function repoLabel(entry: RepoEntry): string {
  return `${entry.repo}@${entry.sha.slice(0, 12)}`;
}

/** `.corpus-cache/<owner>__<name>@<sha>`. */
export function cacheDirFor(entry: RepoEntry): string {
  if (!isRepoName(entry.repo) || !SHA_PATTERN.test(entry.sha)) {
    throw new Error(`invalid corpus entry ${entry.repo}@${entry.sha}`);
  }
  return path.join(CACHE_DIR, `${entry.repo.replace('/', '__')}@${entry.sha}`);
}

// ---------------------------------------------------------------------------------------------
// Cache file formats
// ---------------------------------------------------------------------------------------------

export type TreeEntryType = 'blob' | 'tree' | 'commit';

/** One entry of a recursive git tree listing, as returned by the GitHub git/trees API. */
export interface TreeEntry {
  readonly path: string;
  /** Git file mode: 100644, 100755 (file), 120000 (symlink), 040000 (tree), 160000 (submodule). */
  readonly mode: string;
  readonly type: TreeEntryType;
  readonly sha: string;
  /** Blobs only. */
  readonly size?: number;
}

/** `tree.json`: the repository's full path list at the pinned commit. */
export interface CachedTree {
  readonly repo: string;
  readonly sha: string;
  /**
   * True when GitHub's listing stayed truncated even after falling back to per-directory
   * requests (a single directory with more than 100 000 entries). Absence then proves nothing.
   */
  readonly truncated: boolean;
  /**
   * Directories whose contents were deliberately not listed in the per-directory fallback because
   * the walker never lists them anyway (`node_modules`, `vendor`, ...).
   */
  readonly unlistedDirectories: readonly string[];
  readonly entries: readonly TreeEntry[];
}

/** `links.json`: symlink path (as stored in the tree) -> link text. */
export type CachedLinks = Record<string, string>;

/** `files.json`: real tree path -> where its verified bytes are stored in the cache directory. */
export type CachedFiles = Record<string, { readonly sha: string; readonly file: string }>;

export const TREE_FILE = 'tree.json';
export const LINKS_FILE = 'links.json';
export const FILES_FILE = 'files.json';

/** Git's object id for a blob with these bytes. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/** Reads a JSON file from the cache, or returns undefined when it does not exist yet. */
export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

/**
 * Resolves a path inside a cache directory, refusing anything that could escape it. Tree paths
 * come from third-party repositories, so they are checked component by component.
 */
export function insideCacheDir(cacheDir: string, relative: string): string | undefined {
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
    return undefined;
  }
  const resolved = path.join(cacheDir, ...parts);
  const back = path.relative(cacheDir, resolved);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) return undefined;
  return resolved;
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}
