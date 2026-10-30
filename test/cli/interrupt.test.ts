import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INTERRUPT_SIGNALS,
  type InterruptSignal,
  interrupts,
  type SignalTarget,
  signalExitCode,
} from '../../src/cli/interrupt.js';
import { exited, removeTempDirs, spawnCli, tempDir, writeFiles } from './helpers.js';

/** A stand-in for `process`: signals are emitted by hand, and kill() is recorded. */
class FakeProcess extends EventEmitter implements SignalTarget {
  readonly pid = 4242;
  readonly killed: [number, InterruptSignal][] = [];

  kill(pid: number, signal: InterruptSignal): boolean {
    this.killed.push([pid, signal]);
    return true;
  }

  send(signal: InterruptSignal): void {
    this.emit(signal, signal);
  }

  listening(): number {
    return INTERRUPT_SIGNALS.reduce((sum, name) => sum + this.listenerCount(name), 0);
  }
}

describe('interrupts', () => {
  it('listens only during work, and turns the first signal into an abort', async () => {
    const target = new FakeProcess();
    const interrupt = interrupts(target);
    expect(target.listening()).toBe(0);
    const result = await interrupt.during(() => {
      expect(target.listening()).toBe(3);
      target.send('SIGTERM');
      // The work goes on: it decides what to finish.
      return Promise.resolve('finished');
    });
    expect(result).toBe('finished');
    expect(interrupt.signal.aborted).toBe(true);
    expect(interrupt.signal.reason).toBe('SIGTERM');
    expect(interrupt.received()).toBe('SIGTERM');
    expect(target.killed).toEqual([]);
    expect(target.listening()).toBe(0);
  });

  it('ends the process at once on a second signal', async () => {
    const target = new FakeProcess();
    const interrupt = interrupts(target);
    await interrupt.during(() => {
      target.send('SIGINT');
      target.send('SIGINT');
      // Without a listener, the re-raised signal's default action ends the process.
      expect(target.listening()).toBe(0);
      return Promise.resolve();
    });
    expect(target.killed).toEqual([[4242, 'SIGINT']]);
    expect(interrupt.received()).toBe('SIGINT');
  });

  it('keeps listening through nested work and removes its listeners after a failure', async () => {
    const target = new FakeProcess();
    const interrupt = interrupts(target);
    await expect(
      interrupt.during(async () => {
        await interrupt.during(() => Promise.resolve());
        expect(target.listening()).toBe(3);
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    expect(target.listening()).toBe(0);
    // Never interrupted: nothing aborted, nothing received.
    expect(interrupt.signal.aborted).toBe(false);
    expect(interrupt.received()).toBeUndefined();
  });

  it('reports a signal as a shell does: 128 plus its number', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode('SIGHUP')).toBe(129);
  });
});

// The CLI as a process, interrupted while it writes fixes. Windows has no SIGINT to send: there,
// kill() ends the process without running a handler.
describe.skipIf(process.platform === 'win32')('fix --write interrupted by Ctrl+C', () => {
  afterEach(removeTempDirs);

  it('finishes the fix in progress, leaves no temporary file and exits 130', async () => {
    const repo = await tempDir();
    const rules = 300;
    const files: Record<string, string> = {};
    for (let index = 0; index < rules; index++) {
      files[`.cursor/rules/r${index}.md`] = `Prefer named exports in module ${index}.\n`;
    }
    await writeFiles(repo, files);
    const directory = join(repo, '.cursor', 'rules');
    const child = spawnCli(
      ['fix', '--write', '--review', '--rule', 'cursor/md-file-ignored'],
      repo,
    );
    const done = exited(child);
    // Ctrl+C once the first rule is renamed.
    while (!(await readdir(directory)).some((name) => name.endsWith('.mdc'))) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    child.kill('SIGINT');
    const result = await done;

    expect(result).toMatchObject({ code: 130, signal: null, stdout: '' });
    const applied =
      /^Interrupted: (\d+) of 300 fixes applied; run agentcheckup fix again for the rest\.$/m.exec(
        result.stderr,
      );
    expect(applied, result.stderr).not.toBeNull();
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const renamed = names.filter((name) => name.endsWith('.mdc'));
    expect(renamed.length).toBe(Number(applied?.[1]));
    expect(renamed.length).toBeLessThan(rules);
    for (const name of renamed) {
      expect(await readFile(join(directory, name), 'utf8')).toMatch(
        /^---\nalwaysApply: true\n---\n/,
      );
    }
    // Every rule is still .md or completely .mdc, never both.
    expect(names.length).toBe(rules);
  });
});
