/**
 * The fix writer when the file system fails or refuses: no hard links (FAT, some network drives),
 * a failed flush, a file held open on Windows, permissions. File system calls are wrapped so a
 * test can make one of them fail; otherwise they behave as usual.
 */
import {
  chmod,
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceFile } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import {
  type CommitPoint,
  type FixWriteResult,
  writeFixes,
  type WriteStep,
} from '../../src/io/write-fix.js';
import {
  canDenyPermissions,
  isWindows,
  makeTempDir,
  removeTempDirs,
  writeTree,
} from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    mkdir: vi.fn(actual.mkdir),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

afterEach(async () => {
  for (const wrapped of [link, mkdir, open, rename, unlink]) vi.mocked(wrapped).mockReset();
  vi.restoreAllMocks();
  await removeTempDirs();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function systemError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

async function scanned(tree: Record<string, string>): Promise<{
  root: string;
  files: readonly SourceFile[];
}> {
  const root = await makeTempDir();
  await writeTree(root, tree);
  return { root, files: (await walk(root)).files };
}

async function writeOne(
  root: string,
  files: readonly SourceFile[],
  steps: readonly WriteStep[],
  beforeCommit?: (point: CommitPoint) => void,
): Promise<FixWriteResult> {
  const options = beforeCommit === undefined ? {} : { beforeCommit };
  const [result] = await writeFixes(root, files, [{ id: 'fix', steps }], options);
  return result!;
}

async function text(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split('/')), 'utf8');
}

async function entries(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }))
    .map((entry) => entry.split(path.sep).join('/'))
    .sort();
}

/** Makes FileHandle#sync fail on the calls `fail` picks; others sync as usual. */
async function failSync(root: string, fail: (call: number) => string | undefined): Promise<void> {
  const probe = await open(path.join(root, '.probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as { sync: (this: FileHandle) => Promise<void> };
  await probe.close();
  await unlink(path.join(root, '.probe'));
  const original = prototype.sync;
  let calls = 0;
  vi.spyOn(prototype, 'sync').mockImplementation(function (this: FileHandle) {
    const code = fail(++calls);
    return code === undefined ? original.call(this) : Promise.reject(systemError(code));
  });
}

describe('writeFixes without hard links', () => {
  it('refuses creates and renames, leaving nothing behind', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    vi.mocked(link).mockRejectedValue(systemError('EPERM'));
    const results = await writeFixes(root, files, [
      { id: 'create', steps: [{ kind: 'create', path: 'docs/sub/CLAUDE.md', bytes: bytes('x') }] },
      { id: 'rename', steps: [{ kind: 'rename', from: 'AGENTS.md', to: 'docs/AGENTS.md' }] },
    ]);
    expect(results).toEqual([
      {
        id: 'create',
        status: 'skipped',
        reason: 'refused-path',
        path: 'docs/sub/CLAUDE.md',
        detail: 'the file system does not allow a hard link here (EPERM)',
      },
      {
        id: 'rename',
        status: 'skipped',
        reason: 'refused-path',
        path: 'docs/AGENTS.md',
        detail: 'the file system does not allow a hard link here (EPERM)',
      },
    ]);
    // The directories made for them are removed again, and no temporary file is left.
    expect(await entries(root)).toEqual(['AGENTS.md']);
    expect(await text(root, 'AGENTS.md')).toBe('a');
  });

  it('reports other link errors as failed writes', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    vi.mocked(link).mockRejectedValueOnce(systemError('EIO'));
    expect(
      await writeOne(root, files, [{ kind: 'create', path: 'CLAUDE.md', bytes: bytes('x') }]),
    ).toEqual({
      id: 'fix',
      status: 'skipped',
      reason: 'write-failed',
      path: 'CLAUDE.md',
      detail: 'the file system reported EIO',
    });
    expect(await entries(root)).toEqual(['AGENTS.md']);
  });
});

