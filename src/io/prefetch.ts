/**
 * Building blocks that let the walker keep the thread pool busy: bounded directory listings that
 * can be requested ahead of time, a concurrency limiter, and file probes (lstat, then the safe read).
 * Nothing here decides what ends up in the snapshot; the walker consumes results in its own
 * deterministic order.
 */
import type { Dir, Dirent, Stats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';

import { type ReadOutcome, readRegularFile } from './safe-read.js';

/** Entries fetched per thread-pool round trip when listing a directory. */
export const LISTING_BATCH_SIZE = 512;

/** A directory's entries in the filesystem's own order (not sorted). */
export interface Listing {
  readonly entries: readonly Dirent[];
  /** False when reading stopped at the cap before the end of the directory. */
  readonly complete: boolean;
}

/**
 * Lists `realPath`, keeping at most `cap` entries, so a directory with millions of entries cannot
 * exhaust memory. Entries stay in the filesystem's order: the first N of two listings of an
 * unchanged directory are the same entries, so a listing can be truncated later. Undefined when
 * the directory cannot be listed. Never throws.
 */
export async function readListing(realPath: string, cap: number): Promise<Listing | undefined> {
  let directory: Dir;
  try {
    directory = await opendir(realPath, { bufferSize: LISTING_BATCH_SIZE });
  } catch {
    return undefined;
  }
  const entries: Dirent[] = [];
  try {
    for (let entry = await directory.read(); entry !== null; entry = await directory.read()) {
      if (entries.length >= cap) return { entries, complete: false };
      entries.push(entry);
    }
    return { entries, complete: true };
  } catch {
    return undefined;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

/** Runs at most `max` tasks at a time; the others wait in arrival order. */
export class Limiter {
  readonly #max: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active < this.#max) {
      this.#active += 1;
    } else {
      // A finishing task hands its slot over directly, so the count never exceeds `max`.
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#active -= 1;
      else next();
    }
  }
}

/** What a candidate file turned out to be when it was probed. */
export type FileProbe =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-a-file'; readonly special: boolean }
  /** `outcome` is absent when the file was not read (only lstat-ed). */
  | { readonly kind: 'file'; readonly stats: Stats; readonly outcome?: ReadOutcome };

/**
 * lstat `realPath` and, when `readUpTo` is given and the file is a regular file of at most that
 * size, read it with readRegularFile (same open flags and identity check). Never throws.
 */
export async function probeFile(realPath: string, readUpTo?: number): Promise<FileProbe> {
  let stats: Stats;
  try {
    stats = await lstat(realPath);
  } catch {
    return { kind: 'missing' };
  }
  // The entry may have been replaced since it was listed.
  if (!stats.isFile()) {
    return { kind: 'not-a-file', special: !stats.isDirectory() && !stats.isSymbolicLink() };
  }
  if (readUpTo === undefined || stats.size > readUpTo) return { kind: 'file', stats };
  return { kind: 'file', stats, outcome: await readRegularFile(realPath, stats, readUpTo) };
}
