import { chmod, link as hardLink, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OutputError, writeOutputFile } from '../../src/io/output.js';
import {
  canDenyPermissions,
  fifosSupported,
  isWindows,
  link,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

describe('writeOutputFile', () => {
  it('creates a new file', async () => {
    const root = await makeTempDir();
    const file = path.join(root, 'report.txt');
    await writeOutputFile(file, 'ş\n');
    expect(await readFile(file, 'utf8')).toBe('ş\n');
    expect(await readdir(root)).toEqual(['report.txt']);
  });

  it('replaces a regular file through a rename', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'report.txt': 'old', 'other.txt': '' });
    const file = path.join(root, 'report.txt');
    // A hard link to the old report keeps the old content: the report is a new file.
    await hardLink(file, path.join(root, 'old-link.txt'));
    await writeOutputFile(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(await readFile(path.join(root, 'old-link.txt'), 'utf8')).toBe('old');
    expect((await readdir(root)).sort()).toEqual(['old-link.txt', 'other.txt', 'report.txt']);
  });

  it.skipIf(!symlinksSupported)('refuses symlinks to files, dangling ones too', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'secret.txt': 'keep' });
    await link(root, 'to-file.txt', 'secret.txt');
    await link(root, 'dangling.txt', 'created-by-attacker.txt');
    for (const name of ['to-file.txt', 'dangling.txt']) {
      const error = await writeOutputFile(path.join(root, name), 'x').catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(OutputError);
      expect((error as Error).message).toMatch(/it is a symbolic link/);
    }
    expect(await readFile(path.join(root, 'secret.txt'), 'utf8')).toBe('keep');
    expect((await readdir(root)).sort()).toEqual(['dangling.txt', 'secret.txt', 'to-file.txt']);
  });

  it('refuses directories and reports a missing directory', async () => {
    const root = await makeTempDir();
    await makeDirs(root, 'out');
    await expect(writeOutputFile(path.join(root, 'out'), 'x')).rejects.toThrow(
      /not a regular file/,
    );
    await expect(writeOutputFile(path.join(root, 'missing', 'r.txt'), 'x')).rejects.toThrow(
      /its directory does not exist/,
    );
    await writeTree(root, { file: '' });
    await expect(writeOutputFile(path.join(root, 'file', 'r.txt'), 'x')).rejects.toThrow(
      isWindows ? OutputError : /Cannot write .*: ENOTDIR\.$/,
    );
  });

  it.skipIf(!fifosSupported)('refuses FIFOs without opening them', async () => {
    const root = await makeTempDir();
    expect(makeFifo(path.join(root, 'fifo'))).toBe(true);
    await expect(writeOutputFile(path.join(root, 'fifo'), 'x')).rejects.toThrow(
      /not a regular file/,
    );
  });

  it.skipIf(!canDenyPermissions)('reports a directory it cannot write to', async () => {
    const root = await makeTempDir();
    await makeDirs(root, 'locked');
    const locked = path.join(root, 'locked');
    await chmod(locked, 0o500);
    try {
      await expect(writeOutputFile(path.join(locked, 'r.txt'), 'x')).rejects.toThrow(
        /Cannot write .*: EACCES/,
      );
      expect(await readdir(locked)).toEqual([]);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it.skipIf(isWindows)('creates the file with the default permissions', async () => {
    const root = await makeTempDir();
    const file = path.join(root, 'r.txt');
    await writeOutputFile(file, 'x');
    // 0o666 minus the umask, as fs.writeFile would; never executable.
    expect((await stat(file)).mode & 0o111).toBe(0);
  });
});
