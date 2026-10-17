/**
 * The fix writer (src/io/write-fix.ts, docs/adr/0008) against hostile trees and trees that
 * change after the scan. Each test walks a real directory, so the writer gets the identities the
 * walker records, then changes the tree before or during the write.
 */
import { constants, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import {
  chmod,
  link as hardLink,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { SourceFile } from '../../src/core/types.js';
import type { FixSkipReason } from '../../src/fix/index.js';
import { walk } from '../../src/io/walk.js';
import {
  type CommitPoint,
  type FixWrite,
  type FixWriteReason,
  type FixWriteResult,
  FixWriteError,
  MAX_FIXES_PER_RUN,
  MAX_WRITTEN_FILE_BYTES,
  pathRefusal,
  writeFixes,
  type WriteStep,
} from '../../src/io/write-fix.js';
import { snapshotFrom } from '../helpers/lint.js';
import {
  fifosSupported,
  isWindows,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  type Tree,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const SECRET = 'AGENTCHECKUP_WRITE_SECRET_5d02c1';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A temporary repository with `tree`, and the files the walker read from it. */
async function scanned(tree: Tree): Promise<{ root: string; files: readonly SourceFile[] }> {
  const root = await makeTempDir();
  await writeTree(root, tree);
  return { root, files: (await walk(root)).files };
}

function at(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

async function text(root: string, relativePath: string): Promise<string> {
  return readFile(at(root, relativePath), 'utf8');
}

/** Every entry below `root`, directories with a trailing slash; temporary files would show. */
async function listing(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => {
      const relative = path.relative(root, path.join(entry.parentPath, entry.name));
      const posix = relative.split(path.sep).join('/');
      return entry.isDirectory() ? `${posix}/` : posix;
    })
    .sort();
}

async function writeOne(
  root: string,
  files: readonly SourceFile[],
  steps: readonly WriteStep[],
  beforeCommit?: (point: CommitPoint) => void | Promise<void>,
): Promise<FixWriteResult> {
  const fix: FixWrite = { id: 'rule/id#variant', steps };
  const options = beforeCommit === undefined ? {} : { beforeCommit };
  const [result] = await writeFixes(root, files, [fix], options);
  return result!;
}

/** A file outside every repository, which no write may reach. */
async function outsideFile(): Promise<{ directory: string; file: string }> {
  const directory = await makeTempDir('agentcheckup-outside-');
  await writeTree(directory, { 'target.md': SECRET });
  return { directory, file: path.join(directory, 'target.md') };
}

/** Runs `swap` the first time a step reaches `kind` at `relativePath`. */
function when(
  kind: CommitPoint['kind'],
  relativePath: string,
  swap: () => void | Promise<void>,
): (point: CommitPoint) => Promise<void> {
  let done = false;
  return async (point) => {
    if (done || point.kind !== kind || point.path !== relativePath) return;
    done = true;
    await swap();
  };
}

describe('pathRefusal', () => {
  it('accepts normalized relative paths', () => {
    for (const ok of [
      'AGENTS.md',
      '.cursor/rules/style.mdc',
      '.github/instructions/a b.instructions.md',
      'docs/ünïcode/ş.md',
      'console.md',
      'auxiliary/x.md',
      'com10.md',
      'lpt.md',
      'nul-check.md',
      '.gitignore',
      '.github/x.md',
      'a/.git-keep',
    ]) {
      expect(pathRefusal(ok), ok).toBeUndefined();
    }
  });

  it('refuses paths that leave the root or are not normalized', () => {
    for (const bad of [
      '',
      '..',
      '../escape.md',
      'docs/../../escape.md',
      'docs/..',
      './AGENTS.md',
      'docs/./AGENTS.md',
      'docs//AGENTS.md',
      'docs/',
      '/etc/passwd',
      '//server/share/x.md',
      'C:/Windows/x.md',
      'c:x.md',
      '\\\\server\\share\\x.md',
      'docs\\x.md',
      'a'.repeat(4097),
    ]) {
      expect(pathRefusal(bad), bad).toBeDefined();
    }
  });

  it('refuses NUL, control characters and characters Windows treats specially', () => {
    for (const bad of [
      'a\0b.md',
      'a\nb.md',
      'a\u001bb.md',
      'AGENTS.md:stream',
      'a<b.md',
      'a>b.md',
      'a"b.md',
      'a|b.md',
      'a?.md',
      'a*.md',
    ]) {
      expect(pathRefusal(bad), JSON.stringify(bad)).toBeDefined();
    }
  });

  it('refuses Windows device names with any extension, in any directory, in any case', () => {
    for (const bad of [
      'aux',
      'aux.md',
      'AUX.MD',
      'docs/Con.txt',
      'nul',
      'nul.tar.gz',
      'prn.md',
      'com1.md',
      'COM9',
      'com0.md',
      'lpt1.md',
      'LPT9.x',
      'com¹.md',
      'lpt³',
      'conin$',
      'CONOUT$.md',
      'aux .md',
      'aux/x.md',
    ]) {
      expect(pathRefusal(bad), bad).toMatch(/reserved on Windows/);
    }
  });

  it('refuses names with a trailing dot or space, which Windows drops', () => {
    for (const bad of ['CLAUDE.md.', 'CLAUDE.md ', 'docs./x.md', 'docs /x.md', 'x...']) {
      expect(pathRefusal(bad), bad).toMatch(/ends with a dot or a space/);
    }
  });

  it('refuses anything inside .git, however it is spelled', () => {
    for (const bad of [
      '.git',
      '.git/hooks/pre-commit',
      '.GIT/config',
      'sub/.Git/hooks/post-checkout',
      '.g\u200cit/hooks/pre-commit',
      '\ufeff.git/config',
      'GIT~1/config',
    ]) {
      expect(pathRefusal(bad), JSON.stringify(bad)).toMatch(/inside \.git/);
    }
  });
});

describe('writeFixes: applying', () => {
  it('replaces a file and leaves no temporary file', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '# Claude\n' });
    const result = await writeOne(root, files, [
      { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('@AGENTS.md\n\n# Claude\n') },
    ]);
    expect(result).toEqual({ id: 'rule/id#variant', status: 'applied' });
    expect(await text(root, 'CLAUDE.md')).toBe('@AGENTS.md\n\n# Claude\n');
    expect(await text(root, 'AGENTS.md')).toBe('# Rules\n');
    expect(await listing(root)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('creates a file, making its directories one at a time', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': '# Rules\n' });
    const made: string[] = [];
    const result = await writeOne(
      root,
      files,
      [{ kind: 'create', path: 'packages/api/CLAUDE.md', bytes: bytes('@AGENTS.md\n') }],
      (point) => {
        made.push(`${point.kind} ${point.path}`);
      },
    );
    expect(result.status).toBe('applied');
    expect(made).toEqual(['mkdir packages', 'mkdir packages/api', 'create packages/api/CLAUDE.md']);
    expect(await text(root, 'packages/api/CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await listing(root)).toEqual([
      'AGENTS.md',
      'packages/',
      'packages/api/',
      'packages/api/CLAUDE.md',
    ]);
  });

  it('renames a file and edits it under the new name', async () => {
    const { root, files } = await scanned({ '.cursor/rules/style.md': 'Use tabs.\n' });
    const result = await writeOne(root, files, [
      { kind: 'rename', from: '.cursor/rules/style.md', to: '.cursor/rules/style.mdc' },
      {
        kind: 'replace',
        path: '.cursor/rules/style.mdc',
        bytes: bytes('---\nalwaysApply: true\n---\nUse tabs.\n'),
      },
    ]);
    expect(result.status).toBe('applied');
    expect(await listing(root)).toEqual(['.cursor/', '.cursor/rules/', '.cursor/rules/style.mdc']);
    expect(await text(root, '.cursor/rules/style.mdc')).toBe(
      '---\nalwaysApply: true\n---\nUse tabs.\n',
    );
  });

  it('moves the file itself on a rename, into new directories', async () => {
    const { root, files } = await scanned({ 'GEMINI.md': 'x' });
    const inode = (await lstat(at(root, 'GEMINI.md'), { bigint: true })).ino;
    const result = await writeOne(root, files, [
      { kind: 'rename', from: 'GEMINI.md', to: 'docs/agents/GEMINI.md' },
    ]);
    expect(result.status).toBe('applied');
    expect(await listing(root)).toEqual(['docs/', 'docs/agents/', 'docs/agents/GEMINI.md']);
    expect((await lstat(at(root, 'docs/agents/GEMINI.md'), { bigint: true })).ino).toBe(inode);
  });

  it('lets a later fix change what an earlier fix wrote, and nothing else', async () => {
    const { root, files } = await scanned({ 'CLAUDE.md': 'one\n' });
    const results = await writeFixes(root, files, [
      { id: 'a', steps: [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('two\n') }] },
      { id: 'b', steps: [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('three\n') }] },
      { id: 'c', steps: [{ kind: 'rename', from: 'CLAUDE.md', to: 'docs/CLAUDE.md' }] },
      { id: 'd', steps: [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('four\n') }] },
      { id: 'e', steps: [{ kind: 'create', path: 'CLAUDE.md', bytes: bytes('five\n') }] },
    ]);
    expect(results).toEqual([
      { id: 'a', status: 'applied' },
      { id: 'b', status: 'applied' },
      { id: 'c', status: 'applied' },
      {
        id: 'd',
        status: 'skipped',
        reason: 'changed-since-scan',
        path: 'CLAUDE.md',
        detail: 'an earlier change moved or removed it',
      },
      { id: 'e', status: 'applied' },
    ]);
    expect(await text(root, 'docs/CLAUDE.md')).toBe('three\n');
    expect(await text(root, 'CLAUDE.md')).toBe('five\n');
  });

  it.skipIf(!symlinksSupported)(
    'writes to the real root when the root is given through a symlink',
    async () => {
      const { root, files } = await scanned({ 'CLAUDE.md': 'old' });
      const parent = await makeTempDir();
      const alias = path.join(parent, 'repo');
      await symlink(root, alias, 'dir');
      const result = await writeOne(alias, files, [
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('new') },
      ]);
      expect(result.status).toBe('applied');
      expect(await text(root, 'CLAUDE.md')).toBe('new');
    },
  );

  it('throws only for an unusable root', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'file.md': '' });
    await expect(writeFixes(path.join(root, 'missing'), [], [])).rejects.toThrow(
      /Cannot write fixes to .*: it does not exist/,
    );
    await expect(writeFixes(path.join(root, 'file.md'), [], [])).rejects.toThrow(
      new FixWriteError(
        `Cannot write fixes to ${path.join(root, 'file.md')}: it is not a directory`,
      ),
    );
  });

  it('reports with the reasons of the fix plan', () => {
    expectTypeOf<FixWriteReason>().toExtend<FixSkipReason>();
  });
});

