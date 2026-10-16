/**
 * The walker's import pass (src/io/imports.ts, Walker.readImports): files that instruction files
 * import are read after the walk, as far as agents follow imports, within the caps and never from
 * outside the root.
 */
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSnapshot, scanWithContext } from '../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../src/core/types.js';
import {
  IMPORT_MARKDOWN_LINE_BUDGET,
  ImportPlanner,
  MAX_IMPORTED_BYTES,
  MAX_IMPORTED_FILES,
} from '../../src/io/imports.js';
import { walk } from '../../src/io/walk.js';
import { MAX_MARKDOWN_LINES } from '../../src/parse/markdown.js';
import { builtinRules } from '../../src/rules/index.js';
import { snapshotFrom } from '../helpers/lint.js';
import {
  canDenyPermissions,
  filePaths,
  link,
  makeTempDir,
  removeTempDirs,
  serializeSnapshot,
  symlinksSupported,
  textOf,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const OPTIONS = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;

function imported(snapshot: Snapshot): string[] {
  return snapshot.files.filter((file) => file.imported === true).map((file) => file.path);
}

describe('walk: import pass', () => {
  it('reads an import chain through README.md up to the hops Claude Code follows', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': '# Project\n\n@README.md\n',
      'README.md': 'Read @docs/guide.md first.\n',
      'docs/guide.md': 'Details: @deep.md\n',
      'docs/deep.md': '@deeper.md\n',
      'docs/deeper.md': 'Hop 4. @deepest.md\n',
      'docs/deepest.md': 'Hop 5: Claude Code stops before this file.\n',
      'docs/unrelated.md': 'Nobody imports this.\n',
    });

    const snapshot = await walk(root);

    expect(imported(snapshot)).toEqual([
      'README.md',
      'docs/deep.md',
      'docs/deeper.md',
      'docs/guide.md',
    ]);
    expect(filePaths(snapshot)).not.toContain('docs/unrelated.md');
    expect(filePaths(snapshot)).not.toContain('docs/deepest.md');
    expect(textOf(snapshot, 'README.md')).toBe('Read @docs/guide.md first.\n');
    expect(snapshot.skipped).toEqual([]);
  });

  it('follows GEMINI.md imports five hops deep', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'GEMINI.md': '@a.md\n',
      'a.md': '@b.md\n',
      'b.md': '@c.md\n',
      'c.md': '@d.md\n',
      'd.md': '@e.md\n',
      'e.md': '@f.md\n',
      'f.md': 'Six hops away.\n',
    });

    expect(imported(await walk(root))).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
  });

  it('lets the rules and the load plan follow imports inside an imported file', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': '@README.md\n',
      'README.md': 'Setup: @docs/setup.md and @docs/missing.md\n',
      'docs/setup.md': '@a.md\n',
      'docs/a.md': '@b.md\n',
      'docs/b.md': '@c.md\n',
      'docs/c.md': 'Five hops from CLAUDE.md.\n',
    });
    const result = scanWithContext(await walk(root), { ...OPTIONS, agents: ['claude-code'] });

    const findings = result.findings.map((finding) => [finding.ruleId, finding.path]);
    expect(findings).toContainEqual(['instr/import-unresolved', 'README.md']);
    expect(findings).toContainEqual(['instr/import-depth', 'docs/b.md']);
    expect(result.artifacts).toContainEqual({
      path: 'README.md',
      kind: 'imported-file',
      readers: ['claude-code', 'gemini'],
    });
    const plan = result.context.plans[0];
    const readme = plan?.entries.find((entry) => entry.id === 'import:README.md');
    expect(readme?.size?.bytes).toBe(
      Buffer.byteLength('Setup: @docs/setup.md and @docs/missing.md\n'),
    );
    expect(plan?.incomplete.filter((item) => item.startsWith('unread:'))).toEqual([]);
  });

  it('reads each file of an import cycle once', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': '@a.md\n',
      'a.md': '@b.md\n',
      'b.md': 'Back to @a.md\n',
    });

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual(['CLAUDE.md', 'a.md', 'b.md']);
    const cycle = scanSnapshot(snapshot, OPTIONS).findings.filter(
      (finding) => finding.ruleId === 'instr/import-depth',
    );
    expect(cycle.map((finding) => [finding.path, finding.severity])).toEqual([['b.md', 'info']]);
  });

  it.skipIf(!symlinksSupported)(
    'follows the imports of AGENTS.md when CLAUDE.md or GEMINI.md is a symlink to it',
    async () => {
      const root = await makeTempDir();
      await writeTree(root, {
        'AGENTS.md': 'Read @docs/guide.md first.\n',
        'docs/guide.md': 'Guide.\n',
        'pkg/AGENTS.md': 'See @./notes.md\n',
        'pkg/notes.md': 'Notes.\n',
        'unrelated.md': 'Nobody imports this.\n',
      });
      await link(root, 'CLAUDE.md', 'AGENTS.md');
      await link(root, 'pkg/GEMINI.md', 'AGENTS.md');

      const snapshot = await walk(root);

      expect(imported(snapshot)).toEqual(['docs/guide.md', 'pkg/notes.md']);
      const result = scanWithContext(snapshot, { ...OPTIONS, agents: ['claude-code'] });
      const plan = result.context.plans[0];
      expect(plan?.entries.find((entry) => entry.id === 'import:docs/guide.md')).toMatchObject({
        via: ['CLAUDE.md'],
        size: { bytes: 7 },
        certainty: 'documented',
      });
      expect(plan?.incomplete).toEqual([]);
    },
  );

  it.skipIf(!symlinksSupported)(
    "resolves imports from a symlinked CLAUDE.md's own directory",
    async () => {
      const root = await makeTempDir();
      await writeTree(root, {
        'AGENTS.md': '@notes.md\n',
        'notes.md': 'Next to AGENTS.md.\n',
        '.claude/notes.md': 'Next to the link.\n',
      });
      await link(root, '.claude/CLAUDE.md', '../AGENTS.md');

      const snapshot = await walk(root);

      expect(imported(snapshot)).toEqual(['.claude/notes.md']);
      const result = scanWithContext(snapshot, { ...OPTIONS, agents: ['claude-code'] });
      expect(result.context.plans[0]?.entries.map((entry) => [entry.id, entry.certainty])).toEqual([
        ['instructions:.claude/CLAUDE.md', 'documented'],
        ['import:.claude/notes.md', 'unverified'],
      ]);
    },
  );

  it('only follows imports of files the agents load, outside HTML comments', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': 'Root.\n<!-- @commented.md -->\n',
      // Claude Code reads no AGENTS.md below a CLAUDE.md, and nothing expands imports in commands.
      'AGENTS.md': '@from-agents.md\n',
      '.claude/commands/ship.md': '@from-command.md\n',
      'commented.md': 'x',
      'from-agents.md': 'x',
      'from-command.md': 'x',
    });

    expect(imported(await walk(root))).toEqual([]);
  });

  it('can be turned off', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'CLAUDE.md': '@README.md\n', 'README.md': 'x' });

    expect(filePaths(await walk(root, { followImports: false }))).toEqual(['CLAUDE.md']);
  });

  it('reads only listed text files: not gitignored, data, binary or dot files', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'private.md\n',
      'CLAUDE.md':
        '@private.md @package.json @logo.png @.env @notes.txt @./LICENSE @bin.md @docs\n',
      'private.md': 'ignored by .gitignore',
      'package.json': '{}',
      'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]),
      '.env': 'TOKEN=secret',
      'notes.txt': 'plain text',
      LICENSE: 'MIT',
      'bin.md': new Uint8Array([0x41, 0, 0x42]),
      'docs/index.md': 'a directory is not a file',
    });

    for (const scanIgnoredAgentConfig of [false, true]) {
      const snapshot = await walk(root, { scanIgnoredAgentConfig });
      expect(imported(snapshot)).toEqual(['LICENSE', 'notes.txt']);
      expect(snapshot.skipped).toEqual([{ path: 'bin.md', reason: 'binary', size: 3 }]);
      expect([...snapshot.ignoredFiles]).toEqual(['private.md']);
      expect(serializeSnapshot(snapshot)).not.toContain('TOKEN=secret');
    }
  });

  it('skips a target over the per-file cap as too-large', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': '@huge.md @small.md\n',
      'huge.md': 'x'.repeat(5000),
      'small.md': 'fits',
    });

    const snapshot = await walk(root, { maxFileBytes: 1000 });

    expect(imported(snapshot)).toEqual(['small.md']);
    expect(snapshot.skipped).toEqual([{ path: 'huge.md', reason: 'too-large', size: 5000 }]);
  });

  it('stops at the import file cap and reports the rest as import-limit', async () => {
    const root = await makeTempDir();
    const count = MAX_IMPORTED_FILES + 3;
    const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(3, '0')}.md`);
    const tree: Record<string, string> = { 'CLAUDE.md': names.map((n) => `@${n}`).join('\n') };
    for (const name of names) tree[name] = name;
    await writeTree(root, tree);

    const snapshot = await walk(root);

    expect(imported(snapshot)).toEqual(names.slice(0, MAX_IMPORTED_FILES));
    expect(snapshot.skipped).toEqual(
      names.slice(MAX_IMPORTED_FILES).map((path) => ({ path, reason: 'import-limit' })),
    );
  });

  it('stops at the import byte cap, then at the walk byte cap', async () => {
    const root = await makeTempDir();
    const MiB = 1024 * 1024;
    // Eight parts fit the import byte cap with a little room; the ninth does not, tiny.md does.
    const part = MiB - 100;
    const files = MAX_IMPORTED_BYTES / MiB + 1;
    const names = Array.from({ length: files }, (_, i) => `part${String(i)}.md`);
    const tree: Record<string, string> = {
      'CLAUDE.md': `${names.map((n) => `@${n}`).join(' ')} @tiny.md\n`,
      'tiny.md': 'x',
    };
    for (const name of names) tree[name] = 'y'.repeat(part);
    await writeTree(root, tree);

    const snapshot = await walk(root);
    expect(imported(snapshot)).toEqual([...names.slice(0, -1), 'tiny.md']);
    expect(snapshot.skipped).toEqual([{ path: names.at(-1), reason: 'import-limit', size: part }]);

    // Room for CLAUDE.md and one part: the walk's own byte cap still applies.
    const bounded = await walk(root, { maxTotalBytes: MiB + 1000 });
    expect(imported(bounded)).toEqual(['part0.md', 'tiny.md']);
    expect(bounded.skipped).toEqual(
      names.slice(1).map((path) => ({ path, reason: 'byte-limit', size: part })),
    );
  });

  it('stops looking for imports when its Markdown budget is spent', async () => {
    const root = await makeTempDir();
    // Instruction files that each use up a parse window of lines, then one with an import.
    const big = Math.ceil(IMPORT_MARKDOWN_LINE_BUDGET / MAX_MARKDOWN_LINES);
    const tree: Record<string, string> = { 'z/CLAUDE.md': '@x.md\n', 'z/x.md': 'x' };
    for (let i = 0; i < big; i++) {
      tree[`d${String(i).padStart(2, '0')}/CLAUDE.md`] =
        `@none.md\n${'\n'.repeat(MAX_MARKDOWN_LINES)}`;
    }
    await writeTree(root, tree);

    expect(imported(await walk(root))).toEqual([]);
    delete tree['d00/CLAUDE.md'];
    const fewer = await makeTempDir();
    await writeTree(fewer, tree);
    expect(imported(await walk(fewer))).toEqual(['z/x.md']);
  });

  it.skipIf(!symlinksSupported)('reuses what the walk found for a binary file', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': '@notes.md\n',
      'bin/AGENTS.md': new Uint8Array([0x41, 0, 0x42]),
    });
    await link(root, 'notes.md', 'bin/AGENTS.md');

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual(['CLAUDE.md']);
    expect(snapshot.skipped).toEqual([
      { path: 'bin/AGENTS.md', reason: 'binary', size: 3 },
      { path: 'notes.md', reason: 'binary', size: 3 },
    ]);
  });

  it.skipIf(!canDenyPermissions)('reports a target it cannot open as unreadable', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'CLAUDE.md': '@locked.md\n', 'locked.md': 'x' });
    await chmod(path.join(root, 'locked.md'), 0o000);

    const snapshot = await walk(root);

    expect(imported(snapshot)).toEqual([]);
    expect(snapshot.skipped).toEqual([{ path: 'locked.md', reason: 'unreadable' }]);
  });

  it.skipIf(!symlinksSupported)('never follows an import out of the root', async () => {
    const outside = await makeTempDir('agentcheckup-outside-');
    await writeTree(outside, { 'secret.md': 'OUTSIDE_SECRET', 'dir/notes.md': 'OUTSIDE_SECRET' });
    const root = await makeTempDir();
    await writeTree(root, {
      'CLAUDE.md': '@docs/secret.md @linked/notes.md @../secret.md @alias.md\n',
      'docs/real.md': 'inside',
    });
    await link(root, 'docs/secret.md', `${outside}/secret.md`);
    await link(root, 'linked', `${outside}/dir`);
    await link(root, 'alias.md', 'docs/real.md');

    const snapshot = await walk(root);

    expect(snapshot.files.filter((file) => file.imported === true)).toEqual([
      {
        path: 'alias.md',
        bytes: new TextEncoder().encode('inside'),
        symlinkTarget: 'docs/real.md',
        imported: true,
        identity: expect.objectContaining({
          // SHA-256 of "inside".
          sha256: createHash('sha256').update('inside').digest('hex'),
        }) as unknown,
      },
    ]);
    expect(serializeSnapshot(snapshot)).not.toContain('OUTSIDE_SECRET');
    expect(snapshot.unresolvedSymlinks.map((entry) => entry.path)).toEqual([
      'docs/secret.md',
      'linked',
    ]);
  });

  it.skipIf(!symlinksSupported)(
    'reuses a file the walk read instead of reading it again',
    async () => {
      const root = await makeTempDir();
      await writeTree(root, { 'AGENTS.md': 'shared', 'CLAUDE.md': '@agents-link.md\n' });
      await link(root, 'agents-link.md', 'AGENTS.md');

      // Exactly the bytes of the two candidates: the import adds no bytes.
      const snapshot = await walk(root, { maxTotalBytes: 22 });

      const shared = snapshot.files.filter((file) => file.path !== 'CLAUDE.md');
      expect(shared.map((file) => [file.path, file.symlinkTarget, file.imported])).toEqual([
        ['AGENTS.md', undefined, undefined],
        ['agents-link.md', 'AGENTS.md', true],
      ]);
      expect(shared[0]?.bytes).toBe(shared[1]?.bytes);
      expect(snapshot.skipped).toEqual([]);
    },
  );
});

describe('ImportPlanner: edge budget', () => {
  const encoder = new TextEncoder();

  /**
   * Runs the planner as the walker does: `files` were read by the walk, `targets` exist and are
   * read when the planner asks for them. Returns the targets of each round.
   */
  function rounds(
    files: Record<string, string>,
    targets: Record<string, string>,
    maxEdgeVisits?: number,
  ): string[][] {
    const snapshot = snapshotFrom(files, { paths: Object.keys(targets) });
    const planner = new ImportPlanner(
      snapshot,
      maxEdgeVisits === undefined ? {} : { maxEdgeVisits },
    );
    const asked: string[][] = [];
    for (let next = planner.next(); next.length > 0; next = planner.next()) {
      asked.push(next);
      for (const path of next) {
        planner.done(path, { path, bytes: encoder.encode(targets[path]), imported: true });
      }
    }
    return asked;
  }

  // CLAUDE.md has one import, a.md two: three edge visits in two rounds.
  const files = { 'CLAUDE.md': '@a.md\n' };
  const targets = { 'a.md': '@b.md @c.md\n', 'b.md': 'B.\n', 'c.md': 'C.\n' };

  it('reads every round within the budget', () => {
    expect(rounds(files, targets)).toEqual([['a.md'], ['b.md', 'c.md']]);
    expect(rounds(files, targets, 3)).toEqual([['a.md'], ['b.md', 'c.md']]);
  });

  it('stops before the round whose imports exceed the budget', () => {
    expect(rounds(files, targets, 2)).toEqual([['a.md']]);
    expect(rounds(files, targets, 0)).toEqual([]);
  });

  it('still reads what the round found before the budget ran out, and nothing after', () => {
    // The roots expand in path order: CLAUDE.md fits, sub/CLAUDE.md does not.
    const twoRoots = { 'CLAUDE.md': '@a.md\n', 'sub/CLAUDE.md': '@x.md @y.md\n' };
    const more = { ...targets, 'sub/x.md': 'X.\n', 'sub/y.md': 'Y.\n' };
    expect(rounds(twoRoots, more)).toEqual([
      ['a.md', 'sub/x.md', 'sub/y.md'],
      ['b.md', 'c.md'],
    ]);
    expect(rounds(twoRoots, more, 1)).toEqual([['a.md']]);
  });

  it('spends nothing on files without an @', () => {
    expect(rounds({ 'CLAUDE.md': 'No imports.\n', 'AGENTS.md': 'x' }, {}, 0)).toEqual([]);
    expect(
      rounds({ 'CLAUDE.md': 'Plain.\n', 'pkg/CLAUDE.md': '@a.md\n' }, { 'pkg/a.md': 'A.\n' }, 1),
    ).toEqual([['pkg/a.md']]);
  });
});
