import { chmod } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG_MAX_BYTES, readConfigFile } from '../../src/io/config-file.js';
import {
  canDenyPermissions,
  fifosSupported,
  link,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const NAME = 'agentcheck.config.json';

describe('readConfigFile', () => {
  it('reads a regular file in the root as UTF-8 without a BOM', async () => {
    const root = await makeTempDir();
    await writeTree(root, { [NAME]: '\uFEFF{"rules":{}} ş' });
    expect(await readConfigFile(root, NAME)).toBe('{"rules":{}} ş');
  });

  it('returns undefined when the file or the root is missing', async () => {
    const root = await makeTempDir();
    expect(await readConfigFile(root, NAME)).toBeUndefined();
    expect(await readConfigFile(path.join(root, 'missing'), NAME)).toBeUndefined();
    await writeTree(root, { file: 'x' });
    expect(await readConfigFile(path.join(root, 'file'), NAME)).toBeUndefined();
  });

  it('enforces the size limit, 256 KiB by default', async () => {
    const root = await makeTempDir();
    await writeTree(root, { [NAME]: 'x'.repeat(DEFAULT_CONFIG_MAX_BYTES + 1) });
    await expect(readConfigFile(root, NAME)).rejects.toThrow(/exceeds the 262144-byte limit/);
    await expect(readConfigFile(root, NAME, DEFAULT_CONFIG_MAX_BYTES + 1)).resolves.toHaveLength(
      DEFAULT_CONFIG_MAX_BYTES + 1,
    );
  });

  it('refuses directories', async () => {
    const root = await makeTempDir();
    await makeDirs(root, NAME);
    await expect(readConfigFile(root, NAME)).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(!symlinksSupported)('refuses symlinks, even to a file in the root', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'real.json': '{}' });
    await link(root, NAME, 'real.json');
    await expect(readConfigFile(root, NAME)).rejects.toThrow(/symbolic link/);
  });

  it.skipIf(!fifosSupported)('refuses FIFOs without opening them', async () => {
    const root = await makeTempDir();
    expect(makeFifo(path.join(root, NAME))).toBe(true);
    await expect(readConfigFile(root, NAME)).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(!canDenyPermissions)('reports unreadable files and roots', async () => {
    const root = await makeTempDir();
    await writeTree(root, { [NAME]: '{}', 'locked/x': '' });
    const filePath = path.join(root, NAME);
    const locked = path.join(root, 'locked');
    await chmod(filePath, 0o000);
    await chmod(locked, 0o000);
    try {
      await expect(readConfigFile(root, NAME)).rejects.toThrow(/Cannot read .*: EACCES/);
      await expect(readConfigFile(locked, NAME)).rejects.toThrow(/Cannot read .*: EACCES/);
    } finally {
      await chmod(filePath, 0o600);
      await chmod(locked, 0o700);
    }
  });

  it('rejects names that are not plain file names', async () => {
    const root = await makeTempDir();
    for (const name of ['', '.', '..', '../x.json', 'a/b.json', 'a\\b.json', 'a\0b']) {
      await expect(readConfigFile(root, name)).rejects.toThrow(/plain file name/);
    }
    await expect(readConfigFile(root, NAME, -1)).rejects.toThrow(RangeError);
  });
});
