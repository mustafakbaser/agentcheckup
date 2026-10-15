/**
 * The walker's output must make `pathStatus` (src/core/paths.ts) correct on real trees: rules use
 * it to decide whether a referenced file is missing, and must never call an unlisted file missing.
 */
import { chmod } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pathStatus } from '../../src/core/paths.js';
import type { Snapshot } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import {
  canDenyPermissions,
  link,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

function statuses(snapshot: Snapshot, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((p) => [p, pathStatus(snapshot, p)]));
}

describe('pathStatus on a walked tree', () => {
  it('tells existing, missing and unknown paths apart', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'notes.local.md\ngenerated/\n',
      'AGENTS.md': '# agents',
      'docs/guide.md': 'guide',
      'notes.local.md': 'gitignored file',
      'generated/out.md': 'inside a gitignored directory',
      'node_modules/pkg/README.md': 'inside a hard-excluded directory',
      'deep/a/b/c/file.md': 'below the depth limit',
    });

    const snapshot = await walk(root, { maxDepth: 3 });

    expect(
      statuses(snapshot, [
        'AGENTS.md',
        'docs/guide.md',
        './docs/../docs/guide.md',
        'docs',
        'docs/',
        // A gitignored file exists; it is just not read.
        'notes.local.md',
        // Below hard-excluded, gitignored and depth-limited directories: unknown.
        'node_modules/pkg/README.md',
        'generated/out.md',
        'deep/a/b/c/file.md',
        // The opaque directories themselves exist.
        'node_modules',
        'generated',
        'deep/a/b/c',
        // Truly missing.
        'docs/missing.md',
        'nowhere/file.md',
        'AGENTS.md/child',
        // Outside the root: nothing is known.
        '../outside.md',
      ]),
    ).toEqual({
      'AGENTS.md': 'exists',
      'docs/guide.md': 'exists',
      './docs/../docs/guide.md': 'exists',
      docs: 'exists',
      'docs/': 'exists',
      'notes.local.md': 'exists',
      'node_modules/pkg/README.md': 'unknown',
      'generated/out.md': 'unknown',
      'deep/a/b/c/file.md': 'unknown',
      node_modules: 'exists',
      generated: 'exists',
      'deep/a/b/c': 'exists',
      'docs/missing.md': 'missing',
      'nowhere/file.md': 'missing',
      'AGENTS.md/child': 'missing',
      '../outside.md': 'unknown',
    });
  });

  it.skipIf(!symlinksSupported)(
    'handles linked, looping and unresolvable directories',
    async () => {
      const root = await makeTempDir();
      const outside = await makeTempDir('agentcheck-outside-');
      await writeTree(outside, { 'skills/x/SKILL.md': 'outside' });
      await writeTree(root, { '.agents/skills/x/SKILL.md': 'inside', 'sub/AGENTS.md': 'x' });
      await link(root, '.claude/skills', '../.agents/skills');
      await link(root, '.cursor/skills', path.join(outside, 'skills'));
      await link(root, 'sub/up', '..');
      await link(root, 'gone', 'missing-dir');

      const snapshot = await walk(root);

      expect(
        statuses(snapshot, [
          '.claude/skills/x/SKILL.md',
          '.claude/skills/y/SKILL.md',
          '.cursor/skills/x/SKILL.md',
          '.cursor/skills',
          'sub/up/AGENTS.md',
          'sub/up',
          'gone/x',
          'gone',
        ]),
      ).toEqual({
        // Listed through the link.
        '.claude/skills/x/SKILL.md': 'exists',
        '.claude/skills/y/SKILL.md': 'missing',
        // The target outside the root is never looked at.
        '.cursor/skills/x/SKILL.md': 'unknown',
        '.cursor/skills': 'exists',
        // The loop guard does not list the root again under sub/up/.
        'sub/up/AGENTS.md': 'unknown',
        'sub/up': 'exists',
        'gone/x': 'unknown',
        gone: 'exists',
      });
    },
  );

  it.skipIf(!canDenyPermissions)(
    'treats the contents of unreadable directories as unknown',
    async () => {
      const root = await makeTempDir();
      await writeTree(root, { 'private/AGENTS.md': 'x' });
      const locked = path.join(root, 'private');
      await chmod(locked, 0o000);
      try {
        const snapshot = await walk(root);
        expect(statuses(snapshot, ['private/AGENTS.md', 'private'])).toEqual({
          'private/AGENTS.md': 'unknown',
          private: 'exists',
        });
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  it('treats directories the entry limit left unlisted as unknown', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a/AGENTS.md': 'a', 'a/CLAUDE.md': 'a', 'b/AGENTS.md': 'b' });
    const snapshot = await walk(root, { maxEntries: 3 });
    expect(statuses(snapshot, ['a/AGENTS.md', 'a/CLAUDE.md', 'b/AGENTS.md', 'b/x.md'])).toEqual({
      'a/AGENTS.md': 'exists',
      'a/CLAUDE.md': 'unknown',
      'b/AGENTS.md': 'unknown',
      'b/x.md': 'unknown',
    });
  });
});