describe('writeFixes when the file system fails', () => {
  it('keeps the file when flushing the new content fails', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    await failSync(root, (call) => (call === 1 ? 'EIO' : undefined));
    expect(
      await writeOne(root, files, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }]),
    ).toMatchObject({
      status: 'skipped',
      reason: 'write-failed',
      detail: 'the file system reported EIO',
    });
    expect(await entries(root)).toEqual(['AGENTS.md']);
    expect(await text(root, 'AGENTS.md')).toBe('a');
  });

  it.skipIf(isWindows)(
    'ignores a directory it cannot sync, but undoes a step whose sync fails',
    async () => {
      const { root, files } = await scanned({ 'AGENTS.md': 'a' });
      // Call 1 flushes the temporary file, call 2 the directory after the rename.
      await failSync(root, (call) => (call === 2 ? 'EINVAL' : undefined));
      expect(
        await writeOne(root, files, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }]),
      ).toEqual({ id: 'fix', status: 'applied' });
      expect(await text(root, 'AGENTS.md')).toBe('b');

      vi.restoreAllMocks();
      const again = await scanned({ 'AGENTS.md': 'a' });
      await failSync(again.root, (call) => (call === 2 ? 'EIO' : undefined));
      expect(
        await writeOne(again.root, again.files, [
          { kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') },
        ]),
      ).toEqual({
        id: 'fix',
        status: 'rolled-back',
        reason: 'write-failed',
        path: 'AGENTS.md',
        detail: 'the file system reported EIO',
        unrestored: [],
      });
      expect(await text(again.root, 'AGENTS.md')).toBe('a');
      expect(await entries(again.root)).toEqual(['AGENTS.md']);
    },
  );

  it('keeps the file when the rename fails, as when an editor holds it open on Windows', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    vi.mocked(rename).mockRejectedValueOnce(systemError('EBUSY'));
    expect(
      await writeOne(root, files, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }]),
    ).toMatchObject({
      status: 'skipped',
      reason: 'write-failed',
      detail: 'the file system reported EBUSY',
    });
    expect(await entries(root)).toEqual(['AGENTS.md']);
    expect(await text(root, 'AGENTS.md')).toBe('a');
  });

  it('puts a file back when its old name cannot be removed', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    // The writer works below the real root (on macOS, /private/var rather than /var).
    const source = path.join(await realpath(root), 'AGENTS.md');
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(unlink).mockImplementation(async (target) => {
      if (target === source) throw systemError('EBUSY');
      await actual.unlink(target);
    });
    expect(
      await writeOne(root, files, [{ kind: 'rename', from: 'AGENTS.md', to: 'docs/AGENTS.md' }]),
    ).toMatchObject({ status: 'skipped', reason: 'write-failed', path: 'docs/AGENTS.md' });
    expect(await entries(root)).toEqual(['AGENTS.md']);
  });

  it('reports a directory it cannot make', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    vi.mocked(mkdir).mockRejectedValueOnce(systemError('ENOSPC'));
    expect(
      await writeOne(root, files, [{ kind: 'create', path: 'docs/CLAUDE.md', bytes: bytes('x') }]),
    ).toMatchObject({
      status: 'skipped',
      reason: 'write-failed',
      detail: 'the file system reported ENOSPC',
    });
    expect(await entries(root)).toEqual(['AGENTS.md']);
  });

  it('lists the files it could not restore', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    const result = await writeOne(
      root,
      files,
      [
        { kind: 'replace', path: 'AGENTS.md', bytes: bytes('A') },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      (point) => {
        // The second step's rename fails, and so does the rename that would restore the first.
        if (point.path === 'CLAUDE.md') {
          vi.mocked(rename)
            .mockRejectedValueOnce(systemError('EIO'))
            .mockRejectedValueOnce(systemError('EIO'));
        }
      },
    );
    expect(result).toEqual({
      id: 'fix',
      status: 'rolled-back',
      reason: 'write-failed',
      path: 'CLAUDE.md',
      detail: 'the file system reported EIO',
      unrestored: ['AGENTS.md'],
    });
    expect(await text(root, 'AGENTS.md')).toBe('A');
    expect(await text(root, 'CLAUDE.md')).toBe('c');
    expect(await entries(root)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });
});

