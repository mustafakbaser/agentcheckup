import { mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { walk } from '../../src/io/walk.js';
import {
  fifosSupported,
  filePaths,
  isWindows,
  link,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  serializeSnapshot,
  symlinksSupported,
  textOf,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

/** On macOS the temp dir is under /var, a symlink to /private/var. */
const tmpdirIsAliased = (await realpath(os.tmpdir())) !== path.resolve(os.tmpdir());

const describeSymlinks = describe.skipIf(!symlinksSupported);

describeSymlinks('walk: symlinks inside the root', () => {
  it('reads a file symlink and records its target (CLAUDE.md -> AGENTS.md)', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': '# shared instructions' });
    await link(root, 'CLAUDE.md', 'AGENTS.md');
    await link(root, '.github/copilot-instructions.md', '../AGENTS.md');

    const snapshot = await walk(root);

    expect(snapshot.files).toEqual([
      {
        path: '.github/copilot-instructions.md',
        bytes: expect.any(Uint8Array) as unknown,
        symlinkTarget: 'AGENTS.md',
      },
      { path: 'AGENTS.md', bytes: expect.any(Uint8Array) as unknown },
      { path: 'CLAUDE.md', bytes: expect.any(Uint8Array) as unknown, symlinkTarget: 'AGENTS.md' },
    ]);
    expect(textOf(snapshot, 'CLAUDE.md')).toBe('# shared instructions');
    expect(snapshot.paths.has('CLAUDE.md')).toBe(true);
    expect(snapshot.unresolvedSymlinks).toEqual([]);
  });

  it('resolves chains of links and links through linked directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'docs/agents/main.md': 'main' });
    await link(root, 'shared', 'docs/agents');
    await link(root, 'step', 'shared/main.md');
    await link(root, 'AGENTS.md', 'step');
    const snapshot = await walk(root);
    expect(snapshot.files.find((file) => file.path === 'AGENTS.md')?.symlinkTarget).toBe(
      'docs/agents/main.md',
    );
  });

  it('accepts absolute links that point into the root, by real or given path', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'x' });
    const { realpath } = await import('node:fs/promises');
    const realRoot = await realpath(root);
    await link(root, 'CLAUDE.md', path.join(root, 'AGENTS.md'));
    await link(root, 'GEMINI.md', path.join(realRoot, 'AGENTS.md'));
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
    expect(snapshot.unresolvedSymlinks).toEqual([]);
  });

  it.skipIf(!tmpdirIsAliased)(
    'accepts links that spell the root with a system alias (/var for /private/var)',
    async () => {
      const root = await makeTempDir();
      const realRoot = await realpath(root);
      await writeTree(root, { 'AGENTS.md': 'x' });
      // The link uses the alias spelling; the scan is started with the real path.
      await link(root, 'CLAUDE.md', path.join(root, 'AGENTS.md'));
      if (fifosSupported) {
        expect(makeFifo(path.join(root, 'pipe'))).toBe(true);
        await link(root, 'GEMINI.md', path.join(root, 'pipe'));
      }
      const snapshot = await walk(realRoot);
      expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'CLAUDE.md']);
      expect(snapshot.unresolvedSymlinks).toEqual(
        fifosSupported
          ? [{ path: 'GEMINI.md', target: path.join(root, 'pipe'), problem: 'not-a-regular-file' }]
          : [],
      );
    },
  );

  it('descends into a directory symlink and reports paths under the link', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.agents/skills/demo/SKILL.md': '---\nname: demo\n---\n',
      '.agents/skills/demo/scripts/run.sh': 'echo',
    });
    await link(root, '.claude/skills', '../.agents/skills');
    await link(root, '.cursor/skills', '../.agents/skills');

    const snapshot = await walk(root);

    // Both the real tree and each alias are reported (agents load files by these paths), and
    // every alias names the real file so the engine can fold them into one artifact.
    expect(snapshot.files.map((file) => [file.path, file.symlinkTarget])).toEqual([
      ['.agents/skills/demo/SKILL.md', undefined],
      ['.claude/skills/demo/SKILL.md', '.agents/skills/demo/SKILL.md'],
      ['.cursor/skills/demo/SKILL.md', '.agents/skills/demo/SKILL.md'],
    ]);
    expect(snapshot.opaqueDirectories).toEqual(new Set());
    for (const expected of [
      '.claude/skills/',
      '.claude/skills/demo/',
      '.claude/skills/demo/scripts/run.sh',
      '.cursor/skills/demo/scripts/',
    ]) {
      expect(snapshot.paths.has(expected)).toBe(true);
    }
    expect(snapshot.paths.has('.claude/skills')).toBe(false);
  });

  it('names the real file for links inside linked directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'real/AGENTS.md': 'agents',
      'real/nested/CLAUDE.md': 'claude',
      'other/GEMINI.md': 'gemini',
    });
    await link(root, 'real/nested/GEMINI.md', '../../other/GEMINI.md');
    await link(root, 'alias', 'real');
    await link(root, 'alias2', 'alias/nested');

    const snapshot = await walk(root);

    expect(snapshot.files.map((file) => [file.path, file.symlinkTarget])).toEqual([
      ['alias/AGENTS.md', 'real/AGENTS.md'],
      ['alias/nested/CLAUDE.md', 'real/nested/CLAUDE.md'],
      ['alias/nested/GEMINI.md', 'other/GEMINI.md'],
      ['alias2/CLAUDE.md', 'real/nested/CLAUDE.md'],
      ['alias2/GEMINI.md', 'other/GEMINI.md'],
      ['other/GEMINI.md', undefined],
      ['real/AGENTS.md', undefined],
      ['real/nested/CLAUDE.md', undefined],
      ['real/nested/GEMINI.md', 'other/GEMINI.md'],
    ]);
  });

  it('does not descend into a directory symlink with an excluded name', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'packages/AGENTS.md': 'x' });
    await link(root, 'node_modules', 'packages');
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['packages/AGENTS.md']);
    expect(snapshot.paths.has('node_modules/')).toBe(true);
    expect(snapshot.opaqueDirectories).toEqual(new Set(['node_modules/']));
  });

  it('applies depth limits to linked directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'real/AGENTS.md': 'x' });
    await link(root, 'a/linked', '../real');
    const snapshot = await walk(root, { maxDepth: 1 });
    expect(snapshot.skipped).toEqual([{ path: 'a/linked/', reason: 'depth-limit' }]);
    expect(snapshot.opaqueDirectories).toEqual(new Set(['a/linked/']));
  });

  it('matches a symlink against .gitignore as a file, as git does', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '.gitignore': 'linked/\n', 'real/AGENTS.md': 'x' });
    await link(root, 'linked', 'real');
    const snapshot = await walk(root);
    // `linked/` matches directories only, and git stores a symlink as a file: the link is kept.
    expect(snapshot.paths.has('linked/')).toBe(true);
    // Git never looks below a symlink. Here, paths below it are matched as if the link were the
    // directory it is used as, so `linked/AGENTS.md` is ignored (it exists, but is not read).
    expect(snapshot.ignoredFiles).toEqual(new Set(['linked/AGENTS.md']));
    expect(filePaths(snapshot)).toEqual(['real/AGENTS.md']);
  });

  it('records an ignored symlink as an ignored file whose target is unknown', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '.gitignore': 'linked\n', 'real/AGENTS.md': 'x' });
    await link(root, 'linked', 'real');
    const snapshot = await walk(root);
    expect(snapshot.paths.has('linked')).toBe(false);
    expect(snapshot.paths.has('linked/')).toBe(false);
    expect(snapshot.ignoredFiles).toEqual(new Set(['linked']));
    expect(snapshot.opaqueDirectories).toEqual(new Set(['linked/']));
  });
});

