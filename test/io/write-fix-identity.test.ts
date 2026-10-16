/**
 * `SourceFile.identity`, which the walker records for the fix writer: the device and inode of
 * the file it read and the SHA-256 of the bytes. It is internal; no report may contain it.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CONTEXT_FORMATS } from '../../src/cli/args.js';
import { run } from '../../src/cli/run.js';
import { sameFile } from '../../src/io/safe-read.js';
import { walk } from '../../src/io/walk.js';
import { FORMATS } from '../../src/report/index.js';
import { capture } from '../cli/helpers.js';
import { link, makeTempDir, removeTempDirs, symlinksSupported, writeTree } from './helpers.js';

afterEach(removeTempDirs);

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const TREE = {
  'AGENTS.md': '# Rules\n\nUse pnpm.\n',
  'CLAUDE.md': '# Claude\n\n@docs/guide.md\n@docs/missing.md\n',
  'docs/guide.md': 'Run the tests before you push.\n',
  '.cursor/rules/style.md': 'Use tabs.\n',
  '.mcp.json': '{ "mcpServers": { "docs": { "url": "https://example.com/mcp" } } }\n',
  '.claude/settings.json': '{ "permissions": { "allow": ["Bash(pnpm test)"] } }\n',
  '.agents/skills/notes/SKILL.md': '---\nname: notes\n---\nTake notes.\n',
};

describe('SourceFile.identity', () => {
  it('names the file the walker read and hashes the bytes it read', async () => {
    const root = await makeTempDir();
    await writeTree(root, TREE);
    const { files } = await walk(root);
    expect(files.map((file) => file.path)).toContain('docs/guide.md');
    for (const file of files) {
      const { identity } = file;
      expect(identity, file.path).toBeDefined();
      expect(identity?.sha256, file.path).toBe(sha256(file.bytes));
      const stats = await lstat(path.join(root, ...file.path.split('/')), { bigint: true });
      expect(identity !== undefined && sameFile(identity, stats), file.path).toBe(true);
    }
    // An imported file has one as well.
    expect(files.find((file) => file.path === 'docs/guide.md')?.imported).toBe(true);
  });

  it.skipIf(!symlinksSupported)('gives an alias the identity of the real file', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'AGENTS.md': 'shared' });
    await link(root, 'CLAUDE.md', 'AGENTS.md');
    const { files } = await walk(root);
    const [real, alias] = files;
    expect(alias?.symlinkTarget).toBe('AGENTS.md');
    expect(alias?.identity).toEqual(real?.identity);
  });
});

describe('reports never contain an identity', () => {
  /** Every key anywhere in a JSON value. */
  function keysOf(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) keysOf(item, keys);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        keys.add(key);
        keysOf(item, keys);
      }
    }
    return keys;
  }

  it('in any scan or context format', async () => {
    const root = await makeTempDir();
    await writeTree(root, TREE);
    const { files } = await walk(root);
    const hashes = files.map((file) => file.identity?.sha256 ?? 'missing');
    const commands = [
      ...FORMATS.map((format) => ['--format', format, '--no-config']),
      ['--context', '--format', 'json', '--no-config'],
      ['--context', '--no-config'],
      ...CONTEXT_FORMATS.map((format) => ['context', '--format', format, '--no-config']),
      ['context', '--matrix', '--format', 'json', '--no-config'],
    ];
    for (const args of commands) {
      const io = capture(root);
      // A bigint that reached JSON.stringify would throw and exit 3.
      expect(await run([...args, root], io), args.join(' ')).toBeLessThan(3);
      const output = io.output();
      expect(output.length, args.join(' ')).toBeGreaterThan(0);
      for (const hash of hashes) expect(output, args.join(' ')).not.toContain(hash);
      if (args.includes('json') || args.includes('sarif')) {
        const keys = keysOf(JSON.parse(output));
        for (const key of ['identity', 'ino', 'dev', 'sha256']) {
          expect(keys.has(key), `${args.join(' ')}: ${key}`).toBe(false);
        }
      }
    }
  });
});
