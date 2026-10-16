/**
 * Writes fixes to the scanned repository: the only code in agentcheckup that changes files in it
 * (docs/adr/0008-write-fixes-to-the-scanned-repository.md). `agentcheckup fix --write` and
 * `fix -i` call it once the fixes were applied and verified in memory (src/fix), with the bytes
 * each file must end up with. The repository may be hostile (docs/adr/0003) and may change
 * between the scan and the write, so each step checks again what it is about to change:
 *
 * - Paths are normalized POSIX paths relative to the root: no `.`, `..` or empty components, not
 *   absolute, no NUL or other control characters, none of the characters Windows forbids or
 *   gives a meaning (`<>:"\|?*`: drive letters, alternate data streams), no Windows device
 *   names (`aux.md`, `COM1.txt`), no trailing dot or space (Windows drops them, so `CLAUDE.md.`
 *   would be `CLAUDE.md`) and nothing inside `.git`, whose hooks git would run.
 * - Every parent directory is lstat-ed from the real root and must be a directory, never a
 *   symlink (or a Windows junction), even one that stays inside the root. Missing parents of a
 *   new file are created one at a time; one that appears meanwhile (EEXIST) must be a real
 *   directory.
 * - A file is replaced only when it is a regular file with a single link whose device and inode
 *   equal its `SourceFile.identity`, and the SHA-256 of its bytes equals the scanned one; files
 *   the scan reached through a symlink, or did not read from disk, are never written.
 * - New content goes to a temporary file created next to the target with
 *   O_CREAT | O_EXCL | O_NOFOLLOW and given the target's permission bits, then written and
 *   flushed (fsync). Identity and hash are checked again, rename() replaces the target, and the
 *   directory is flushed where the platform can (not on Windows), as writeOutputFile does.
 * - Creates and renames never replace anything: the new name is made with link(), which fails
 *   when it exists, and the temporary file or the old name is unlinked after. Where hard links
 *   are not supported (FAT, some network drives), creates and renames are refused.
 * - Each fix is all or nothing: when a step fails, the fix's completed steps are undone from the
 *   contents held in memory, each only while its file still holds what the fix wrote. Fixes
 *   apply in order; a later fix sees the files as earlier ones left them.
 * - Not supported: deletions, directory renames and case-only renames. Nothing is executed.
 *
 * Hard links: a file with more than one link is refused. rename() gives the name a new file, so
 * the other names would keep the old content and the fix would silently reach only one of them;
 * writing in place instead would change every name, including one outside the repository.
 *
 * Out of scope, as for the walker: Node.js has no openat() or renameat2(). A local process that
 * swaps a parent directory, or changes the file, between the last check and the rename can still
 * redirect or overwrite that one write. rename() itself never follows a symlink at the target.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { compareStrings } from '../core/compare.js';
import type { SourceFile } from '../core/types.js';
import { NO_DIRECTORY_SYNC } from './output.js';
import { errorCode, joinRelative } from './paths.js';
import { type FileIdentity, SAFE_OPEN_FLAGS, sameFile } from './safe-read.js';

/** Bytes of one written file at most (ADR 0008). Larger content is skipped with `limit`. */
export const MAX_WRITTEN_FILE_BYTES = 1024 * 1024;

/** Fixes one run writes at most (ADR 0008). Later ones are skipped with `limit`. */
export const MAX_FIXES_PER_RUN = 1000;

/** Longer paths are refused before anything touches the disk. */
const MAX_PATH_LENGTH = 4096;

/**
 * One change to one file, with paths relative to the root (POSIX, as in the snapshot).
 * - `replace`: new bytes for a file the scan read (a fix's `edit` and `encoding` changes).
 * - `create`: a new file; nothing may exist at `path`.
 * - `rename`: moves a file the scan read, or that an earlier step wrote; nothing may exist at
 *   `to`. The file keeps its inode, so its permissions and other links stay as they were.
 */
export type WriteStep =
  | { readonly kind: 'replace'; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: 'create'; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string };

/** The steps of one fix, applied in order and undone together. */
export interface FixWrite {
  /** Returned with the result, to match it with the planned fix. */
  readonly id: string;
  readonly steps: readonly WriteStep[];
}

