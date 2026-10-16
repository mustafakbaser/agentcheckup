/**
 * The filesystem walker: the only code in agentcheckup that lists directories and reads files of the
 * scanned tree, which may be a hostile repository. Guarantees:
 *
 * - Nothing outside the scan root is read, listed or even stat-ed through a symlink.
 * - FIFOs, sockets and devices are never opened.
 * - Every read is bounded (per file and in total), and so is the walk (entries and depth).
 * - Hostile trees never make it throw; problems are reported in the snapshot. Only an unusable
 *   root throws (WalkError).
 * - Output is deterministic: entries are visited in code-point order and every list is sorted.
 *
 * Out of scope: a concurrent local process that swaps directories for symlinks while the scan runs.
 * File reads detect swaps (see readRegularFile), but Node.js has no openat()/O_DIRECTORY-based
 * listing, so a racing directory swap could expose names from outside the root.
 */
import { createHash } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import { compareStrings } from '../core/compare.js';
import type {
  SkippedEntry,
  SkipReason,
  Snapshot,
  SourceFile,
  SourceIdentity,
  SymlinkProblem,
  UnresolvedSymlink,
} from '../core/types.js';
import {
  defaultIsCandidate,
  isAgentConfigDirectory,
  isHardExcludedDirectory,
  looksBinary,
} from './filters.js';
import {
  addGitignoreRules,
  chainWeight,
  type IgnoreLayer,
  isIgnored,
  MAX_GITIGNORE_BYTES,
  MAX_GITIGNORE_MATCH_WORK,
  MAX_GITIGNORE_WEIGHT_PER_PATH,
  MAX_GITIGNORE_WEIGHT_TOTAL,
  parseGitignore,
} from './gitignore.js';
import { ImportPlanner, MAX_IMPORTED_BYTES, MAX_IMPORTED_FILES } from './imports.js';
import { errorCode, joinRelative, sanitizeLinkText } from './paths.js';
import { type FileProbe, Limiter, type Listing, probeFile, readListing } from './prefetch.js';
import { resolveSymlink, type ScanRoots } from './resolve.js';
import { type FileIdentity, type ReadOutcome, readRegularFile } from './safe-read.js';
import { isOpaqueSubmodule, MAX_GITMODULES_BYTES, parseGitmodules } from './submodules.js';

/** Re-exported for existing importers; the policy helpers live in filters.ts. */
export { HARD_EXCLUDED_DIRECTORIES } from './filters.js';

export interface WalkOptions {
  /** Larger candidates are skipped as `too-large` and never read. Default 1 MiB. */
  maxFileBytes?: number;
  /** Total candidate bytes read; candidates that no longer fit are `byte-limit`. Default 64 MiB. */
  maxTotalBytes?: number;
  /** Directory entries visited before the walk stops with one `file-limit` entry. Default 200 000. */
  maxEntries?: number;
  /** Directories deeper than this (the root is 0) are not listed: `depth-limit`. Default 32. */
  maxDepth?: number;
  /** Honor `.gitignore` files in the tree. Default true. */
  respectGitignore?: boolean;
  /**
   * Do not let `.gitignore` hide agent configuration: list agent configuration directories
   * (isAgentConfigDirectory) and read candidates even where a `.gitignore` matches them, and
   * record them in `gitignoredConfig`. Everything else stays ignored. For untrusted
   * repositories, whose `.gitignore` could hide committed configuration that agents load
   * (`git add -f .mcp.json`). Default false: in a trusted repository, ignored agent files
   * (CLAUDE.local.md, .claude/settings.local.json) are personal and stay out of the scan. With
   * it, `isCandidate` is also called for ignored entries.
   */
  scanIgnoredAgentConfig?: boolean;
  /**
   * After the walk, also read the files that instruction files import (`@docs/guide.md` in
   * CLAUDE.md) when they are listed, text and inside the root, up to the hops agents follow.
   * See imports.ts for the caps. Default true.
   */
  followImports?: boolean;
  /** Which files to read. Default: files that `classify()` recognizes. */
  isCandidate?: (relativePosixPath: string) => boolean;
}

export const DEFAULT_WALK_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 200_000,
  maxDepth: 32,
} as const;

/** Thrown when the scan root itself is unusable: missing, not a directory, or unreadable. */
export class WalkError extends Error {
  override readonly name = 'WalkError';
}

/**
 * Walks `root` and reads every candidate config file in it.
 *
 * - `files`: candidates that were read. `symlinkTarget` is set when the file was reached through a
 *   symlink (the file itself or a parent directory) and holds the real file's root-relative path.
 *   `identity` holds the device and inode of the file that was read and the SHA-256 of its bytes.
 * - `paths`: every file and directory listed (directories end with `/`), except ignored ones.
 * - `opaqueDirectories`: directories that exist but were not (fully) listed: hard-excluded,
 *   gitignored, too deep, unreadable, loop-guarded directory links, links whose target was not
 *   looked at (outside the root, broken, gitignored), git submodules (see submodules.ts), and
 *   directories left unlisted when the entry limit stopped the walk. Anything below them is
 *   unknown, never missing.
 * - `ignoredFiles`: files (and symlinks, which git treats as files) excluded by `.gitignore`.
 * - `gitignoredConfig`: with `scanIgnoredAgentConfig`, agent configuration that a `.gitignore`
 *   matches and that was listed and read anyway (directories with a trailing `/`).
 * - `skipped`: candidates and import targets that were not read (`too-large`, `byte-limit`,
 *   `import-limit`, `binary`, `special-file`, `unreadable`), directories that were not listed
 *   (`depth-limit`, `unreadable`, with a trailing `/`), `.gitignore` and `.gitmodules` files that
 *   could not be applied, and at most one `file-limit` entry naming the first entry that was not
 *   visited.
 *
 * With `followImports` (the default), `files` also holds the import targets read after the walk,
 * marked `imported` (see readImports).
 */
