/**
 * Ctrl+C, SIGTERM and SIGHUP while a command changes files or asks for input. Outside such work
 * a signal ends the process at once, as it does without a handler: a scan has nothing to finish.
 * Within {@link Interrupts.during}, the first signal aborts {@link Interrupts.signal} instead:
 * the prompt of `fix -i` closes and gives the terminal back, and `fix` finishes or undoes the
 * fix it is writing and skips the rest (src/io/write-fix.ts). A second signal ends the process
 * at once. Once the command is done, it exits with 128 plus the signal's number (130 for
 * SIGINT, 143 for SIGTERM, 129 for SIGHUP), as a shell reports a process the signal ended.
 */
import { constants } from 'node:os';

export const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** The part of `process` this module uses, so tests can send signals to a stand-in. */
export interface SignalTarget {
  readonly pid: number;
  on(signal: InterruptSignal, listener: (signal: InterruptSignal) => void): unknown;
  off(signal: InterruptSignal, listener: (signal: InterruptSignal) => void): unknown;
  kill(pid: number, signal: InterruptSignal): unknown;
}

export interface Interrupts {
  /** Aborted by the first signal during {@link during}, with the signal's name as its reason. */
  readonly signal: AbortSignal;
  /** Runs `work` with signals turned into an abort of {@link signal}. Calls may nest. */
  readonly during: <T>(work: () => Promise<T>) => Promise<T>;
  /** The signal that aborted {@link signal}, if one did. */
  readonly received: () => InterruptSignal | undefined;
}

export function interrupts(target: SignalTarget): Interrupts {
  const controller = new AbortController();
  let received: InterruptSignal | undefined;
  let active = 0;
  const listen = (on: boolean): void => {
    for (const name of INTERRUPT_SIGNALS) {
      if (on) target.on(name, onSignal);
      else target.off(name, onSignal);
    }
  };
  function onSignal(signal: InterruptSignal): void {
    if (received === undefined) {
      received = signal;
      controller.abort(signal);
      return;
    }
    // The second signal: without a listener, the signal's default action ends the process.
    listen(false);
    active = 0;
    target.kill(target.pid, signal);
  }
  return {
    signal: controller.signal,
    async during(work) {
      if (active++ === 0) listen(true);
      try {
        return await work();
      } finally {
        if (active > 0 && --active === 0) listen(false);
      }
    },
    received: () => received,
  };
}

/** The exit code of a process `signal` ended: 128 plus the signal's number. */
export function signalExitCode(signal: InterruptSignal): number {
  return 128 + constants.signals[signal];
}
