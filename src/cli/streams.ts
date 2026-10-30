/**
 * Output to a reader that may stop reading. `agentcheckup | head` closes the pipe after ten
 * lines, and a CI step may close stderr. A write to a closed pipe fails with EPIPE, reported as
 * an 'error' event on the stream; unhandled, it would end the process with a stack trace and
 * exit code 1, whatever the run found, before an `--output` file or the fixes are written. The
 * guarded writer drops what nobody reads instead, so the command finishes and exits with the
 * code it computed.
 */
import type { Writable } from 'node:stream';

/**
 * Listens for errors on `stream` and returns a writer that drops text once a write failed or
 * the stream was destroyed. The listener covers every writer of the stream, so guard it before
 * anything else writes to it, readline included.
 */
export function guardStream(stream: Writable): (text: string) => void {
  let closed = false;
  stream.on('error', () => {
    closed = true;
  });
  return (text) => {
    if (closed || stream.destroyed) return;
    stream.write(text);
  };
}