export async function walk(root: string, options: WalkOptions = {}): Promise<Snapshot> {
  const settings = resolveOptions(options);
  const roots = await resolveRoot(root);
  const walker = new Walker(roots, settings);
  await walker.run();
  if (settings.followImports) await walker.readImports();
  return walker.snapshot();
}

interface Settings {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly respectGitignore: boolean;
  readonly scanIgnoredAgentConfig: boolean;
  readonly followImports: boolean;
  readonly isCandidate: (relativePosixPath: string) => boolean;
  /**
   * Read candidates ahead of their turn. Only with the default isCandidate, which is pure: a
   * custom predicate is called exactly once per listed, non-ignored file, when it is visited.
   */
  readonly readAhead: boolean;
}

function resolveOptions(options: WalkOptions): Settings {
  return {
    maxFileBytes: limit('maxFileBytes', options.maxFileBytes, DEFAULT_WALK_LIMITS.maxFileBytes),
    maxTotalBytes: limit('maxTotalBytes', options.maxTotalBytes, DEFAULT_WALK_LIMITS.maxTotalBytes),
    maxEntries: limit('maxEntries', options.maxEntries, DEFAULT_WALK_LIMITS.maxEntries),
    maxDepth: limit('maxDepth', options.maxDepth, DEFAULT_WALK_LIMITS.maxDepth),
    respectGitignore: options.respectGitignore ?? true,
    scanIgnoredAgentConfig: options.scanIgnoredAgentConfig ?? false,
    followImports: options.followImports ?? true,
    isCandidate: options.isCandidate ?? defaultIsCandidate,
    readAhead: options.isCandidate === undefined,
  };
}

function limit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

async function resolveRoot(root: string): Promise<ScanRoots> {
  try {
    const real = await realpath(root);
    const stats = await lstat(real);
    if (stats.isDirectory()) {
      return { real, given: path.resolve(root), aliases: await systemAliases(real) };
    }
  } catch (error) {
    const reason = errorCode(error) === 'ENOENT' ? 'it does not exist' : 'it cannot be accessed';
    throw new WalkError(`Cannot scan ${root}: ${reason}`, { cause: error });
  }
  throw new WalkError(`Cannot scan ${root}: it is not a directory`);
}

/**
 * Other absolute spellings of the root that links commonly use. On macOS /var, /tmp and /etc are
 * symlinks into /private, so a link written as `/var/folders/.../x` names a root whose real path is
 * `/private/var/folders/.../x`. Only that top-level system symlink is examined: it comes from the
 * root the user chose, never from the scanned tree.
 */
async function systemAliases(real: string): Promise<string[]> {
  const segments = real.split(path.sep);
  const top = segments[2];
  if (path.sep !== '/' || segments[1] !== 'private' || top === undefined) return [];
  const alias = `/${segments.slice(2).join('/')}`;
  try {
    const stats = await lstat(`/${top}`);
    if (stats.isSymbolicLink() && (await realpath(`/${top}`)) === `/private/${top}`) return [alias];
  } catch {
    // No such alias on this system.
  }
  return [];
}

interface DirectoryFrame {
  /** POSIX, relative to the root, no trailing slash, as agents reach it; `''` for the root. */
  readonly relativePath: string;
  /** Absolute and symlink-free: what is listed and what child paths are built from. */
  readonly realPath: string;
  /** POSIX, relative to the root, symlink-free. Differs from `relativePath` below a link. */
  readonly realRelativePath: string;
  readonly depth: number;
  /** .gitignore rules inherited from ancestors (not this directory's own file). */
  readonly ignore: IgnoreLayer | undefined;
  readonly parent: DirectoryFrame | undefined;
}

/** Where an entry is: as agents reach it, and on disk. */
interface Location {
  /** POSIX, relative to the root, possibly through symlinks. What the snapshot reports. */
  readonly relativePath: string;
  /** Absolute and symlink-free (for a symlink entry: the link itself). */
  readonly realPath: string;
  /** POSIX, relative to the root, symlink-free. */
  readonly realRelativePath: string;
}

type EntryKind = 'file' | 'directory' | 'symlink' | 'special';

/** Decided from the directory entry type, which (like lstat) describes the entry, not its target. */
function entryKind(entry: Dirent): EntryKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  // FIFOs, sockets, devices, and anything the filesystem did not type. Opening a FIFO blocks until
  // a writer appears (hanging the scan) and opening a device can have side effects.
  return 'special';
}

/** True when `realPath` is `frame`'s directory or one of its ancestors on the current walk path. */
function isOnWalkPath(frame: DirectoryFrame, realPath: string): boolean {
  for (let current: DirectoryFrame | undefined = frame; current; current = current.parent) {
    if (current.realPath === realPath) return true;
  }
  return false;
}

