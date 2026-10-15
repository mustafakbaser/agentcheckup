import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SYMLINK_HOPS, resolveSymlink, type ScanRoots } from '../../src/io/resolve.js';
import { walk } from '../../src/io/walk.js';
import { link, makeTempDir, removeTempDirs, symlinksSupported, writeTree } from './helpers.js';

afterEach(removeTempDirs);

async function rootsOf(root: string): Promise<ScanRoots> {
  return { real: await realpath(root), given: path.resolve(root) };
}

describe('resolveSymlink', () => {
  it('resolves relative text against the link directory', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a/AGENTS.md': 'x' });
    const roots = await rootsOf(root);
    const result = await resolveSymlink(roots, path.join(roots.real, 'a'), './/AGENTS.md');
    expect(result).toMatchObject({
      kind: 'inside',
      relativePath: 'a/AGENTS.md',
      realPath: path.join(roots.real, 'a', 'AGENTS.md'),
    });
  });

  it('resolves to the root itself', async () => {
    const root = await makeTempDir();
    const roots = await rootsOf(root);
    expect(await resolveSymlink(roots, roots.real, '.')).toMatchObject({
      kind: 'inside',
      relativePath: '',
    });
    expect(await resolveSymlink(roots, roots.real, roots.given)).toMatchObject({
      kind: 'inside',
      relativePath: '',
    });
  });

  it('applies .. physically and stops at the root', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a/b/x.md': 'x' });
    const roots = await rootsOf(root);
    const from = path.join(roots.real, 'a', 'b');
    expect(await resolveSymlink(roots, from, '../b/x.md')).toMatchObject({
      relativePath: 'a/b/x.md',
    });
    expect(await resolveSymlink(roots, from, '../../../x')).toEqual({ kind: 'outside' });
    expect(await resolveSymlink(roots, roots.real, '..')).toEqual({ kind: 'outside' });
  });

  it('reports empty text and missing components as broken', async () => {
    const root = await makeTempDir();
    const roots = await rootsOf(root);
    expect(await resolveSymlink(roots, roots.real, '')).toEqual({ kind: 'broken' });
    expect(await resolveSymlink(roots, roots.real, 'missing/x')).toEqual({ kind: 'broken' });
  });

  it.skipIf(!symlinksSupported)('follows nested links inside the root', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'real/dir/AGENTS.md': 'x' });
    await link(root, 'alias', 'real/dir');
    const roots = await rootsOf(root);
    await link(root, 'abs-alias', path.join(roots.real, 'real'));
    expect(await resolveSymlink(roots, roots.real, 'alias/AGENTS.md')).toMatchObject({
      relativePath: 'real/dir/AGENTS.md',
    });
    // `..` after a link is applied to the link's target, not lexically.
    expect(await resolveSymlink(roots, roots.real, 'alias/../dir/AGENTS.md')).toMatchObject({
      relativePath: 'real/dir/AGENTS.md',
    });
    expect(await resolveSymlink(roots, roots.real, 'abs-alias/dir')).toMatchObject({
      relativePath: 'real/dir',
    });
  });

  it.skipIf(!symlinksSupported)('stops a nested link that leaves the root', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir('agentcheckup-outside-');
    await link(root, 'out-abs', outside);
    await link(root, 'out-rel', '../..');
    const roots = await rootsOf(root);
    expect(await resolveSymlink(roots, roots.real, 'out-abs/x')).toEqual({ kind: 'outside' });
    expect(await resolveSymlink(roots, roots.real, 'out-rel/x')).toEqual({ kind: 'outside' });
  });

  it.skipIf(!symlinksSupported)(
    'follows at most MAX_SYMLINK_HOPS links, like the kernel',
    async () => {
      const root = await makeTempDir();
      await writeTree(root, { 'end.md': 'x' });
      // c1 -> c2 -> ... -> c40 -> end.md is a chain of exactly 40 links; c0 adds a 41st.
      await link(root, `c${MAX_SYMLINK_HOPS}`, 'end.md');
      for (let index = MAX_SYMLINK_HOPS - 1; index >= 0; index--) {
        await link(root, `c${index}`, `c${index + 1}`);
      }
      const snapshot = await walk(root);
      expect(snapshot.unresolvedSymlinks).toEqual([
        { path: 'c0', target: 'c1', problem: 'broken' },
      ]);
    },
  );
});
