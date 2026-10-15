import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { errorCode } from './paths.js';
import { readRegularFile } from './safe-read.js';

export const DEFAULT_CONFIG_MAX_BYTES = 256 * 1024;

/**
 * Reads the config file `fileName` directly inside `root`. Returns undefined when it does not
 * exist; throws an Error when it is a symlink, not a regular file, too large, or unreadable.
 *
 * A config changes what agentcheck reports (it can disable rules), and the repository may be
 * hostile, so it must be a regular file that lives in the root: a symlink could make agentcheck
 * read a file from elsewhere on the machine and echo parts of it back in parse errors.
 */
export async function readConfigFile(
  root: string,
  fileName: string,
  maxBytes = DEFAULT_CONFIG_MAX_BYTES,
): Promise<string | undefined> {
  assertPlainFileName(fileName);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${String(maxBytes)}`);
  }
  const filePath = path.join(root, fileName);
  let stats: BigIntStats;
  try {
    // bigint: the identity readRegularFile checks the opened file against (see FileIdentity).
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new Error(`Cannot read ${fileName}: ${code ?? 'unknown error'}`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to read ${fileName}: it is a symbolic link, not a regular file`);
  }
  if (!stats.isFile()) throw new Error(`Refusing to read ${fileName}: it is not a regular file`);
  const size = Number(stats.size);
  if (size > maxBytes) throw tooLarge(fileName, size, maxBytes);

  const outcome = await readRegularFile(filePath, stats, maxBytes);
  if (outcome.ok) return new TextDecoder('utf-8').decode(outcome.bytes);
  switch (outcome.reason) {
    case 'too-large':
      throw tooLarge(fileName, outcome.size, maxBytes);
    case 'special-file':
      throw new Error(`Refusing to read ${fileName}: it is not a regular file`);
    case 'unreadable':
      throw new Error(`Cannot read ${fileName}: ${outcome.code ?? 'it changed while being read'}`);
  }
}

function tooLarge(fileName: string, size: number, maxBytes: number): Error {
  return new Error(
    `Refusing to read ${fileName}: ${size} bytes exceeds the ${maxBytes}-byte limit`,
  );
}

/** Only a bare file name: no separators, no traversal. This is a programming error, not input. */
function assertPlainFileName(fileName: string): void {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new Error(`Config file name must be a plain file name, got ${JSON.stringify(fileName)}`);
  }
}
