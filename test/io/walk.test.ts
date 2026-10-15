import { chmod, lstat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_WALK_LIMITS,
  HARD_EXCLUDED_DIRECTORIES,
  walk,
  WalkError,
} from '../../src/io/walk.js';
import {
  canDenyPermissions,
  fifosSupported,
  filePaths,
  isWindows,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  textOf,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const MiB = 1024 * 1024;

describe('walk: discovery and output shape', () => {
  it('reads candidates, lists every path and sorts by code point', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'AGENTS.md': '# root',
      'CLAUDE.md': 'claude',
      'README.md': 'not a config file',
      'src/index.ts': 'export {};',
      '.claude/settings.json': '{}',
      '.claude/skills/demo/SKILL.md': '---\nname: demo\n---\n',
      '.cursor/rules/style.mdc': 'rule',
      'packages/app/AGENTS.md': '# app',
      'a/b/GEMINI.md': 'gemini',
      'Zeta/AGENTS.md': 'upper-case directory sorts before lower-case',
    });
    await makeDirs(root, 'empty');

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual([
      '.claude/settings.json',
      '.claude/skills/demo/SKILL.md',
      '.cursor/rules/style.mdc',
      'AGENTS.md',
      'CLAUDE.md',
      'Zeta/AGENTS.md',
      'a/b/GEMINI.md',
      'packages/app/AGENTS.md',
    ]);
    expect(textOf(snapshot, 'AGENTS.md')).toBe('# root');
    expect([...snapshot.paths]).toEqual([
      '.claude/',
      '.claude/settings.json',
      '.claude/skills/',
      '.claude/skills/demo/',
      '.claude/skills/demo/SKILL.md',
      '.cursor/',
      '.cursor/rules/',
      '.cursor/rules/style.mdc',
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'Zeta/',
      'Zeta/AGENTS.md',
      'a/',
      'a/b/',
      'a/b/GEMINI.md',
      'empty/',
      'packages/',
      'packages/app/',
      'packages/app/AGENTS.md',
      'src/',
      'src/index.ts',
    ]);
    expect(snapshot.skipped).toEqual([]);
    expect(snapshot.unresolvedSymlinks).toEqual([]);
    expect(snapshot.opaqueDirectories).toEqual(new Set());
    expect(snapshot.ignoredFiles).toEqual(new Set());
    for (const file of snapshot.files) expect(file.symlinkTarget).toBeUndefined();
  });

  it('returns plain Uint8Array bytes with their own exact-size buffer', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'abc' });
    const [file] = (await walk(root)).files;
    expect(file?.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(file?.bytes)).toBe(false);
    expect(file?.bytes.buffer.byteLength).toBe(3);
  });

  it('is deterministic', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'b/AGENTS.md': 'b',
      'a/AGENTS.md': 'a',
      'c/d/e/CLAUDE.md': 'c',
      'x.txt': 'x',
    });
    const first = await walk(root);
    const second = await walk(root);
    expect(filePaths(second)).toEqual(filePaths(first));
    expect([...second.paths]).toEqual([...first.paths]);
  });

  it('reads an empty candidate', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': '' });
    const snapshot = await walk(root);
    expect(snapshot.files).toEqual([{ path: 'AGENTS.md', bytes: new Uint8Array() }]);
  });

  it('honors a custom isCandidate predicate', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'notes/todo.txt': 'todo', 'AGENTS.md': 'agents' });
    const seen: string[] = [];
    const snapshot = await walk(root, {
      isCandidate: (relativePath) => {
        seen.push(relativePath);
        return relativePath.endsWith('.txt');
      },
    });
    expect(filePaths(snapshot)).toEqual(['notes/todo.txt']);
    expect(seen.sort()).toEqual(['AGENTS.md', 'notes/todo.txt']);
  });
});

