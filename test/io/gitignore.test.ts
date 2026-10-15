import { chmod, symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addGitignore,
  chainWeight,
  isIgnored,
  MAX_GITIGNORE_BYTES,
  MAX_GITIGNORE_MATCH_WORK,
  MAX_GITIGNORE_WEIGHT_PER_PATH,
  MAX_GITIGNORE_WEIGHT_TOTAL,
  MAX_GLOBSTARS_PER_PATTERN,
  parseGitignore,
} from '../../src/io/gitignore.js';
import { walk } from '../../src/io/walk.js';
import {
  canDenyPermissions,
  fifosSupported,
  filePaths,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

describe('walk: .gitignore semantics', () => {
  it('applies root and nested .gitignore files to their own subtrees', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '# local notes\n*.local.md\nignored-dir/\n/root-only.md\n\n',
      'CLAUDE.local.md': 'ignored by *.local.md',
      'root-only.md': 'anchored to the root',
      'ignored-dir/AGENTS.md': 'inside an ignored directory',
      'AGENTS.md': 'kept',

      'sub/.gitignore': '!CLAUDE.local.md\n/AGENTS.md\n',
      'sub/CLAUDE.local.md': 're-included by the deeper .gitignore',
      'sub/AGENTS.md': 'ignored, anchored to sub/',
      'sub/root-only.md': 'the root pattern is anchored, so this is kept',
      'sub/deep/AGENTS.md': 'the sub/ pattern is anchored, so this is kept',
      'sub/deep/CLAUDE.local.md': 'still re-included below sub/',

      'other/CLAUDE.local.md': 'the sibling .gitignore does not apply here',
      'other/GEMINI.md': 'kept',
    });

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual([
      'AGENTS.md',
      'other/GEMINI.md',
      'sub/CLAUDE.local.md',
      'sub/deep/AGENTS.md',
      'sub/deep/CLAUDE.local.md',
    ]);
    // Ignored entries are not even listed as paths.
    for (const ignored of [
      'CLAUDE.local.md',
      'root-only.md',
      'ignored-dir/',
      'ignored-dir/AGENTS.md',
      'sub/AGENTS.md',
      'other/CLAUDE.local.md',
    ]) {
      expect(snapshot.paths.has(ignored)).toBe(false);
    }
    expect(snapshot.paths.has('sub/root-only.md')).toBe(true);
    expect(snapshot.paths.has('.gitignore')).toBe(true);
    // They exist, though: ignored files and directories are recorded separately.
    expect([...snapshot.ignoredFiles]).toEqual([
      'CLAUDE.local.md',
      'other/CLAUDE.local.md',
      'root-only.md',
      'sub/AGENTS.md',
    ]);
    expect([...snapshot.opaqueDirectories]).toEqual(['ignored-dir/']);
  });

  it('cannot re-include a file inside an ignored directory, like git', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'generated/\n!generated/AGENTS.md\n',
      'generated/AGENTS.md': 'x',
    });
    const snapshot = await walk(root);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.paths.has('generated/')).toBe(false);
    expect(snapshot.opaqueDirectories).toEqual(new Set(['generated/']));
    expect(snapshot.ignoredFiles).toEqual(new Set());
  });

  it('lets a later negation in the same file win', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '.claude/rules/*\n!.claude/rules/keep.md\n',
      '.claude/rules/drop.md': 'x',
      '.claude/rules/keep.md': 'x',
    });
    expect(filePaths(await walk(root))).toEqual(['.claude/rules/keep.md']);
  });

  it('matches directory-only patterns against directories only', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'docs/\n',
      'docs/AGENTS.md': 'ignored',
      'nested/docs': 'a file named docs is not matched',
    });
    const snapshot = await walk(root);
    expect(snapshot.paths.has('nested/docs')).toBe(true);
    expect(snapshot.paths.has('docs/')).toBe(false);
    expect(snapshot.opaqueDirectories).toEqual(new Set(['docs/']));
  });

  it('matches case-sensitively, like git by default', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '.gitignore': 'agents.md\n', 'AGENTS.md': 'kept' });
    expect(filePaths(await walk(root))).toEqual(['AGENTS.md']);
  });

  it('handles CRLF line endings and a UTF-8 BOM', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '﻿CLAUDE.md\r\nGEMINI.md\r\n',
      'AGENTS.md': 'kept',
      'CLAUDE.md': 'ignored',
      'GEMINI.md': 'ignored',
    });
    expect(filePaths(await walk(root))).toEqual(['AGENTS.md']);
  });

  it('is disabled by respectGitignore: false', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '.gitignore': '*.md\n', 'AGENTS.md': 'x', 'a/CLAUDE.md': 'x' });
    const snapshot = await walk(root, { respectGitignore: false });
    expect(snapshot.gitignoreApplied).toBe(false);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'a/CLAUDE.md']);
    expect(snapshot.ignoredFiles).toEqual(new Set());
    expect(snapshot.opaqueDirectories).toEqual(new Set());
  });

  it('skips a .gitignore larger than 256 KiB and does not apply it', async () => {
    expect(MAX_GITIGNORE_BYTES).toBe(256 * 1024);
    const root = await makeTempDir();
    const huge = `AGENTS.md\n${'#'.repeat(MAX_GITIGNORE_BYTES)}\n`;
    await writeTree(root, { '.gitignore': huge, 'AGENTS.md': 'x' });
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md']);
    expect(snapshot.skipped).toEqual([
      { path: '.gitignore', reason: 'too-large', size: Buffer.byteLength(huge) },
    ]);
    expect(snapshot.gitignoreApplied).toBe(false);
  });

  it('ignores a .gitignore that is a directory', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'x' });
    await makeDirs(root, '.gitignore');
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md']);
    // Not a .gitignore file at all, so nothing was left unapplied.
    expect(snapshot.gitignoreApplied).toBe(true);
  });

  it.skipIf(!symlinksSupported)('does not follow a symlinked .gitignore', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'rules.txt': 'AGENTS.md\n', 'AGENTS.md': 'x' });
    await symlink('rules.txt', path.join(root, '.gitignore'));
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md']);
    expect(snapshot.gitignoreApplied).toBe(false);
  });

  it('cannot be used to hang the walk with nested globstars', { timeout: 10_000 }, async () => {
    const root = await makeTempDir();
    const segments = Array.from({ length: 34 }, () => 'a');
    await writeTree(root, {
      // Without the globstar cap this pattern takes ~8 s here, growing polynomially with depth.
      '.gitignore': `${'a/**/'.repeat(14)}b\n`,
      [`${segments.join('/')}/AGENTS.md`]: 'deep',
    });
    const started = performance.now();
    const snapshot = await walk(root);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(snapshot.skipped.map((entry) => entry.reason)).toEqual(['depth-limit']);
  });
});

