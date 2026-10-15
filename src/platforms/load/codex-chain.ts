/**
 * The AGENTS.md chain Codex reads for one working directory, mirrored from
 * codex-rs/core/src/agents_md.rs and the Codex AGENTS.md documentation:
 *
 * - Codex walks from the project root (the nearest directory with a `.git` entry) down to the
 *   working directory and reads one file per directory: `AGENTS.override.md` when it exists as a
 *   file, even an empty one, otherwise `AGENTS.md`. Without a root marker it reads only the
 *   working directory's file.
 * - A file whose content is only whitespace is skipped and uses no budget.
 * - It reads at most `project_doc_max_bytes` across the chain: the file that crosses the limit is
 *   cut at that byte, and later files are dropped. When the kept bytes of the crossing file are
 *   only whitespace, Codex skips that file too and the budget carries over to the next one.
 *
 * Only files agentcheckup read can be measured. When a candidate exists but was not read, or might
 * exist, the choice in that directory is unknown and the chain stops before it.
 */
import { pathStatus } from '../../core/paths.js';
import type { Artifact } from '../../core/types.js';
import { joinPath, nearestGitRoot, selfAndAncestors } from '../paths.js';
import { codexSeesBlank } from './codex-text.js';
import type { LoadView } from './view.js';

/** The files Codex looks for in each directory, in order of preference. */
export const CODEX_FILE_NAMES: readonly string[] = ['AGENTS.override.md', 'AGENTS.md'];

/** Codex's default `project_doc_max_bytes`. */
export const CODEX_DEFAULT_MAX_BYTES = 32_768;

export interface CodexChainOptions {
  /** Codex's `project_doc_max_bytes`: a positive integer. */
  readonly maxBytes: number;
}

interface ChainFileBase {
  /** The directory Codex chose this file in. */
  readonly directory: string;
  /** The path Codex opens; may be a symlink alias of `artifact.path`. */
  readonly path: string;
  readonly artifact: Artifact;
  /** Size of the file in bytes. */
  readonly size: number;
  /** Bytes of the files before this one that Codex read in full. */
  readonly offset: number;
}

/**
 * - `read`: read in full.
 * - `blank`: only whitespace; Codex skips it and it uses no budget.
 * - `dropped`: the budget was used up before this file.
 */
export interface CodexWholeFile extends ChainFileBase {
  readonly status: 'read' | 'blank' | 'dropped';
}

/**
 * The budget runs out inside this file and Codex reads only its first `cutAt` bytes.
 * - `cut`: the chain ends here; later files are dropped.
 * - `cut-blank`: those bytes are only whitespace, so Codex skips the file and the budget carries
 *   over to the next one.
 */
export interface CodexCutFile extends ChainFileBase {
  readonly status: 'cut' | 'cut-blank';
  /** The byte where Codex stops reading this file: the budget left after `offset`. */
  readonly cutAt: number;
}

export type CodexChainFile = CodexWholeFile | CodexCutFile;

export interface CodexChain {
  /**
   * Where the chain starts: the nearest directory at or above the start directory that has a
   * `.git` entry, else the start directory itself.
   */
  readonly root: string;
  /** False when no directory at or above the start has a `.git` entry. */
  readonly rootMarker: boolean;
  readonly maxBytes: number;
  /** The file Codex chose in each directory that has one, root first. */
  readonly files: readonly CodexChainFile[];
  /** Budget bytes Codex used: files read in full, plus the kept part of the `cut` file. */
  readonly used: number;
  /** Bytes of every file on the chain that is not blank, as if there were no limit. */
  readonly total: number;
  /** The file where the budget runs out and the chain ends, if any. */
  readonly cut?: CodexCutFile & { readonly status: 'cut' };
  /** Files after `cut` that Codex never reads, in chain order. */
  readonly dropped: readonly CodexWholeFile[];
  /**
   * A directory whose file agentcheckup cannot tell (a candidate exists but was not read, or might
   * exist). The chain stops before it, so later directories are not on `files`.
   */
  readonly unknownAt?: string;
}