describe('walk: hard exclusions', () => {
  it('never lists excluded directories, at any depth, with or without .gitignore', async () => {
    const root = await makeTempDir();
    const tree: Record<string, string> = { 'AGENTS.md': 'mine' };
    for (const directory of HARD_EXCLUDED_DIRECTORIES) {
      tree[`${directory}/AGENTS.md`] = 'vendored';
      tree[`packages/app/${directory}/nested/SKILL.md`] = 'vendored';
    }
    tree['.claude/settings.json'] = '{}';
    tree['worktrees/AGENTS.md'] = 'not under .claude, so not excluded';
    tree['.git-templates/AGENTS.md'] = 'only exact names are excluded';
    await writeTree(root, tree);

    for (const respectGitignore of [true, false]) {
      const snapshot = await walk(root, { respectGitignore });
      expect(filePaths(snapshot)).toEqual([
        '.claude/settings.json',
        '.git-templates/AGENTS.md',
        'AGENTS.md',
        'worktrees/AGENTS.md',
      ]);
      expect(snapshot.opaqueDirectories).toEqual(
        new Set(
          HARD_EXCLUDED_DIRECTORIES.flatMap((directory) => [
            `${directory}/`,
            `packages/app/${directory}/`,
          ]),
        ),
      );
      for (const directory of HARD_EXCLUDED_DIRECTORIES) {
        // The directory itself is seen and listed in paths; nothing below it is.
        expect(snapshot.paths.has(`${directory}/`)).toBe(true);
        expect(snapshot.paths.has(`${directory}/AGENTS.md`)).toBe(false);
        expect(snapshot.paths.has(`packages/app/${directory}/`)).toBe(true);
        expect(snapshot.paths.has(`packages/app/${directory}/nested/`)).toBe(false);
      }
    }
  });

  it('does not exclude names below agent configuration, or a repository could hide skills', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.claude/skills/build/SKILL.md': 'a skill named build',
      '.claude/skills/pdf/node_modules/AGENTS.md': 'below .claude',
      '.github/instructions/vendor/x.instructions.md': 'below .github',
      'skills/dist/SKILL.md': 'below skills/',
      // Exclusions above agent configuration still apply, and .git is excluded everywhere.
      'node_modules/pkg/.claude/skills/build/SKILL.md': 'vendored',
      'build/.claude/skills/x/SKILL.md': 'build output',
      '.claude/skills/cloned/.git/AGENTS.md': 'git internals',
      '.claude/worktrees/wt/CLAUDE.md': 'a worktree',
    });
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual([
      '.claude/skills/build/SKILL.md',
      '.claude/skills/pdf/node_modules/AGENTS.md',
      '.github/instructions/vendor/x.instructions.md',
      'skills/dist/SKILL.md',
    ]);
    expect([...snapshot.opaqueDirectories]).toEqual([
      '.claude/skills/cloned/.git/',
      '.claude/worktrees/',
      'build/',
      'node_modules/',
    ]);
  });

  it('excludes directory names only, not files with the same name', async () => {
    const root = await makeTempDir();
    await writeTree(root, { build: 'a file named build', 'dist.md': 'x' });
    const snapshot = await walk(root);
    expect([...snapshot.paths]).toEqual(['build', 'dist.md']);
  });
});

describe('walk: per-file limits and content checks', () => {
  it('skips candidates over the default 1 MiB limit without reading them', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'AGENTS.md': new Uint8Array(MiB).fill(0x61),
      'CLAUDE.md': new Uint8Array(MiB + 1).fill(0x61),
    });
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md']);
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'too-large', size: MiB + 1 }]);
    expect(snapshot.paths.has('CLAUDE.md')).toBe(true);
    expect(DEFAULT_WALK_LIMITS.maxFileBytes).toBe(MiB);
  });

  it('applies a custom maxFileBytes inclusively', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': '0123456789', 'CLAUDE.md': '0123456789A' });
    const snapshot = await walk(root, { maxFileBytes: 10 });
    expect(filePaths(snapshot)).toEqual(['AGENTS.md']);
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'too-large', size: 11 }]);
  });

  it('skips binary candidates: a NUL byte within the first 8000 bytes', async () => {
    const root = await makeTempDir();
    const lateNul = new Uint8Array(8001).fill(0x61);
    lateNul[8000] = 0;
    await writeTree(root, {
      'AGENTS.md': new Uint8Array([0x23, 0x20, 0x00, 0x41]),
      'CLAUDE.md': lateNul,
    });
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['CLAUDE.md']);
    expect(snapshot.skipped).toEqual([{ path: 'AGENTS.md', reason: 'binary', size: 4 }]);
  });

  it('reads UTF-16 files with a BOM even though they contain NUL bytes', async () => {
    const root = await makeTempDir();
    const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Hi', 'utf16le')]);
    const bigEndian = Buffer.from(littleEndian).swap16();
    await writeTree(root, { 'AGENTS.md': littleEndian, 'CLAUDE.md': bigEndian });
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(snapshot.files[0]?.bytes).toEqual(new Uint8Array(littleEndian));
    expect(snapshot.files[1]?.bytes.subarray(0, 2)).toEqual(new Uint8Array([0xfe, 0xff]));
  });
});