/**
 * Why a fix was not applied; each is also a `FixSkipReason` (src/fix/index.ts).
 * - `changed-since-scan`: a file's bytes or identity differ from what the scan read (or an
 *   earlier fix wrote), or it disappeared.
 * - `refused-path`: the path failed confinement: a symlink, a special file, a hard link, a name
 *   that is not allowed, a file the scan did not read, or a create or rename target that exists.
 * - `limit`: content over {@link MAX_WRITTEN_FILE_BYTES}, or past {@link MAX_FIXES_PER_RUN}.
 * - `write-failed`: the file system reported an error.
 */
export type FixWriteReason = 'changed-since-scan' | 'refused-path' | 'limit' | 'write-failed';

export interface FixWriteFailure {
  readonly reason: FixWriteReason;
  /** The root-relative path of the step that failed. Absent past {@link MAX_FIXES_PER_RUN}. */
  readonly path?: string;
  /** A few words, such as `it is a symbolic link`. Never file content, never absolute paths. */
  readonly detail: string;
}

/**
 * What became of one fix.
 * - `applied`: every step was written.
 * - `skipped`: nothing was changed (directories created for it were removed again).
 * - `rolled-back`: a step failed after earlier ones were written, and those were undone.
 *   `unrestored` lists the paths that could not be undone because they no longer hold what the
 *   fix wrote, or the file system failed; they are left as they are.
 */
export type FixWriteResult =
  | { readonly id: string; readonly status: 'applied' }
  | ({ readonly id: string; readonly status: 'skipped' } & FixWriteFailure)
  | ({
      readonly id: string;
      readonly status: 'rolled-back';
      readonly unrestored: readonly string[];
    } & FixWriteFailure);

/** Where a step is about to change the repository; see {@link WriteFixesOptions.beforeCommit}. */
export interface CommitPoint {
  readonly kind: 'mkdir' | 'replace' | 'create' | 'rename';
  /** Root-relative path of the directory or file about to appear or be replaced. */
  readonly path: string;
}

export interface WriteFixesOptions {
  /**
   * Test hook. Runs after a step's last check and just before the mkdir(), rename() or link()
   * that changes the repository; not while undoing a fix. Tests use it to change the tree inside
   * the window that Node.js cannot close.
   */
  readonly beforeCommit?: (point: CommitPoint) => void | Promise<void>;
}

/** The root itself is unusable: missing, not a directory, or not accessible. */
export class FixWriteError extends Error {
  override readonly name = 'FixWriteError';
}

/**
 * Applies `fixes` to the repository at `root`, in order, and returns one result per fix in the
 * same order. `files` are the files of the snapshot the walk returned for `root`, before any fix
 * was applied in memory: only files among them with an `identity` and no `symlinkTarget` are
 * replaced or renamed, and only while they still hold the bytes the walk read. Throws
 * {@link FixWriteError} only when the root is unusable; every other problem becomes a result.
 */
export async function writeFixes(
  root: string,
  files: readonly SourceFile[],
  fixes: readonly FixWrite[],
  options: WriteFixesOptions = {},
): Promise<FixWriteResult[]> {
  const writer = new FixWriter(await realRoot(root), files, options.beforeCommit);
  const results: FixWriteResult[] = [];
  for (const [index, fix] of fixes.entries()) {
    results.push(
      index < MAX_FIXES_PER_RUN
        ? await writer.apply(fix)
        : {
            id: fix.id,
            status: 'skipped',
            reason: 'limit',
            detail: `more than ${MAX_FIXES_PER_RUN} fixes in one run`,
          },
    );
  }
  return results;
}

async function realRoot(root: string): Promise<string> {
  try {
    const real = await realpath(root);
    if ((await lstat(real)).isDirectory()) return real;
  } catch (error) {
    const reason = errorCode(error) === 'ENOENT' ? 'it does not exist' : 'it cannot be accessed';
    throw new FixWriteError(`Cannot write fixes to ${root}: ${reason}`, { cause: error });
  }
  throw new FixWriteError(`Cannot write fixes to ${root}: it is not a directory`);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Characters Windows does not allow in names, or reads as drive, stream or wildcard syntax. */
const WINDOWS_SPECIAL_CHARACTERS = '<>:"\\|?*';

/** Device names Windows resolves in every directory, with any extension (`nul.md`). */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
]);
/** `com` and `lpt` followed by one of these are devices too (the superscripts included). */
const RESERVED_PORT_DIGITS = '0123456789¹²³';

