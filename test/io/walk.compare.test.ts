/**
 * walk() reads ahead, prefetches listings and reuses alias contents for speed. None of that may
 * change the result: it must equal the one-at-a-time oracle in ./reference/sequential-walk.ts,
 * byte for byte, under every limit.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Snapshot } from '../../src/core/types.js';
import { defaultIsCandidate } from '../../src/io/filters.js';
import { walk, type WalkOptions } from '../../src/io/walk.js';
import {
  fifosSupported,
  link,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';
import { sequentialWalk } from './reference/sequential-walk.js';

afterEach(removeTempDirs);

function digest(snapshot: Snapshot): string {
  return JSON.stringify({
    files: snapshot.files.map((file) => [
      file.path,
      file.symlinkTarget ?? null,
      file.imported ?? false,
      createHash('sha256').update(file.bytes).digest('hex'),
    ]),
    paths: [...snapshot.paths],
    opaqueDirectories: [...snapshot.opaqueDirectories],
    ignoredFiles: [...snapshot.ignoredFiles],
    gitignoredConfig: [...(snapshot.gitignoredConfig ?? [])],
    gitignoreApplied: snapshot.gitignoreApplied,
    unresolvedSymlinks: snapshot.unresolvedSymlinks,
    skipped: snapshot.skipped,
  });
}

async function expectSameAsSequential(root: string, options: WalkOptions = {}): Promise<void> {
  const actual = digest(await walk(root, options));
  const expected = digest(await sequentialWalk(root, options));
  expect(actual, JSON.stringify(options)).toBe(expected);
}

/** A tree touching every feature, wider than the prefetch window and the read-ahead cap. */
async function mixedTree(): Promise<{ root: string; entries: number }> {
  const root = await makeTempDir();
  const tree: Record<string, string | Uint8Array> = {
    '.gitignore': '*.local.md\ngenerated/\n.cursor/rules/private/\ndocs/private.md\n',
    '.gitmodules': '[submodule "libs/sub"]\n\tpath = libs/sub\n',
    'AGENTS.md': '# root',
    'CLAUDE.local.md': 'ignored unless untrusted: @docs/local.md',
    '.cursor/rules/private/secret.mdc': 'ignored config directory',
    'docs/guide.md': 'Guide: @more.md and @../README.md and @../big/AGENTS.md\n',
    'docs/more.md': 'x'.repeat(150),
    'docs/local.md': 'local',
    'docs/private.md': 'ignored',
    'README.md': 'readme',
    'generated/AGENTS.md': 'ignored directory',
    'node_modules/pkg/AGENTS.md': 'excluded',
    '.claude/skills/build/SKILL.md': 'agent config is never excluded',
    '.agents/skills/demo/SKILL.md': '---\nname: demo\n---\n',
    'binary/AGENTS.md': new Uint8Array([0x41, 0, 0x42]),
    'big/AGENTS.md': 'x'.repeat(2000),
    'nested/.gitignore': '!CLAUDE.local.md\n',
    'nested/CLAUDE.local.md': 're-included: @../docs/guide.md @../docs/private.md @up/x.md',
  };
  for (let index = 0; index < 40; index++) {
    const name = `pkg${String(index).padStart(2, '0')}`;
    tree[`packages/${name}/AGENTS.md`] = `package ${name}`;
    tree[`packages/${name}/src/index.ts`] = 'export {};';
    tree[`.claude/rules/rule${String(index).padStart(2, '0')}.md`] = `rule ${String(index)}`;
  }
  await writeTree(root, tree);
  await makeDirs(root, 'libs/sub');
  if (symlinksSupported) {
    await link(root, '.claude/skills/demo', '../../.agents/skills/demo');
    await link(root, '.cursor/skills', '../.agents/skills');
    await link(root, 'CLAUDE.md', 'AGENTS.md');
    await link(root, 'GEMINI.md', 'binary/AGENTS.md');
    await link(root, 'big/CLAUDE.md', 'AGENTS.md');
    await link(root, 'broken.md', 'missing.md');
    await link(root, 'outside.md', '../../outside.md');
    await link(root, 'packages/up', '..');
  }
  if (fifosSupported) makeFifo(path.join(root, 'packages', 'pkg00', 'CLAUDE.md'));
  const entries = (await sequentialWalk(root, { respectGitignore: false })).paths.size;
  return { root, entries };
}

