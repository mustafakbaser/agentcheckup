/**
 * Builds the `Snapshot` agentcheckup's walker would produce for a corpus repository, from the cache
 * written by fetch.ts: the walk is replayed over the git tree (virtual-walk.ts) and file bytes
 * come from the cache, verified against their git object ids. The walker's import pass is
 * replayed too (replayImports), with the same planner and caps.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareStrings } from '../../src/core/compare.js';
import type { SkippedEntry, SkipReason, Snapshot, SourceFile } from '../../src/core/types.js';
import { looksBinary } from '../../src/io/filters.js';
import { ImportPlanner, MAX_IMPORTED_BYTES, MAX_IMPORTED_FILES } from '../../src/io/imports.js';
import { DEFAULT_WALK_LIMITS } from '../../src/io/walk.js';
import { MAX_GITMODULES_BYTES, parseGitmodules } from '../../src/io/submodules.js';
import {
  type CachedFiles,
  type CachedLinks,
  type CachedTree,
  cacheDirFor,
  FILES_FILE,
  gitBlobSha,
  insideCacheDir,
  LINKS_FILE,
  readJsonIfExists,
  type RepoEntry,
  TREE_FILE,
} from './common.js';
import { type Candidate, type PathResolution, VirtualTree } from './virtual-walk.js';

export interface Loaded {
  readonly snapshot: Snapshot;
  readonly truncated: boolean;
  /**
   * Import targets the walker would read but whose bytes are not in the cache (fetch.ts adds
   * them). The snapshot leaves them unread, so it may differ from a real walk until they are.
   */
  readonly importsNotFetched: readonly Candidate[];
}

const utf8 = new TextDecoder('utf-8');

/** The snapshot, or why it cannot be built yet (the cache is incomplete). */
export async function loadSnapshot(
  entry: RepoEntry,
): Promise<Loaded | { readonly problem: string }> {
  const directory = cacheDirFor(entry);
  const tree = await readJsonIfExists<CachedTree>(path.join(directory, TREE_FILE));
  if (tree?.sha !== entry.sha || tree.repo !== entry.repo) return { problem: 'tree not fetched' };
  const links = new Map(
    Object.entries((await readJsonIfExists<CachedLinks>(path.join(directory, LINKS_FILE))) ?? {}),
  );
  const files = new Map(
    Object.entries((await readJsonIfExists<CachedFiles>(path.join(directory, FILES_FILE))) ?? {}),
  );

  /** Verified cached bytes of the blob at `realPath`, or undefined when not fetched. */
  const cached = async (realPath: string, sha: string): Promise<Uint8Array | undefined> => {
    const stored = files.get(realPath);
    const location = stored?.sha === sha ? insideCacheDir(directory, stored.file) : undefined;
    const data =
      location === undefined ? undefined : await readFile(location).catch(() => undefined);
    if (data === undefined || gitBlobSha(data) !== sha) return undefined;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };

  const virtualTree = new VirtualTree(tree);
  const skipped: SkippedEntry[] = [];

  // The root .gitmodules, applied as the walker's #loadGitmodules does: a regular file only, and
  // one that is too large is reported and not applied.
  let submodules = new Set<string>();
  const gitmodules = virtualTree.gitmodules();
  if (gitmodules !== undefined) {
    if (gitmodules.size > MAX_GITMODULES_BYTES) {
      skipped.push({ path: '.gitmodules', reason: 'too-large', size: gitmodules.size });
    } else {
      const bytes = await cached('.gitmodules', gitmodules.sha);
      if (bytes === undefined) return { problem: '.gitmodules not fetched' };
      submodules = new Set(parseGitmodules(utf8.decode(bytes)));
    }
  }

  const plan = virtualTree.walk(links, { submodules });
  if (plan.missingLinkTexts.length > 0) {
    return { problem: `${String(plan.missingLinkTexts.length)} symlink targets not fetched` };
  }
  skipped.push(...plan.skipped);

  const bytesByRealPath = new Map<string, Uint8Array>();
  const sourceFiles: SourceFile[] = [];
  let absent = 0;
  for (const candidate of plan.candidates) {
    let bytes = bytesByRealPath.get(candidate.realPath);
    if (bytes === undefined) {
      bytes = await cached(candidate.realPath, candidate.sha);
      if (bytes === undefined) {
        absent += 1;
        continue;
      }
      bytesByRealPath.set(candidate.realPath, bytes);
    }
    if (looksBinary(bytes)) {
      skipped.push({ path: candidate.path, reason: 'binary', size: bytes.length });
      continue;
    }
    sourceFiles.push(
      candidate.path === candidate.realPath
        ? { path: candidate.path, bytes }
        : { path: candidate.path, bytes, symlinkTarget: candidate.realPath },
    );
  }
  if (absent > 0) return { problem: `${String(absent)} files not fetched` };

  const walked: Snapshot = {
    files: sourceFiles,
    // The pinned tree is a git checkout: a real clone has a `.git` directory at its root,
    // which rules use as the project-root marker (e.g. Codex's AGENTS.md chain).
    paths: new Set([...plan.paths, '.git/']),
    opaqueDirectories: new Set(plan.opaqueDirectories),
    // Every path in a git tree at a pinned commit is committed, which is what rules that
    // check "not gitignored" (settings/local-file-not-ignored) want to know.
    ignoredFiles: new Set(),
    gitignoreApplied: true,
    unresolvedSymlinks: plan.unresolvedSymlinks,
    skipped,
  };
  const imports = await replayImports(walked, {
    resolve: (relativePath) => virtualTree.resolvePath(relativePath, links),
    cached,
    contents: bytesByRealPath,
    bytesRead: plan.bytesRead,
  });
  return {
    snapshot: {
      ...walked,
      files: [...sourceFiles, ...imports.files].sort((a, b) => compareStrings(a.path, b.path)),
      skipped: [...skipped, ...imports.skipped].sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason),
      ),
    },
    truncated: tree.truncated,
    importsNotFetched: imports.notFetched,
  };
}

