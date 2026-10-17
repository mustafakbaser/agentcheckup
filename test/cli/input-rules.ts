/**
 * Test-only rules for the `agentcheckup fix -i` tests of fixes that need the user's words
 * (test/cli/fix-input.test.ts adds them to the built-in rules with vi.mock):
 *
 * - test/shout (warning): a line of AGENTS.md that is `SHOUT`, reported on that line. Review fix:
 *   write it as `shout`. One fix per line, so [A]ll has more than one to apply, and [s]uppress
 *   has a line to put the directive before.
 * - risk/payload (a risk warning): a `PAYLOAD` line of AGENTS.md. Review fix: delete the word.
 *   [s]uppress is never offered for it.
 */
import type { AnyRule, Artifact } from '../../src/core/types.js';
import { replaceSpan } from '../../src/fix/edits.js';
import { testRule } from '../fix/helpers.js';

/** Offsets of each line of `artifact` that is exactly `word`. */
function linesOf(artifact: Artifact, word: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of artifact.decoded.text.split('\n')) {
    if (line === word) offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

const shout = testRule({
  id: 'test/shout',
  check(context, artifact) {
    for (const offset of linesOf(artifact, 'SHOUT')) {
      const span = { offset, length: 'SHOUT'.length };
      context.report({
        artifact,
        message: 'AGENTS.md shouts.',
        span,
        fix: {
          id: 'test/shout#lower',
          class: 'review',
          title: `Lower the shout at offset ${offset} of ${artifact.path}`,
          changes: [replaceSpan(artifact, span, 'shout')],
        },
      });
    }
  },
});

const payload = testRule({
  id: 'risk/payload',
  category: 'risk',
  check(context, artifact) {
    for (const offset of linesOf(artifact, 'PAYLOAD')) {
      const span = { offset, length: 'PAYLOAD'.length };
      context.report({
        artifact,
        message: 'AGENTS.md carries a payload.',
        span,
        fix: {
          id: 'risk/payload#delete',
          class: 'review',
          title: `Delete the payload of ${artifact.path}`,
          changes: [replaceSpan(artifact, span, 'removed')],
        },
      });
    }
  },
});

export const INPUT_TEST_RULES: readonly AnyRule[] = [shout, payload];