/**
 * Code points HFS+ ignores in names: `.git` with U+200C (zero-width non-joiner) after the `g`
 * is `.git` there. Git's is_hfs_dotgit skips the same ones.
 */
function isIgnorableInHfsName(code: number): boolean {
  return (
    (code >= 0x200c && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x206a && code <= 0x206f) ||
    code === 0xfeff
  );
}

/**
 * Why `relativePath` cannot be written, or undefined when it is a normalized root-relative path
 * that is allowed on every platform. Purely lexical; the disk is checked when writing.
 */
export function pathRefusal(relativePath: string): string | undefined {
  if (relativePath === '') return 'the path is empty';
  if (relativePath.length > MAX_PATH_LENGTH) return 'the path is too long';
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return 'the path is absolute';
  }
  for (const name of relativePath.split('/')) {
    const refusal = nameRefusal(name);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function nameRefusal(name: string): string | undefined {
  if (name === '' || name === '.') return 'the path is not normalized';
  if (name === '..') return 'the path contains ".."';
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) < 0x20) return 'the path contains a control character';
    if (WINDOWS_SPECIAL_CHARACTERS.includes(name.charAt(index))) {
      return `the path contains "${name.charAt(index)}"`;
    }
  }
  if (name.endsWith('.') || name.endsWith(' ')) return 'a name ends with a dot or a space';
  if (isReservedName(name)) return 'a name is reserved on Windows';
  if (isGitDirectoryName(name)) return 'the path is inside .git';
  return undefined;
}

/** `aux`, `nul.md`, `COM1.txt`, `lpt¹.x`: the part before the first dot names a device. */
function isReservedName(name: string): boolean {
  const dot = name.indexOf('.');
  const stem = (dot === -1 ? name : name.slice(0, dot)).trimEnd().toLowerCase();
  if (RESERVED_NAMES.has(stem)) return true;
  return (
    stem.length === 4 &&
    (stem.startsWith('com') || stem.startsWith('lpt')) &&
    RESERVED_PORT_DIGITS.includes(stem.charAt(3))
  );
}

/** `.git`, in any case, with HFS+-ignored code points, or as its Windows short name. */
function isGitDirectoryName(name: string): boolean {
  let visible = '';
  for (const character of name) {
    if (!isIgnorableInHfsName(character.charCodeAt(0))) visible += character;
  }
  const folded = visible.toLowerCase();
  return folded === '.git' || folded === 'git~1';
}

/** Two spellings that a case-insensitive or normalizing file system treats as one name. */
function sameNameIgnoringCase(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

function optionalFlag(name: 'O_NOFOLLOW' | 'O_NOCTTY' | 'O_DIRECTORY'): number {
  const value: number | undefined = (constants as Partial<typeof constants>)[name];
  return value ?? 0;
}

/** A new temporary file: fails if anything, a symlink included, already has the name. */
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  optionalFlag('O_NOFOLLOW') |
  optionalFlag('O_NOCTTY');

const DIRECTORY_FLAGS =
  constants.O_RDONLY | optionalFlag('O_DIRECTORY') | optionalFlag('O_NOFOLLOW');

/** Permissions of a created file before the umask, as `fs.writeFile` uses. */
const NEW_FILE_MODE = 0o666;

/**
 * Errors of link() that mean the file system cannot make or does not allow a hard link here:
 * FAT and some network drives (EPERM, ENOTSUP, and EISDIR for ERROR_INVALID_FUNCTION on
 * Windows), Linux's protected_hardlinks (EPERM), or a link count at its maximum (EMLINK).
 */
const LINK_UNSUPPORTED: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
  'EISDIR',
]);

/** A file as the run last saw it: as the scan read it, then as a fix wrote it. */
interface FileState {
  readonly identity: FileIdentity;
  readonly sha256: string;
  /** For undoing a later change: what the file holds in this state. */
  readonly bytes: Uint8Array;
}

/**
 * A completed step of the current fix, with what undoing it needs. Undoing compares each file
 * with its state in the run, which the later steps' undoing has already set back.
 */
type Completed =
  | { readonly kind: 'mkdir'; readonly path: string }
  | { readonly kind: 'replace'; readonly path: string; readonly before: Uint8Array }
  | { readonly kind: 'create'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string };

