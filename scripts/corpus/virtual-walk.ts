/**
 * Replays src/io/walk.ts over a git tree listing instead of a checkout, so the corpus can be
 * scanned without cloning (and without running git in third-party repositories).
 *
 * It mirrors the walker's observable behavior: breadth-first in code-point order, hard-excluded
 * directories listed but never entered (and marked opaque), the depth, entry, per-file and total
 * byte limits, and symlinks resolved like src/io/resolve.ts (component by component, `..` applied
 * physically, never leaving the root, 40 hops at most, loop guard on the current walk path).
 * Files reached through a symlink get `symlinkTarget`, the real file's path.
 *
 * The walker's own policies come from src/io/filters.ts and src/io/submodules.ts, so the two stay
 * in step. Submodules declared in the root `.gitmodules` get the walker's treatment; a gitlink
 * (tree entry of type `commit`) is never checked out from a tree, so it is always opaque.
 *
 * Deliberate differences, documented in corpus/README.md:
 * - `.gitignore` is not applied (`ignoredFiles` stays empty): every listed file is committed.
 * - Absolute symlink targets are outside the root: the checkout location is not known.
 * - Binary sniffing and reading `.gitmodules` need bytes and happen in snapshot.ts.
 */
import { compareStrings } from '../../src/core/compare.js';
import type { SkippedEntry, UnresolvedSymlink } from '../../src/core/types.js';
import { sanitizeLinkText } from '../../src/io/paths.js';
import { defaultIsCandidate, isHardExcludedDirectory } from '../../src/io/filters.js';
import { MAX_SYMLINK_HOPS } from '../../src/io/resolve.js';
import { isOpaqueSubmodule } from '../../src/io/submodules.js';
import { DEFAULT_WALK_LIMITS } from '../../src/io/walk.js';
import type { CachedTree } from './common.js';

type NodeKind = 'file' | 'directory' | 'symlink' | 'submodule';

interface Node {
  readonly kind: NodeKind;
  readonly sha: string;
  readonly size: number;
}

/** A candidate config file the walker would read. */
export interface Candidate {
  /** Path as agents reach it (possibly through symlinks). */
  readonly path: string;
  /** Path of the real file in the tree. Equals `path` unless a symlink was crossed. */
  readonly realPath: string;
  /** Git blob id of the real file. */
  readonly sha: string;
  readonly size: number;
}

export interface WalkPlan {
  readonly paths: readonly string[];
  readonly opaqueDirectories: readonly string[];
  readonly unresolvedSymlinks: readonly UnresolvedSymlink[];
  readonly skipped: readonly SkippedEntry[];
  /** Sorted by path. */
  readonly candidates: readonly Candidate[];
  /** Real paths of symlinks whose link text is needed but was not provided. */
  readonly missingLinkTexts: readonly string[];
  /** Every symlink the walk looked at, by real path (for statistics). */
  readonly symlinksSeen: number;
}

export interface WalkLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
}

export interface VirtualWalkOptions {
  /** Paths declared in the root `.gitmodules` (see src/io/submodules.ts parseGitmodules). */
  readonly submodules?: ReadonlySet<string>;
  readonly limits?: WalkLimits;
}

interface Frame {
  readonly relativePath: string;
  readonly realPath: string;
  readonly depth: number;
  readonly parent: Frame | undefined;
}

type Resolution =
  | { readonly kind: 'inside'; readonly realPath: string; readonly node: Node | undefined }
  | { readonly kind: 'outside' }
  | { readonly kind: 'broken' }
  | { readonly kind: 'unknown' };

const OUTSIDE = { kind: 'outside' } as const;
const BROKEN = { kind: 'broken' } as const;
const UNKNOWN = { kind: 'unknown' } as const;

