import type { Snapshot } from './types.js';

export type PathStatus = 'exists' | 'missing' | 'unknown';

/**
 * Whether a root-relative POSIX path exists in the scanned tree.
 *
 * "unknown" means the path is inside a directory agentcheckup did not list (node_modules,
 * gitignored, too deep, unreadable). Rules must not report "missing file" for unknown paths:
 * the file may well exist.
 */
export function pathStatus(snapshot: Snapshot, path: string): PathStatus {
  const normalized = normalizeRelative(path);
  if (normalized === undefined) return 'unknown';
  if (normalized === '') return 'exists';
  if (snapshot.paths.has(normalized) || snapshot.paths.has(`${normalized}/`)) return 'exists';
  if (snapshot.ignoredFiles.has(normalized)) return 'exists';

  let index = normalized.indexOf('/');
  while (index !== -1) {
    if (snapshot.opaqueDirectories.has(normalized.slice(0, index + 1))) return 'unknown';
    index = normalized.indexOf('/', index + 1);
  }
  if (snapshot.opaqueDirectories.has(`${normalized}/`)) return 'exists';
  // When the entry limit cut the walk short, any directory, including the root, may be only
  // partly listed. Absence then proves nothing.
  if (stoppedAtFileLimit(snapshot)) return 'unknown';
  return 'missing';
}

const FILE_LIMIT = new WeakMap<
  Snapshot['skipped'],
  { readonly length: number; readonly stopped: boolean }
>();

/**
 * Whether the walk stopped at its entry limit, found once per list of skipped entries. The walk
 * hands its import pass a snapshot whose list it keeps appending to, so a longer list is
 * searched again.
 */
function stoppedAtFileLimit(snapshot: Snapshot): boolean {
  const { skipped } = snapshot;
  const cached = FILE_LIMIT.get(skipped);
  if (cached?.length === skipped.length) return cached.stopped;
  const stopped = skipped.some((entry) => entry.reason === 'file-limit');
  FILE_LIMIT.set(skipped, { length: skipped.length, stopped });
  return stopped;
}

/**
 * Normalizes `a/./b/../c` to `a/c`. Returns undefined when the path climbs above the root,
 * because the scan has no knowledge of anything outside it.
 */
export function normalizeRelative(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Directory part of a POSIX path, without trailing slash; '' for top-level files. */
export function dirnamePosix(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Joins a directory and a relative path, then normalizes. Undefined if it escapes the root. */
export function joinRelative(directory: string, relative: string): string | undefined {
  return normalizeRelative(directory === '' ? relative : `${directory}/${relative}`);
}
