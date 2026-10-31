/**
 * The unified diff between two versions of a source's normalized text, for `pnpm drift:diff`.
 *
 * The visible text of an HTML page is normalized to one long line (normalize.ts), which would
 * make a diff of one line. For the diff only, lines longer than {@link LONG_LINE} characters are
 * broken after each sentence, so the diff shows the sentences that changed. The hash is not
 * affected.
 *
 * The text comes from the network, so every line goes through `forTerminal` and the output
 * through `guardWorkflowCommands`, like everything agentcheckup prints.
 */
import { diffHunks } from '../../src/report/fix-diff.js';
import { forTerminal, guardWorkflowCommands } from '../../src/report/sanitize.js';

/** A hunk range as GNU diff writes it: a count of 1 is left out. */
function range(start: number, lines: number): string {
  return lines === 1 ? String(start) : `${String(start)},${String(lines)}`;
}

const LONG_LINE = 200;

/** `text` with a line break after each sentence of a long line. */
export function sentenceLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.length <= LONG_LINE
        ? line
        : line.replaceAll('. ', '.\n').replaceAll('? ', '?\n').replaceAll('! ', '!\n'),
    )
    .join('\n');
}

/** Normalized text has no line break after its last line; compare it as if it had one. */
function asLines(text: string): string {
  return text === '' ? '' : `${sentenceLines(text)}\n`;
}

/**
 * `--- from` and `+++ to` headers and the hunks from `before` to `after`, or the empty string
 * when the texts are the same.
 */
export function formatTextDiff(
  before: string,
  after: string,
  labels: { readonly from: string; readonly to: string },
): string {
  const hunks = diffHunks(asLines(before), asLines(after));
  if (hunks.length === 0) return '';
  const out = [`--- ${forTerminal(labels.from)}`, `+++ ${forTerminal(labels.to)}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    );
    for (const line of hunk.lines) out.push(forTerminal(line));
  }
  return guardWorkflowCommands(`${out.join('\n')}\n`);
}