describe('writeFixes: confinement', () => {
  it.skipIf(!symlinksSupported)(
    'never writes a file the scan reached through a symlink',
    async () => {
      const { root } = await scanned({ 'AGENTS.md': 'shared' });
      await symlink('AGENTS.md', at(root, 'CLAUDE.md'));
      const { files } = await walk(root);
      expect(files.find((file) => file.path === 'CLAUDE.md')?.symlinkTarget).toBe('AGENTS.md');
      const result = await writeOne(root, files, [
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('@AGENTS.md\n') },
      ]);
      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        path: 'CLAUDE.md',
        detail: 'the scan reached it through a symbolic link',
      });
      expect(await text(root, 'AGENTS.md')).toBe('shared');
      expect((await lstat(at(root, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(!symlinksSupported)('refuses a file swapped for a symlink after the scan', async () => {
    const outside = await outsideFile();
    const { root, files } = await scanned({ 'CLAUDE.md': 'scanned' });
    rmSync(at(root, 'CLAUDE.md'));
    symlinkSync(outside.file, at(root, 'CLAUDE.md'));
    const result = await writeOne(root, files, [
      { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('new') },
    ]);
    // Windows has no O_NOFOLLOW: the link is followed, and the file it leads to is not the one
    // the scan recorded.
    expect(result).toMatchObject(
      (constants as Partial<typeof constants>).O_NOFOLLOW === undefined
        ? {
            status: 'skipped',
            reason: 'changed-since-scan',
            detail: 'another file replaced it since the scan',
          }
        : { status: 'skipped', reason: 'refused-path', detail: 'it is a symbolic link' },
    );
    expect(await readFile(outside.file, 'utf8')).toBe(SECRET);
  });

  it.skipIf(!symlinksSupported)(
    'refuses a symlinked parent directory, inside the root too',
    async () => {
      const { root } = await scanned({
        '.agents/skills/notes/SKILL.md': '---\nname: notes\n---\n',
      });
      await mkdir(at(root, '.claude'));
      await symlink('../.agents/skills', at(root, '.claude/skills'), 'dir');
      const { files } = await walk(root);
      expect(
        files.find((file) => file.path === '.claude/skills/notes/SKILL.md')?.symlinkTarget,
      ).toBe('.agents/skills/notes/SKILL.md');
      const result = await writeOne(root, files, [
        { kind: 'replace', path: '.claude/skills/notes/SKILL.md', bytes: bytes('changed') },
      ]);
      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        detail: 'the scan reached it through a symbolic link',
      });
      const created = await writeOne(root, files, [
        { kind: 'create', path: '.claude/skills/new/SKILL.md', bytes: bytes('new') },
      ]);
      expect(created).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        detail: '.claude/skills is a symbolic link',
      });
      expect(await listing(at(root, '.agents'))).toEqual([
        'skills/',
        'skills/notes/',
        'skills/notes/SKILL.md',
      ]);
    },
  );

  it.skipIf(!symlinksSupported)(
    'refuses a parent directory swapped for a symlink after the scan',
    async () => {
      const outside = await outsideFile();
      const { root, files } = await scanned({ '.cursor/rules/style.mdc': 'scanned' });
      // The same name outside, so only the directory check tells them apart.
      await writeTree(outside.directory, { 'rules/style.mdc': 'scanned' });
      renameSync(at(root, '.cursor/rules'), at(root, '.cursor/rules-moved'));
      symlinkSync(path.join(outside.directory, 'rules'), at(root, '.cursor/rules'), 'dir');
      const result = await writeOne(root, files, [
        { kind: 'replace', path: '.cursor/rules/style.mdc', bytes: bytes('new') },
      ]);
      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        detail: '.cursor/rules is a symbolic link',
      });
      expect(await readFile(path.join(outside.directory, 'rules/style.mdc'), 'utf8')).toBe(
        'scanned',
      );
    },
  );

  it.skipIf(!symlinksSupported)(
    'refuses a symlinked directory at the top of the root',
    async () => {
      const outside = await outsideFile();
      const { root, files } = await scanned({ 'AGENTS.md': 'x' });
      await symlink(outside.directory, at(root, '.claude'), 'dir');
      const result = await writeOne(root, files, [
        { kind: 'create', path: '.claude/settings.json', bytes: bytes('{}') },
      ]);
      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        path: '.claude/settings.json',
        detail: '.claude is a symbolic link',
      });
      expect(await readdir(outside.directory)).toEqual(['target.md']);
    },
  );

  it.skipIf(!fifosSupported)(
    'never opens a FIFO, as a target or in place of a scanned file',
    async () => {
      const { root, files } = await scanned({ 'CLAUDE.md': 'scanned' });
      rmSync(at(root, 'CLAUDE.md'));
      expect(makeFifo(at(root, 'CLAUDE.md'))).toBe(true);
      expect(makeFifo(at(root, 'GEMINI.md'))).toBe(true);
      const started = performance.now();
      const results = await writeFixes(root, files, [
        { id: 'edit', steps: [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('new') }] },
        { id: 'create', steps: [{ kind: 'create', path: 'GEMINI.md', bytes: bytes('new') }] },
      ]);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(results).toMatchObject([
        { status: 'skipped', reason: 'refused-path', detail: 'it is not a regular file' },
        { status: 'skipped', reason: 'refused-path', detail: 'it already exists' },
      ]);
      expect((await lstat(at(root, 'CLAUDE.md'))).isFIFO()).toBe(true);
    },
  );

  // Decision: a file with more than one link is refused. rename() would give this name a new
  // file and leave the old content under the other names; writing in place would change every
  // name, including one outside the repository.
  it('refuses a hard-linked file, whether linked before or after the scan', async () => {
    const outside = await makeTempDir('agentcheckup-outside-');
    const { root } = await scanned({ 'AGENTS.md': 'shared', 'CLAUDE.md': 'own' });
    await hardLink(at(root, 'AGENTS.md'), path.join(outside, 'AGENTS.md'));
    const { files } = await walk(root);
    await hardLink(at(root, 'CLAUDE.md'), at(root, 'CLAUDE.copy'));
    const results = await writeFixes(root, files, [
      { id: 'before', steps: [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('new') }] },
      { id: 'after', steps: [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('new') }] },
      { id: 'rename', steps: [{ kind: 'rename', from: 'AGENTS.md', to: 'docs/AGENTS.md' }] },
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        detail: 'it has other hard links',
      });
    }
    expect(await readFile(path.join(outside, 'AGENTS.md'), 'utf8')).toBe('shared');
    expect(await text(root, 'AGENTS.md')).toBe('shared');
    expect(await text(root, 'CLAUDE.md')).toBe('own');
  });

  it('refuses names that are not allowed before touching the disk', async () => {
    const outside = await makeTempDir('agentcheckup-outside-');
    const root = path.join(outside, 'repo');
    await mkdir(root);
    await writeTree(root, { 'AGENTS.md': 'x' });
    const { files } = await walk(root);
    const targets = [
      'aux.md',
      'docs/NUL',
      'com1.txt',
      'CLAUDE.md.',
      'CLAUDE.md ',
      '../escape.md',
      'docs/../../escape.md',
      path.join(outside, 'absolute.md'),
      '/tmp/agentcheckup-absolute.md',
      'C:/agentcheckup.md',
      'AGENTS.md:stream',
      'a\0b.md',
      '.git/hooks/pre-commit',
    ];
    const results = await writeFixes(
      root,
      files,
      targets.flatMap((target) => [
        { id: `create ${target}`, steps: [{ kind: 'create', path: target, bytes: bytes(SECRET) }] },
        { id: `rename ${target}`, steps: [{ kind: 'rename', from: 'AGENTS.md', to: target }] },
      ]),
    );
    for (const result of results) {
      expect(result, result.id).toMatchObject({ status: 'skipped', reason: 'refused-path' });
    }
    expect(await listing(outside)).toEqual(['repo/', 'repo/AGENTS.md']);
    expect(await text(root, 'AGENTS.md')).toBe('x');
  });

  it('writes only files the scan read from disk, as it read them', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'x', 'notes.txt': 'not a candidate' });
    const inMemory = snapshotFrom({ 'AGENTS.md': 'x' }).files;
    const tampered = files.map((file) => ({ ...file, bytes: bytes('other') }));
    const results = [
      await writeOne(root, files, [{ kind: 'replace', path: 'notes.txt', bytes: bytes('y') }]),
      await writeOne(root, inMemory, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('y') }]),
      await writeOne(root, tampered, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('y') }]),
    ];
    expect(results.map((result) => 'detail' in result && result.detail)).toEqual([
      'the scan did not read it',
      'the scan did not read it from disk',
      'its scanned bytes do not match their hash',
    ]);
    expect(await text(root, 'AGENTS.md')).toBe('x');
  });

  it('refuses deletions, directory renames, case-only renames and renames onto themselves', async () => {
    const { root, files } = await scanned({
      'AGENTS.md': 'x',
      'docs/CLAUDE.md': 'y',
      '.cursor/rules/caf\u00e9.mdc': 'z',
    });
    const before = await listing(root);
    const results = await writeFixes(root, files, [
      { id: 'delete', steps: [{ kind: 'delete', path: 'AGENTS.md' } as unknown as WriteStep] },
      { id: 'directory', steps: [{ kind: 'rename', from: 'docs', to: 'documentation' }] },
      { id: 'case', steps: [{ kind: 'rename', from: 'AGENTS.md', to: 'agents.md' }] },
      {
        id: 'case below',
        steps: [{ kind: 'rename', from: 'docs/CLAUDE.md', to: 'Docs/claude.MD' }],
      },
      {
        // NFC to NFD: one name on macOS file systems.
        id: 'normalization',
        steps: [
          {
            kind: 'rename',
            from: '.cursor/rules/caf\u00e9.mdc',
            to: '.cursor/rules/cafe\u0301.mdc',
          },
        ],
      },
      { id: 'itself', steps: [{ kind: 'rename', from: 'AGENTS.md', to: 'AGENTS.md' }] },
      {
        id: 'moved before',
        steps: [
          { kind: 'rename', from: 'AGENTS.md', to: 'docs/AGENTS.md' },
          { kind: 'replace', path: 'AGENTS.md', bytes: bytes('y') },
        ],
      },
    ]);
    expect(results.map((result) => 'detail' in result && result.detail)).toEqual([
      'only edits, creates and renames of files are supported',
      'the scan did not read it',
      'case-only renames are not supported',
      'case-only renames are not supported',
      'case-only renames are not supported',
      'it would move the file onto itself',
      'an earlier change moved it',
    ]);
    expect(await listing(root)).toEqual(before);
  });

  it('refuses a parent that is a file', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'x' });
    expect(
      await writeOne(root, files, [
        { kind: 'create', path: 'AGENTS.md/CLAUDE.md', bytes: bytes('y') },
      ]),
    ).toMatchObject({
      status: 'skipped',
      reason: 'refused-path',
      detail: 'AGENTS.md is not a directory',
    });
  });

  it('follows a fix through files it creates and moves', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'x' });
    const result = await writeOne(root, files, [
      { kind: 'create', path: 'docs/a.md', bytes: bytes('first') },
      { kind: 'rename', from: 'docs/a.md', to: 'docs/b.md' },
      { kind: 'create', path: 'docs/a.md', bytes: bytes('second') },
      { kind: 'replace', path: 'docs/b.md', bytes: bytes('first, edited') },
    ]);
    expect(result.status).toBe('applied');
    expect(await listing(root)).toEqual(['AGENTS.md', 'docs/', 'docs/a.md', 'docs/b.md']);
    expect(await text(root, 'docs/a.md')).toBe('second');
    expect(await text(root, 'docs/b.md')).toBe('first, edited');
  });

  it('bounds written files at 1 MiB and fixes per run', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'x' });
    const results = await writeFixes(root, files, [
      {
        id: 'too large',
        steps: [
          { kind: 'replace', path: 'AGENTS.md', bytes: new Uint8Array(MAX_WRITTEN_FILE_BYTES + 1) },
        ],
      },
      {
        id: 'largest',
        steps: [
          { kind: 'create', path: 'CLAUDE.md', bytes: new Uint8Array(MAX_WRITTEN_FILE_BYTES) },
        ],
      },
    ]);
    expect(results).toEqual([
      {
        id: 'too large',
        status: 'skipped',
        reason: 'limit',
        path: 'AGENTS.md',
        detail: 'the new content is larger than 1048576 bytes',
      },
      { id: 'largest', status: 'applied' },
    ]);
    expect(await text(root, 'AGENTS.md')).toBe('x');
    expect((await stat(at(root, 'CLAUDE.md'))).size).toBe(MAX_WRITTEN_FILE_BYTES);

    const many = Array.from({ length: MAX_FIXES_PER_RUN + 1 }, (_, index) => ({
      id: String(index),
      steps: [],
    }));
    const outcome = await writeFixes(root, files, many);
    expect(outcome.filter((result) => result.status === 'applied')).toHaveLength(MAX_FIXES_PER_RUN);
    expect(outcome.at(-1)).toEqual({
      id: String(MAX_FIXES_PER_RUN),
      status: 'skipped',
      reason: 'limit',
      detail: 'more than 1000 fixes in one run',
    });
  });

  it.skipIf(isWindows)('keeps the permission bits of a replaced file', async () => {
    const { root } = await scanned({ 'AGENTS.md': 'x', '.claude/settings.json': '{}' });
    await chmod(at(root, 'AGENTS.md'), 0o640);
    await chmod(at(root, '.claude/settings.json'), 0o755);
    const { files } = await walk(root);
    const results = await writeFixes(root, files, [
      { id: 'a', steps: [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('y') }] },
      { id: 'b', steps: [{ kind: 'replace', path: '.claude/settings.json', bytes: bytes('{ }') }] },
    ]);
    expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
    expect((await stat(at(root, 'AGENTS.md'))).mode & 0o7777).toBe(0o640);
    expect((await stat(at(root, '.claude/settings.json'))).mode & 0o7777).toBe(0o755);
  });
});

