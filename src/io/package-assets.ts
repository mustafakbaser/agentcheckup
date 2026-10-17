/**
 * Reads files that ship inside the agentcheckup package itself, such as the agentcheckup skill
 * in skills/agentcheckup, for `agentcheckup skill install`. The package directory is not the
 * scanned repository, but it is read with the same care as any input (docs/adr/0003):
 *
 * - Only files below the package root, named by a normalized relative path, through parent
 *   directories that are real directories, not symlinks.
 * - Only regular files. The file is opened without following a symlink where the platform can
 *   (O_NOFOLLOW), every decision is made on the opened handle, and afterwards the path must
 *   still name that same file, which also catches a symlink where O_NOFOLLOW does not exist.
 * - At most `maxBytes` bytes, counted on the opened file and while reading.
 * - Valid UTF-8 text.
 */
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorCode } from './paths.js';
import { parseJsonInput } from './read-file.js';
import { SAFE_OPEN_FLAGS, sameFile } from './safe-read.js';

/** The `name` in the package's package.json. */
export const PACKAGE_NAME = 'agentcheckup';

/** Bytes of one package file at most. The skill's files are a few KiB each. */
export const MAX_PACKAGE_FILE_BYTES = 64 * 1024;

/**
 * How many directories above this module the package root may be: one from the bundle in
 * dist/, two from the sources in src/io/.
 */
const MAX_PACKAGE_DEPTH = 3;

/** A package file is missing, not a regular file, too large or not text. */
export class PackageAssetError extends Error {
  override readonly name = 'PackageAssetError';
}

/**
 * The root of the agentcheckup package that `from` belongs to: the nearest directory above it,
 * within {@link MAX_PACKAGE_DEPTH} levels, whose package.json is named {@link PACKAGE_NAME}.
 * Default: the package this module runs from. Throws {@link PackageAssetError} when none is.
 */
export async function findPackageRoot(
  from: string = fileURLToPath(import.meta.url),
): Promise<string> {
  let directory = path.dirname(from);
  for (let level = 0; level < MAX_PACKAGE_DEPTH; level++) {
    if ((await manifestName(directory)) === PACKAGE_NAME) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new PackageAssetError(
    `Cannot find the ${PACKAGE_NAME} package above ${path.dirname(from)}. Reinstall ${PACKAGE_NAME}.`,
  );
}

/** The `name` of the package.json in `directory`, or undefined when it has none. */
async function manifestName(directory: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readPackageText(directory, 'package.json');
  } catch (error) {
    if (error instanceof PackageAssetError && errorCode(error.cause) === 'ENOENT') return undefined;
    throw error;
  }
  const manifest = parseJsonInput(text, { label: `${directory}/package.json` });
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)) return undefined;
  return typeof manifest.name === 'string' ? manifest.name : undefined;
}

/**
 * Reads `relativePath`, a normalized POSIX path below `root`, as UTF-8 text. A byte order mark
 * stays in the text. Throws {@link PackageAssetError}, with the file system error as its cause,
 * when the file cannot be read as the module comment describes.
 */
export async function readPackageText(
  root: string,
  relativePath: string,
  maxBytes: number = MAX_PACKAGE_FILE_BYTES,
): Promise<string> {
  const names = relativeNames(relativePath);
  const fail = (reason: string, cause?: unknown): PackageAssetError =>
    new PackageAssetError(
      `Cannot read ${relativePath} from the ${PACKAGE_NAME} package: ${reason}.`,
      cause === undefined ? undefined : { cause },
    );

  let directory: string;
  try {
    directory = await realpath(root);
  } catch (error) {
    throw fail('the package directory cannot be accessed', error);
  }
  for (const name of names.slice(0, -1)) {
    directory = path.join(directory, name);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      throw fail(
        errorCode(error) === 'ENOENT' ? 'it does not exist' : 'a directory cannot be accessed',
        error,
      );
    }
    if (stats.isSymbolicLink()) throw fail(`${name} is a symbolic link`);
    if (!stats.isDirectory()) throw fail(`${name} is not a directory`);
  }

  const file = path.join(directory, names[names.length - 1] ?? '');
  let handle: FileHandle;
  try {
    handle = await open(file, SAFE_OPEN_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    const reason =
      code === 'ENOENT'
        ? 'it does not exist'
        : code === 'ELOOP'
          ? 'it is a symbolic link'
          : 'it cannot be opened';
    throw fail(reason, error);
  }
  let bytes: Uint8Array;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw fail('it is not a regular file');
    if (opened.size > BigInt(maxBytes)) throw fail(`it is larger than ${maxBytes} bytes`);
    // Where O_NOFOLLOW does not exist, open() follows a symlink: the path must name the file
    // that was opened, as a regular file of its own.
    const named = await lstat(file, { bigint: true });
    if (named.isSymbolicLink() || !sameFile(named, opened)) {
      throw fail('it is a symbolic link or changed while being read');
    }
    bytes = await readAtMost(handle, maxBytes + 1);
  } catch (error) {
    if (error instanceof PackageAssetError) throw error;
    throw fail('it cannot be read', error);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.length > maxBytes) throw fail(`it is larger than ${maxBytes} bytes`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw fail('it is not UTF-8 text', error);
  }
}

/** The names of a normalized relative POSIX path; a programming error for anything else. */
function relativeNames(relativePath: string): string[] {
  const names = relativePath.split('/');
  for (const name of names) {
    if (
      name === '' ||
      name === '.' ||
      name === '..' ||
      name.includes('\\') ||
      name.includes('\0')
    ) {
      throw new Error(`Package file paths must be normalized and relative, got ${relativePath}`);
    }
  }
  return names;
}

async function readAtMost(handle: FileHandle, limit: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(limit);
  let filled = 0;
  while (filled < limit) {
    const { bytesRead } = await handle.read(bytes, filled, limit - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return bytes.subarray(0, filled);
}
