import { describe, expect, it } from 'vitest';
import { ansiStyle, shouldUseColor } from '../../src/cli/style.js';

describe('shouldUseColor', () => {
  const tty = { flag: undefined, env: {}, isTTY: true };

  it.each([
    [{ ...tty }, true],
    [{ ...tty, isTTY: false }, false],
    [{ ...tty, flag: false }, false],
    [{ ...tty, isTTY: false, flag: true }, true],
    [{ ...tty, env: { NO_COLOR: '1' } }, false],
    [{ ...tty, env: { NO_COLOR: '' } }, true],
    [{ ...tty, isTTY: false, env: { FORCE_COLOR: '1' } }, true],
    [{ ...tty, env: { FORCE_COLOR: '0' } }, false],
    [{ ...tty, env: { FORCE_COLOR: '1', NO_COLOR: '1' } }, true],
    [{ ...tty, env: { TERM: 'dumb' } }, false],
    [{ ...tty, flag: true, env: { NO_COLOR: '1' } }, true],
  ])('decides %j -> %s', (input, expected) => {
    expect(shouldUseColor(input)).toBe(expected);
  });

  it('wraps text in matching ANSI codes', () => {
    expect(ansiStyle.red('x')).toBe('\u001b[31mx\u001b[39m');
    expect(ansiStyle.bold('x')).toBe('\u001b[1mx\u001b[22m');
  });
});