/** `count` distinct non-matching rules of 26 bytes each: 10 000 of them fit in 256 KiB. */
function noMatchRules(count: number, tag: string): string {
  return Array.from(
    { length: count },
    (_, index) => `nomatch-${String(index).padStart(5, '0')}-${tag}.tmp\n`,
  ).join('');
}

describe('walk: .gitignore cost budgets', () => {
  it(
    'bounds the rules applied along one path (30 nested 256 KiB files)',
    { timeout: 20_000 },
    async () => {
      const root = await makeTempDir();
      const tree: Record<string, string> = {};
      let directory = '';
      for (let level = 0; level < 30; level++) {
        const prefix = directory === '' ? '' : `${directory}/`;
        tree[`${prefix}.gitignore`] = noMatchRules(10_000, `lvl${String(level).padStart(4, '0')}`);
        tree[`${prefix}CLAUDE.md`] = `level ${String(level)}`;
        tree[`${prefix}CLAUDE.local.md`] = `level ${String(level)}`;
        directory = `${prefix}d`;
      }
      for (const content of Object.values(tree)) {
        expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_GITIGNORE_BYTES);
      }
      await writeTree(root, tree);

      const started = performance.now();
      const snapshot = await walk(root);
      const elapsed = performance.now() - started;

      // Before the budget this shape took ~3 minutes.
      // Unbounded, this took minutes and ran out of memory; 10 s leaves room for slow CI runners.
      expect(elapsed).toBeLessThan(10_000);
      expect(snapshot.files).toHaveLength(60);
      // Two files fit the per-path budget (2 x 10 000); the 28 below them are not applied.
      expect(MAX_GITIGNORE_WEIGHT_PER_PATH).toBe(20_000);
      const skipped = snapshot.skipped.filter((entry) => entry.reason === 'byte-limit');
      expect(skipped).toHaveLength(28);
      expect(skipped[0]).toEqual({ path: 'd/d/.gitignore', reason: 'byte-limit', size: 260_000 });
    },
  );

  it('bounds the rules compiled across sibling directories', async () => {
    const root = await makeTempDir();
    const tree: Record<string, string> = {};
    for (let index = 0; index < 12; index++) {
      tree[`s${String(index).padStart(2, '0')}/.gitignore`] = noMatchRules(9000, 'sibling');
    }
    await writeTree(root, tree);
    const snapshot = await walk(root);
    // 11 x 9 000 fit in the total budget; the 12th would exceed it.
    expect(MAX_GITIGNORE_WEIGHT_TOTAL).toBe(100_000);
    expect(snapshot.skipped).toEqual([
      { path: 's11/.gitignore', reason: 'byte-limit', size: 234_000 },
    ]);
    expect(snapshot.gitignoreApplied).toBe(false);
  });

  it('reports a .gitignore over the per-path budget as not applied', async () => {
    const root = await makeTempDir();
    // 9 000 + 9 000 fit in one path's budget of 20 000; the third file below them does not.
    await writeTree(root, {
      '.gitignore': noMatchRules(9000, 'level-0'),
      'a/.gitignore': noMatchRules(9000, 'level-1'),
      'a/b/.gitignore': noMatchRules(9000, 'level-2'),
    });
    const snapshot = await walk(root);
    expect(snapshot.skipped).toEqual([
      { path: 'a/b/.gitignore', reason: 'byte-limit', size: 234_000 },
    ]);
    expect(snapshot.gitignoreApplied).toBe(false);
  });

  it('stops applying .gitignore once the match budget is spent', { timeout: 20_000 }, async () => {
    const root = await makeTempDir();
    // Rules with three globstars are weighed as the most expensive kind, so few entries suffice.
    const gitignore = [
      ...Array.from({ length: 208 }, (_, index) => `x/**/y/**/z/**/w${String(index)}`),
      '*.log',
    ].join('\n');
    const perTest = parseGitignore(gitignore).weight;
    const allowedTests = Math.floor(MAX_GITIGNORE_MATCH_WORK / perTest);
    const tree: Record<string, string> = { '.gitignore': gitignore };
    for (let index = 0; index < allowedTests + 100; index++) {
      tree[`f${String(index).padStart(5, '0')}.log`] = '';
    }
    await writeTree(root, tree);

    const snapshot = await walk(root);

    // .gitignore itself is the first entry tested; the next allowedTests - 1 logs are ignored.
    expect(snapshot.ignoredFiles.size).toBe(allowedTests - 1);
    expect(snapshot.skipped).toEqual([{ path: '.gitignore', reason: 'byte-limit' }]);
    const lastLog = `f${String(allowedTests + 99).padStart(5, '0')}.log`;
    expect(snapshot.paths.has(lastLog)).toBe(true);
    expect(snapshot.gitignoreApplied).toBe(false);
  });
});