/** Ends a step; caught per fix. */
class StepError extends Error {
  readonly failure: FixWriteFailure;

  constructor(failure: FixWriteFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

function refused(relativePath: string, detail: string): StepError {
  return new StepError({ reason: 'refused-path', path: relativePath, detail });
}

function changed(relativePath: string, detail: string): StepError {
  return new StepError({ reason: 'changed-since-scan', path: relativePath, detail });
}

function writeFailed(relativePath: string, error: unknown): StepError {
  if (error instanceof StepError) return error;
  const code = errorCode(error);
  const detail = code === undefined ? 'writing failed' : `the file system reported ${code}`;
  return new StepError({ reason: 'write-failed', path: relativePath, detail });
}

/** For best-effort cleanup whose failure changes nothing about the outcome. */
function ignore(): undefined {
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const STEP_KINDS: ReadonlySet<string> = new Set(['replace', 'create', 'rename']);

function stepPath(step: WriteStep): string {
  return step.kind === 'rename' ? step.to : step.path;
}

/** Where a path is on disk, once its parent directories have been checked. */
interface Placement {
  /** Absolute path of the parent directory. */
  readonly directory: string;
  readonly absolute: string;
}

class FixWriter {
  readonly #root: string;
  readonly #scanned = new Map<string, SourceFile>();
  /**
   * Files the run has looked at or written, by path; `null` once the run moved or removed the
   * file. Paths not in it are looked up in the scan.
   */
  readonly #files = new Map<string, FileState | null>();
  readonly #beforeCommit: ((point: CommitPoint) => void | Promise<void>) | undefined;

  constructor(
    root: string,
    files: readonly SourceFile[],
    beforeCommit: ((point: CommitPoint) => void | Promise<void>) | undefined,
  ) {
    this.#root = root;
    for (const file of files) this.#scanned.set(file.path, file);
    this.#beforeCommit = beforeCommit;
  }

  async apply(fix: FixWrite): Promise<FixWriteResult> {
    try {
      this.#checkPlan(fix.steps);
      await this.#checkDisk(fix.steps);
    } catch (error) {
      return { id: fix.id, status: 'skipped', ...failureOf(error) };
    }
    const done: Completed[] = [];
    for (const step of fix.steps) {
      try {
        await this.#run(step, done);
      } catch (error) {
        const failure = failureOf(error);
        const wroteFiles = done.some((entry) => entry.kind !== 'mkdir');
        const unrestored = await this.#undo(done);
        if (!wroteFiles && unrestored.length === 0) {
          return { id: fix.id, status: 'skipped', ...failure };
        }
        return { id: fix.id, status: 'rolled-back', ...failure, unrestored };
      }
    }
    return { id: fix.id, status: 'applied' };
  }

  /**
   * The state of the file at `relativePath` this run may change, or undefined when it may not:
   * a file the scan read from disk (an identity, no symlink on the way, bytes that match the
   * hash) or one an earlier step wrote.
   */
  #state(relativePath: string): FileState | undefined {
    const known = this.#files.get(relativePath);
    if (known !== undefined) return known ?? undefined;
    const file = this.#scanned.get(relativePath);
    if (file?.identity === undefined || file.symlinkTarget !== undefined) return undefined;
    // The bytes are what undoing a change restores, so they must be the bytes that were hashed.
    if (sha256(file.bytes) !== file.identity.sha256) return undefined;
    const state: FileState = {
      identity: { dev: file.identity.dev, ino: file.identity.ino },
      sha256: file.identity.sha256,
      bytes: file.bytes,
    };
    this.#files.set(relativePath, state);
    return state;
  }

  /** Why {@link #state} has nothing for `relativePath`. */
  #unknown(relativePath: string): StepError {
    if (this.#files.get(relativePath) === null) {
      return changed(relativePath, 'an earlier change moved or removed it');
    }
    const file = this.#scanned.get(relativePath);
    if (file === undefined) return refused(relativePath, 'the scan did not read it');
    if (file.symlinkTarget !== undefined) {
      return refused(relativePath, 'the scan reached it through a symbolic link');
    }
    if (file.identity === undefined)
      return refused(relativePath, 'the scan did not read it from disk');
    return refused(relativePath, 'its scanned bytes do not match their hash');
  }

  /** Whether something is at `relativePath` as far as the scan and this run know. */
  #exists(relativePath: string): boolean {
    const known = this.#files.get(relativePath);
    if (known !== undefined) return known !== null;
    return this.#scanned.has(relativePath);
  }