describe('walk() equals the sequential oracle', () => {
  it('on a tree that exercises the import pass and untrusted .gitignore handling', async () => {
    const { root } = await mixedTree();
    const imported = (snapshot: Snapshot): string[] =>
      snapshot.files.filter((file) => file.imported === true).map((file) => file.path);
    expect(imported(await walk(root))).toEqual(['README.md', 'docs/guide.md', 'docs/more.md']);
    const untrusted = await walk(root, { scanIgnoredAgentConfig: true });
    expect(imported(untrusted)).toEqual([
      'README.md',
      'docs/guide.md',
      'docs/local.md',
      'docs/more.md',
    ]);
    expect([...(untrusted.gitignoredConfig ?? [])]).toEqual([
      '.cursor/rules/private/',
      '.cursor/rules/private/secret.mdc',
      'CLAUDE.local.md',
    ]);
  });

  it('on a tree with every feature, under every entry limit', { timeout: 60_000 }, async () => {
    const { root, entries } = await mixedTree();
    await expectSameAsSequential(root);
    for (let maxEntries = 0; maxEntries <= entries + 2; maxEntries += 3) {
      await expectSameAsSequential(root, { maxEntries });
    }
  });

  it(
    'under depth, size and gitignore settings and a custom predicate',
    { timeout: 60_000 },
    async () => {
      const { root } = await mixedTree();
      for (let maxDepth = 0; maxDepth <= 4; maxDepth++)
        await expectSameAsSequential(root, { maxDepth });
      await expectSameAsSequential(root, { maxFileBytes: 100 });
      await expectSameAsSequential(root, { respectGitignore: false });
      await expectSameAsSequential(root, { scanIgnoredAgentConfig: true });
      await expectSameAsSequential(root, { scanIgnoredAgentConfig: true, maxFileBytes: 100 });
      await expectSameAsSequential(root, { followImports: false });
      // A custom predicate turns read-ahead off: it is called once per file, at its turn.
      await expectSameAsSequential(root, { isCandidate: (p) => defaultIsCandidate(p) });
    },
  );

  it('on a directory larger than a prefetched listing holds', { timeout: 60_000 }, async () => {
    const root = await makeTempDir();
    const tree: Record<string, string> = {};
    for (let index = 0; index < 5000; index++)
      tree[`many/f${String(index).padStart(4, '0')}.md`] = '';
    tree['many/AGENTS.md'] = 'x';
    tree['z/AGENTS.md'] = 'after the big directory';
    await writeTree(root, tree);
    for (const maxEntries of [undefined, 100, 4096, 4097, 4500, 5003, 5004]) {
      await expectSameAsSequential(root, maxEntries === undefined ? {} : { maxEntries });
    }
  });
});

describe.skipIf(!symlinksSupported)('walk(): alias paths', () => {
  it('reads each real file once and counts it once against maxTotalBytes', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '.agents/skills/demo/SKILL.md': '0123456789' });
    await link(root, '.claude/skills', '../.agents/skills');
    await link(root, '.cursor/skills', '../.agents/skills');
    await link(root, 'skills', '.agents/skills');

    const snapshot = await walk(root, { maxTotalBytes: 15 });

    expect(snapshot.files.map((file) => file.path)).toEqual([
      '.agents/skills/demo/SKILL.md',
      '.claude/skills/demo/SKILL.md',
      '.cursor/skills/demo/SKILL.md',
      'skills/demo/SKILL.md',
    ]);
    expect(snapshot.skipped).toEqual([]);
    // The same bytes, read once.
    expect(new Set(snapshot.files.map((file) => file.bytes)).size).toBe(1);
    // The sequential walk read and counted every alias, so only one fit.
    const sequential = await sequentialWalk(root, { maxTotalBytes: 15 });
    expect(sequential.files).toHaveLength(1);
  });
});
