/**
 * The tree changing while it is walked: an entry swapped between listing and lstat, or a file
 * swapped between lstat and open. The isCandidate callback runs at exactly those points (after
 * listing for files; after symlink resolution and before the read for links), so these tests can
 * swap entries deterministically.
 */
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { walk, type WalkOptions } from '../../src/io/walk.js';
import {
  canDenyPermissions,
  fifosSupported,
  filePaths,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  serializeSnapshot,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const SECRET = 'AGENTCHECK_RACE_SECRET_92b1f0';

/** Runs `swap` the first time `trigger` is offered to isCandidate; only `wanted` is a candidate. */
function swapWhen(trigger: string, swap: () => void, wanted = trigger): WalkOptions {
  let done = false;
  return {
    isCandidate: (relativePath) => {
      if (!done && relativePath === trigger) {
        done = true;
        swap();
      }
      return relativePath === wanted;
    },
  };
}

async function outsideSecret(): Promise<string> {
  const outside = await makeTempDir('agentcheck-outside-');
  await writeTree(outside, { 'secret.md': SECRET });
  return path.join(outside, 'secret.md');
}

describe('walk: entries replaced after listing', () => {
  it('reports a candidate deleted after listing as unreadable', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'x' });
    const target = path.join(root, 'AGENTS.md');
    const snapshot = await walk(
      root,
      swapWhen('AGENTS.md', () => {
        rmSync(target);
      }),
    );
    expect(snapshot.skipped).toEqual([{ path: 'AGENTS.md', reason: 'unreadable' }]);
  });

  it.skipIf(!symlinksSupported)(
    'never reads through a candidate swapped for an outside symlink',
    async () => {
      const secret = await outsideSecret();
      const root = await makeTempDir();
      await writeTree(root, { 'AGENTS.md': 'x' });
      const target = path.join(root, 'AGENTS.md');
      const snapshot = await walk(
        root,
        swapWhen('AGENTS.md', () => {
          rmSync(target);
          symlinkSync(secret, target);
        }),
      );
      expect(snapshot.skipped).toEqual([{ path: 'AGENTS.md', reason: 'unreadable' }]);
      expect(serializeSnapshot(snapshot)).not.toContain(SECRET);
    },
  );

  it.skipIf(!fifosSupported)('never opens a candidate swapped for a FIFO', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'x' });
    const target = path.join(root, 'AGENTS.md');
    const snapshot = await walk(
      root,
      swapWhen('AGENTS.md', () => {
        rmSync(target);
        makeFifo(target);
      }),
    );
    expect(snapshot.skipped).toEqual([{ path: 'AGENTS.md', reason: 'special-file' }]);
  });

  it.skipIf(!symlinksSupported)('reports a symlink deleted after listing as broken', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'A.md': 'listed first', 'target.md': 'x' });
    await symlink('target.md', path.join(root, 'B.md'));
    const snapshot = await walk(
      root,
      swapWhen('A.md', () => {
        rmSync(path.join(root, 'B.md'));
      }),
    );
    expect(snapshot.unresolvedSymlinks).toEqual([{ path: 'B.md', target: '', problem: 'broken' }]);
  });
});

describe.skipIf(!symlinksSupported)('walk: link targets replaced between lstat and open', () => {
  async function linkedTree(): Promise<{ root: string; target: string }> {
    const root = await makeTempDir();
    await writeTree(root, { 'target.md': 'original' });
    await symlink('target.md', path.join(root, 'CLAUDE.md'));
    return { root, target: path.join(root, 'target.md') };
  }

  it('bounds a target that grew past maxFileBytes', async () => {
    const { root, target } = await linkedTree();
    const snapshot = await walk(root, {
      ...swapWhen('CLAUDE.md', () => {
        writeFileSync(target, 'x'.repeat(100));
      }),
      maxFileBytes: 50,
    });
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'too-large', size: 100 }]);
  });

  it('bounds a target that grew past the remaining byte budget', async () => {
    const { root, target } = await linkedTree();
    const snapshot = await walk(root, {
      ...swapWhen('CLAUDE.md', () => {
        writeFileSync(target, 'x'.repeat(100));
      }),
      maxTotalBytes: 50,
    });
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'byte-limit', size: 100 }]);
  });

  it('rejects a target replaced by another file (identity check)', async () => {
    const { root, target } = await linkedTree();
    const snapshot = await walk(
      root,
      swapWhen('CLAUDE.md', () => {
        rmSync(target);
        writeFileSync(target, 'replacement');
      }),
    );
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'unreadable' }]);
    expect(snapshot.files).toEqual([]);
  });

  it('never reads a target replaced by an outside symlink', async () => {
    const secret = await outsideSecret();
    const { root, target } = await linkedTree();
    const snapshot = await walk(
      root,
      swapWhen('CLAUDE.md', () => {
        rmSync(target);
        symlinkSync(secret, target);
      }),
    );
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'unreadable' }]);
    expect(serializeSnapshot(snapshot)).not.toContain(SECRET);
  });

  it('never reads through a parent directory replaced by an outside symlink', async () => {
    const outsideFile = await outsideSecret();
    const root = await makeTempDir();
    await writeTree(root, { 'docs/AGENTS.md': 'original' });
    await symlink('docs/AGENTS.md', path.join(root, 'CLAUDE.md'));
    // Same file name outside, so only the device/inode check can tell them apart.
    const outsideDir = path.join(path.dirname(outsideFile), 'docs');
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, 'AGENTS.md'), SECRET);
    const snapshot = await walk(
      root,
      swapWhen('CLAUDE.md', () => {
        rmSync(path.join(root, 'docs'), { recursive: true });
        symlinkSync(outsideDir, path.join(root, 'docs'));
      }),
    );
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'unreadable' }]);
    expect(serializeSnapshot(snapshot)).not.toContain(SECRET);
  });

  it.skipIf(!fifosSupported)('does not hang on a target replaced by a FIFO', async () => {
    const { root, target } = await linkedTree();
    const started = performance.now();
    const snapshot = await walk(
      root,
      swapWhen('CLAUDE.md', () => {
        rmSync(target);
        makeFifo(target);
      }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'special-file' }]);
  });
});

describe('walk: unreadable .gitignore', () => {
  it.skipIf(!canDenyPermissions)('reports it and walks on without its rules', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '.gitignore': 'AGENTS.md\n', 'AGENTS.md': 'x' });
    const gitignore = path.join(root, '.gitignore');
    await chmod(gitignore, 0o000);
    try {
      const snapshot = await walk(root);
      expect(filePaths(snapshot)).toEqual(['AGENTS.md']);
      expect(snapshot.skipped).toEqual([{ path: '.gitignore', reason: 'unreadable' }]);
    } finally {
      await chmod(gitignore, 0o600);
      await rm(gitignore);
    }
  });
});