type Selection =
  | { readonly kind: 'file'; readonly path: string; readonly artifact: Artifact }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

/**
 * The file Codex reads in `directory`: the first of AGENTS.override.md and AGENTS.md that exists
 * as a file, even when it is empty. A candidate that exists but was not read (gitignored, too
 * large) or might exist makes the choice unknown.
 */
function selectFile(view: Pick<LoadView, 'snapshot' | 'index'>, directory: string): Selection {
  for (const name of CODEX_FILE_NAMES) {
    const path = joinPath(directory, name);
    const artifact = view.index.get(path);
    if (artifact !== undefined) return { kind: 'file', path, artifact };
    if (pathStatus(view.snapshot, path) !== 'missing') return { kind: 'unknown' };
  }
  return { kind: 'none' };
}

/** Directories from `root` down to `directory`, inclusive. */
function chainDirectories(root: string, directory: string): string[] {
  const upward = selfAndAncestors(directory);
  const end = upward.indexOf(root);
  return upward.slice(0, end === -1 ? upward.length : end + 1).reverse();
}

const blankFiles = new WeakMap<Artifact, boolean>();

/** `codexSeesBlank` of the whole file, computed once per artifact. */
function isBlankFile(artifact: Artifact): boolean {
  let blank = blankFiles.get(artifact);
  if (blank === undefined) {
    blank = codexSeesBlank(artifact.file.bytes);
    blankFiles.set(artifact, blank);
  }
  return blank;
}

/** The chain Codex reads when it starts in `startDir` (root-relative, '' for the scan root). */
export function codexChain(
  view: Pick<LoadView, 'snapshot' | 'index'>,
  startDir: string,
  options: CodexChainOptions,
): CodexChain {
  const { maxBytes } = options;
  const marker = nearestGitRoot(view.snapshot, startDir);
  // Without a project root marker Codex reads only the working directory's file.
  const root = marker ?? startDir;
  const files: CodexChainFile[] = [];
  const dropped: CodexWholeFile[] = [];
  let cut: (CodexCutFile & { readonly status: 'cut' }) | undefined;
  let unknownAt: string | undefined;
  let remaining = maxBytes;
  let offset = 0;
  let total = 0;
  // True from a cut until the next file read in full: a used-up budget then drops later files.
  let afterCut = false;

  for (const directory of chainDirectories(root, startDir)) {
    const selection = selectFile(view, directory);
    if (selection.kind === 'unknown') {
      unknownAt = directory;
      break;
    }
    if (selection.kind === 'none') continue;
    const { path, artifact } = selection;
    const base = { directory, path, artifact, size: artifact.file.bytes.length, offset };
    if (isBlankFile(artifact)) {
      files.push({ ...base, status: 'blank' });
      continue;
    }
    total += base.size;

    if (remaining === 0 && afterCut) {
      const file = { ...base, status: 'dropped' } as const;
      files.push(file);
      dropped.push(file);
      continue;
    }
    if (base.size > remaining) {
      // Codex keeps the first `remaining` bytes. When those are only whitespace it skips the file
      // and the budget carries over to the next one.
      const keptBlank =
        remaining !== 0 && codexSeesBlank(artifact.file.bytes.subarray(0, remaining));
      if (keptBlank) {
        files.push({ ...base, status: 'cut-blank', cutAt: remaining });
      } else {
        cut = { ...base, status: 'cut', cutAt: remaining };
        files.push(cut);
        remaining = 0;
      }
      afterCut = true;
      continue;
    }

    files.push({ ...base, status: 'read' });
    remaining -= base.size;
    offset += base.size;
    afterCut = false;
  }

  return {
    root,
    rootMarker: marker !== undefined,
    maxBytes,
    files,
    used: maxBytes - remaining,
    total,
    ...(cut === undefined ? {} : { cut }),
    dropped,
    ...(unknownAt === undefined ? {} : { unknownAt }),
  };
}
