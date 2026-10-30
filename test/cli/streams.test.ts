import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../../src/cli/run.js';
import { guardStream } from '../../src/cli/streams.js';
import { exited, removeTempDirs, spawnCli, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SMOKE = fileURLToPath(new URL('../fixtures/smoke', import.meta.url));

/** A stream whose every write fails as a write to a pipe without a reader does. */
function closedPipe(written: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString());
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('guardStream', () => {
  it('drops what follows a failed write, without an unhandled error', async () => {
    const written: string[] = [];
    const stream = closedPipe(written);
    const write = guardStream(stream);
    write('first\n');
    await tick();
    expect(stream.destroyed).toBe(true);
    expect(() => {
      write('second\n');
      write('third\n');
    }).not.toThrow();
    await tick();
    expect(written).toEqual(['first\n']);
  });

  it('drops writes to a destroyed stream, and covers other writers of the stream', async () => {
    const written: string[] = [];
    const stream = closedPipe(written);
    const write = guardStream(stream);
    // Another writer, as readline writes to stdout itself: its error is handled too.
    stream.write('prompt> ');
    await tick();
    write('report\n');
    await tick();
    expect(written).toEqual(['prompt> ']);
  });

  it('writes everything to a reader that keeps reading', () => {
    const written: string[] = [];
    const write = guardStream(
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written.push(chunk.toString());
          callback();
        },
      }),
    );
    write('a');
    write('b');
    expect(written).toEqual(['a', 'b']);
  });
});

// The CLI as a process whose reader stops at once, as `agentcheckup … | head -0` does.
describe('the CLI with a closed pipe', () => {
  it('rules --json, larger than a pipe buffer, exits 0 with stdout closed', async () => {
    const child = spawnCli(['rules', '--json'], ROOT);
    child.stdout.destroy();
    expect(await exited(child)).toMatchObject({ code: EXIT.ok, signal: null, stderr: '' });
  });

  it('a scan with errors keeps exit code 1', async () => {
    const child = spawnCli([SMOKE], ROOT);
    child.stdout.destroy();
    expect(await exited(child)).toMatchObject({ code: EXIT.findings, stderr: '' });
  });

  it('a usage error keeps exit code 2 with stderr closed', async () => {
    const child = spawnCli(['--bogus'], ROOT);
    child.stderr.destroy();
    expect(await exited(child)).toMatchObject({ code: EXIT.usage, stdout: '' });
  });

  it('fix --write applies its fixes and exits 0 with stdout closed', async () => {
    const repo = await tempDir();
    await writeFiles(repo, {
      'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
      'CLAUDE.md': '# Claude notes\n\nUse the staging database for manual tests.\n',
    });
    const child = spawnCli(['fix', '--write'], repo);
    child.stdout.destroy();
    expect(await exited(child)).toMatchObject({ code: EXIT.ok, stderr: '' });
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toMatch(/^@AGENTS\.md\n/);
  });

  it('--output is written after a warning to a closed stderr', async () => {
    const repo = await tempDir();
    await writeFiles(repo, {
      'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
      'agentcheckup.config.json': '{ "rules": { "no/such-rule": "off" } }\n',
    });
    const child = spawnCli(['--format', 'json', '-o', 'report.json'], repo);
    child.stderr.destroy();
    expect(await exited(child)).toMatchObject({ code: EXIT.ok, stdout: '' });
    const report = JSON.parse(await readFile(join(repo, 'report.json'), 'utf8')) as {
      findings: unknown;
    };
    expect(Array.isArray(report.findings)).toBe(true);
  });
});
