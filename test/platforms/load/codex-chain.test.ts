import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG } from '../../../src/core/config.js';
import { buildArtifacts } from '../../../src/core/engine.js';
import {
  type CodexChain,
  codexChain,
  type CodexChainOptions,
} from '../../../src/platforms/load/codex-chain.js';
import { indexArtifacts } from '../../../src/platforms/paths.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

function chainOf(
  files: FileMap,
  startDir: string,
  options: CodexChainOptions,
  extras: SnapshotExtras = {},
): CodexChain {
  const snapshot = snapshotFrom(files, extras);
  const index = indexArtifacts(buildArtifacts(snapshot, EMPTY_CONFIG));
  return codexChain({ snapshot, index }, startDir, options);
}

/** A Git checkout: `.git` at the scan root is the project root marker. */
function repoChain(
  files: FileMap,
  startDir: string,
  options: CodexChainOptions = { maxBytes: 32_768 },
  extras: SnapshotExtras = {},
): CodexChain {
  return chainOf(files, startDir, options, {
    ...extras,
    paths: ['.git/HEAD', ...(extras.paths ?? [])],
  });
}

/** `[path, status, offset]`, plus `cutAt` for a cut file. */
function steps(chain: CodexChain): (string | number)[][] {
  return chain.files.map((file) =>
    file.status === 'cut' || file.status === 'cut-blank'
      ? [file.path, file.status, file.offset, file.cutAt]
      : [file.path, file.status, file.offset],
  );
}