describeSymlinks('walk: symlink loops', () => {
  it('reports file symlink cycles as broken', async () => {
    const root = await makeTempDir();
    await link(root, 'a.md', 'b.md');
    await link(root, 'b.md', 'a.md');
    await link(root, 'self.md', 'self.md');
    const snapshot = await walk(root);
    expect(snapshot.unresolvedSymlinks).toEqual([
      { path: 'a.md', target: 'b.md', problem: 'broken' },
      { path: 'b.md', target: 'a.md', problem: 'broken' },
      { path: 'self.md', target: 'self.md', problem: 'broken' },
    ]);
  });

  it('does not descend into a directory symlink to itself or an ancestor', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'sub/AGENTS.md': 'x' });
    await link(root, 'sub/up', '..');
    await link(root, 'sub/here', '.');
    await link(root, 'top', '.');
    const absoluteRoot = await import('node:fs/promises').then(({ realpath }) => realpath(root));
    await link(root, 'sub/deep/root', absoluteRoot);

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual(['sub/AGENTS.md']);
    // Their contents exist (they are the root and sub/) but are not listed under these paths.
    expect([...snapshot.opaqueDirectories]).toEqual([
      'sub/deep/root/',
      'sub/here/',
      'sub/up/',
      'top/',
    ]);
    expect([...snapshot.paths]).toEqual([
      'sub/',
      'sub/AGENTS.md',
      'sub/deep/',
      'sub/deep/root/',
      'sub/here/',
      'sub/up/',
      'top/',
    ]);
  });

  it('terminates on mutually linked directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'x/AGENTS.md': 'x', 'y/AGENTS.md': 'y' });
    await link(root, 'x/to-y', '../y');
    await link(root, 'y/to-x', '../x');

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual([
      'x/AGENTS.md',
      'x/to-y/AGENTS.md',
      'y/AGENTS.md',
      'y/to-x/AGENTS.md',
    ]);
    expect(snapshot.files.map((file) => file.symlinkTarget)).toEqual([
      undefined,
      'y/AGENTS.md',
      undefined,
      'x/AGENTS.md',
    ]);
    // The second hop leads back to a directory already on the walk path and is not entered.
    expect(snapshot.paths.has('x/to-y/to-x/')).toBe(true);
    expect(snapshot.paths.has('x/to-y/to-x/AGENTS.md')).toBe(false);
    expect([...snapshot.opaqueDirectories]).toEqual(['x/to-y/to-x/', 'y/to-x/to-y/']);
  });

  it('bounds exponential fan-out of directory links with the entry limit', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, 'd12'), { recursive: true });
    await writeFile(path.join(root, 'd12', 'AGENTS.md'), 'leaf');
    for (let level = 0; level < 12; level++) {
      await link(root, `d${level}/l`, `../d${level + 1}`);
      await link(root, `d${level}/r`, `../d${level + 1}`);
    }
    const snapshot = await walk(root, { maxEntries: 5000 });
    expect(snapshot.skipped.filter((entry) => entry.reason === 'file-limit')).toHaveLength(1);
  });
});

