/**
 * Line input from the terminal for `agentcheckup fix -i`. The readline interface opens on the
 * first question, so commands that ask nothing never touch stdin.
 */
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { safeCopiedText } from '../fix/edits.js';
import type { Prompt } from './common.js';

export interface TerminalPrompt extends Prompt {
  /** Releases the input, so the process can exit. */
  readonly close: () => void;
}

/**
 * True for text that may go on the input line as it is: one line without a control,
 * bidirectional or invisible character, so prefilling never writes an escape sequence to the
 * terminal.
 */
export function prefillable(text: string): boolean {
  return safeCopiedText(text, Number.MAX_SAFE_INTEGER) !== undefined;
}

export function terminalPrompt(
  input: Readable & { readonly isTTY?: boolean },
  output: Writable,
): TerminalPrompt {
  const isTTY = input.isTTY === true;
  let lines: Interface | undefined;
  let ended = false;

  const open = (): Interface => {
    if (lines !== undefined) return lines;
    const created = createInterface({ input, output, terminal: isTTY });
    created.on('close', () => {
      ended = true;
    });
    // Ctrl+C ends the input: the command stops asking and writes nothing.
    created.on('SIGINT', () => {
      created.close();
    });
    lines = created;
    return created;
  };

  return {
    isTTY,
    ask(question, options = {}) {
      if (ended) return Promise.resolve(undefined);
      const reader = open();
      return new Promise((resolve) => {
        const onClose = (): void => {
          resolve(undefined);
        };
        reader.once('close', onClose);
        reader.question(question, (answer) => {
          reader.off('close', onClose);
          resolve(answer);
        });
        // In a terminal, readline takes written text as typed: the user edits it or presses Enter.
        const { initial } = options;
        if (isTTY && initial !== undefined && prefillable(initial)) reader.write(initial);
      });
    },
    close() {
      lines?.close();
    },
  };
}
