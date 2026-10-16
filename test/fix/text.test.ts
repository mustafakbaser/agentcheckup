import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decode } from '../../src/core/text.js';
import type { TextEdit } from '../../src/core/types.js';
import {
  applyEdits,
  composeEdits,
  editProblem,
  encodeChecked,
  encodeText,
  eolNear,
  lineEndAfter,
  lineIndexAt,
  roundTrips,
  sameBytes,
  withEol,
} from '../../src/fix/text.js';

/** Sorted, non-overlapping edits over a text of `size` code units, at most one insert per offset. */
function editsFor(size: number): fc.Arbitrary<TextEdit[]> {
  return fc
    .array(
      fc.record({
        offset: fc.integer({ min: 0, max: size }),
        length: fc.integer({ min: 0, max: 4 }),
        text: fc.string({ maxLength: 4 }),
      }),
      { maxLength: 6 },
    )
    .map((raw) => {
      const sorted = raw
        .map((edit) => ({ ...edit, length: Math.min(edit.length, size - edit.offset) }))
        .sort((a, b) => a.offset - b.offset || a.length - b.length);
      const edits: TextEdit[] = [];
      let end = -1;
      let insert = -1;
      for (const edit of sorted) {
        if (edit.offset < end) continue;
        if (edit.length === 0 && edit.offset === insert) continue;
        edits.push(edit);
        end = edit.offset + edit.length;
        insert = edit.length === 0 ? edit.offset : -1;
      }
      return edits;
    });
}

describe('composeEdits', () => {
  it('gives the text of applying both lists in turn', () => {
    const scenario = fc.string({ maxLength: 12 }).chain((original) =>
      editsFor(original.length).chain((first) => {
        const middle = applyEdits(original, first);
        return editsFor(middle.length).map((second) => ({ original, first, second }));
      }),
    );
    fc.assert(
      fc.property(scenario, ({ original, first, second }) => {
        const composed = composeEdits(original, first, second);
        expect(applyEdits(original, composed)).toBe(
          applyEdits(applyEdits(original, first), second),
        );
        expect(editProblem(original.replaceAll('\r', ' '), composed)).toBeUndefined();
      }),
    );
  });

  it('keeps distant edits apart and merges touching ones', () => {
    const original = 'abcdefghij';
    const first = [{ offset: 1, length: 1, text: 'BB' }];
    expect(composeEdits(original, first, [{ offset: 8, length: 1, text: 'X' }])).toEqual([
      { offset: 1, length: 1, text: 'BB' },
      { offset: 7, length: 1, text: 'X' },
    ]);
    expect(composeEdits(original, first, [{ offset: 2, length: 0, text: '!' }])).toEqual([
      { offset: 1, length: 1, text: 'B!B' },
    ]);
    // Inserting and deleting the same text composes to nothing.
    expect(
      composeEdits(
        original,
        [{ offset: 3, length: 0, text: 'x' }],
        [{ offset: 3, length: 1, text: '' }],
      ),
    ).toEqual([]);
  });
});

describe('editProblem', () => {
  it('accepts sorted, non-overlapping edits', () => {
    expect(
      editProblem('abcdef', [
        { offset: 0, length: 0, text: 'x' },
        { offset: 0, length: 2, text: 'y' },
        { offset: 2, length: 0, text: 'z' },
      ]),
    ).toBeUndefined();
  });

  it('names what does not fit', () => {
    expect(editProblem('abc', [{ offset: -1, length: 0, text: '' }])).toMatch(/negative/);
    expect(editProblem('abc', [{ offset: 1.5, length: 0, text: '' }])).toMatch(/fractional/);
    expect(editProblem('abc', [{ offset: 2, length: 2, text: '' }])).toMatch(/past the end/);
    expect(
      editProblem('abcdef', [
        { offset: 2, length: 2, text: '' },
        { offset: 3, length: 0, text: '' },
      ]),
    ).toMatch(/overlap/);
    expect(
      editProblem('abc', [
        { offset: 1, length: 0, text: 'a' },
        { offset: 1, length: 0, text: 'b' },
      ]),
    ).toMatch(/two insertions/);
    expect(editProblem('a\r\nb', [{ offset: 2, length: 0, text: 'x' }])).toMatch(/line break/);
    expect(editProblem('a😀b', [{ offset: 2, length: 0, text: 'x' }])).toMatch(/surrogate/);
  });
});

describe('line endings', () => {
  it('takes the file ending, or the neighbor in a mixed file', () => {
    expect(eolNear(decode(new TextEncoder().encode('a\nb\n')), 0)).toBe('\n');
    expect(eolNear(decode(new TextEncoder().encode('a\r\nb\r\n')), 0)).toBe('\r\n');
    expect(eolNear(decode(new TextEncoder().encode('one line')), 3)).toBe('\n');
    const mixed = decode(new TextEncoder().encode('a\r\nb\nc'));
    expect(mixed.lineEnding).toBe('mixed');
    expect(eolNear(mixed, 0)).toBe('\r\n');
    expect(eolNear(mixed, 3)).toBe('\n');
    // The last line has no ending: the line above it decides.
    expect(eolNear(mixed, 6)).toBe('\n');
  });

  it('rewrites CRLF and LF, leaving lone CR alone', () => {
    expect(withEol('a\nb\r\nc\rd', '\r\n')).toBe('a\r\nb\r\nc\rd');
    expect(withEol('a\nb\r\nc', '\n')).toBe('a\nb\nc');
    expect(withEol('plain', '\r\n')).toBe('plain');
  });

  it('finds lines', () => {
    expect(lineIndexAt([0, 4, 9], 0)).toBe(0);
    expect(lineIndexAt([0, 4, 9], 5)).toBe(1);
    expect(lineIndexAt([0, 4, 9], 20)).toBe(2);
    expect(lineEndAfter('ab\r\ncd', 0)).toBe(2);
    expect(lineEndAfter('ab\ncd', 4)).toBe(5);
  });
});

describe('encoding', () => {
  it('round-trips every encoding the decoder detects', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 40 }),
        fc.constantFrom(
          ['utf-8', false],
          ['utf-8', true],
          ['utf-16le', true],
          ['utf-16be', true],
        ) as fc.Arbitrary<['utf-8' | 'utf-16le' | 'utf-16be', boolean]>,
        (text, [encoding, bom]) => {
          const bytes = encodeChecked(text, encoding, bom);
          if (bytes === undefined) return;
          const decoded = decode(bytes);
          expect(decoded.text).toBe(text);
          expect(roundTrips(bytes, decoded)).toBe(true);
        },
      ),
    );
  });

  it('refuses text that does not survive encoding', () => {
    // A lone surrogate becomes U+FFFD in UTF-8.
    expect(encodeChecked('a\ud800b', 'utf-8', false)).toBeUndefined();
    // Text starting with U+FEFF would read back as a byte order mark.
    expect(encodeChecked('\uFEFFa', 'utf-8', false)).toBeUndefined();
    expect(encodeChecked('a', 'utf-16le', true)).toEqual(new Uint8Array([0xff, 0xfe, 0x61, 0]));
    expect(encodeText('a', 'utf-16be', true)).toEqual(new Uint8Array([0xfe, 0xff, 0, 0x61]));
  });

  it('finds files that do not round-trip', () => {
    const invalid = new Uint8Array([0x61, 0xff, 0x62]);
    expect(roundTrips(invalid, decode(invalid))).toBe(false);
    const decoded = decode(new TextEncoder().encode('abc'));
    expect(roundTrips(new TextEncoder().encode('abd'), decoded)).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