const utf8 = new TextDecoder('utf-8');

/** A git control file (.gitignore, .gitmodules) as the walk found it. */
type ControlFile =
  /** No such file, or a directory of that name (not a control file at all). */
  | { readonly kind: 'absent' }
  /** There, but not usable: a symlink, a special file, too large, or unreadable. */
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'read';
      readonly text: string;
      readonly size: number;
      readonly relativePath: string;
    };

const ABSENT = { kind: 'absent' } as const;
const SKIPPED = { kind: 'skipped' } as const;

/**
 * Throughput. Each directory and each candidate costs a few thread-pool round trips; done one at a
 * time, the walk spends most of its time waiting. So listings are requested for the next
 * directories in the queue, and candidates are read ahead of their turn, while results are still
 * consumed strictly in walk order: the snapshot is exactly what a one-at-a-time walk produces.
 */
/** Directories whose listings are requested ahead of the one being processed, in queue order. */
const LISTING_PREFETCH = 32;
/** Entries a listing requested ahead may hold. Larger directories are listed again in turn. */
const PREFETCH_ENTRY_CAP = 4096;
/** Candidate reads in flight at once. */
const READ_AHEAD_CONCURRENCY = 16;
/** Candidates read ahead and not yet consumed: at most this many times maxFileBytes in memory. */
const MAX_READ_AHEADS = 32;

/** A directory's listing, shared by every queued frame (alias view) of that real directory. */
interface ListingSlot {
  /** Queued frames that will consume it. */
  users: number;
  listing: Promise<Listing | undefined> | undefined;
}

/** What reading a real file gave: alias paths of the same file reuse it. */
type FileContent =
  | { readonly bytes: Uint8Array; readonly identity: SourceIdentity }
  | { readonly binarySize: number };

/**
 * The identity a text file gets in the snapshot: the device and inode of the opened handle and
 * the SHA-256 of the bytes read, which `agentcheckup fix --write` compares with the file on disk
 * before replacing it (src/io/write-fix.ts).
 */
