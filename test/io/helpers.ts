import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Snapshot } from '../../src/core/types.js';

export type Tree = Readonly<Record<string, string | Uint8Array>>;

/** Temporary directories created by a test file; remove them with `removeTempDirs` in afterEach. */
const created: string[] = [];

export async function makeTempDir(prefix = 'agentcheckup-io-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  const dirs = created.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

/** Writes files (POSIX paths relative to `root`), creating parent directories. */
export async function writeTree(root: string, tree: Tree): Promise<void> {
  for (const [relativePath, content] of Object.entries(tree)) {
    const filePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

export async function makeDirs(root: string, ...relativePaths: string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    await mkdir(path.join(root, ...relativePath.split('/')), { recursive: true });
  }
}

/** Creates `linkPath` (relative to root) with the raw link text `target`. */
export async function link(root: string, linkPath: string, target: string): Promise<void> {
  const absolute = path.join(root, ...linkPath.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await symlink(target, absolute);
}

async function probeSymlinks(): Promise<boolean> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentcheckup-probe-'));
  try {
    await writeFile(path.join(dir, 'target'), '');
    await symlink('target', path.join(dir, 'link'));
    return true;
  } catch {
    // EPERM on Windows without Developer Mode.
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const symlinksSupported = await probeSymlinks();

export const isWindows = process.platform === 'win32';

/** Permission tests are meaningless as root (it bypasses mode bits) and on Windows. */
export const canDenyPermissions =
  !isWindows && typeof process.getuid === 'function' && process.getuid() !== 0;

export function makeFifo(filePath: string): boolean {
  if (isWindows) return false;
  const result = spawnSync('mkfifo', [filePath]);
  return result.status === 0;
}

async function probeFifo(): Promise<boolean> {
  if (isWindows) return false;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentcheckup-probe-'));
  try {
    return makeFifo(path.join(dir, 'fifo'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const fifosSupported = await probeFifo();

/**
 * Serializes a snapshot so that file contents appear as text: Uint8Array becomes its latin1
 * string (every byte maps to one character), Set becomes an array.
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('latin1');
    if (value instanceof Set) return [...(value as Set<unknown>)];
    return value;
  });
}

const decoder = new TextDecoder();

export function textOf(snapshot: Snapshot, filePath: string): string | undefined {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  return file === undefined ? undefined : decoder.decode(file.bytes);
}

export function filePaths(snapshot: Snapshot): string[] {
  return snapshot.files.map((file) => file.path);
}
