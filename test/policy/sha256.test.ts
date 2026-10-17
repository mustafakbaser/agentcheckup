import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/policy/sha256.js';

const reference = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('gives the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto around block boundaries', () => {
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });

  it('agrees with node:crypto on any text, encoded as UTF-8', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        // Lone surrogates encode as U+FFFD in both.
        expect(sha256Hex(text)).toBe(reference(text));
      }),
      { numRuns: 300 },
    );
  });
});
