import { spawnSync } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findPackageRoot,
  MAX_PACKAGE_FILE_BYTES,
  PackageAssetError,
  readPackageText,
} from '../../src/io/package-assets.js';
import { makeTempDir, removeTempDirs, symlinksSupported, writeTree } from '../io/helpers.js';
import { REPO_ROOT, skillText } from './helpers.js';

afterEach(removeTempDirs);

const MANIFEST = '{ "name": "agentcheckup", "version": "1.2.3" }\n';

/** A package root with a package.json and the given files. */
async function fakePackage(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const root = await makeTempDir('agentcheckup-package-');
  await writeTree(root, { 'package.json': MANIFEST, ...files });
  return root;
}

async function refusal(root: string, path: string, maxBytes?: number): Promise<string> {
  try {
    await readPackageText(root, path, maxBytes);
  } catch (error) {
    expect(error).toBeInstanceOf(PackageAssetError);
    return (error as Error).message;
  }
  throw new Error(`${path} was read`);
}

describe('findPackageRoot', () => {
  it('finds this package from its sources', async () => {
    expect(await findPackageRoot()).toBe(join(REPO_ROOT, '.').replace(/[/\\]$/, ''));
  });

  it('finds a package from a bundle in dist/', async () => {
    const root = await fakePackage({ 'dist/cli.js': '' });
    expect(await findPackageRoot(join(root, 'dist', 'cli.js'))).toBe(root);
  });

  it('skips a package.json with another name, and gives up after three levels', async () => {
    const root = await fakePackage({
      'a/package.json': '{ "name": "other" }',
      'a/b/c/d/x.js': '',
    });
    expect(await findPackageRoot(join(root, 'a', 'x.js'))).toBe(root);
    await expect(findPackageRoot(join(root, 'a', 'b', 'c', 'd', 'x.js'))).rejects.toThrow(
      PackageAssetError,
    );
  });

  it('skips a package.json without a name, and stops at the file system root', async () => {
    const root = await fakePackage({
      'a/package.json': '[]',
      'a/b/package.json': '{ "name": 5 }',
      'a/b/x.js': '',
    });
    expect(await findPackageRoot(join(root, 'a', 'b', 'x.js'))).toBe(root);
    await expect(findPackageRoot(join(parse(root).root, 'x.js'))).rejects.toThrow(
      'Cannot find the agentcheckup package above',
    );
  });

  it('refuses a package.json that is not a file', async () => {
    const root = await makeTempDir('agentcheckup-package-');
    await mkdir(join(root, 'package.json'));
    await expect(findPackageRoot(join(root, 'x.js'))).rejects.toThrow('it is not a regular file');
  });
});

describe('readPackageText', () => {
  it('reads a file below the package root as text, byte order mark included', async () => {
    const root = await fakePackage({
      'skills/agentcheckup/SKILL.md': '# Skill\n',
      'skills/agentcheckup/bom.md': '﻿# Bom\n',
    });
    expect(await readPackageText(root, 'skills/agentcheckup/SKILL.md')).toBe('# Skill\n');
    expect(await readPackageText(root, 'skills/agentcheckup/bom.md')).toBe('﻿# Bom\n');
    expect(await readPackageText(REPO_ROOT, 'skills/agentcheckup/SKILL.md')).toBe(
      await skillText(),
    );
  });

  it('refuses a package root that does not exist', async () => {
    const root = join(await makeTempDir('agentcheckup-package-'), 'gone');
    expect(await refusal(root, 'x.md')).toContain('the package directory cannot be accessed');
  });

  it('refuses a missing file, a directory and a file that is too large', async () => {
    const root = await fakePackage({ 'skills/big.md': 'x'.repeat(11) });
    expect(await refusal(root, 'skills/none.md')).toBe(
      'Cannot read skills/none.md from the agentcheckup package: it does not exist.',
    );
    expect(await refusal(root, 'nope/none.md')).toContain('it does not exist');
    expect(await refusal(root, 'skills')).toContain('it is not a regular file');
    expect(await refusal(root, 'skills/big.md', 10)).toContain('it is larger than 10 bytes');
    expect(await readPackageText(root, 'skills/big.md', 11)).toBe('x'.repeat(11));
    expect(MAX_PACKAGE_FILE_BYTES).toBe(65536);
  });

  it('refuses a file that is not UTF-8, and a parent that is a file', async () => {
    const root = await fakePackage({ 'skills/latin1.md': new Uint8Array([0x63, 0x61, 0xe9]) });
    expect(await refusal(root, 'skills/latin1.md')).toContain('it is not UTF-8 text');
    expect(await refusal(root, 'package.json/x.md')).toContain('package.json is not a directory');
  });

  it('throws on a path that is not normalized and relative', async () => {
    const root = await fakePackage();
    for (const path of ['', '../x.md', 'a/../x.md', './x.md', 'a//x.md', 'a\\x.md']) {
      await expect(readPackageText(root, path), path).rejects.toThrow('must be normalized');
    }
  });

  it.skipIf(!symlinksSupported)('refuses a symlinked file, even inside the package', async () => {
    const root = await fakePackage({ 'skills/real.md': '# Real\n' });
    await symlink('real.md', join(root, 'skills', 'link.md'));
    expect(await refusal(root, 'skills/link.md')).toContain('symbolic link');
  });

  it.skipIf(!symlinksSupported)('refuses a symlinked directory on the way', async () => {
    const outside = await makeTempDir('agentcheckup-outside-');
    await writeTree(outside, { 'SKILL.md': '# Outside\n' });
    const root = await fakePackage();
    await mkdir(join(root, 'skills'));
    await symlink(outside, join(root, 'skills', 'agentcheckup'), 'dir');
    expect(await refusal(root, 'skills/agentcheckup/SKILL.md')).toBe(
      'Cannot read skills/agentcheckup/SKILL.md from the agentcheckup package: agentcheckup is a symbolic link.',
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking', async () => {
    const root = await fakePackage();
    const made = spawnSync('mkfifo', [join(root, 'fifo.md')]);
    if (made.status !== 0) return;
    expect(await refusal(root, 'fifo.md')).toContain('it is not a regular file');
  });

  it.skipIf(!symlinksSupported)('reads through a package root given as a symlink', async () => {
    const root = await fakePackage({ 'x.md': 'x\n' });
    const alias = join(await makeTempDir('agentcheckup-alias-'), 'pkg');
    await symlink(root, alias, 'dir');
    expect(await readPackageText(alias, 'x.md')).toBe('x\n');
  });
});
