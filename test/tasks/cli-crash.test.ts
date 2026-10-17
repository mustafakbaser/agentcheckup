import { describe, expect, it, vi } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import type * as Engine from '../../src/core/engine.js';
import { capture, CONTEXT_FIXTURE } from '../cli/helpers.js';

// A rule that crashes: runRules reports a failure, as the engine does for a rule that throws.
vi.mock('../../src/core/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Engine>();
  return {
    ...actual,
    runRules: (...args: Parameters<typeof actual.runRules>) => ({
      ...actual.runRules(...args),
      ruleFailures: [{ ruleId: 'skill/description-quality', message: 'boom\u001B[2J' }],
    }),
  };
});

describe('agentcheckup tasks with a crashed rule', () => {
  it.each([[['tasks']], [['tasks', '--check']]])('%j exits 3 and lists nothing', async (args) => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(args, io)).toBe(EXIT.internal);
    expect(io.out).toEqual([]);
    expect(io.errors()).toBe(
      'Rule skill/description-quality crashed: boom<U+001B>[2J\n' +
        'A scan with a crashed rule cannot tell which tasks are open.\n',
    );
  });
});