  /** Lexical checks of a whole fix, before anything touches the disk. */
  #checkPlan(steps: readonly WriteStep[]): void {
    /** Paths the fix's earlier steps create (true) or move away (false). */
    const planned = new Map<string, boolean>();
    const exists = (relativePath: string): boolean =>
      planned.get(relativePath) ?? this.#exists(relativePath);
    const writable = (relativePath: string): void => {
      const created = planned.get(relativePath);
      if (created === true) return;
      if (created === false) throw changed(relativePath, 'an earlier change moved it');
      if (this.#state(relativePath) === undefined) throw this.#unknown(relativePath);
    };
    for (const step of steps) {
      if (!STEP_KINDS.has(step.kind)) {
        throw refused(stepPath(step), 'only edits, creates and renames of files are supported');
      }
      for (const relativePath of step.kind === 'rename' ? [step.from, step.to] : [step.path]) {
        const refusal = pathRefusal(relativePath);
        if (refusal !== undefined) throw refused(relativePath, refusal);
      }
      if (step.kind !== 'rename' && step.bytes.length > MAX_WRITTEN_FILE_BYTES) {
        throw new StepError({
          reason: 'limit',
          path: step.path,
          detail: `the new content is larger than ${MAX_WRITTEN_FILE_BYTES} bytes`,
        });
      }
      switch (step.kind) {
        case 'replace':
          writable(step.path);
          break;
        case 'create':
          if (exists(step.path)) throw refused(step.path, 'it already exists');
          planned.set(step.path, true);
          break;
        case 'rename':
          if (step.from === step.to) throw refused(step.to, 'it would move the file onto itself');
          if (sameNameIgnoringCase(step.from, step.to)) {
            throw refused(step.to, 'case-only renames are not supported');
          }
          writable(step.from);
          if (exists(step.to)) throw refused(step.to, 'it already exists');
          planned.set(step.from, false);
          planned.set(step.to, true);
          break;
      }
    }
  }

