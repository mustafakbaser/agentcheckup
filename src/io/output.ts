/**
 * Writes a report to the `--output` file. In CI the file often lands inside a checkout of the
 * scanned repository, which may be hostile (docs/adr/0003): a committed symlink named like the
 * report must not make agentcheckup write somewhere else on the machine.
 *
 * - An existing symlink, directory, FIFO or device at the path is refused; only a regular file
 *   is replaced.
 * - The report is written to a new temporary file in the same directory, created exclusively
 *   (O_CREAT | O_EXCL, and O_NOFOLLOW where it exists), then renamed over the destination.
 *   rename() replaces the directory entry and never follows a symlink, so even a symlink
 *   planted after the check is replaced rather than written through, and readers never see a
 *   half-written report. A hard-linked destination gets a new file; the other links keep the
 *   old content.
 * - The temporary file is flushed to disk (fsync) before the rename, and the directory after
 *   it where the platform can sync a directory (not Windows). After a crash or power loss the
 *   path holds the old report or the complete new one, never an empty or partial file.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { errorCode } from './paths.js';
import type { FileIdentity } from './safe-read.js';

/** The report could not be written. The CLI exits with code 2. */
export class OutputError extends Error {
  override readonly name = 'OutputError';
}

function optionalFlag(name: 'O_NOFOLLOW' | 'O_NOCTTY' | 'O_DIRECTORY'): number {
  const value: number | undefined = (constants as Partial<typeof constants>)[name];
  return value ?? 0;
}

/** Create a new file, fail if anything (a symlink included) already has the name. */
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  optionalFlag('O_NOFOLLOW') |
  optionalFlag('O_NOCTTY');

/** Permissions before the umask, as `fs.writeFile` uses. */
const FILE_MODE = 0o666;

/**
 * Errors that mean a directory cannot be opened or synced here, as on Windows (EISDIR, EPERM)
 * and on some file systems (EINVAL, ENOTSUP). The report is in place by then; only the extra
 * durability of its directory entry is lost. Shared with src/io/write-fix.ts.
 */
export const NO_DIRECTORY_SYNC: ReadonlySet<string> = new Set([
  'EISDIR',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EACCES',
  'EBADF',
]);

/**
 * Writes `text` as UTF-8 to `filePath`, replacing a regular file that is there. Throws
 * {@link OutputError} when the path is a symlink or not a regular file, its directory does not
 * exist, or writing fails.
 */
export async function writeOutputFile(filePath: string, text: string): Promise<void> {
  await checkDestination(filePath);
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let handle: FileHandle;
  try {
    handle = await open(temporary, CREATE_FLAGS, FILE_MODE);
  } catch (error) {
    throw failure(filePath, error);
  }
  try {
    try {
      await handle.writeFile(text, 'utf8');
      // On disk before the rename makes it visible: a crash must not leave an empty report.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Checked again just before the rename: a symlink that appeared meanwhile is reported
    // rather than silently replaced. (rename itself would replace it, not follow it.)
    await checkDestination(filePath);
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error instanceof OutputError ? error : failure(filePath, error);
  }
  await syncDirectory(directory, filePath);
}

/** Flushes the directory entry the rename wrote, where the platform can sync a directory. */
async function syncDirectory(directory: string, filePath: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | optionalFlag('O_DIRECTORY'));
  } catch (error) {
    if (NO_DIRECTORY_SYNC.has(errorCode(error) ?? '')) return;
    throw failure(filePath, error);
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!NO_DIRECTORY_SYNC.has(errorCode(error) ?? '')) throw failure(filePath, error);
  } finally {
    await handle.close();
  }
}

/** Throws unless `filePath` is missing or a regular file. */
async function checkDestination(filePath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw failure(filePath, error);
  }
  if (stats.isSymbolicLink()) {
    throw new OutputError(
      `Refusing to write ${filePath}: it is a symbolic link. Remove it or choose another --output path.`,
    );
  }
  if (!stats.isFile()) {
    throw new OutputError(`Refusing to write ${filePath}: it is not a regular file.`);
  }
}

/**
 * The device and inode of the entry at `filePath`, which writing the path would replace: symlinks
 * in its directories are followed, the last component is not. One file has one identity whatever
 * the name used for it: through a symlinked directory, /tmp for /private/tmp on macOS, or in
 * another case or Unicode normalization on a file system that ignores them. Undefined when
 * nothing is there, or it cannot be looked at.
 */
export async function entryIdentity(filePath: string): Promise<FileIdentity | undefined> {
  try {
    const stats = await lstat(filePath, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

/**
 * `filePath` with the symlinks of its directory resolved, for a file that may not exist yet.
 * Undefined when the directory does not exist or cannot be resolved.
 */
export async function realParentPath(filePath: string): Promise<string | undefined> {
  try {
    return path.join(await realpath(path.dirname(filePath)), path.basename(filePath));
  } catch {
    return undefined;
  }
}

/** The real path of `directory`, or `directory` itself when it cannot be resolved. */
export async function realPathOrSelf(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return directory;
  }
}

function failure(filePath: string, error: unknown): OutputError {
  const code = errorCode(error);
  const reason =
    code === 'ENOENT'
      ? 'its directory does not exist'
      : code === 'EEXIST'
        ? 'a temporary file with the same name already exists'
        : (code ?? (error instanceof Error ? error.message : String(error)));
  return new OutputError(`Cannot write ${filePath}: ${reason}.`, { cause: error });
}