function sourceIdentity(file: FileIdentity, bytes: Uint8Array): SourceIdentity {
  return {
    dev: file.dev,
    ino: file.ino,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const byName = (a: Dirent, b: Dirent): number => compareStrings(a.name, b.name);

function sortedSet(values: Iterable<string>): ReadonlySet<string> {
  return new Set([...values].sort(compareStrings));
}

class Walker {
  readonly #roots: ScanRoots;
  readonly #settings: Settings;
  readonly #queue: DirectoryFrame[] = [];
  readonly #files: SourceFile[] = [];
  readonly #paths = new Set<string>();
  readonly #opaqueDirectories = new Set<string>();
  readonly #ignoredFiles = new Set<string>();
  /** Agent configuration scanned although a .gitignore matches it (scanIgnoredAgentConfig). */
  readonly #gitignoredConfig = new Set<string>();
  /** Declared in the root `.gitmodules`. */
  readonly #submodules = new Set<string>();
  readonly #unresolved: UnresolvedSymlink[] = [];
  readonly #skipped: SkippedEntry[] = [];
  #entriesSeen = 0;
  #bytesRead = 0;
  /** Files the import pass added, and the bytes it read from disk (see imports.ts). */
  #importedFiles = 0;
  #importedBytes = 0;
  #stopped = false;
  /** Weight of all .gitignore rules compiled so far (see gitignore.ts for the budgets). */
  #gitignoreWeight = 0;
  /** Weight of all rule tests so far. */
  #matchWork = 0;
  /** Set when the match budget ran out: .gitignore files are no longer applied. */
  #gitignoreExhausted = false;
  /** Set when a .gitignore was not applied, or only partly: `gitignoreApplied` is then false. */
  #gitignorePartial = false;
  /** Listings by real directory path. */
  readonly #listings = new Map<string, ListingSlot>();
  /** Queue index up to which listings have been requested. */
  #requested = 0;
  /** Candidates read ahead, by real path, and which frame asked for them (to drop leftovers). */
  readonly #readAheads = new Map<string, Promise<FileProbe>>();
  readonly #readAheadsByFrame = new Map<DirectoryFrame, string[]>();
  readonly #readLimiter = new Limiter(READ_AHEAD_CONCURRENCY);
  /**
   * Every real file read so far, by real path: each is read once and counted once against
   * maxTotalBytes, however many alias paths (symlinks, symlinked directories) lead to it.
   */
  readonly #contents = new Map<string, FileContent>();
  /** Background I/O still running; drained before the walk returns. */
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(roots: ScanRoots, settings: Settings) {
    this.#roots = roots;
    this.#settings = settings;
  }

  async run(): Promise<void> {
    try {
      await this.#loadGitmodules();
      this.#enqueue({
        relativePath: '',
        realPath: this.#roots.real,
        realRelativePath: '',
        depth: 0,
        ignore: undefined,
        parent: undefined,
      });
      // Breadth-first with an explicit queue (no recursion, so no stack overflow on deep trees).
      // The array grows while it is iterated, which for-of supports. Breadth-first also means that
      // when a limit is hit, the shallow files that matter most (root AGENTS.md, .claude/) are done.
      let listed = 0;
      for (const frame of this.#queue) {
        this.#requestListings(listed);
        listed += 1;
        await this.#listDirectory(frame);
        if (this.#stopped) {
          // The entry limit stopped the walk inside `frame`: it and every directory still queued
          // were not fully listed, so their contents are unknown rather than missing. (The root
          // has no entry of its own; a stop while listing it shows as the `file-limit` entry.)
          if (frame.parent !== undefined) this.#markOpaque(frame.relativePath);
          for (const pending of this.#queue.slice(listed)) this.#markOpaque(pending.relativePath);
          break;
        }
      }
    } finally {
      // No I/O may outlive the walk, even when it stops early or throws.
      while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
    }
    this.#markUnlistedSubmodules();
  }

  #enqueue(frame: DirectoryFrame): void {
    this.#queue.push(frame);
    const slot = this.#listings.get(frame.realPath);
    if (slot === undefined) this.#listings.set(frame.realPath, { users: 1, listing: undefined });
    else slot.users += 1;
  }

  /** Requests the listings of the queued directories from `from` up to LISTING_PREFETCH ahead. */
  #requestListings(from: number): void {
    const end = Math.min(this.#queue.length, from + LISTING_PREFETCH);
    for (; this.#requested < end; this.#requested += 1) {
      const frame = this.#queue[this.#requested];
      if (frame !== undefined) this.#requestListing(frame);
    }
  }

  #requestListing(frame: DirectoryFrame): void {
    const slot = this.#listings.get(frame.realPath);
    if (slot === undefined) return;
    // Listing ahead may keep more entries than the budget will allow by the time the directory's
    // turn comes; #takeListing truncates to the exact budget then.
    const cap = Math.min(PREFETCH_ENTRY_CAP, this.#settings.maxEntries - this.#entriesSeen + 1);
    slot.listing ??= this.#track(readListing(frame.realPath, cap));
    if (this.#settings.readAhead) {
      void this.#track(
        slot.listing.then((listing) => {
          this.#readAhead(frame, listing);
        }),
      );
    }
  }

  /** Starts reading the candidate files of a listed directory, within MAX_READ_AHEADS. */
  #readAhead(frame: DirectoryFrame, listing: Listing | undefined): void {
    if (listing === undefined || this.#stopped) return;
    const owned = this.#readAheadsByFrame.get(frame) ?? [];
    for (const entry of listing.entries) {
      if (this.#readAheads.size >= MAX_READ_AHEADS) break;
      if (!entry.isFile()) continue;
      if (!defaultIsCandidate(joinRelative(frame.relativePath, entry.name))) continue;
      const realPath = path.join(frame.realPath, entry.name);
      if (this.#readAheads.has(realPath) || this.#contents.has(realPath)) continue;
      const maxBytes = this.#settings.maxFileBytes;
      const probe = this.#readLimiter.run(() => probeFile(realPath, maxBytes));
      this.#readAheads.set(realPath, this.#track(probe));
      owned.push(realPath);
    }
    if (owned.length > 0) this.#readAheadsByFrame.set(frame, owned);
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise);
    const done = (): void => {
      this.#inFlight.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }

  snapshot(): Snapshot {
    const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
      compareStrings(a.path, b.path);
    return {
      files: this.#files.sort(byPath),
      paths: sortedSet(this.#paths),
      opaqueDirectories: sortedSet(this.#opaqueDirectories),
      ignoredFiles: sortedSet(this.#ignoredFiles),
      ...(this.#gitignoredConfig.size === 0
        ? {}
        : { gitignoredConfig: sortedSet(this.#gitignoredConfig) }),
      gitignoreApplied: this.#settings.respectGitignore && !this.#gitignorePartial,
      unresolvedSymlinks: this.#unresolved.sort(byPath),
      skipped: this.#skipped.sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason),
      ),
    };
  }

  async #listDirectory(frame: DirectoryFrame): Promise<void> {
    try {
      await this.#visitDirectory(frame);
    } finally {
      // Read-aheads for entries that were not visited (ignored, past a limit) are dropped.
      for (const realPath of this.#readAheadsByFrame.get(frame) ?? []) {
        this.#readAheads.delete(realPath);
      }
      this.#readAheadsByFrame.delete(frame);
    }
  }

  async #visitDirectory(frame: DirectoryFrame): Promise<void> {
    const listing = await this.#takeListing(frame);
    if (listing === undefined) {
      if (frame.parent === undefined) {
        throw new WalkError(`Cannot scan ${this.#roots.given}: the directory cannot be read`);
      }
      this.#skip(`${frame.relativePath}/`, 'unreadable');
      this.#markOpaque(frame.relativePath);
      return;
    }
    const { entries, whole } = listing;
    if (
      this.#submodules.has(frame.relativePath) &&
      isOpaqueSubmodule(
        frame.relativePath,
        entries.map((entry) => entry.name),
      )
    ) {
      this.#markOpaque(frame.relativePath);
      return;
    }
    const applyGitignore = this.#settings.respectGitignore && !this.#gitignoreExhausted;
    // A whole listing tells whether there is a .gitignore, which saves an lstat per directory.
    const hasGitignore = whole ? entries.some((entry) => entry.name === '.gitignore') : undefined;
    const ignore = applyGitignore ? await this.#loadGitignore(frame, hasGitignore) : undefined;
    for (const entry of entries) {
      if (this.#entriesSeen >= this.#settings.maxEntries) {
        const entryPath = joinRelative(frame.relativePath, entry.name);
        this.#skip(entry.isDirectory() ? `${entryPath}/` : entryPath, 'file-limit');
        this.#stopped = true;
        return;
      }
      this.#entriesSeen += 1;
      await this.#visitEntry(frame, ignore, entry);
    }
  }

  /**
   * `frame`'s entries in code-point order: at most one more than the remaining entry budget, so a
   * directory with millions of entries cannot exhaust memory. They are the first entries in the
   * filesystem's listing order, as a one-at-a-time walk would see them. (So when the budget runs
   * out inside a directory, which entries were seen depends on the filesystem.) `whole` is true
   * when they are all of the directory's entries.
   */
  async #takeListing(
    frame: DirectoryFrame,
  ): Promise<{ entries: Dirent[]; whole: boolean } | undefined> {
    const wanted = this.#settings.maxEntries - this.#entriesSeen + 1;
    const slot = this.#listings.get(frame.realPath);
    let listing = await (slot?.listing ?? readListing(frame.realPath, wanted));
    if (slot !== undefined) {
      slot.users -= 1;
      if (slot.users <= 0) this.#listings.delete(frame.realPath);
    }
    if (listing !== undefined && !listing.complete && listing.entries.length < wanted) {
      // Listed ahead only up to PREFETCH_ENTRY_CAP: list again with the real budget.
      listing = await readListing(frame.realPath, wanted);
    }
    if (listing === undefined) return undefined;
    return {
      entries: listing.entries.slice(0, wanted).sort(byName),
      whole: listing.complete && listing.entries.length <= wanted,
    };
  }

  /** The ignore layers for `frame`'s entries: its ancestors' rules plus its own .gitignore. */
  async #loadGitignore(
    frame: DirectoryFrame,
    present: boolean | undefined,
  ): Promise<IgnoreLayer | undefined> {
    if (present === false) return frame.ignore;
    const file = await this.#readControlFile(frame, '.gitignore', MAX_GITIGNORE_BYTES);
    if (file.kind !== 'read') {
      if (file.kind === 'skipped') this.#gitignorePartial = true;
      return frame.ignore;
    }
    const rules = parseGitignore(file.text);
    // Patterns dropped as too costly to match leave the file only partly applied.
    if (rules.dropped > 0) this.#gitignorePartial = true;
    if (rules.weight === 0) return frame.ignore;
    if (
      chainWeight(frame.ignore) + rules.weight > MAX_GITIGNORE_WEIGHT_PER_PATH ||
      this.#gitignoreWeight + rules.weight > MAX_GITIGNORE_WEIGHT_TOTAL
    ) {
      this.#skip(file.relativePath, 'byte-limit', file.size);
      this.#gitignorePartial = true;
      return frame.ignore;
    }
    this.#gitignoreWeight += rules.weight;
    return addGitignoreRules(frame.ignore, frame.relativePath, rules);
  }

  /** isIgnored, within the walk's match budget. Past it, nothing is ignored any more. */
  #isIgnored(layer: IgnoreLayer | undefined, relativePath: string, isDirectory: boolean): boolean {
    if (layer === undefined || this.#gitignoreExhausted) return false;
    this.#matchWork += layer.chainWeight;
    if (this.#matchWork > MAX_GITIGNORE_MATCH_WORK) {
      this.#gitignoreExhausted = true;
      this.#gitignorePartial = true;
      this.#skip(joinRelative(layer.base, '.gitignore'), 'byte-limit');
      return false;
    }
    return isIgnored(layer, relativePath, isDirectory);
  }

  /** Submodule paths from the root `.gitmodules` (nested repositories' files are not read). */
  async #loadGitmodules(): Promise<void> {
    const root = { realPath: this.#roots.real, relativePath: '' };
    const file = await this.#readControlFile(root, '.gitmodules', MAX_GITMODULES_BYTES);
    if (file.kind !== 'read') return;
    for (const submodule of parseGitmodules(file.text)) this.#submodules.add(submodule);
  }

  /**
   * Reads a git control file (.gitignore, .gitmodules) that steers the walk. It must be a regular
   * file: a symlink is not followed (git refuses them too), as it could point outside the root.
   * A file that is too large or unreadable is reported in `skipped` and not applied; a symlink
   * or special file is `skipped` silently, a directory of that name is `absent`.
   */
  async #readControlFile(
    directory: Pick<DirectoryFrame, 'realPath' | 'relativePath'>,
    name: string,
    maxBytes: number,
  ): Promise<ControlFile> {
    const filePath = path.join(directory.realPath, name);
    let stats: BigIntStats;
    try {
      // bigint: the identity readRegularFile checks the opened file against (see FileIdentity).
      stats = await lstat(filePath, { bigint: true });
    } catch {
      return ABSENT;
    }
    if (stats.isDirectory()) return ABSENT;
    if (!stats.isFile()) return SKIPPED;
    const relativePath = joinRelative(directory.relativePath, name);
    const size = Number(stats.size);
    if (size > maxBytes) {
      this.#skip(relativePath, 'too-large', size);
      return SKIPPED;
    }
    const outcome = await readRegularFile(filePath, stats, maxBytes);
    if (!outcome.ok) {
      this.#skip(
        relativePath,
        outcome.reason,
        outcome.reason === 'too-large' ? outcome.size : undefined,
      );
      return SKIPPED;
    }
    return {
      kind: 'read',
      text: utf8.decode(outcome.bytes),
      size: outcome.bytes.length,
      relativePath,
    };
  }

  /**
   * Submodules that were never listed as directories: not checked out at all (an archive, a
   * sparse tree) or not reached. Their contents are unknown, not missing. Paths already known
   * as files, or inside an opaque directory, need nothing more.
   */
  #markUnlistedSubmodules(): void {
    for (const submodule of this.#submodules) {
      if (this.#paths.has(`${submodule}/`) || this.#paths.has(submodule)) continue;
      if (this.#ignoredFiles.has(submodule) || this.#isOpaque(submodule)) continue;
      this.#markOpaque(submodule);
    }
  }

  /** Whether `relativePath` is an opaque directory or lies inside one. */
  #isOpaque(relativePath: string): boolean {
    for (
      let end = relativePath.indexOf('/');
      end !== -1;
      end = relativePath.indexOf('/', end + 1)
    ) {
      if (this.#opaqueDirectories.has(relativePath.slice(0, end + 1))) return true;
    }
    return this.#opaqueDirectories.has(`${relativePath}/`);
  }

  async #visitEntry(
    frame: DirectoryFrame,
    ignore: IgnoreLayer | undefined,
    entry: Dirent,
  ): Promise<void> {
    const location: Location = {
      relativePath: joinRelative(frame.relativePath, entry.name),
      realPath: path.join(frame.realPath, entry.name),
      realRelativePath: joinRelative(frame.realRelativePath, entry.name),
    };
    const kind = entryKind(entry);
    const { relativePath } = location;
    // A symlink is matched as a file even when it points to a directory, as git stores it. Git
    // never looks below a symlink; here, paths below one are matched as if it were a directory.
    const gitignored = this.#isIgnored(ignore, relativePath, kind === 'directory');
    if (gitignored && !this.#scansIgnored(relativePath, kind)) {
      this.#recordIgnored(relativePath, kind);
      return;
    }
    switch (kind) {
      case 'directory':
        if (gitignored) this.#gitignoredConfig.add(`${relativePath}/`);
        this.#enterDirectory(frame, ignore, location);
        return;
      case 'file':
        if (gitignored) this.#gitignoredConfig.add(relativePath);
        await this.#visitFile(location);
        return;
      case 'symlink':
        await this.#visitSymlink(frame, ignore, location, gitignored);
        return;
      case 'special':
        if (gitignored) this.#gitignoredConfig.add(relativePath);
        this.#paths.add(relativePath);
        if (this.#settings.isCandidate(relativePath)) this.#skip(relativePath, 'special-file');
        return;
    }
  }

  /**
   * Whether an entry that a .gitignore matches is scanned anyway: with scanIgnoredAgentConfig,
   * agent configuration directories and everything below them are listed, and candidates are
   * read, so an untrusted repository cannot hide what agents load from the scan. A symlink
   * qualifies by its own path; visitSymlink checks what it leads to.
   */
  #scansIgnored(relativePath: string, kind: EntryKind): boolean {
    if (!this.#settings.scanIgnoredAgentConfig) return false;
    switch (kind) {
      case 'directory':
        return isAgentConfigDirectory(relativePath);
      case 'symlink':
        return isAgentConfigDirectory(relativePath) || this.#settings.isCandidate(relativePath);
      case 'file':
      case 'special':
        return this.#settings.isCandidate(relativePath);
    }
  }

  /**
   * Ignored entries are not listed in `paths`, but they exist. A symlink's target is not looked at,
   * so it is recorded as an ignored file whose "contents", if it leads to a directory, are unknown.
   */
  #recordIgnored(relativePath: string, kind: EntryKind): void {
    if (kind !== 'directory') this.#ignoredFiles.add(relativePath);
    if (kind === 'directory' || kind === 'symlink') this.#markOpaque(relativePath);
  }

  #enterDirectory(
    parent: DirectoryFrame,
    ignore: IgnoreLayer | undefined,
    location: Location,
  ): void {
    const { relativePath, realPath, realRelativePath } = location;
    this.#paths.add(`${relativePath}/`);
    // Loop guard for directory symlinks (`up -> ..`, `a/l -> ../b` + `b/l -> ../a`): never enter a
    // directory that is already on the current walk path. Only that path is checked, not every
    // directory seen so far: `.claude/skills -> ../.agents/skills` must be walked even though
    // `.agents/skills` is walked too, because agents load the files under the link's path.
    // Duplicated subtrees are bounded by maxDepth and maxEntries.
    if (isHardExcludedDirectory(relativePath) || isOnWalkPath(parent, realPath)) {
      this.#markOpaque(relativePath);
      return;
    }
    const depth = parent.depth + 1;
    if (depth > this.#settings.maxDepth) {
      this.#skip(`${relativePath}/`, 'depth-limit');
      this.#markOpaque(relativePath);
      return;
    }
    this.#enqueue({ relativePath, realPath, realRelativePath, depth, ignore, parent });
  }

  async #visitFile(location: Location): Promise<void> {
    const { relativePath } = location;
    this.#paths.add(relativePath);
    if (!this.#settings.isCandidate(relativePath)) return;
    if (this.#reuseContent(location)) return;
    const readAhead = this.#readAheads.get(location.realPath);
    this.#readAheads.delete(location.realPath);
    const probe = await (readAhead ?? probeFile(location.realPath));
    switch (probe.kind) {
      case 'missing':
        this.#skip(relativePath, 'unreadable');
        return;
      case 'not-a-file':
        this.#skip(relativePath, probe.special ? 'special-file' : 'unreadable');
        return;
      case 'file':
        await this.#readCandidate(location, probe.stats, probe.outcome);
        return;
    }
  }

  /** Another path already led to this real file: reuse what reading it gave. */
  #reuseContent(location: Location): boolean {
    const content = this.#contents.get(location.realPath);
    if (content === undefined) return false;
    if ('bytes' in content) this.#addFile(location, content);
    else this.#skip(location.relativePath, 'binary', content.binarySize);
    return true;
  }

  /**
   * `gitignored`: a .gitignore matches the link, which #scansIgnored let through. It is scanned
   * when it leads to an agent configuration directory or is a candidate, like an entry of that
   * kind; otherwise it stays ignored, as it would have without scanIgnoredAgentConfig.
   */
  async #visitSymlink(
    frame: DirectoryFrame,
    ignore: IgnoreLayer | undefined,
    link: Location,
    gitignored: boolean,
  ): Promise<void> {
    const { relativePath } = link;
    let linkText: string;
    try {
      linkText = await readlink(link.realPath);
    } catch {
      this.#unresolvedLink(relativePath, '', 'broken', gitignored);
      return;
    }
    const resolution = await resolveSymlink(this.#roots, frame.realPath, linkText);
    if (resolution.kind !== 'inside') {
      const problem = resolution.kind === 'outside' ? 'outside-root' : 'broken';
      this.#unresolvedLink(relativePath, linkText, problem, gitignored);
      return;
    }
    const target: Location = {
      ...link,
      realPath: resolution.realPath,
      realRelativePath: resolution.relativePath,
    };
    const { stats } = resolution;
    if (stats.isDirectory()) {
      if (gitignored) {
        if (!isAgentConfigDirectory(relativePath)) {
          this.#recordIgnored(relativePath, 'symlink');
          return;
        }
        this.#gitignoredConfig.add(`${relativePath}/`);
      }
      this.#enterDirectory(frame, ignore, target);
      return;
    }
    if (!stats.isFile()) {
      this.#unresolvedLink(relativePath, linkText, 'not-a-regular-file', gitignored);
      return;
    }
    const candidate = this.#settings.isCandidate(relativePath);
    if (gitignored) {
      if (!candidate) {
        this.#recordIgnored(relativePath, 'symlink');
        return;
      }
      this.#gitignoredConfig.add(relativePath);
    }
    this.#paths.add(relativePath);
    if (!candidate) return;
    await this.#readCandidate(target, stats);
  }

  /**
   * Reads `location.realPath`, which the caller has lstat-ed as the regular file `stats`, unless
   * `readAhead` already holds the outcome of reading it (with maxFileBytes as the only limit).
   */
  async #readCandidate(
    location: Location,
    stats: BigIntStats,
    readAhead?: ReadOutcome,
  ): Promise<void> {
    const { relativePath } = location;
    const { maxFileBytes, maxTotalBytes } = this.#settings;
    const size = Number(stats.size);
    if (size > maxFileBytes) {
      this.#skip(relativePath, 'too-large', size);
      return;
    }
    if (this.#reuseContent(location)) return;
    // A candidate that does not fit the remaining budget is skipped, but smaller ones after it
    // are still read.
    const remaining = maxTotalBytes - this.#bytesRead;
    if (size > remaining) {
      this.#skip(relativePath, 'byte-limit', size);
      return;
    }
    const outcome =
      readAhead ??
      (await readRegularFile(location.realPath, stats, Math.min(maxFileBytes, remaining)));
    if (!outcome.ok) {
      if (outcome.reason === 'too-large') {
        const reason = outcome.size > maxFileBytes ? 'too-large' : 'byte-limit';
        this.#skip(relativePath, reason, outcome.size);
      } else {
        this.#skip(relativePath, outcome.reason);
      }
      return;
    }
    const { bytes } = outcome;
    // A read-ahead was only bounded by maxFileBytes: the budget is checked here, in walk order.
    if (bytes.length > remaining) {
      this.#skip(relativePath, 'byte-limit', bytes.length);
      return;
    }
    this.#bytesRead += bytes.length;
    if (looksBinary(bytes)) {
      this.#contents.set(location.realPath, { binarySize: bytes.length });
      this.#skip(relativePath, 'binary', bytes.length);
      return;
    }
    const content = { bytes, identity: sourceIdentity(outcome.identity, bytes) };
    this.#contents.set(location.realPath, content);
    this.#addFile(location, content);
  }

  /**
   * Alias paths share the same bytes and identity objects; consumers must treat them as
   * read-only. The identity names the real file, also for an alias path.
   */
  #addFile(
    location: Location,
    content: { readonly bytes: Uint8Array; readonly identity: SourceIdentity },
    imported = false,
  ): SourceFile {
    const { relativePath, realRelativePath } = location;
    // Reached through a symlink (the file itself or a parent directory): name the real file, so
    // the engine can treat the alias and the file as one artifact.
    const file: SourceFile = {
      path: relativePath,
      bytes: content.bytes,
      ...(realRelativePath === relativePath ? {} : { symlinkTarget: realRelativePath }),
      ...(imported ? { imported } : {}),
      identity: content.identity,
    };
    this.#files.push(file);
    return file;
  }

  /**
   * The import pass. Instruction files can import other files (`@README.md`), which the agent
   * then loads too; the walk read only agent configuration, so the import rules and the load
   * plans could not size those files or follow their own imports. ImportPlanner (imports.ts) says
   * which targets to read, hop by hop from the files agents load, as far as agents follow imports;
   * this reads them like candidates: inside the root only, resolved without leaving it (a link out
   * of the root is never followed), each real file once, within the caps:
   * - `too-large`: over maxFileBytes, the per-file cap of the walk;
   * - `import-limit`: past MAX_IMPORTED_FILES files or MAX_IMPORTED_BYTES bytes for the pass;
   * - `byte-limit`: past what is left of maxTotalBytes.
   * Read files are marked `imported`; binary ones are skipped as `binary`.
   */
  async readImports(): Promise<void> {
    const planner = new ImportPlanner(this.snapshot());
    for (let targets = planner.next(); targets.length > 0; targets = planner.next()) {
      for (const target of targets) planner.done(target, await this.#readImport(target));
    }
  }

  async #readImport(relativePath: string): Promise<SourceFile | undefined> {
    if (this.#importedFiles >= MAX_IMPORTED_FILES) {
      this.#skip(relativePath, 'import-limit');
      return undefined;
    }
    // The planner only asks for listed files; resolve the path again from the root, never
    // touching anything outside it, in case it goes through symlinks.
    const resolution = await resolveSymlink(this.#roots, this.#roots.real, relativePath);
    if (resolution.kind !== 'inside' || !resolution.stats.isFile()) {
      const special =
        resolution.kind === 'inside' &&
        !resolution.stats.isDirectory() &&
        !resolution.stats.isSymbolicLink();
      this.#skip(relativePath, special ? 'special-file' : 'unreadable');
      return undefined;
    }
    const location: Location = {
      relativePath,
      realPath: resolution.realPath,
      realRelativePath: resolution.relativePath,
    };
    const known = this.#contents.get(location.realPath);
    if (known !== undefined) {
      // Read already, through another path: no second read, and no bytes counted again.
      this.#importedFiles += 1;
      if ('bytes' in known) return this.#addFile(location, known, true);
      this.#skip(relativePath, 'binary', known.binarySize);
      return undefined;
    }
    const { maxFileBytes, maxTotalBytes } = this.#settings;
    const size = Number(resolution.stats.size);
    const importBudget = MAX_IMPORTED_BYTES - this.#importedBytes;
    const totalBudget = maxTotalBytes - this.#bytesRead;
    const reason = (bytes: number): SkipReason | undefined =>
      bytes > maxFileBytes
        ? 'too-large'
        : bytes > importBudget
          ? 'import-limit'
          : bytes > totalBudget
            ? 'byte-limit'
            : undefined;
    const before = reason(size);
    if (before !== undefined) {
      this.#skip(relativePath, before, size);
      return undefined;
    }
    const outcome = await readRegularFile(
      location.realPath,
      resolution.stats,
      Math.min(maxFileBytes, importBudget, totalBudget),
    );
    if (!outcome.ok) {
      // A file that grew since it was stat-ed is judged by its new size.
      if (outcome.reason === 'too-large') {
        this.#skip(relativePath, reason(outcome.size) ?? 'too-large', outcome.size);
      } else {
        this.#skip(relativePath, outcome.reason);
      }
      return undefined;
    }
    const { bytes } = outcome;
    this.#importedFiles += 1;
    this.#importedBytes += bytes.length;
    this.#bytesRead += bytes.length;
    if (looksBinary(bytes)) {
      this.#contents.set(location.realPath, { binarySize: bytes.length });
      this.#skip(relativePath, 'binary', bytes.length);
      return undefined;
    }
    const content = { bytes, identity: sourceIdentity(outcome.identity, bytes) };
    this.#contents.set(location.realPath, content);
    return this.#addFile(location, content, true);
  }

  /**
   * A link whose target was not entered. For `outside-root` and `broken` links nothing is known
   * about what lies below them (the target may be a directory, and is never looked at), so they
   * are also opaque. A `not-a-regular-file` target was examined and is not a directory.
   */
  #unresolvedLink(
    relativePath: string,
    linkText: string,
    problem: SymlinkProblem,
    gitignored = false,
  ): void {
    if (gitignored) this.#gitignoredConfig.add(relativePath);
    this.#paths.add(relativePath);
    if (problem !== 'not-a-regular-file') this.#markOpaque(relativePath);
    // Windows returns link text with backslashes; report it with forward slashes like every
    // other path, so output is the same on every platform. On POSIX a backslash is part of a name.
    const portable = process.platform === 'win32' ? linkText.replaceAll('\\', '/') : linkText;
    this.#unresolved.push({ path: relativePath, target: sanitizeLinkText(portable), problem });
  }

  #markOpaque(relativePath: string): void {
    this.#opaqueDirectories.add(`${relativePath}/`);
  }

  #skip(relativePath: string, reason: SkipReason, size?: number): void {
    this.#skipped.push(
      size === undefined ? { path: relativePath, reason } : { path: relativePath, reason, size },
    );
  }
}
