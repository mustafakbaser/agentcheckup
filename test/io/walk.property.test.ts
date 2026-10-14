import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import fc from 'fast-check';
import { afterEach, expect, it } from 'vitest';

import { pathStatus } from '../../src/core/paths.js';
import type { Snapshot } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import { sequentialWalk } from './reference/sequential-walk.js';
import {
  makeTempDir,
  removeTempDirs,
  serializeSnapshot,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const SECRET = 'AGENTCHECK_PROPERTY_SECRET_c41d9e';
const OUTSIDE = '<outside>';
const ROOT = '<root>';

const name = fc.constantFrom(
  'a',
  'b c',
  'ş',
  'İ',
  '😀',
  '..x',
  '.hidden',
  '.claude',
  'rules',
  'skills',
  'AGENTS.md',
  'SKILL.md',
  'x.md',
  'node_modules',
  '.git',
  '.gitignore',
);

const linkTarget = fc.constantFrom(
  '.',
  '..',
  '../..',
  '../../../..',
  'a',
  'AGENTS.md',
  '../AGENTS.md',
  'a/b c',
  '/',
  '../a',
  '../../skills',
  `${ROOT}/a`,
  `${ROOT}/.claude`,
  `${ROOT}/skills/AGENTS.md`,
  OUTSIDE,
  `${OUTSIDE}/secret.md`,
);

const entry = fc.oneof(
  fc.record({
    kind: fc.constant('file' as const),
    segments: fc.array(name, { minLength: 1, maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constant('dir' as const),
    segments: fc.array(name, { minLength: 1, maxLength: 4 }),
  }),
  {
    // Links are the interesting part: weighted up, and kept shallow so they are not shadowed.
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('link' as const),
      segments: fc.array(name, { minLength: 1, maxLength: 2 }),
      target: linkTarget,
    }),
  },
);

type Entry = typeof entry extends fc.Arbitrary<infer T> ? T : never;

/** Candidate files that links can alias, present in some runs. */
const BASE_TREE = {
  'a/AGENTS.md': 'a',
  'a/b c/CLAUDE.md': 'b c',
  '.claude/rules/x.md': 'rule',
  'skills/AGENTS.md': 'skills',
  'skills/SKILL.md': 'skill',
};

/** Declared submodules: checkouts, placeholders and bogus entries all occur at random. */
const GITMODULES = ['a', 'skills', '.claude', 'b c', 'a/b c', '../evil', '/abs']
  .map((p) => `[submodule "${p}"]\n\tpath = ${p}\n`)
  .join('');

/** Generated .gitignore files get real patterns, so ignored files and directories occur. */
const GITIGNORE = 'AGENTS.md\nb c/\n.hidden\n!x.md\nskills\n';

function contentFor(segments: readonly string[]): string {
  return segments.at(-1) === '.gitignore' ? GITIGNORE : `content of ${segments.join('/')}`;
}

interface Shape {
  readonly base: boolean;
  readonly gitignore: boolean;
  readonly gitmodules: boolean;
  readonly entries: readonly Entry[];
}

const shape: fc.Arbitrary<Shape> = fc.record({
  base: fc.boolean(),
  gitignore: fc.boolean(),
  gitmodules: fc.boolean(),
  entries: fc.array(entry, { maxLength: 14 }),
});

async function build(root: string, outside: string, input: Shape) {
  const { base, gitignore, gitmodules, entries } = input;
  if (base) await writeTree(root, BASE_TREE);
  if (gitignore) await writeTree(root, { '.gitignore': GITIGNORE });
  if (gitmodules) await writeTree(root, { '.gitmodules': GITMODULES });
  for (const item of entries) {
    const absolute = path.join(root, ...item.segments);
    try {
      await mkdir(path.dirname(absolute), { recursive: true });
      if (item.kind === 'dir') await mkdir(absolute, { recursive: true });
      else if (item.kind === 'file') await writeFile(absolute, contentFor(item.segments));
      else if (symlinksSupported)
        await symlink(item.target.replace(OUTSIDE, outside).replace(ROOT, root), absolute);
    } catch {
      // Conflicting shapes (a file where a directory is needed, duplicates) are simply skipped.
    }
  }
}

function assertWellFormed(relativePath: string): void {
  expect(relativePath).not.toBe('');
  expect(path.isAbsolute(relativePath)).toBe(false);
  const segments = (relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath).split(
    '/',
  );
  for (const segment of segments) {
    expect(['', '.', '..']).not.toContain(segment);
  }
}

/**
 * `symlinkTarget` is present exactly when the reported path goes through a symlink, and names the
 * real, symlink-free file whose bytes were read.
 */
async function assertRealFiles(root: string, snapshot: Snapshot): Promise<void> {
  const realRoot = await realpath(root);
  for (const file of snapshot.files) {
    const reported = path.join(root, ...file.path.split('/'));
    const real = file.symlinkTarget ?? file.path;
    const realAbsolute = path.join(realRoot, ...real.split('/'));
    expect(await realpath(reported)).toBe(realAbsolute);
    expect(await realpath(realAbsolute)).toBe(realAbsolute);
    expect(new Uint8Array(await readFile(realAbsolute))).toEqual(file.bytes);
    if (file.symlinkTarget !== undefined) {
      assertWellFormed(file.symlinkTarget);
      expect(file.symlinkTarget).not.toBe(file.path);
    }
  }
}

function assertConsistentSets(snapshot: Snapshot): void {
  for (const directory of snapshot.opaqueDirectories) {
    assertWellFormed(directory);
    expect(directory.endsWith('/')).toBe(true);
    expect(pathStatus(snapshot, directory)).toBe('exists');
  }
  for (const ignored of snapshot.ignoredFiles) {
    assertWellFormed(ignored);
    expect(ignored.endsWith('/')).toBe(false);
    expect(snapshot.paths.has(ignored)).toBe(false);
    expect(pathStatus(snapshot, ignored)).toBe('exists');
  }
  for (const listed of snapshot.paths) expect(pathStatus(snapshot, listed)).toBe('exists');
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

it('yields well-formed, consistent snapshots and no outside content on random trees', async () => {
  const outside = await makeTempDir('agentcheck-outside-');
  await writeTree(outside, { 'secret.md': SECRET, 'AGENTS.md': SECRET });

  await fc.assert(
    fc.asyncProperty(shape, async (input) => {
      const root = await makeTempDir();
      await build(root, outside, input);

      const snapshot = await walk(root);
      const again = await walk(root);
      // Read-ahead and prefetching must not change the result (see walk.compare.test.ts).
      const sequential = await sequentialWalk(root);

      const paths = [...snapshot.paths];
      const filePaths = snapshot.files.map((file) => file.path);
      for (const relativePath of [
        ...paths,
        ...filePaths,
        ...snapshot.skipped.map((skipped) => skipped.path),
        ...snapshot.unresolvedSymlinks.map((link) => link.path),
      ]) {
        assertWellFormed(relativePath);
      }
      for (const file of snapshot.files) expect(snapshot.paths.has(file.path)).toBe(true);
      await assertRealFiles(root, snapshot);
      assertConsistentSets(snapshot);
      expect(isSorted(paths)).toBe(true);
      expect(isSorted(filePaths)).toBe(true);
      expect(isSorted([...snapshot.opaqueDirectories])).toBe(true);
      expect(isSorted([...snapshot.ignoredFiles])).toBe(true);

      const json = serializeSnapshot(snapshot);
      expect(json).not.toContain(SECRET);
      expect(serializeSnapshot(again)).toBe(json);
      expect(serializeSnapshot(sequential)).toBe(json);
    }),
    { numRuns: 150 },
  );
}, 60_000);