describe('codexChain', () => {
  it('reads one file per directory from the Git root down to the start directory', () => {
    const chain = repoChain(
      {
        'AGENTS.md': 'root\n',
        'a/b/AGENTS.md': 'b\n',
        'a/b/c/AGENTS.md': 'below the start directory\n',
        'other/AGENTS.md': 'beside it\n',
      },
      'a/b',
    );
    expect(steps(chain)).toEqual([
      ['AGENTS.md', 'read', 0],
      ['a/b/AGENTS.md', 'read', 5],
    ]);
    expect(chain).toMatchObject({ root: '', rootMarker: true, used: 7, total: 7, dropped: [] });
    expect(chain.files.map((file) => file.directory)).toEqual(['', 'a/b']);
    expect(chain.cut).toBeUndefined();
    expect(chain.unknownAt).toBeUndefined();
  });

  it('prefers AGENTS.override.md over AGENTS.md, even when the override is blank', () => {
    const chain = repoChain(
      {
        'AGENTS.override.md': 'override\n',
        'AGENTS.md': 'hidden\n',
        'pkg/AGENTS.override.md': '  \n',
        'pkg/AGENTS.md': 'also hidden\n',
      },
      'pkg',
    );
    expect(steps(chain)).toEqual([
      ['AGENTS.override.md', 'read', 0],
      ['pkg/AGENTS.override.md', 'blank', 9],
    ]);
  });

  it('reads only the start directory without a project root marker', () => {
    const chain = chainOf({ 'AGENTS.md': 'root\n', 'pkg/AGENTS.md': 'pkg\n' }, 'pkg', {
      maxBytes: 32_768,
    });
    expect(steps(chain)).toEqual([['pkg/AGENTS.md', 'read', 0]]);
    expect(chain).toMatchObject({ root: 'pkg', rootMarker: false });
  });

  it('starts at the nearest .git entry, also a .git file', () => {
    const chain = repoChain(
      { 'AGENTS.md': 'root\n', 'sub/AGENTS.md': 'sub\n', 'sub/x/AGENTS.md': 'x\n' },
      'sub/x',
      undefined,
      { paths: ['sub/.git'] },
    );
    expect(chain.root).toBe('sub');
    expect(steps(chain)).toEqual([
      ['sub/AGENTS.md', 'read', 0],
      ['sub/x/AGENTS.md', 'read', 4],
    ]);
  });

  it('skips whitespace-only files without using budget, but not a byte order mark', () => {
    const chain = repoChain(
      { 'AGENTS.md': ' \n\t\r\n', 'a/AGENTS.md': '﻿\n', 'a/b/AGENTS.md': 'x'.repeat(6) },
      'a/b',
      { maxBytes: 10 },
    );
    // Codex keeps U+FEFF, which Rust does not trim, so a BOM-only file is not blank.
    expect(steps(chain)).toEqual([
      ['AGENTS.md', 'blank', 0],
      ['a/AGENTS.md', 'read', 0],
      ['a/b/AGENTS.md', 'read', 4],
    ]);
    expect(chain).toMatchObject({ used: 10, total: 10 });
    expect(chain.cut).toBeUndefined();
  });

  it('cuts the file that crosses the budget and drops the files after it', () => {
    const chain = repoChain(
      {
        'AGENTS.md': 'x'.repeat(6),
        'a/AGENTS.md': 'y'.repeat(8),
        'a/b/AGENTS.md': 'z',
        'a/b/c/AGENTS.md': '   ',
      },
      'a/b/c',
      { maxBytes: 10 },
    );
    expect(steps(chain)).toEqual([
      ['AGENTS.md', 'read', 0],
      ['a/AGENTS.md', 'cut', 6, 4],
      ['a/b/AGENTS.md', 'dropped', 6],
      // Blank files stay blank after the cut: they would use no budget anyway.
      ['a/b/c/AGENTS.md', 'blank', 6],
    ]);
    expect(chain.cut?.path).toBe('a/AGENTS.md');
    expect(chain.dropped.map((file) => file.path)).toEqual(['a/b/AGENTS.md']);
    expect(chain).toMatchObject({ used: 10, total: 15 });
  });

  it('gives no budget to the file after the files above fill it exactly', () => {
    const chain = repoChain(
      { 'AGENTS.md': 'x'.repeat(10), 'a/AGENTS.md': 'y', 'a/b/AGENTS.md': 'z' },
      'a/b',
      { maxBytes: 10 },
    );
    expect(steps(chain)).toEqual([
      ['AGENTS.md', 'read', 0],
      ['a/AGENTS.md', 'cut', 10, 0],
      ['a/b/AGENTS.md', 'dropped', 10],
    ]);
  });

  it('carries the budget over when the kept bytes of the crossing file are only whitespace', () => {
    const chain = repoChain(
      {
        'AGENTS.md': 'x'.repeat(4),
        'a/AGENTS.md': `${' '.repeat(8)}content`,
        'a/b/AGENTS.md': 'y'.repeat(5),
        'a/b/c/AGENTS.md': 'zzz',
      },
      'a/b/c',
      { maxBytes: 10 },
    );
    expect(steps(chain)).toEqual([
      ['AGENTS.md', 'read', 0],
      ['a/AGENTS.md', 'cut-blank', 4, 6],
      ['a/b/AGENTS.md', 'read', 4],
      ['a/b/c/AGENTS.md', 'cut', 9, 1],
    ]);
    expect(chain.cut?.path).toBe('a/b/c/AGENTS.md');
    expect(chain.dropped).toEqual([]);
    expect(chain).toMatchObject({ used: 10, total: 27 });
  });

  it('stops before a directory whose file exists but was not read', () => {
    const chain = repoChain(
      { 'AGENTS.md': 'root\n', 'pkg/AGENTS.md': 'pkg\n', 'pkg/x/AGENTS.md': 'x\n' },
      'pkg/x',
      undefined,
      { ignoredFiles: ['pkg/AGENTS.override.md'] },
    );
    expect(steps(chain)).toEqual([['AGENTS.md', 'read', 0]]);
    expect(chain.unknownAt).toBe('pkg');
  });

  it('stops before a directory whose contents were not listed', () => {
    const chain = repoChain({ 'AGENTS.md': 'root\n' }, 'vendor/lib', undefined, {
      opaqueDirectories: ['vendor/'],
    });
    expect(steps(chain)).toEqual([['AGENTS.md', 'read', 0]]);
    expect(chain.unknownAt).toBe('vendor');
  });

  it('opens a symlinked file by the path Codex reaches it through', () => {
    const chain = repoChain(
      { 'AGENTS.md': 'shared\n', 'pkg/AGENTS.md': 'shared\n' },
      'pkg',
      undefined,
      { symlinks: { 'pkg/AGENTS.md': 'AGENTS.md' } },
    );
    expect(chain.files.map((file) => [file.path, file.artifact.path])).toEqual([
      ['AGENTS.md', 'AGENTS.md'],
      ['pkg/AGENTS.md', 'AGENTS.md'],
    ]);
  });

  it('finds no file whose name differs only in case', () => {
    const chain = repoChain({ 'Agents.md': 'root\n', 'pkg/agents.override.md': 'pkg\n' }, 'pkg');
    expect(chain.files).toEqual([]);
    expect(chain).toMatchObject({ used: 0, total: 0, dropped: [] });
  });
});