describeSymlinks('walk: symlinks that cannot be followed', () => {
  it('never reads a target outside the root, through any kind of link', async () => {
    const outside = await makeTempDir('agentcheck-outside-');
    const secret = 'AGENTCHECK_FAKE_SECRET_7f3a9c2e51d84b06';
    await writeTree(outside, {
      'secret.md': secret,
      'skills/evil/SKILL.md': secret,
      'AGENTS.md': secret,
    });
    const root = await makeTempDir();
    await writeTree(root, { 'README.md': 'inside' });
    const relativeOutside = path.relative(root, outside);

    await link(root, 'AGENTS.md', path.join(outside, 'secret.md'));
    await link(root, 'CLAUDE.md', `${relativeOutside}/secret.md`);
    await link(root, '.claude/skills', path.join(outside, 'skills'));
    await link(root, '.cursor', outside);
    await link(root, 'inner', outside);
    await link(root, 'GEMINI.md', 'inner/secret.md');
    await link(root, 'sub/AGENTS.md', '../../../../../../../../../../../../../../../etc/hosts');
    await link(root, '.windsurfrules', `../${path.basename(root)}/README.md`);

    const snapshot = await walk(root);
    const json = serializeSnapshot(snapshot);

    expect(json).not.toContain(secret);
    expect(json).not.toContain(Buffer.from(secret).toString('base64'));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.unresolvedSymlinks.map(({ path: p, problem }) => [p, problem])).toEqual([
      ['.claude/skills', 'outside-root'],
      ['.cursor', 'outside-root'],
      // Leaves the root and comes back: rejected, nothing outside is ever touched.
      ['.windsurfrules', 'outside-root'],
      ['AGENTS.md', 'outside-root'],
      ['CLAUDE.md', 'outside-root'],
      ['GEMINI.md', 'outside-root'],
      ['inner', 'outside-root'],
      ['sub/AGENTS.md', 'outside-root'],
    ]);
    expect(snapshot.paths.has('.cursor')).toBe(true);
    expect(snapshot.paths.has('.cursor/')).toBe(false);
    // Nothing is known below a link whose target was never looked at.
    expect([...snapshot.opaqueDirectories]).toEqual(
      snapshot.unresolvedSymlinks.map((entry) => `${entry.path}/`),
    );
    expect(snapshot.unresolvedSymlinks.find((entry) => entry.path === 'AGENTS.md')?.target).toBe(
      path.join(outside, 'secret.md'),
    );
  });

  it('classifies outside targets without checking whether they exist', async () => {
    const root = await makeTempDir();
    const missing = path.join(path.parse(root).root, 'agentcheck-does-not-exist', 'AGENTS.md');
    await link(root, 'AGENTS.md', missing);
    const snapshot = await walk(root);
    expect(snapshot.unresolvedSymlinks).toEqual([
      { path: 'AGENTS.md', target: missing, problem: 'outside-root' },
    ]);
  });

  it('reports broken links, including links through a file', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'x' });
    await link(root, 'CLAUDE.md', 'missing.md');
    await link(root, 'GEMINI.md', 'AGENTS.md/child');
    await link(root, '.cursorrules', 'AGENTS.md/');
    await link(root, 'notes.txt', 'nowhere');
    const snapshot = await walk(root);
    expect(snapshot.unresolvedSymlinks).toEqual([
      { path: '.cursorrules', target: 'AGENTS.md/', problem: 'broken' },
      { path: 'CLAUDE.md', target: 'missing.md', problem: 'broken' },
      { path: 'GEMINI.md', target: 'AGENTS.md/child', problem: 'broken' },
      { path: 'notes.txt', target: 'nowhere', problem: 'broken' },
    ]);
    expect(snapshot.paths.has('CLAUDE.md')).toBe(true);
    expect([...snapshot.opaqueDirectories]).toEqual([
      '.cursorrules/',
      'CLAUDE.md/',
      'GEMINI.md/',
      'notes.txt/',
    ]);
  });

  it.skipIf(isWindows)('sanitizes control characters in the reported link text', async () => {
    const root = await makeTempDir();
    await link(root, 'CLAUDE.md', 'evil\u001b[31m\nred‮txt.md');
    const snapshot = await walk(root);
    expect(snapshot.unresolvedSymlinks).toEqual([
      { path: 'CLAUDE.md', target: 'evil�[31m�red�txt.md', problem: 'broken' },
    ]);
  });

  it.skipIf(!fifosSupported)('reports a link to a FIFO as not a regular file', async () => {
    const root = await makeTempDir();
    expect(makeFifo(path.join(root, 'pipe'))).toBe(true);
    await link(root, 'AGENTS.md', 'pipe');
    const started = performance.now();
    const snapshot = await walk(root);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(snapshot.unresolvedSymlinks).toEqual([
      { path: 'AGENTS.md', target: 'pipe', problem: 'not-a-regular-file' },
    ]);
    expect(snapshot.files).toEqual([]);
    // The target was examined and is not a directory: nothing can exist below the link.
    expect(snapshot.opaqueDirectories).toEqual(new Set());
  });

  it('reports links that do not fit the limits like regular candidates', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'big.md': '0123456789', 'bin.md': new Uint8Array([0, 1]) });
    await link(root, 'AGENTS.md', 'big.md');
    await link(root, 'CLAUDE.md', 'bin.md');
    const snapshot = await walk(root, { maxFileBytes: 5 });
    expect(snapshot.skipped).toEqual([
      { path: 'AGENTS.md', reason: 'too-large', size: 10 },
      { path: 'CLAUDE.md', reason: 'binary', size: 2 },
    ]);
  });
});