describe('snapshot.gitignoreApplied', () => {
  it('is true when every .gitignore encountered was applied in full', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '# comments only count as applied\n\n',
      'a/.gitignore': 'x.md\n**/y.md\na/**/b/**/c/**/z.md\n',
      // Below the depth limit: never listed, so never encountered.
      'a/b/c/.gitignore': `${'d/**/'.repeat(5)}e\n`,
    });
    expect((await walk(root, { maxDepth: 2 })).gitignoreApplied).toBe(true);
    const bare = await makeTempDir();
    await writeTree(bare, { 'AGENTS.md': 'no .gitignore anywhere' });
    expect((await walk(bare)).gitignoreApplied).toBe(true);
  });

  it('is false when patterns were dropped as too costly to match', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'sub/.gitignore': `kept.md\n${'d/**/'.repeat(4)}e\n` });
    expect((await walk(root)).gitignoreApplied).toBe(false);
  });

  it.skipIf(!fifosSupported)('is false when a .gitignore is a special file', async () => {
    const root = await makeTempDir();
    expect(makeFifo(path.join(root, '.gitignore'))).toBe(true);
    expect((await walk(root)).gitignoreApplied).toBe(false);
  });

  it.skipIf(!canDenyPermissions)('is false when a .gitignore is unreadable', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'sub/.gitignore': 'x\n' });
    const file = path.join(root, 'sub', '.gitignore');
    await chmod(file, 0o000);
    try {
      const snapshot = await walk(root);
      expect(snapshot.skipped).toEqual([{ path: 'sub/.gitignore', reason: 'unreadable' }]);
      expect(snapshot.gitignoreApplied).toBe(false);
    } finally {
      await chmod(file, 0o600);
    }
  });
});

