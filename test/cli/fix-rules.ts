/**
 * Test-only rules that attach fixes, for the `agentcheckup fix` CLI tests (no built-in rule
 * emits fixes yet). test/cli/fix.test.ts adds them to the built-in rules with vi.mock.
 *
 * On an AGENTS.md:
 * - test/heading: no `# ` heading on line 1. Safe fix: insert `# Agents` and a blank line; one
 *   alternative inserts `# Project` (review).
 * - test/footer: no `Reviewed.` line. Review fix: append it.
 * - test/notes: no docs/agents-notes.md next to it. Safe fix: create that file.
 * - test/move: an AGENTS.md under old/. Safe fix: rename it to new/AGENTS.md.
 * - mcp/literal-secret (replaces the built-in rule, which emits no fix yet): a `token: <value>`
 *   line. Review fix: replace the value with `${TOKEN}`, with the rotation warning.
 * - test/crash: throws on a file that contains `CRASH`.
 */
import type { AnyRule, Artifact } from '../../src/core/types.js';
import { createFile, insertLine, renameFile, replaceSpan } from '../../src/fix/edits.js';
import { testRule } from '../fix/helpers.js';

export const ROTATE =
  'Revoke and rotate this credential now. Editing the file does not remove it from git history.';

function lines(artifact: Artifact): string[] {
  return artifact.decoded.text.split('\n');
}

function lineCount(artifact: Artifact): number {
  const { text } = artifact.decoded;
  if (text === '') return 0;
  return text.endsWith('\n') ? lines(artifact).length - 1 : lines(artifact).length;
}

const heading = testRule({
  id: 'test/heading',
  check(context, artifact) {
    if (artifact.decoded.text.startsWith('# ') || artifact.decoded.text === '') return;
    context.report({
      artifact,
      message: 'AGENTS.md has no heading.',
      fix: {
        id: 'test/heading#agents',
        class: 'safe',
        title: `Add "# Agents" as line 1 of ${artifact.path}`,
        changes: [insertLine(artifact, 0, '# Agents', { blankAfter: true })],
        alternatives: [
          {
            id: 'test/heading#project',
            class: 'review',
            title: `Add "# Project" as line 1 of ${artifact.path}`,
            changes: [insertLine(artifact, 0, '# Project', { blankAfter: true })],
          },
        ],
      },
    });
  },
});

const footer = testRule({
  id: 'test/footer',
  check(context, artifact) {
    if (artifact.decoded.text === '' || lines(artifact).includes('Reviewed.')) return;
    context.report({
      artifact,
      message: 'AGENTS.md is not marked as reviewed.',
      fix: {
        id: 'test/footer#append',
        class: 'review',
        title: `Append "Reviewed." to ${artifact.path}`,
        changes: [insertLine(artifact, lineCount(artifact), 'Reviewed.')],
        notes: ['Only a person can say this.'],
      },
    });
  },
});

const NOTES = 'docs/agents-notes.md';

const notes = testRule({
  id: 'test/notes',
  check(context, artifact) {
    if (artifact.path !== 'AGENTS.md' || !artifact.decoded.text.includes('See the notes.')) return;
    if (context.snapshot.paths.has(NOTES)) return;
    context.report({
      artifact,
      message: `AGENTS.md points to ${NOTES}, which does not exist.`,
      fix: {
        id: 'test/notes#create',
        class: 'safe',
        title: `Create ${NOTES}`,
        changes: [createFile(NOTES, '# Notes\n')],
      },
    });
  },
});

const move = testRule({
  id: 'test/move',
  check(context, artifact) {
    if (artifact.path !== 'old/AGENTS.md') return;
    context.report({
      artifact,
      message: 'old/ is retired.',
      fix: {
        id: 'test/move#rename',
        class: 'safe',
        title: 'Move old/AGENTS.md to new/AGENTS.md',
        changes: [renameFile(artifact, 'new/AGENTS.md')],
      },
    });
  },
});

const SECRET_LINE = /^token: (\S+)$/m;

const secret = testRule({
  id: 'mcp/literal-secret',
  severity: 'error',
  check(context, artifact) {
    const match = SECRET_LINE.exec(artifact.decoded.text);
    const value = match?.[1];
    if (match === null || value === undefined || value.startsWith('${')) return;
    const offset = match.index + 'token: '.length;
    context.report({
      artifact,
      message: 'AGENTS.md has a literal token.',
      fix: {
        id: 'mcp/literal-secret#env',
        class: 'review',
        title: `Read the token from TOKEN in ${artifact.path}`,
        changes: [replaceSpan(artifact, { offset, length: value.length }, '${TOKEN}')],
        warning: ROTATE,
      },
    });
  },
});

const crash = testRule({
  id: 'test/crash',
  check(_context, artifact) {
    if (artifact.decoded.text.includes('CRASH')) throw new Error('test rule crashed');
  },
});

export const FIX_TEST_RULES: readonly AnyRule[] = [heading, footer, notes, move, secret, crash];
