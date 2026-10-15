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

  it('does not affect a scan without --context', async () => {
    expect(await run(['--fail-on', 'none'], capture(CONTEXT_FIXTURE))).toBe(EXIT.ok);
  });
});