  /**
   * The disk checks of every step, without changing anything, so that a fix that cannot apply
   * is skipped rather than written and undone. Each step checks again when it runs.
   */
  async #checkDisk(steps: readonly WriteStep[]): Promise<void> {
    /** Paths an earlier step of the fix changes: the disk does not show their state yet. */
    const pending = new Set<string>();
    for (const step of steps) {
      try {
        if (step.kind === 'replace') {
          if (!pending.has(step.path)) await this.#checkFile(step.path, this.#required(step.path));
          continue;
        }
        if (step.kind === 'rename') {
          if (!pending.has(step.from)) {
            await this.#checkFile(step.from, this.#required(step.from));
          }
          pending.add(step.from);
        }
        const target = stepPath(step);
        if (!pending.has(target)) await this.#checkAbsent(target);
        pending.add(target);
      } catch (error) {
        throw writeFailed(stepPath(step), error);
      }
    }
  }

  #required(relativePath: string): FileState {
    const state = this.#state(relativePath);
    if (state === undefined) throw this.#unknown(relativePath);
    return state;
  }

  async #run(step: WriteStep, done: Completed[]): Promise<void> {
    try {
      switch (step.kind) {
        case 'replace':
          await this.#replace(step.path, step.bytes, done);
          return;
        case 'create':
          await this.#create(step.path, step.bytes, done);
          return;
        case 'rename':
          await this.#rename(step.from, step.to, done);
          return;
      }
    } catch (error) {
      throw writeFailed(stepPath(step), error);
    }
  }

  async #replace(relativePath: string, bytes: Uint8Array, done: Completed[]): Promise<void> {
    const before = this.#required(relativePath);
    const { after, directory } = await this.#replaceContents(relativePath, before, bytes, true);
    done.push({ kind: 'replace', path: relativePath, before: before.bytes });
    this.#files.set(relativePath, after);
    await syncDirectory(directory);
  }

  /**
   * Replaces the file at `relativePath`, which must still be `expected`, with `bytes`: a
   * temporary file with the same permission bits, checked again, then renamed over it.
   */
  async #replaceContents(
    relativePath: string,
    expected: FileState,
    bytes: Uint8Array,
    notify: boolean,
  ): Promise<{ after: FileState; directory: string }> {
    const { directory, absolute, mode } = await this.#checkFile(relativePath, expected);
    const temporary = await writeTemporary(relativePath, directory, bytes, mode);
    try {
      await this.#checkFile(relativePath, expected);
      if (notify) await this.#beforeCommit?.({ kind: 'replace', path: relativePath });
      await rename(temporary.path, absolute);
    } catch (error) {
      await unlink(temporary.path).catch(ignore);
      throw error;
    }
    return { after: { identity: temporary.identity, sha256: sha256(bytes), bytes }, directory };
  }

  async #create(relativePath: string, bytes: Uint8Array, done: Completed[]): Promise<void> {
    const madeBefore = done.length;
    const { directory, absolute } = await this.#makeParents(relativePath, done);
    await checkNothingAt(relativePath, absolute);
    const temporary = await writeTemporary(relativePath, directory, bytes, undefined);
    try {
      await this.#beforeCommit?.({ kind: 'create', path: relativePath });
      await linkNewName(relativePath, temporary.path, absolute);
    } catch (error) {
      await unlink(temporary.path).catch(ignore);
      throw error;
    }
    const after: FileState = { identity: temporary.identity, sha256: sha256(bytes), bytes };
    done.push({ kind: 'create', path: relativePath });
    this.#files.set(relativePath, after);
    await unlink(temporary.path);
    await this.#syncChanged(directory, done.slice(madeBefore));
  }

  async #rename(from: string, to: string, done: Completed[]): Promise<void> {
    const state = this.#required(from);
    const source = await this.#checkFile(from, state);
    const madeBefore = done.length;
    const target = await this.#makeParents(to, done);
    await checkNothingAt(to, target.absolute);
    await this.#beforeCommit?.({ kind: 'rename', path: to });
    await linkNewName(to, source.absolute, target.absolute);
    try {
      // Whether link() follows a symlink at its source differs between systems, and the source
      // may have been swapped since the check: both names must lead to the checked file before
      // the old one goes.
      await expectFile(to, target.absolute, state.identity);
      await expectFile(from, source.absolute, state.identity);
      await unlink(source.absolute);
    } catch (error) {
      await unlink(target.absolute).catch(ignore);
      throw error;
    }
    done.push({ kind: 'rename', from, to });
    this.#files.set(from, null);
    this.#files.set(to, state);
    await syncDirectory(source.directory);
    await this.#syncChanged(target.directory, done.slice(madeBefore));
  }

  /** Flushes `directory` and the parent of every directory in `made`. */
  async #syncChanged(directory: string, made: readonly Completed[]): Promise<void> {
    for (const entry of made) {
      if (entry.kind === 'mkdir') await syncDirectory(path.dirname(this.#absolute(entry.path)));
    }
    await syncDirectory(directory);
  }

  /** Undoes `done` in reverse order. Returns the paths it could not restore. */
  async #undo(done: readonly Completed[]): Promise<string[]> {
    const unrestored: string[] = [];
    for (const entry of done.toReversed()) {
      try {
        await this.#undoStep(entry);
      } catch {
        unrestored.push(entry.kind === 'rename' ? entry.to : entry.path);
      }
    }
    return unrestored.sort(compareStrings);
  }

  async #undoStep(entry: Completed): Promise<void> {
    if (entry.kind === 'mkdir') {
      // Only an empty directory goes; one someone filled meanwhile stays, as does a symlink.
      await rmdir(this.#absolute(entry.path)).catch(ignore);
      return;
    }
    const at = entry.kind === 'rename' ? entry.to : entry.path;
    const current = this.#files.get(at);
    if (current === undefined || current === null) throw changed(at, 'it is gone');
    switch (entry.kind) {
      case 'replace': {
        const restored = await this.#replaceContents(at, current, entry.before, false);
        this.#files.set(at, restored.after);
        await syncDirectory(restored.directory).catch(ignore);
        return;
      }
      case 'create': {
        const { directory, absolute } = await this.#checkFile(at, current);
        await unlink(absolute);
        this.#files.set(at, null);
        await syncDirectory(directory).catch(ignore);
        return;
      }
      case 'rename': {
        const moved = await this.#checkFile(at, current);
        const original = await this.#parents(entry.from);
        await linkNewName(entry.from, moved.absolute, original.absolute);
        await unlink(moved.absolute);
        this.#files.set(at, null);
        this.#files.set(entry.from, current);
        await syncDirectory(moved.directory).catch(ignore);
        await syncDirectory(original.directory).catch(ignore);
        return;
      }
    }
  }

  #absolute(relativePath: string): string {
    return path.join(this.#root, ...relativePath.split('/'));
  }

  /**
   * Checks that every parent directory of `relativePath` exists and is a real directory, from
   * the root down. A missing one means the file is gone.
   */
  async #parents(relativePath: string): Promise<Placement> {
    const names = relativePath.split('/');
    names.pop();
    let directory = this.#root;
    let relative = '';
    for (const name of names) {
      relative = joinRelative(relative, name);
      directory = path.join(directory, name);
      const kind = await directoryKind(relativePath, directory);
      if (kind === 'missing') throw changed(relativePath, `its directory ${relative} is gone`);
      if (kind !== 'directory') throw refused(relativePath, notADirectory(relative, kind));
    }
    return { directory, absolute: this.#absolute(relativePath) };
  }

  /**
   * Like {@link #parents}, but creates missing directories, one at a time, and records them in
   * `done`. A directory that appears meanwhile is accepted only if it is a real directory.
   */
  async #makeParents(relativePath: string, done: Completed[]): Promise<Placement> {
    const names = relativePath.split('/');
    names.pop();
    let directory = this.#root;
    let relative = '';
    for (const name of names) {
      relative = joinRelative(relative, name);
      directory = path.join(directory, name);
      let kind = await directoryKind(relativePath, directory);
      if (kind === 'missing') {
        await this.#beforeCommit?.({ kind: 'mkdir', path: relative });
        try {
          await mkdir(directory);
          done.push({ kind: 'mkdir', path: relative });
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw writeFailed(relativePath, error);
        }
        // Ours or someone else's: either way it must be a real directory now.
        kind = await directoryKind(relativePath, directory);
      }
      if (kind !== 'directory') throw refused(relativePath, notADirectory(relative, kind));
    }
    return { directory, absolute: this.#absolute(relativePath) };
  }

  /** For a create or rename target: its parents are real directories or missing, and it is absent. */
  async #checkAbsent(relativePath: string): Promise<void> {
    const names = relativePath.split('/');
    names.pop();
    let directory = this.#root;
    let relative = '';
    for (const name of names) {
      relative = joinRelative(relative, name);
      directory = path.join(directory, name);
      const kind = await directoryKind(relativePath, directory);
      // Created when the step runs; nothing can be below it yet.
      if (kind === 'missing') return;
      if (kind !== 'directory') throw refused(relativePath, notADirectory(relative, kind));
    }
    await checkNothingAt(relativePath, this.#absolute(relativePath));
  }

  /**
   * Checks that `relativePath` is still `expected`: real parent directories, a regular file with
   * one link, the same device and inode, the same bytes. Returns its permission bits.
   */
  async #checkFile(
    relativePath: string,
    expected: FileState,
  ): Promise<Placement & { readonly mode: number }> {
    const placement = await this.#parents(relativePath);
    const mode = await verifyFile(relativePath, placement.absolute, expected);
    return { ...placement, mode };
  }
}

