import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { capture, CONTEXT_FIXTURE, removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const windows = process.platform === 'win32';

describe('--output', () => {
  it('replaces a regular file and leaves no temporary file behind', async () => {
    const work = await tempDir();
    const output = join(work, 'report.json');
    await writeFile(output, 'old');
    const io = capture(work);
    expect(await run([CONTEXT_FIXTURE, '--format', 'json', '--output', 'report.json'], io)).toBe(
      EXIT.findings,
    );
    expect(io.out).toEqual([]);
    expect(JSON.parse(await readFile(output, 'utf8'))).toHaveProperty('findings');
    expect(await readdir(work)).toEqual(['report.json']);
  });

  it.skipIf(windows)('refuses a symlink, wherever it points', async () => {
    const work = await tempDir();
    const target = join(work, 'target.txt');
    await writeFile(target, 'keep me');
    await symlink(target, join(work, 'report.sarif'));
    await symlink(join(work, 'nowhere'), join(work, 'dangling.sarif'));

    for (const name of ['report.sarif', 'dangling.sarif']) {
      const io = capture(work);
      expect(await run([CONTEXT_FIXTURE, '--format', 'sarif', '--output', name], io)).toBe(
        EXIT.usage,
      );
      expect(io.errors()).toContain('it is a symbolic link');
      expect(io.out).toEqual([]);
    }
    expect(await readFile(target, 'utf8')).toBe('keep me');
    await expect(lstat(join(work, 'nowhere'))).rejects.toThrow();
    expect((await readdir(work)).sort()).toEqual(['dangling.sarif', 'report.sarif', 'target.txt']);
  });

  it('refuses a directory and a missing parent directory', async () => {
    const work = await tempDir();
    await mkdir(join(work, 'out'));
    const directory = capture(work);
    expect(await run(['context', CONTEXT_FIXTURE, '--output', 'out'], directory)).toBe(EXIT.usage);
    expect(directory.errors()).toContain('it is not a regular file');

    const missing = capture(work);
    expect(await run(['context', CONTEXT_FIXTURE, '--output', 'nope/plans.txt'], missing)).toBe(
      EXIT.usage,
    );
    expect(missing.errors()).toContain('its directory does not exist');
  });
});
