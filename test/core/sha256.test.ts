import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/sha256.js';
import { taskId } from '../../src/tasks/index.js';

function reference(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto at block boundaries', () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 128]) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });

  it('matches node:crypto on any text, astral characters and lone surrogates included', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(sha256Hex(text)).toBe(reference(text));
      }),
    );
  });
});

describe('taskId', () => {
  it('is ac- and the first 8 hex digits of SHA-256(rule id, NUL, path)', () => {
    const path = '.claude/skills/deploy/SKILL.md';
    const id = taskId('skill/description-quality', path);
    expect(id).toBe(`ac-${reference(`skill/description-quality\u0000${path}`).slice(0, 8)}`);
    expect(id).toMatch(/^ac-[\da-f]{8}$/);
  });

  it('differs by rule and by path', () => {
    const id = taskId('skill/body-too-long', 'a/SKILL.md');
    expect(taskId('skill/body-too-long', 'b/SKILL.md')).not.toBe(id);
    expect(taskId('skill/description-quality', 'a/SKILL.md')).not.toBe(id);
  });
});