/** Every check and step throws a StepError (see #run and #checkDisk); anything else is a bug. */
function failureOf(error: unknown): FixWriteFailure {
  if (error instanceof StepError) return error.failure;
  throw error;
}

type DirectoryKind = 'directory' | 'missing' | 'symlink' | 'other';

async function directoryKind(relativePath: string, absolute: string): Promise<DirectoryKind> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return 'missing';
    throw writeFailed(relativePath, error);
  }
  if (stats.isSymbolicLink()) return 'symlink';
  return stats.isDirectory() ? 'directory' : 'other';
}

function notADirectory(relative: string, kind: DirectoryKind): string {
  return kind === 'symlink' ? `${relative} is a symbolic link` : `${relative} is not a directory`;
}

/** Refuses `absolute` when anything is there, a dangling symlink included. */
async function checkNothingAt(relativePath: string, absolute: string): Promise<void> {
  try {
    await lstat(absolute);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw writeFailed(relativePath, error);
  }
  throw refused(relativePath, 'it already exists');
}

/**
 * Opens the file without following a symlink and compares it with `expected`. Reads at most one
 * byte more than `expected` holds. Returns the permission bits (without setuid, setgid, sticky).
 */
async function verifyFile(
  relativePath: string,
  absolute: string,
  expected: FileState,
): Promise<number> {
  let stats: BigIntStats;
  try {
    stats = await lstat(absolute, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw changed(relativePath, 'it is gone');
    throw writeFailed(relativePath, error);
  }
  if (stats.isSymbolicLink()) throw refused(relativePath, 'it is a symbolic link');
  if (!stats.isFile()) throw refused(relativePath, 'it is not a regular file');
  let handle: FileHandle;
  try {
    handle = await open(absolute, SAFE_OPEN_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP') throw refused(relativePath, 'it is a symbolic link');
    if (code === 'ENOENT') throw changed(relativePath, 'it is gone');
    throw writeFailed(relativePath, error);
  }
  try {
    // The handle, not the path: what was opened is what is compared. Anything swapped in after
    // the lstat (a FIFO, a directory, another file) has another device or inode.
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(opened, expected.identity)) {
      throw changed(relativePath, 'another file replaced it since the scan');
    }
    if (opened.nlink > 1n) throw refused(relativePath, 'it has other hard links');
    const size = expected.bytes.length;
    if (
      opened.size !== BigInt(size) ||
      sha256(await readAtMost(handle, size + 1)) !== expected.sha256
    ) {
      throw changed(relativePath, 'its content changed since the scan');
    }
    return Number(opened.mode & 0o777n);
  } finally {
    await handle.close().catch(ignore);
  }
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

/** After a link(): `absolute` must be a regular file with `identity`. */
async function expectFile(
  relativePath: string,
  absolute: string,
  identity: FileIdentity,
): Promise<void> {
  const stats = await lstat(absolute, { bigint: true });
  if (!stats.isFile() || !sameFile(stats, identity)) {
    throw changed(relativePath, 'another file replaced it during the change');
  }
}

/**
 * Writes `bytes` to a new temporary file in `directory` and flushes it. `mode` sets its
 * permission bits exactly (a replaced file's); without it the umask applies, as for any new file.
 */
async function writeTemporary(
  relativePath: string,
  directory: string,
  bytes: Uint8Array,
  mode: number | undefined,
): Promise<{ readonly path: string; readonly identity: FileIdentity }> {
  // A short fixed-length name: the target's own name could push it past NAME_MAX.
  const temporary = path.join(directory, `.agentcheckup-${randomBytes(8).toString('hex')}.tmp`);
  let handle: FileHandle;
  try {
    handle = await open(temporary, CREATE_FLAGS, mode === undefined ? NEW_FILE_MODE : 0o600);
  } catch (error) {
    throw writeFailed(relativePath, error);
  }
  try {
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(bytes);
    // On disk before a rename or link makes it visible: a crash must not leave a partial file.
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    await handle.close();
    return { path: temporary, identity: { dev: stats.dev, ino: stats.ino } };
  } catch (error) {
    // Closed first: Windows cannot unlink an open file.
    await handle.close().catch(ignore);
    await unlink(temporary).catch(ignore);
    throw writeFailed(relativePath, error);
  }
}

/** Gives the file at `existing` the new name `target`, which must not exist. */
async function linkNewName(relativePath: string, existing: string, target: string): Promise<void> {
  try {
    await link(existing, target);
  } catch (error) {
    const code = errorCode(error) ?? '';
    if (code === 'EEXIST') throw refused(relativePath, 'it already exists');
    if (LINK_UNSUPPORTED.has(code)) {
      throw refused(relativePath, `the file system does not allow a hard link here (${code})`);
    }
    throw writeFailed(relativePath, error);
  }
}

/** Flushes a directory's entries, where the platform can sync a directory (as output.ts does). */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(directory, DIRECTORY_FLAGS);
  } catch (error) {
    if (NO_DIRECTORY_SYNC.has(errorCode(error) ?? '')) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!NO_DIRECTORY_SYNC.has(errorCode(error) ?? '')) throw error;
  } finally {
    await handle.close().catch(ignore);
  }
}
