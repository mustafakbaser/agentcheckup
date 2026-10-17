/**
 * Which paths a fix may name, before the writer checks the file system again
 * (docs/adr/0008-write-fixes-to-the-scanned-repository.md). Pure: decides from the path text and
 * the snapshot alone.
 */
import type { Snapshot } from '../core/types.js';

/** Longest path a fix may name, in UTF-16 code units. */
export const MAX_FIX_PATH_LENGTH = 1024;

/** Device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  ...['com', 'lpt'].flatMap((prefix) =>
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'].map(
      (digit) => `${prefix}${digit}`,
    ),
  ),
]);

/** Characters Windows does not allow in names, plus the backslash separator. */
const FORBIDDEN = '\\:*?"<>|';

/**
 * Why `path` cannot be the target of a fix, or undefined when it can: a normalized POSIX path
 * relative to the scan root, without `.` or `..` segments, control characters, characters
 * Windows does not allow, names ending in a dot or space, or reserved device names such as
 * `aux.md`.
 */
export function pathProblem(path: string): string | undefined {
  if (path.length === 0) return 'the path is empty';
  if (path.length > MAX_FIX_PATH_LENGTH) return 'the path is too long';
  if (path.startsWith('/')) return 'the path is absolute';
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 'the path has a control character';
    if (FORBIDDEN.includes(path.charAt(i)))
      return 'the path has a character Windows does not allow';
  }
  for (const segment of path.split('/')) {
    if (segment === '') return 'the path has an empty segment';
    if (segment === '.' || segment === '..') return 'the path has a "." or ".." segment';
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return 'a name in the path ends with a dot or a space';
    }
    const dot = segment.indexOf('.');
    const base = (dot === -1 ? segment : segment.slice(0, dot)).trimEnd().toLowerCase();
    if (WINDOWS_RESERVED.has(base)) return 'the path has a name Windows reserves';
  }
  return undefined;
}

/** Case- and normalization-insensitive form of a path, as macOS and Windows compare names. */
export function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** Directory prefixes (`a/`, `a/b/`) of a path, shortest first. */
export function parentDirectories(path: string): string[] {
  const parents: string[] = [];
  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    parents.push(path.slice(0, index + 1));
  }
  return parents;
}

/**
 * Directories (trailing `/`) that may be symbolic links, and paths where a new file may not go.
 *
 * A file reached through a symlink has `symlinkTarget`. When its name equals the target's name,
 * the link may be the file itself or any directory between the root and the file whose remaining
 * path the target shares, so every such directory counts as a possible link, unless a file below
 * it was read at its own path: a file below a symlinked directory always has `symlinkTarget`.
 * Unresolved symlinks and directories the walk did not list count too. A create or rename target
 * below one of them is refused; the writer checks each directory with lstat again before writing.
 */
export function blockedDirectories(snapshot: Snapshot): Set<string> {
  const real = new Set<string>();
  for (const file of snapshot.files) {
    if (file.symlinkTarget !== undefined) continue;
    for (const directory of parentDirectories(file.path)) real.add(directory);
  }
  const blocked = new Set<string>();
  for (const file of snapshot.files) {
    const target = file.symlinkTarget;
    if (target === undefined) continue;
    for (const directory of parentDirectories(file.path)) {
      if (real.has(directory)) continue;
      const rest = file.path.slice(directory.length);
      if (!(target === rest || target.endsWith(`/${rest}`))) continue;
      if (target.slice(0, target.length - rest.length) !== directory) blocked.add(directory);
    }
  }
  for (const link of snapshot.unresolvedSymlinks) blocked.add(`${link.path}/`);
  for (const directory of snapshot.opaqueDirectories) blocked.add(directory);
  return blocked;
}