describe('writeFixes when the tree changes in a window a hook cannot reach', () => {
  it('refuses a file that became a symlink or disappeared between lstat and open', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    // The first open is the check of the file itself.
    vi.mocked(open).mockRejectedValueOnce(systemError('ELOOP'));
    expect(
      await writeOne(root, files, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }]),
    ).toMatchObject({ status: 'skipped', reason: 'refused-path', detail: 'it is a symbolic link' });
    vi.mocked(open).mockRejectedValueOnce(systemError('ENOENT'));
    expect(
      await writeOne(root, files, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }]),
    ).toMatchObject({ status: 'skipped', reason: 'changed-since-scan', detail: 'it is gone' });
    expect(await text(root, 'AGENTS.md')).toBe('a');
  });

  it('moves nothing when the new name leads to another file after link()', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'other.txt': 'o' });
    const real = await realpath(root);
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    // As if a symlink swapped in at the source made link() name another file.
    vi.mocked(link).mockImplementationOnce((_existing, target) =>
      actual.link(path.join(real, 'other.txt'), target),
    );
    expect(
      await writeOne(root, files, [{ kind: 'rename', from: 'AGENTS.md', to: 'docs/AGENTS.md' }]),
    ).toMatchObject({
      status: 'skipped',
      reason: 'changed-since-scan',
      path: 'docs/AGENTS.md',
      detail: 'another file replaced it during the change',
    });
    expect(await entries(root)).toEqual(['AGENTS.md', 'other.txt']);
  });

  it('reports a step that fails without an error code', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    expect(
      await writeOne(
        root,
        files,
        [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }],
        () => {
          throw new Error('interrupted');
        },
      ),
    ).toMatchObject({ status: 'skipped', reason: 'write-failed', detail: 'writing failed' });
    expect(await entries(root)).toEqual(['AGENTS.md']);
  });

  it('writes where a directory cannot be opened to sync it, as on Windows', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    const real = await realpath(root);
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    let code = 'EISDIR';
    vi.mocked(open).mockImplementation((target, ...rest) =>
      target === real ? Promise.reject(systemError(code)) : actual.open(target, ...rest),
    );
    expect(
      await writeOne(root, files, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('b') }]),
    ).toEqual({ id: 'fix', status: 'applied' });
    expect(await text(root, 'AGENTS.md')).toBe('b');
    code = 'EIO';
    expect(
      await writeOne(root, files, [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') }]),
    ).toMatchObject({ status: 'rolled-back', reason: 'write-failed', unrestored: [] });
    expect(await text(root, 'CLAUDE.md')).toBe('c');
  });
});

describe.skipIf(!canDenyPermissions)('writeFixes without permission', () => {
  it('reports files and directories it may not read or write', async () => {
    const { root, files } = await scanned({
      'AGENTS.md': 'a',
      'locked/AGENTS.md': 'b',
      'readonly/AGENTS.md': 'c',
    });
    await chmod(path.join(root, 'AGENTS.md'), 0o200);
    await chmod(path.join(root, 'locked'), 0o000);
    await chmod(path.join(root, 'readonly'), 0o500);
    try {
      const results = await writeFixes(root, files, [
        { id: 'unreadable', steps: [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('x') }] },
        { id: 'locked', steps: [{ kind: 'replace', path: 'locked/AGENTS.md', bytes: bytes('x') }] },
        {
          id: 'readonly',
          steps: [{ kind: 'replace', path: 'readonly/AGENTS.md', bytes: bytes('x') }],
        },
        { id: 'create', steps: [{ kind: 'create', path: 'locked/CLAUDE.md', bytes: bytes('x') }] },
        {
          id: 'create below',
          steps: [{ kind: 'create', path: 'locked/sub/CLAUDE.md', bytes: bytes('x') }],
        },
      ]);
      const denied = {
        status: 'skipped',
        reason: 'write-failed',
        detail: 'the file system reported EACCES',
      };
      expect(results).toMatchObject([denied, denied, denied, denied, denied]);
    } finally {
      await chmod(path.join(root, 'AGENTS.md'), 0o600);
      await chmod(path.join(root, 'locked'), 0o700);
      await chmod(path.join(root, 'readonly'), 0o700);
    }
    expect(await text(root, 'readonly/AGENTS.md')).toBe('c');
    expect(await entries(path.join(root, 'readonly'))).toEqual(['AGENTS.md']);
  });
});
