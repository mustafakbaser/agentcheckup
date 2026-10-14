import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRegularFile } from '../../src/io/safe-read.js';
import {
  fifosSupported,
  isWindows,
  link,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
} from './helpers.js';

afterEach(removeTempDirs);

async function fileWith(content: string): Promise<string> {
  const root = await makeTempDir();
  const filePath = path.join(root, 'file.md');
  await writeFile(filePath, content);
  return filePath;
}

describe('readRegularFile', () => {
  it('reads the whole file', async () => {
    const filePath = await fileWith('hello');
    const outcome = await readRegularFile(filePath, await lstat(filePath), 100);
    expect(outcome).toEqual({ ok: true, bytes: new Uint8Array(Buffer.from('hello')) });
  });

  it('re-checks the size on the opened file', async () => {
    const filePath = await fileWith('0123456789');
    const outcome = await readRegularFile(filePath, await lstat(filePath), 4);
    expect(outcome).toEqual({ ok: false, reason: 'too-large', size: 10 });
  });

  it('rejects a file that is not the one that was checked', async () => {
    const filePath = await fileWith('swapped');
    const other = await fileWith('checked');
    const outcome = await readRegularFile(filePath, await lstat(other), 100);
    expect(outcome).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports a missing file with its error code', async () => {
    const root = await makeTempDir();
    const outcome = await readRegularFile(path.join(root, 'nope'), { dev: 0, ino: 0 }, 100);
    expect(outcome).toEqual({ ok: false, reason: 'unreadable', code: 'ENOENT' });
  });

  it.skipIf(isWindows)('rejects a directory', async () => {
    const root = await makeTempDir();
    await makeDirs(root, 'dir');
    const dir = path.join(root, 'dir');
    expect(await readRegularFile(dir, await lstat(dir), 100)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it.skipIf(!fifosSupported)('opens a FIFO without blocking and rejects it', async () => {
    const root = await makeTempDir();
    const fifo = path.join(root, 'fifo');
    expect(makeFifo(fifo)).toBe(true);
    const started = performance.now();
    const outcome = await readRegularFile(fifo, await lstat(fifo), 100);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(outcome).toEqual({ ok: false, reason: 'special-file' });
  });

  it.skipIf(!symlinksSupported || isWindows)('refuses to follow a symlink', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'target.md'), 'x');
    await link(root, 'link.md', 'target.md');
    const target = await lstat(path.join(root, 'target.md'));
    const outcome = await readRegularFile(path.join(root, 'link.md'), target, 100);
    expect(outcome).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});