describe('writeFixes: changes since the scan', () => {
  it('skips a file whose bytes changed, and leaves the new bytes alone', async () => {
    const { root, files } = await scanned({ 'CLAUDE.md': 'scanned' });
    await writeFile(at(root, 'CLAUDE.md'), 'edited by the user');
    const result = await writeOne(root, files, [
      { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('fixed') },
    ]);
    expect(result).toEqual({
      id: 'rule/id#variant',
      status: 'skipped',
      reason: 'changed-since-scan',
      path: 'CLAUDE.md',
      detail: 'its content changed since the scan',
    });
    expect(await text(root, 'CLAUDE.md')).toBe('edited by the user');
    // Same length, other bytes: the hash tells them apart.
    const sameSize = await scanned({ 'CLAUDE.md': 'scanned' });
    await writeFile(at(sameSize.root, 'CLAUDE.md'), 'Scanned');
    expect(
      await writeOne(sameSize.root, sameSize.files, [
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('fixed') },
      ]),
    ).toMatchObject({ reason: 'changed-since-scan', detail: 'its content changed since the scan' });
  });

  it('skips a file replaced by another one with the same bytes', async () => {
    const { root, files } = await scanned({ 'CLAUDE.md': 'scanned' });
    // Moved aside rather than deleted: Linux reuses a freed inode number at once, and a
    // replacement with the same inode would be indistinguishable.
    await rename(at(root, 'CLAUDE.md'), at(root, 'CLAUDE.old'));
    await writeFile(at(root, 'CLAUDE.md'), 'scanned');
    const result = await writeOne(root, files, [
      { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('fixed') },
    ]);
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'changed-since-scan',
      detail: 'another file replaced it since the scan',
    });
    expect(await text(root, 'CLAUDE.md')).toBe('scanned');
  });

  it('skips a file or directory that is gone', async () => {
    const { root, files } = await scanned({ 'CLAUDE.md': 'x', 'docs/AGENTS.md': 'y' });
    rmSync(at(root, 'CLAUDE.md'));
    rmSync(at(root, 'docs'), { recursive: true });
    const results = await writeFixes(root, files, [
      { id: 'file', steps: [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('new') }] },
      {
        id: 'directory',
        steps: [{ kind: 'replace', path: 'docs/AGENTS.md', bytes: bytes('new') }],
      },
    ]);
    expect(results).toMatchObject([
      { status: 'skipped', reason: 'changed-since-scan', detail: 'it is gone' },
      { status: 'skipped', reason: 'changed-since-scan', detail: 'its directory docs is gone' },
    ]);
    expect(await listing(root)).toEqual([]);
  });

  it('never replaces an existing create or rename target, nor one that appears in between', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'GEMINI.md': 'g' });
    await writeTree(root, { 'docs/existing.md': 'keep' });
    const before = await listing(root);
    const results = await writeFixes(root, files, [
      { id: 'scanned', steps: [{ kind: 'create', path: 'GEMINI.md', bytes: bytes(SECRET) }] },
      {
        id: 'on disk',
        steps: [{ kind: 'create', path: 'docs/existing.md', bytes: bytes(SECRET) }],
      },
      { id: 'rename', steps: [{ kind: 'rename', from: 'AGENTS.md', to: 'docs/existing.md' }] },
      { id: 'onto scanned', steps: [{ kind: 'rename', from: 'AGENTS.md', to: 'GEMINI.md' }] },
    ]);
    for (const result of results) {
      expect(result, result.id).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        detail: 'it already exists',
      });
    }
    expect(await listing(root)).toEqual(before);
    expect(await text(root, 'docs/existing.md')).toBe('keep');

    for (const step of [
      { kind: 'create', path: 'new/dir/CLAUDE.md', bytes: bytes(SECRET) },
      { kind: 'rename', from: 'AGENTS.md', to: 'new/dir/CLAUDE.md' },
    ] as const) {
      const raced = await writeOne(
        root,
        files,
        [step],
        when(step.kind, 'new/dir/CLAUDE.md', () => {
          writeFileSync(at(root, 'new/dir/CLAUDE.md'), 'appeared');
        }),
      );
      expect(raced).toMatchObject({
        status: 'skipped',
        reason: 'refused-path',
        path: 'new/dir/CLAUDE.md',
        detail: 'it already exists',
      });
      expect(await text(root, 'new/dir/CLAUDE.md')).toBe('appeared');
      expect(await text(root, 'AGENTS.md')).toBe('a');
      // No temporary file is left behind; the directories stay because they are not empty.
      expect(await readdir(at(root, 'new/dir'))).toEqual(['CLAUDE.md']);
      rmSync(at(root, 'new'), { recursive: true });
    }
  });

  it('accepts a directory that appears before mkdir, if it is a real directory', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    const result = await writeOne(
      root,
      files,
      [{ kind: 'create', path: 'docs/CLAUDE.md', bytes: bytes('new') }],
      when('mkdir', 'docs', () => mkdir(at(root, 'docs'))),
    );
    expect(result.status).toBe('applied');
    expect(await text(root, 'docs/CLAUDE.md')).toBe('new');
  });

  it.skipIf(!symlinksSupported)('refuses a symlink that appears before mkdir', async () => {
    const outside = await outsideFile();
    const { root, files } = await scanned({ 'AGENTS.md': 'a' });
    const result = await writeOne(
      root,
      files,
      [{ kind: 'create', path: 'docs/sub/CLAUDE.md', bytes: bytes(SECRET) }],
      when('mkdir', 'docs', () => symlink(outside.directory, at(root, 'docs'), 'dir')),
    );
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'refused-path',
      detail: 'docs is a symbolic link',
    });
    expect(await readdir(outside.directory)).toEqual(['target.md']);
  });

  it.skipIf(!symlinksSupported)(
    'a file swapped for a symlink after the last check is replaced, not followed',
    async () => {
      const outside = await outsideFile();
      const { root, files } = await scanned({ 'CLAUDE.md': 'scanned' });
      const result = await writeOne(
        root,
        files,
        [{ kind: 'replace', path: 'CLAUDE.md', bytes: bytes('fixed') }],
        when('replace', 'CLAUDE.md', () => {
          renameSync(at(root, 'CLAUDE.md'), at(root, 'CLAUDE.old'));
          symlinkSync(outside.file, at(root, 'CLAUDE.md'));
        }),
      );
      // rename() replaces the directory entry: the symlink is gone and nothing outside changed.
      expect(result.status).toBe('applied');
      expect((await lstat(at(root, 'CLAUDE.md'))).isFile()).toBe(true);
      expect(await text(root, 'CLAUDE.md')).toBe('fixed');
      expect(await readFile(outside.file, 'utf8')).toBe(SECRET);
    },
  );

  it.skipIf(!symlinksSupported)(
    'a parent swapped for a symlink after the last check makes the write fail',
    async () => {
      const outside = await outsideFile();
      const { root, files } = await scanned({ 'docs/AGENTS.md': 'scanned' });
      const result = await writeOne(
        root,
        files,
        [{ kind: 'replace', path: 'docs/AGENTS.md', bytes: bytes('fixed') }],
        when('replace', 'docs/AGENTS.md', () => {
          renameSync(at(root, 'docs'), at(root, 'docs-moved'));
          symlinkSync(outside.directory, at(root, 'docs'), 'dir');
        }),
      );
      // The temporary file stayed in the moved directory, so the rename finds nothing to move.
      // (Moving the directory out of the root as well is out of scope: see ADR 0008.)
      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'write-failed',
        path: 'docs/AGENTS.md',
      });
      expect(await readdir(outside.directory)).toEqual(['target.md']);
      expect(await readFile(outside.file, 'utf8')).toBe(SECRET);
      expect(await text(root, 'docs-moved/AGENTS.md')).toBe('scanned');
    },
  );
});