describe('walk: global limits', () => {
  it('stops after maxEntries entries with exactly one file-limit entry', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'AGENTS.md': 'a',
      'CLAUDE.md': 'c',
      'GEMINI.md': 'g',
      'sub/AGENTS.md': 's',
      'sub/CLAUDE.md': 's',
    });
    const snapshot = await walk(root, { maxEntries: 3 });
    const limits = snapshot.skipped.filter((entry) => entry.reason === 'file-limit');
    expect(limits).toHaveLength(1);
    expect(snapshot.paths.size).toBe(3);
    expect(snapshot.paths.has(limits[0]?.path ?? '')).toBe(false);
  });

  it('counts entries across directories, breadth first', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a/AGENTS.md': 'a', 'b/AGENTS.md': 'b', 'c/AGENTS.md': 'c' });
    // Root has 3 entries; then a/AGENTS.md and b/AGENTS.md fit, c/AGENTS.md does not.
    const snapshot = await walk(root, { maxEntries: 5 });
    expect(filePaths(snapshot)).toEqual(['a/AGENTS.md', 'b/AGENTS.md']);
    expect(snapshot.skipped).toEqual([{ path: 'c/AGENTS.md', reason: 'file-limit' }]);
    // c/ was cut off while being listed: its contents are unknown, not missing.
    expect(snapshot.opaqueDirectories).toEqual(new Set(['c/']));
  });

  it('marks directories left unlisted by the entry limit as opaque', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'a/AGENTS.md': 'a',
      'a/CLAUDE.md': 'a',
      'b/AGENTS.md': 'b',
      'c/d/AGENTS.md': 'c',
    });
    // Root: a/, b/, c/ (3 entries); a/AGENTS.md (4); the limit hits at a/CLAUDE.md.
    const snapshot = await walk(root, { maxEntries: 4 });
    expect(snapshot.skipped).toEqual([{ path: 'a/CLAUDE.md', reason: 'file-limit' }]);
    expect([...snapshot.opaqueDirectories]).toEqual(['a/', 'b/', 'c/']);
  });

  it('marks a directory with a trailing slash when the entry limit hits it', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a/AGENTS.md': 'a', 'b/AGENTS.md': 'b' });
    const snapshot = await walk(root, { maxEntries: 1 });
    expect(snapshot.skipped).toEqual([{ path: 'b/', reason: 'file-limit' }]);
    expect([...snapshot.paths]).toEqual(['a/']);
    expect([...snapshot.opaqueDirectories]).toEqual(['a/']);
  });

  it('reports nothing when the entry budget is exactly used up', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    const snapshot = await walk(root, { maxEntries: 2 });
    expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(snapshot.skipped).toEqual([]);
  });

  it('does not list directories deeper than maxDepth', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'AGENTS.md': '0',
      'a/AGENTS.md': '1',
      'a/b/AGENTS.md': '2',
      'a/b/c/AGENTS.md': '3',
    });
    const snapshot = await walk(root, { maxDepth: 2 });
    expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'a/AGENTS.md', 'a/b/AGENTS.md']);
    expect(snapshot.skipped).toEqual([{ path: 'a/b/c/', reason: 'depth-limit' }]);
    expect(snapshot.opaqueDirectories).toEqual(new Set(['a/b/c/']));
    expect(snapshot.paths.has('a/b/c/')).toBe(true);
    expect(snapshot.paths.has('a/b/c/AGENTS.md')).toBe(false);

    const rootOnly = await walk(root, { maxDepth: 0 });
    expect(filePaths(rootOnly)).toEqual(['AGENTS.md']);
    expect(rootOnly.skipped).toEqual([{ path: 'a/', reason: 'depth-limit' }]);
  });

  it('handles trees deeper than the default depth limit', async () => {
    const root = await makeTempDir();
    const segments = Array.from({ length: DEFAULT_WALK_LIMITS.maxDepth + 3 }, () => 'd');
    await writeTree(root, { [`${segments.join('/')}/AGENTS.md`]: 'deep' });
    const snapshot = await walk(root);
    const deepest = `${segments.slice(0, DEFAULT_WALK_LIMITS.maxDepth + 1).join('/')}/`;
    expect(snapshot.skipped).toEqual([{ path: deepest, reason: 'depth-limit' }]);
    expect(snapshot.files).toEqual([]);
  });

  it('stops reading at maxTotalBytes but still reads smaller files that fit', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'AGENTS.md': '0123456789',
      'CLAUDE.md': '0123456789AB',
      'GEMINI.md': 'xyz',
    });
    const snapshot = await walk(root, { maxTotalBytes: 20 });
    expect(filePaths(snapshot)).toEqual(['AGENTS.md', 'GEMINI.md']);
    expect(snapshot.skipped).toEqual([{ path: 'CLAUDE.md', reason: 'byte-limit', size: 12 }]);
  });

  it('counts binary files against the byte budget', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': new Uint8Array(8), 'CLAUDE.md': '01234' });
    const snapshot = await walk(root, { maxTotalBytes: 10 });
    expect(snapshot.skipped).toEqual([
      { path: 'AGENTS.md', reason: 'binary', size: 8 },
      { path: 'CLAUDE.md', reason: 'byte-limit', size: 5 },
    ]);
  });

  it('rejects invalid limits', async () => {
    const root = await makeTempDir();
    for (const options of [
      { maxFileBytes: -1 },
      { maxTotalBytes: 1.5 },
      { maxEntries: Number.NaN },
      { maxDepth: Number.POSITIVE_INFINITY },
    ]) {
      await expect(walk(root, options)).rejects.toThrow(RangeError);
    }
  });
});