interface ImportSources {
  readonly resolve: (relativePath: string) => PathResolution;
  readonly cached: (realPath: string, sha: string) => Promise<Uint8Array | undefined>;
  /** Bytes of every real file read so far, by real path; the replay adds to it. */
  readonly contents: Map<string, Uint8Array>;
  readonly bytesRead: number;
}

interface ImportReplay {
  readonly files: SourceFile[];
  readonly skipped: SkippedEntry[];
  readonly notFetched: Candidate[];
}

/**
 * The walker's import pass (Walker.readImports in src/io/walk.ts) over the cache: the same
 * planner, order, caps and skip reasons, with cached bytes instead of reads. A target whose bytes
 * are not cached is left unread and listed in `notFetched`.
 */
async function replayImports(walked: Snapshot, sources: ImportSources): Promise<ImportReplay> {
  const files: SourceFile[] = [];
  const skipped: SkippedEntry[] = [];
  const notFetched: Candidate[] = [];
  const { maxFileBytes, maxTotalBytes } = DEFAULT_WALK_LIMITS;
  let count = 0;
  let importedBytes = 0;
  let bytesRead = sources.bytesRead;
  const skip = (path: string, reason: SkipReason, size?: number): void => {
    skipped.push(size === undefined ? { path, reason } : { path, reason, size });
  };
  const add = (path: string, realPath: string, bytes: Uint8Array): SourceFile | undefined => {
    if (looksBinary(bytes)) {
      skip(path, 'binary', bytes.length);
      return undefined;
    }
    const file: SourceFile =
      path === realPath
        ? { path, bytes, imported: true }
        : { path, bytes, symlinkTarget: realPath, imported: true };
    files.push(file);
    return file;
  };
  const tooBig = (size: number): SkipReason | undefined => {
    if (size > maxFileBytes) return 'too-large';
    if (size > MAX_IMPORTED_BYTES - importedBytes) return 'import-limit';
    if (size > maxTotalBytes - bytesRead) return 'byte-limit';
    return undefined;
  };

  const read = async (path: string): Promise<SourceFile | undefined> => {
    if (count >= MAX_IMPORTED_FILES) {
      skip(path, 'import-limit');
      return undefined;
    }
    const target = sources.resolve(path);
    if (target.kind !== 'file') {
      skip(path, 'unreadable');
      return undefined;
    }
    const known = sources.contents.get(target.realPath);
    if (known !== undefined) {
      count += 1;
      return add(path, target.realPath, known);
    }
    const reason = tooBig(target.size);
    if (reason !== undefined) {
      skip(path, reason, target.size);
      return undefined;
    }
    const bytes = await sources.cached(target.realPath, target.sha);
    if (bytes === undefined) {
      notFetched.push({ path, realPath: target.realPath, sha: target.sha, size: target.size });
      return undefined;
    }
    count += 1;
    importedBytes += bytes.length;
    bytesRead += bytes.length;
    sources.contents.set(target.realPath, bytes);
    return add(path, target.realPath, bytes);
  };

  const planner = new ImportPlanner(walked);
  for (let targets = planner.next(); targets.length > 0; targets = planner.next()) {
    for (const target of targets) planner.done(target, await read(target));
  }
  return { files, skipped, notFetched };
}