describe('writeFixes: one fix is all or nothing', () => {
  it('restores the files of a fix whose later step fails', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    const results = await writeFixes(
      root,
      files,
      [
        {
          id: 'both',
          steps: [
            { kind: 'replace', path: 'AGENTS.md', bytes: bytes('A') },
            { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
          ],
        },
        { id: 'later', steps: [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('later') }] },
      ],
      {
        beforeCommit: when('replace', 'AGENTS.md', () => {
          writeFileSync(at(root, 'CLAUDE.md'), 'changed meanwhile');
        }),
      },
    );
    expect(results).toEqual([
      {
        id: 'both',
        status: 'rolled-back',
        reason: 'changed-since-scan',
        path: 'CLAUDE.md',
        detail: 'its content changed since the scan',
        unrestored: [],
      },
      // The restored file is the run's new state of AGENTS.md: a later fix can change it.
      { id: 'later', status: 'applied' },
    ]);
    expect(await text(root, 'AGENTS.md')).toBe('later');
    expect(await text(root, 'CLAUDE.md')).toBe('changed meanwhile');
    expect(await listing(root)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it.skipIf(isWindows)('restores the content and permission bits of a replaced file', async () => {
    const { root } = await scanned({ 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    await chmod(at(root, 'AGENTS.md'), 0o640);
    const { files } = await walk(root);
    const first = await writeOne(
      root,
      files,
      [
        { kind: 'replace', path: 'AGENTS.md', bytes: bytes('A') },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      when('replace', 'AGENTS.md', () => {
        writeFileSync(at(root, 'CLAUDE.md'), 'changed meanwhile');
      }),
    );
    expect(first.status).toBe('rolled-back');
    expect(await text(root, 'AGENTS.md')).toBe('a');
    expect((await stat(at(root, 'AGENTS.md'))).mode & 0o7777).toBe(0o640);
    // The restored content is a new file (its inode number may or may not be reused): a new run
    // works from a new scan.
    const { files: rescanned } = await walk(root);
    expect(
      await writeOne(root, rescanned, [{ kind: 'replace', path: 'AGENTS.md', bytes: bytes('A') }]),
    ).toMatchObject({ status: 'applied' });
  });

  it('removes created files and directories, and moves renamed files back', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'GEMINI.md': 'g', 'CLAUDE.md': 'c' });
    const inode = (await lstat(at(root, 'GEMINI.md'), { bigint: true })).ino;
    const result = await writeOne(
      root,
      files,
      [
        { kind: 'create', path: 'packages/api/AGENTS.md', bytes: bytes('new') },
        { kind: 'rename', from: 'GEMINI.md', to: 'docs/GEMINI.md' },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      when('rename', 'docs/GEMINI.md', () => {
        writeFileSync(at(root, 'CLAUDE.md'), 'changed meanwhile');
      }),
    );
    expect(result).toMatchObject({
      status: 'rolled-back',
      reason: 'changed-since-scan',
      path: 'CLAUDE.md',
      unrestored: [],
    });
    expect(await listing(root)).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
    expect(await text(root, 'GEMINI.md')).toBe('g');
    expect((await lstat(at(root, 'GEMINI.md'), { bigint: true })).ino).toBe(inode);
  });

  it('undoes several changes to one file in reverse order', async () => {
    const { root, files } = await scanned({ 'GEMINI.md': 'g', 'CLAUDE.md': 'c' });
    const result = await writeOne(
      root,
      files,
      [
        { kind: 'replace', path: 'GEMINI.md', bytes: bytes('g2') },
        { kind: 'rename', from: 'GEMINI.md', to: 'docs/GEMINI.md' },
        { kind: 'replace', path: 'docs/GEMINI.md', bytes: bytes('g3') },
        { kind: 'create', path: 'docs/new.md', bytes: bytes('n') },
        { kind: 'replace', path: 'docs/new.md', bytes: bytes('n2') },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      when('replace', 'docs/new.md', () => {
        writeFileSync(at(root, 'CLAUDE.md'), 'changed meanwhile');
      }),
    );
    expect(result).toMatchObject({ status: 'rolled-back', path: 'CLAUDE.md', unrestored: [] });
    expect(await listing(root)).toEqual(['CLAUDE.md', 'GEMINI.md']);
    expect(await text(root, 'GEMINI.md')).toBe('g');
  });

  it('does not move a file back over one that took its old name', async () => {
    const { root, files } = await scanned({ 'GEMINI.md': 'g', 'CLAUDE.md': 'c' });
    const result = await writeOne(
      root,
      files,
      [
        { kind: 'rename', from: 'GEMINI.md', to: 'docs/GEMINI.md' },
        { kind: 'create', path: 'AGENTS.md', bytes: bytes('a') },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      when('create', 'AGENTS.md', () => {
        writeFileSync(at(root, 'GEMINI.md'), 'new file under the old name');
        writeFileSync(at(root, 'CLAUDE.md'), 'changed meanwhile');
      }),
    );
    expect(result).toMatchObject({
      status: 'rolled-back',
      path: 'CLAUDE.md',
      unrestored: ['docs/GEMINI.md'],
    });
    expect(await text(root, 'GEMINI.md')).toBe('new file under the old name');
    expect(await text(root, 'docs/GEMINI.md')).toBe('g');
    expect(await listing(root)).toEqual(['CLAUDE.md', 'GEMINI.md', 'docs/', 'docs/GEMINI.md']);
  });

  it('leaves a file alone when it no longer holds what the fix wrote', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    const result = await writeOne(
      root,
      files,
      [
        { kind: 'replace', path: 'AGENTS.md', bytes: bytes('A') },
        { kind: 'create', path: 'GEMINI.md', bytes: bytes('new') },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      when('create', 'GEMINI.md', () => {
        writeFileSync(at(root, 'AGENTS.md'), 'the user saved this');
        writeFileSync(at(root, 'CLAUDE.md'), 'and this');
      }),
    );
    expect(result).toMatchObject({
      status: 'rolled-back',
      reason: 'changed-since-scan',
      path: 'CLAUDE.md',
      unrestored: ['AGENTS.md'],
    });
    expect(await text(root, 'AGENTS.md')).toBe('the user saved this');
    expect(await listing(root)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('skips a fix that cannot apply without writing any of it', async () => {
    const { root, files } = await scanned({ 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    await writeFile(at(root, 'CLAUDE.md'), 'changed');
    const points: string[] = [];
    const result = await writeOne(
      root,
      files,
      [
        { kind: 'create', path: 'docs/new.md', bytes: bytes('n') },
        { kind: 'replace', path: 'AGENTS.md', bytes: bytes('A') },
        { kind: 'replace', path: 'CLAUDE.md', bytes: bytes('C') },
      ],
      (point) => {
        points.push(point.path);
      },
    );
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'changed-since-scan',
      path: 'CLAUDE.md',
    });
    expect(points).toEqual([]);
    expect(await listing(root)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });
});