describe('walk: bad roots', () => {
  it('throws WalkError when the root is a file', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'x' });
    const promise = walk(path.join(root, 'AGENTS.md'));
    await expect(promise).rejects.toThrow(WalkError);
    await expect(promise).rejects.toThrow(/not a directory/);
  });

  it('throws WalkError when the root does not exist', async () => {
    const root = await makeTempDir();
    const promise = walk(path.join(root, 'missing'));
    await expect(promise).rejects.toBeInstanceOf(WalkError);
    await expect(promise).rejects.toThrow(/does not exist/);
  });

  it('throws WalkError for an unusable root path', async () => {
    await expect(walk('bad\0path')).rejects.toThrow(/cannot be accessed/);
  });

  it.skipIf(!canDenyPermissions)('throws WalkError when the root cannot be listed', async () => {
    const root = await makeTempDir();
    await chmod(root, 0o000);
    try {
      await expect(walk(root)).rejects.toThrow(/cannot be read/);
    } finally {
      await chmod(root, 0o700);
    }
  });
});

describe('walk: unreadable entries', () => {
  it.skipIf(!canDenyPermissions)('reports unreadable files and directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'AGENTS.md': 'locked',
      'CLAUDE.md': 'fine',
      'private/AGENTS.md': 'hidden',
      'notes.txt': 'locked but not a candidate',
    });
    const locked = [path.join(root, 'AGENTS.md'), path.join(root, 'notes.txt')];
    const lockedDir = path.join(root, 'private');
    for (const file of locked) await chmod(file, 0o000);
    await chmod(lockedDir, 0o000);
    try {
      const snapshot = await walk(root);
      expect(filePaths(snapshot)).toEqual(['CLAUDE.md']);
      expect(snapshot.skipped).toEqual([
        { path: 'AGENTS.md', reason: 'unreadable' },
        { path: 'private/', reason: 'unreadable' },
      ]);
      expect(snapshot.paths.has('AGENTS.md')).toBe(true);
      expect(snapshot.paths.has('private/')).toBe(true);
      expect(snapshot.opaqueDirectories).toEqual(new Set(['private/']));
    } finally {
      for (const file of locked) await chmod(file, 0o600);
      await chmod(lockedDir, 0o700);
    }
  });
});

