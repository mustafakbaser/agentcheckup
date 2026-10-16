import { describe, expect, it, vi } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import type * as Engine from '../../src/core/engine.js';
import { capture, CONTEXT_FIXTURE } from './helpers.js';

// A loader that crashes: scanWithContext throws after the CLI validated every option.
vi.mock('../../src/core/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Engine>();
  return {
    ...actual,
    scanWithContext: () => {
      throw new TypeError('loader crashed');
    },
  };
});

describe('a crashing loader', () => {
  it.each([[['context']], [['--context']], [['context', '--matrix']]])(
    '%j exits 3 with an internal error',
    async (args) => {
      const io = capture(CONTEXT_FIXTURE);
      expect(await run(args, io)).toBe(EXIT.internal);
      expect(io.out).toEqual([]);
      expect(io.errors()).toContain('Internal error: loader crashed');
    },
  );

  it('does not affect a scan without --context: the report leaves the plans out', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['--fail-on', 'none'], io)).toBe(EXIT.ok);
    expect(io.output()).not.toContain('What each agent misses');
    expect(io.errors()).toContain('Could not work out what each agent loads');
    expect(io.errors()).toContain('loader crashed');

    const compact = capture(CONTEXT_FIXTURE);
    expect(await run(['--fail-on', 'none', '--compact'], compact)).toBe(EXIT.ok);
    expect(compact.errors()).toBe('');
  });
});
