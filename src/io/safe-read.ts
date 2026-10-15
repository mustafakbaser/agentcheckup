import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';

import { errorCode } from './paths.js';

/** A flag that does not exist on this platform (Windows has no O_NOFOLLOW) contributes 0. */
function optionalFlag(name: 'O_NOFOLLOW' | 'O_NONBLOCK' | 'O_NOCTTY'): number {
  const value: number | undefined = (constants as Partial<typeof constants>)[name];
  return value ?? 0;
}

/**
 * Flags for every open in src/io. Callers lstat first and only open regular files; these flags
 * cover the window between that lstat and the open:
 * - O_NOFOLLOW: fail (ELOOP) if the last component has been replaced by a symlink.
 * - O_NONBLOCK: if it has been replaced by a FIFO, open returns at once instead of blocking until
 *   a writer appears (which would hang the scan); fstat then rejects it. No effect on regular files.
 * - O_NOCTTY: a terminal device swapped in never becomes our controlling terminal.
 */
export const SAFE_OPEN_FLAGS =
  constants.O_RDONLY |
  optionalFlag('O_NOFOLLOW') |
  optionalFlag('O_NONBLOCK') |
  optionalFlag('O_NOCTTY');

/**
 * Identity of the file that was checked with lstat before opening it, as bigints: capture it with
 * `lstat(path, { bigint: true })`. As JS numbers, Windows' 64-bit file IDs lose precision
 * (nodejs/node#12115), so two different files could look alike, or one file unlike itself.
 */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Whether two identities name the same file. `ino` is compared exactly; `dev` as an unsigned
 * 64-bit value, because on Windows the same volume can come back signed from one stat call and
 * unsigned from another (nodejs/node#16496). Nothing else is relaxed.
 */
export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.ino === b.ino && BigInt.asUintN(64, a.dev) === BigInt.asUintN(64, b.dev);
}

export type ReadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too-large'; readonly size: number }
  | { readonly ok: false; readonly reason: 'special-file' }
  | { readonly ok: false; readonly reason: 'unreadable'; readonly code?: string };

/**
 * Reads the regular file at `filePath`, which the caller has lstat-ed as `expected`, reading at
 * most `maxBytes`. Never throws.
 *
 * After opening, the handle is fstat-ed and must still be a regular file with the same device and
 * inode as the lstat-ed entry, and not larger than `maxBytes`. The identity check catches a file
 * or a parent directory swapped between lstat and open; the size check uses the opened file, so
 * a file that grew in between is still bounded.
 */
export async function readRegularFile(
  filePath: string,
  expected: FileIdentity,
  maxBytes: number,
): Promise<ReadOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, SAFE_OPEN_FLAGS);
  } catch (error) {
    return unreadable(error);
  }
  try {
    const stats: BigIntStats = await handle.stat({ bigint: true });
    if (stats.isDirectory()) return { ok: false, reason: 'unreadable' };
    if (!stats.isFile()) return { ok: false, reason: 'special-file' };
    if (!sameFile(stats, expected)) return { ok: false, reason: 'unreadable' };
    const size = Number(stats.size);
    if (size > maxBytes) return { ok: false, reason: 'too-large', size };
    return { ok: true, bytes: await readUpTo(handle, size) };
  } catch (error) {
    return unreadable(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function unreadable(error: unknown): ReadOutcome {
  const code = errorCode(error);
  return code === undefined
    ? { ok: false, reason: 'unreadable' }
    : { ok: false, reason: 'unreadable', code };
}

/**
 * Reads at most `size` bytes. Stops early if the file shrank; never reads past `size` if it grew.
 * The buffer is a fresh, zero-filled Uint8Array: Buffer.allocUnsafe slices a shared pool, so the
 * returned bytes' backing ArrayBuffer could expose other data to whoever holds the snapshot.
 */
async function readUpTo(handle: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(bytes, filled, size - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === size ? bytes : bytes.slice(0, filled);
}