describe('walk: special files', () => {
  it.skipIf(!fifosSupported)(
    'never opens a FIFO, so the walk cannot hang',
    { timeout: 10_000 },
    async () => {
      const root = await makeTempDir();
      await writeTree(root, { 'CLAUDE.md': 'ok' });
      expect(makeFifo(path.join(root, 'AGENTS.md'))).toBe(true);
      expect(makeFifo(path.join(root, 'events.pipe'))).toBe(true);
      await makeDirs(root, '.cursor/rules');
      expect(makeFifo(path.join(root, '.cursor/rules/live.mdc'))).toBe(true);

      const started = performance.now();
      const snapshot = await walk(root);
      expect(performance.now() - started).toBeLessThan(2000);

      expect(filePaths(snapshot)).toEqual(['CLAUDE.md']);
      // Only candidates are reported as skipped; every special file is still a known path.
      expect(snapshot.skipped).toEqual([
        { path: '.cursor/rules/live.mdc', reason: 'special-file' },
        { path: 'AGENTS.md', reason: 'special-file' },
      ]);
      expect(snapshot.paths.has('events.pipe')).toBe(true);
    },
  );
});

describe('walk: hostile and unusual file names', () => {
  it('handles spaces, Turkish letters, emoji and NFC/NFD names', async () => {
    const root = await makeTempDir();
    const names = [
      '.claude/rules/ş-İ-ı-😀.md',
      '.claude/rules/café.md',
      '.claude/rules/café.md',
      'skills dir/my skill/SKILL.md',
      '😀/AGENTS.md',
    ];
    for (const name of names) await writeTree(root, { [name]: name });

    const snapshot = await walk(root);
    // NFC and NFD spellings may be the same file on macOS; every reported path must exist.
    expect(snapshot.files.length).toBeGreaterThanOrEqual(names.length - 1);
    for (const file of snapshot.files) {
      await expect(lstat(path.join(root, ...file.path.split('/')))).resolves.toBeDefined();
    }
    expect(filePaths(snapshot)).toContain('.claude/rules/ş-İ-ı-😀.md');
    expect(filePaths(snapshot)).toContain('skills dir/my skill/SKILL.md');
    expect(filePaths(snapshot)).toContain('😀/AGENTS.md');
    expect(snapshot.skipped).toEqual([]);
  });

  it.skipIf(isWindows)('handles escape sequences and newlines in names', async () => {
    const root = await makeTempDir();
    const ruleName = '.cursor/rules/evil\u001b[2J\nline.mdc';
    const dirName = 'odd\u001b]0;title\u0007\r\ndir';
    await writeTree(root, {
      [ruleName]: 'rule',
      [`${dirName}/AGENTS.md`]: 'agents',
      'back\\slash.md': 'not a separator on POSIX',
    });
    const snapshot = await walk(root);
    // Paths are reported exactly; escaping them for display is the reporter's job.
    expect(filePaths(snapshot)).toEqual([ruleName, `${dirName}/AGENTS.md`]);
    expect(snapshot.paths.has('back\\slash.md')).toBe(true);
  });

  it('never yields absolute paths, ./ prefixes or .. segments', async () => {
    const root = await makeTempDir();
    await writeTree(root, { '..dots/AGENTS.md': 'x', '...md': 'x', '.hidden/CLAUDE.md': 'x' });
    const snapshot = await walk(root);
    expect(filePaths(snapshot)).toEqual(['..dots/AGENTS.md', '.hidden/CLAUDE.md']);
    for (const entry of snapshot.paths) {
      expect(path.isAbsolute(entry)).toBe(false);
      expect(entry.replace(/\/$/, '').split('/')).not.toContain('..');
      expect(entry.startsWith('./')).toBe(false);
    }
  });
});
