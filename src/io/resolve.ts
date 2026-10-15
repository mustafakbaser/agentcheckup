import type { Stats } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import { relativeInsideRoot, splitComponents, stripRootPrefix } from './paths.js';

export interface ScanRoots {
  /** realpath of the scan root. Every path src/io touches is this or below it. */
  readonly real: string;
  /**
   * The root as the user gave it, made absolute but not resolved. Absolute symlinks into the tree
   * often use this spelling (`/tmp/x` while the real path is `/private/tmp/x` on macOS).
   */
  readonly given: string;
  /** Further spellings of the real root, such as `/var/...` for `/private/var/...` on macOS. */
  readonly aliases?: readonly string[];
}

export type SymlinkResolution =
  | {
      readonly kind: 'inside';
      /** Absolute, symlink-free path below the real root. */
      readonly realPath: string;
      /** POSIX, relative to the root; `''` for the root itself. */
      readonly relativePath: string;
      /** lstat of `realPath` (never a symlink). */
      readonly stats: Stats;
    }
  | { readonly kind: 'outside' }
  | { readonly kind: 'broken' };

/** Linux's MAXSYMLINKS. Longer chains are reported as broken, as the kernel reports ELOOP. */
export const MAX_SYMLINK_HOPS = 40;

const OUTSIDE = { kind: 'outside' } as const;
const BROKEN = { kind: 'broken' } as const;

type StartingPoint =
  { readonly base: string; readonly parts: string[] } | typeof OUTSIDE | typeof BROKEN;

/**
 * Resolves a symlink found in `linkDirectory` (an absolute, symlink-free directory inside the
 * root) whose text is `linkText`, without ever touching a path outside the root.
 *
 * This is a small realpath() that stops at the root boundary. fs.realpath would follow the link
 * wherever it points before we could check the result, so a hostile repository could make the scan
 * stat arbitrary paths: `/net/host/...` triggers an automount, `\\host\share\...` makes Windows
 * connect over SMB (leaking NTLM hashes), and even a failed lookup would tell the report whether a
 * path exists on the scanning machine. Instead each component is lstat-ed from inside the root,
 * `..` is applied to the physical path walked so far, and the walk stops as soon as it would
 * leave the root. A path that leaves and re-enters the root (`../repo/x`) is reported as outside.
 */
export async function resolveSymlink(
  roots: ScanRoots,
  linkDirectory: string,
  linkText: string,
): Promise<SymlinkResolution> {
  const start = startingPoint(roots, linkDirectory, linkText);
  if (!('base' in start)) return start;
  let current = start.base;
  // Remaining components with the next one last, so a nested link's text can be pushed on top.
  const pending = start.parts.reverse();
  let hops = 1;
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (current === roots.real) return OUTSIDE;
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let stats: Stats;
    try {
      stats = await lstat(next);
    } catch {
      return BROKEN;
    }
    if (stats.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return BROKEN;
      const nested = startingPoint(roots, current, await readlink(next).catch(() => ''));
      if (!('base' in nested)) return nested;
      current = nested.base;
      pending.push(...nested.parts.reverse());
      continue;
    }
    // Only a directory can be followed by more components, a trailing slash included (ENOTDIR).
    if (pending.length > 0 && !stats.isDirectory()) return BROKEN;
    current = next;
  }
  const relativePath = relativeInsideRoot(roots.real, current);
  if (relativePath === undefined) return OUTSIDE;
  try {
    return { kind: 'inside', realPath: current, relativePath, stats: await lstat(current) };
  } catch {
    return BROKEN;
  }
}

function startingPoint(roots: ScanRoots, from: string, text: string): StartingPoint {
  if (text === '') return BROKEN;
  if (!path.isAbsolute(text)) return { base: from, parts: splitComponents(text) };
  // Absolute targets are compared with the root lexically and never touched when they lie
  // elsewhere (see resolveSymlink).
  for (const rootPath of [roots.real, roots.given, ...(roots.aliases ?? [])]) {
    const rest = stripRootPrefix(rootPath, text);
    if (rest !== undefined) return { base: roots.real, parts: rest };
  }
  return OUTSIDE;
}
