import { chmod } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_INPUT_MAX_BYTES,
  InputFileError,
  parseJsonInput,
  readJsonInput,
  readTextInput,
} from '../../src/io/read-file.js';
import {
  canDenyPermissions,
  fifosSupported,
  link,
  makeDirs,
  makeFifo,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const OPTIONS = { label: 'Baseline file' } as const;

describe('readTextInput', () => {
  it('reads UTF-8 text without the BOM, up to 64 MiB by default', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a.json': '﻿{"x": "ş"}' });
    expect(await readTextInput(path.join(root, 'a.json'), OPTIONS)).toBe('{"x": "ş"}');
    expect(DEFAULT_INPUT_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('reports a missing file, also under a file', async () => {
    const root = await makeTempDir();
    await writeTree(root, { file: 'x' });
    for (const missing of ['nope.json', 'file/nope.json']) {
      await expect(readTextInput(path.join(root, missing), OPTIONS)).rejects.toThrow(
        /^Baseline file not found: /,
      );
    }
  });

  it('enforces the size limit', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a.json': '12345' });
    const file = path.join(root, 'a.json');
    await expect(readTextInput(file, { ...OPTIONS, maxBytes: 4 })).rejects.toThrow(
      /5 bytes exceeds the 4-byte limit/,
    );
    await expect(readTextInput(file, { ...OPTIONS, maxBytes: 5 })).resolves.toBe('12345');
    await expect(readTextInput(file, { ...OPTIONS, maxBytes: -1 })).rejects.toThrow(RangeError);
  });

  it('refuses directories and invalid UTF-8', async () => {
    const root = await makeTempDir();
    await makeDirs(root, 'dir.json');
    await writeTree(root, { 'bad.json': new Uint8Array([0x22, 0xff, 0x22]) });
    await expect(readTextInput(path.join(root, 'dir.json'), OPTIONS)).rejects.toThrow(
      /not a regular file/,
    );
    await expect(readTextInput(path.join(root, 'bad.json'), OPTIONS)).rejects.toThrow(
      /is not valid UTF-8 text/,
    );
  });

  it.skipIf(!symlinksSupported)('refuses symlinks, even to a regular file', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'real.json': '{}' });
    await link(root, 'link.json', 'real.json');
    await expect(readTextInput(path.join(root, 'link.json'), OPTIONS)).rejects.toThrow(
      /symbolic link/,
    );
  });

  it.skipIf(!fifosSupported)('refuses FIFOs without opening them', async () => {
    const root = await makeTempDir();
    expect(makeFifo(path.join(root, 'fifo.json'))).toBe(true);
    await expect(readTextInput(path.join(root, 'fifo.json'), OPTIONS)).rejects.toThrow(
      /not a regular file/,
    );
  });

  it.skipIf(!canDenyPermissions)('reports unreadable files and directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a.json': '{}', 'locked/b.json': '{}' });
    const file = path.join(root, 'a.json');
    const locked = path.join(root, 'locked');
    await chmod(file, 0o000);
    await chmod(locked, 0o000);
    try {
      await expect(readTextInput(file, OPTIONS)).rejects.toThrow(/Cannot read .*: EACCES/);
      await expect(readTextInput(path.join(locked, 'b.json'), OPTIONS)).rejects.toThrow(
        /Cannot read .*: EACCES/,
      );
    } finally {
      await chmod(file, 0o600);
      await chmod(locked, 0o700);
    }
  });
});

describe('parseJsonInput', () => {
  it('builds null-prototype objects and keeps arrays', () => {
    const value = parseJsonInput('{"a": [{"b": 1}, 2, null], "c": {"d": "e"}}', OPTIONS) as {
      a: [{ b: number }, number, null];
      c: { d: string };
    };
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(value.c)).toBeNull();
    expect(Object.getPrototypeOf(value.a[0])).toBeNull();
    expect(Array.isArray(value.a)).toBe(true);
    expect(value.a[0].b).toBe(1);
    expect({ ...value.c }).toEqual({ d: 'e' });
  });

  it('keeps __proto__ and constructor as plain own keys', () => {
    const value = parseJsonInput(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}}',
      OPTIONS,
    ) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect((value['__proto__'] as Record<string, unknown>)['polluted']).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('returns primitives as they are', () => {
    expect(parseJsonInput('3', OPTIONS)).toBe(3);
    expect(parseJsonInput('"x"', OPTIONS)).toBe('x');
    expect(parseJsonInput('null', OPTIONS)).toBeNull();
  });

  it('bounds nesting without recursion', () => {
    expect(() => parseJsonInput('[[[1]]]', { ...OPTIONS, maxDepth: 3 })).not.toThrow();
    expect(() => parseJsonInput('[[[[1]]]]', { ...OPTIONS, maxDepth: 3 })).toThrow(
      /more than 3 levels deep/,
    );
    const deep = `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`;
    expect(() => parseJsonInput(deep, OPTIONS)).toThrow(InputFileError);
  });

  it('reports invalid JSON with a position, without echoing the input', () => {
    let message = '';
    try {
      parseJsonInput('{"secret-token-value": ', OPTIONS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Baseline file is not valid JSON( \(at position \d+\))?\.$/);
    expect(message).not.toContain('secret');
  });
});

describe('readJsonInput', () => {
  it('reads and parses a file', async () => {
    const root = await makeTempDir();
    await writeTree(root, { 'a.json': '{"x": [1]}' });
    const value = (await readJsonInput(path.join(root, 'a.json'), OPTIONS)) as { x: number[] };
    expect(value.x).toEqual([1]);
  });
});