describe('parseGitignore / chainWeight', () => {
  it('weighs patterns by their globstar count and drops unusable lines', () => {
    expect(parseGitignore('a\n**/a\n').weight).toBe(3);
    expect(parseGitignore('a/**/b/**/c').weight).toBe(16);
    expect(parseGitignore('a/**/b/**/c/**/d').weight).toBe(96);
    expect(parseGitignore('a/**/b/**/c/**/d/**/e\n# comment\n\n  \n')).toEqual({
      patterns: [],
      weight: 0,
      dropped: 1,
    });
    expect(parseGitignore('x\r\ny\r\n').patterns).toEqual(['x', 'y']);
  });

  it('sums the weight of a layer and its ancestors', () => {
    const parent = addGitignore(undefined, '', 'a\nb\n');
    const child = addGitignore(parent, 'sub', '**/c\n');
    expect(chainWeight(undefined)).toBe(0);
    expect(chainWeight(parent)).toBe(2);
    expect(chainWeight(child)).toBe(4);
  });
});

describe('addGitignore / isIgnored', () => {
  it('returns the parent layer when a file has no usable patterns', () => {
    const parent = addGitignore(undefined, '', 'x\n');
    expect(addGitignore(parent, 'sub', '# only a comment\n\n   \n')).toBe(parent);
    expect(addGitignore(undefined, '', '')).toBeUndefined();
  });

  it('drops patterns with too many globstars', () => {
    const allowed = `${'x/**/'.repeat(MAX_GLOBSTARS_PER_PATTERN)}AGENTS.md`;
    const dropped = `${'y/**/'.repeat(MAX_GLOBSTARS_PER_PATTERN + 1)}AGENTS.md`;
    const layer = addGitignore(undefined, '', `${allowed}\n${dropped}\n`);
    const allowedPath = `${'x/'.repeat(MAX_GLOBSTARS_PER_PATTERN)}AGENTS.md`;
    const droppedPath = `${'y/'.repeat(MAX_GLOBSTARS_PER_PATTERN + 1)}AGENTS.md`;
    expect(isIgnored(layer, allowedPath, false)).toBe(true);
    expect(isIgnored(layer, droppedPath, false)).toBe(false);
  });

  it('lets the deepest layer decide and falls back to its ancestors', () => {
    const rootLayer = addGitignore(undefined, '', '*.md\n');
    const subLayer = addGitignore(rootLayer, 'a/b', '!keep.md\nlocal.txt\n');
    expect(isIgnored(subLayer, 'a/b/keep.md', false)).toBe(false);
    expect(isIgnored(subLayer, 'a/b/drop.md', false)).toBe(true);
    expect(isIgnored(subLayer, 'a/b/local.txt', false)).toBe(true);
    expect(isIgnored(subLayer, 'a/b/other.txt', false)).toBe(false);
    expect(isIgnored(undefined, 'anything', true)).toBe(false);
  });

  it('treats paths the matcher rejects as not ignored instead of throwing', () => {
    const layer = addGitignore(undefined, '', '*\n');
    expect(isIgnored(layer, '.', false)).toBe(false);
    expect(isIgnored(layer, 'ok', false)).toBe(true);
  });
});