const join = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`);

function nodeKind(mode: string, type: string): NodeKind | undefined {
  if (type === 'tree') return 'directory';
  if (type === 'commit') return 'submodule';
  if (type !== 'blob') return undefined;
  return mode === '120000' ? 'symlink' : 'file';
}

export class VirtualTree {
  readonly #nodes = new Map<string, Node>();
  readonly #children = new Map<string, string[]>();
  readonly #unlisted: ReadonlySet<string>;
  readonly #truncated: boolean;

  constructor(tree: CachedTree) {
    this.#unlisted = new Set(tree.unlistedDirectories);
    this.#truncated = tree.truncated;
    this.#children.set('', []);
    for (const entry of tree.entries) {
      const kind = nodeKind(entry.mode, entry.type);
      if (kind === undefined || this.#nodes.has(entry.path)) continue;
      this.#addParents(entry.path);
      this.#nodes.set(entry.path, { kind, sha: entry.sha, size: entry.size ?? 0 });
      if (kind === 'directory' && !this.#children.has(entry.path)) {
        this.#children.set(entry.path, []);
      }
      const slash = entry.path.lastIndexOf('/');
      this.#children
        .get(slash === -1 ? '' : entry.path.slice(0, slash))
        ?.push(entry.path.slice(slash + 1));
    }
    for (const names of this.#children.values()) names.sort(compareStrings);
  }

  /** Listings are complete, but be robust to a directory missing its own entry. */
  #addParents(path: string): void {
    let index = path.indexOf('/');
    while (index !== -1) {
      const directory = path.slice(0, index);
      if (!this.#nodes.has(directory)) {
        this.#nodes.set(directory, { kind: 'directory', sha: '', size: 0 });
        const slash = directory.lastIndexOf('/');
        this.#children
          .get(slash === -1 ? '' : directory.slice(0, slash))
          ?.push(directory.slice(slash + 1));
        this.#children.set(directory, []);
      }
      index = path.indexOf('/', index + 1);
    }
  }

  node(path: string): Node | undefined {
    return this.#nodes.get(path);
  }

  /**
   * The root `.gitmodules` the walker would read: a regular file only, since the walker does not
   * follow a symlinked control file.
   */
  gitmodules(): Node | undefined {
    const node = this.#nodes.get('.gitmodules');
    return node?.kind === 'file' ? node : undefined;
  }

  /** True when nothing is known about `path` because a parent's contents were never listed. */
  #isUnknown(path: string): boolean {
    if (this.#truncated) return true;
    let index = path.indexOf('/');
    while (index !== -1) {
      const directory = path.slice(0, index);
      if (this.#unlisted.has(directory) || this.#nodes.get(directory)?.kind === 'submodule') {
        return true;
      }
      index = path.indexOf('/', index + 1);
    }
    return false;
  }

  #contentsKnown(realPath: string): boolean {
    if (realPath === '') return true;
    return this.#nodes.get(realPath)?.kind === 'directory' && !this.#unlisted.has(realPath);
  }

  /**
   * Resolves link text found in directory `linkDirectory` (a real path), like
   * src/io/resolve.ts: each component is looked up from inside the root, `..` is applied to the
   * physical path walked so far, and the resolution stops when it would leave the root.
   */
  #resolve(
    linkDirectory: string,
    text: string,
    links: ReadonlyMap<string, string>,
    missing: Set<string>,
  ): Resolution {
    if (text === '') return BROKEN;
    if (text.startsWith('/')) return OUTSIDE;
    const current = linkDirectory === '' ? [] : linkDirectory.split('/');
    const pending = text.split('/').reverse();
    let hops = 1;
    for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (current.length === 0) return OUTSIDE;
        current.pop();
        continue;
      }
      const next = join(current.join('/'), part);
      const node = this.#nodes.get(next);
      if (node === undefined) return this.#isUnknown(next) ? UNKNOWN : BROKEN;
      if (node.kind === 'symlink') {
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) return BROKEN;
        const nested = links.get(next);
        if (nested === undefined) {
          missing.add(next);
          return UNKNOWN;
        }
        if (nested === '') return BROKEN;
        if (nested.startsWith('/')) return OUTSIDE;
        pending.push(...nested.split('/').reverse());
        continue;
      }
      // Only a directory can be followed by more components, a trailing slash included.
      if (pending.length > 0 && node.kind !== 'directory') {
        return node.kind === 'submodule' ? UNKNOWN : BROKEN;
      }
      current.push(part);
    }
    const realPath = current.join('/');
    return {
      kind: 'inside',
      realPath,
      node: realPath === '' ? undefined : this.#nodes.get(realPath),
    };
  }

  /** Walks the tree as src/io/walk.ts would walk a checkout of it. */
  walk(links: ReadonlyMap<string, string>, options: VirtualWalkOptions = {}): WalkPlan {
    const limits = options.limits ?? DEFAULT_WALK_LIMITS;
    const submodules = options.submodules ?? new Set<string>();
    const paths = new Set<string>();
    const opaque = new Set<string>();
    const unresolved: UnresolvedSymlink[] = [];
    const skipped: SkippedEntry[] = [];
    const candidates: Candidate[] = [];
    const missing = new Set<string>();
    const queue: Frame[] = [{ relativePath: '', realPath: '', depth: 0, parent: undefined }];
    let entriesSeen = 0;
    let bytesRead = 0;
    let symlinksSeen = 0;

    const markOpaque = (relativePath: string): void => {
      opaque.add(`${relativePath}/`);
    };

    const isOnWalkPath = (frame: Frame, realPath: string): boolean => {
      for (let current: Frame | undefined = frame; current; current = current.parent) {
        if (current.realPath === realPath) return true;
      }
      return false;
    };

    /** The walker's #isOpaque: an opaque directory or anything inside one. */
    const isOpaque = (relativePath: string): boolean => {
      for (
        let end = relativePath.indexOf('/');
        end !== -1;
        end = relativePath.indexOf('/', end + 1)
      ) {
        if (opaque.has(relativePath.slice(0, end + 1))) return true;
      }
      return opaque.has(`${relativePath}/`);
    };

    const enterDirectory = (parent: Frame, relativePath: string, realPath: string): void => {
      paths.add(`${relativePath}/`);
      if (isHardExcludedDirectory(relativePath) || isOnWalkPath(parent, realPath)) {
        markOpaque(relativePath);
        return;
      }
      const depth = parent.depth + 1;
      if (depth > limits.maxDepth) {
        skipped.push({ path: `${relativePath}/`, reason: 'depth-limit' });
        markOpaque(relativePath);
        return;
      }
      if (!this.#contentsKnown(realPath)) {
        markOpaque(relativePath);
        return;
      }
      queue.push({ relativePath, realPath, depth, parent });
    };

    const readCandidate = (relativePath: string, realPath: string, node: Node): void => {
      if (node.size > limits.maxFileBytes) {
        skipped.push({ path: relativePath, reason: 'too-large', size: node.size });
        return;
      }
      if (node.size > limits.maxTotalBytes - bytesRead) {
        skipped.push({ path: relativePath, reason: 'byte-limit', size: node.size });
        return;
      }
      bytesRead += node.size;
      candidates.push({ path: relativePath, realPath, sha: node.sha, size: node.size });
    };

    const unresolvedLink = (
      relativePath: string,
      text: string,
      problem: 'outside-root' | 'broken',
    ): void => {
      paths.add(relativePath);
      markOpaque(relativePath);
      unresolved.push({ path: relativePath, target: sanitizeLinkText(text), problem });
    };

    const visitSymlink = (frame: Frame, relativePath: string, realPath: string): void => {
      symlinksSeen += 1;
      const text = links.get(realPath);
      if (text === undefined) {
        missing.add(realPath);
        paths.add(relativePath);
        markOpaque(relativePath);
        return;
      }
      const resolution = this.#resolve(frame.realPath, text, links, missing);
      switch (resolution.kind) {
        case 'outside':
          unresolvedLink(relativePath, text, 'outside-root');
          return;
        case 'broken':
          unresolvedLink(relativePath, text, 'broken');
          return;
        case 'unknown':
          paths.add(relativePath);
          markOpaque(relativePath);
          return;
        case 'inside': {
          const { node } = resolution;
          if (node === undefined || node.kind === 'directory' || node.kind === 'submodule') {
            enterDirectory(frame, relativePath, resolution.realPath);
            return;
          }
          paths.add(relativePath);
          if (defaultIsCandidate(relativePath))
            readCandidate(relativePath, resolution.realPath, node);
          return;
        }
      }
    };

    let listed = 0;
    for (const frame of queue) {
      listed += 1;
      let stopped = false;
      const names = this.#children.get(frame.realPath) ?? [];
      // Same check as the walker's #listDirectory. A tree directory is never empty and cannot hold
      // a `.git` entry (git refuses to record one), so declared paths are listed here; gitlinks
      // never reach this point (they are opaque in enterDirectory).
      if (submodules.has(frame.relativePath) && isOpaqueSubmodule(frame.relativePath, names)) {
        markOpaque(frame.relativePath);
        continue;
      }
      for (const name of names) {
        const relativePath = join(frame.relativePath, name);
        const realPath = join(frame.realPath, name);
        const node = this.#nodes.get(realPath);
        if (node === undefined) continue;
        if (entriesSeen >= limits.maxEntries) {
          const isDirectory = node.kind === 'directory' || node.kind === 'submodule';
          skipped.push({
            path: isDirectory ? `${relativePath}/` : relativePath,
            reason: 'file-limit',
          });
          stopped = true;
          break;
        }
        entriesSeen += 1;
        switch (node.kind) {
          case 'directory':
          case 'submodule':
            enterDirectory(frame, relativePath, realPath);
            break;
          case 'file':
            paths.add(relativePath);
            if (defaultIsCandidate(relativePath)) readCandidate(relativePath, realPath, node);
            break;
          case 'symlink':
            visitSymlink(frame, relativePath, realPath);
            break;
        }
      }
      if (stopped) {
        if (frame.parent !== undefined) markOpaque(frame.relativePath);
        for (const pending of queue.slice(listed)) markOpaque(pending.relativePath);
        break;
      }
    }

    // The walker's #markUnlistedSubmodules: declared submodules that were never listed (absent
    // from the tree, or not reached) have unknown contents rather than missing ones.
    for (const submodule of [...submodules].sort(compareStrings)) {
      if (paths.has(`${submodule}/`) || paths.has(submodule) || isOpaque(submodule)) continue;
      markOpaque(submodule);
    }

    if (this.#truncated && !skipped.some((entry) => entry.reason === 'file-limit')) {
      // GitHub could not list everything: like a walk cut short by the entry limit, absence of a
      // path proves nothing.
      skipped.push({ path: '', reason: 'file-limit' });
    }

    const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
      compareStrings(a.path, b.path);
    return {
      paths: [...paths].sort(compareStrings),
      opaqueDirectories: [...opaque].sort(compareStrings),
      unresolvedSymlinks: unresolved.sort(byPath),
      skipped: skipped.sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason),
      ),
      candidates: candidates.sort(byPath),
      missingLinkTexts: [...missing].sort(compareStrings),
      symlinksSeen,
    };
  }
}
