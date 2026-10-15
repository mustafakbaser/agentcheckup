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
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { errorCode } from './paths.js';

/** The report could not be written. The CLI exits with code 2. */
export class OutputError extends Error {
  override readonly name = 'OutputError';
}

function optionalFlag(name: 'O_NOFOLLOW' | 'O_NOCTTY'): number {
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
