import type { Position, Range } from '../../../src/core/types.js';

function position(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}

/** Range of the `occurrence`-th (0-based) appearance of `token` in `text`. */
export function rangeOf(text: string, token: string, occurrence = 0): Range {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(token, index + 1);
    if (index === -1) throw new Error(`"${token}" not found`);
  }
  return { start: position(text, index), end: position(text, index + token.length) };
}

/** Pretty-printed JSON, as people write configuration files. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Deterministic pseudo-random base62 text for fake credentials. Tests assemble tokens at run
 * time, so no contiguous credential-shaped string is committed to this repository.
 */
export function noise(
  length: number,
  seed = 7,
  alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
): string {
  let out = '';
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet.charAt((state >>> 16) % alphabet.length);
  }
  return out;
}
