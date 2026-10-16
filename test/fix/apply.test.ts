import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decode } from '../../src/core/text.js';
import type { FileChange, Snapshot } from '../../src/core/types.js';
import { applyPlan, editedText, FixApplyError } from '../../src/fix/apply.js';
import { encodeText } from '../../src/fix/text.js';
import { snapshotFrom } from '../helpers/lint.js';
import { applyChanges, bytesOf, fixOf, planned, textOf, utf16 } from './helpers.js';

const edit = (path: string, offset: number, length: number, text: string): FileChange => ({
  kind: 'edit',
  path,
  edits: [{ offset, length, text }],
});

/** File contents in every encoding and line ending the decoder detects. */
const fileBytes = fc
  .tuple(
    fc.array(fc.string({ maxLength: 8 }), { maxLength: 6 }),
    fc.constantFrom('\n', '\r\n'),
    fc.boolean(),
    fc.constantFrom(
      ['utf-8', false],
      ['utf-8', true],
      ['utf-16le', true],
      ['utf-16be', true],
    ) as fc.Arbitrary<['utf-8' | 'utf-16le' | 'utf-16be', boolean]>,
  )
  .map(([lines, eol, final, [encoding, bom]]) => {
    const text = lines.join(eol) + (final && lines.length > 0 ? eol : '');
    return encodeText(text.startsWith('\uFEFF') ? `x${text}` : text, encoding, bom);
  });

describe('applyPlan', () => {
  it('returns the snapshot itself for a plan without planned fixes', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': '# A\n' });
    expect(applyPlan(snapshot, { fixes: [] })).toBe(snapshot);
    const skipped = {
      ...planned(fixOf([edit('AGENTS.md', 0, 0, 'x')])),
      status: 'skipped' as const,
      reason: 'conflict' as const,
    };
    expect(applyPlan(snapshot, { fixes: [skipped] })).toBe(snapshot);
  });

  it('leaves every byte alone for a fix that changes nothing', () => {
    fc.assert(
      fc.property(fileBytes, fc.nat(), fc.nat(), (bytes, a, b) => {
        const snapshot = snapshotFrom({ 'AGENTS.md': bytes, 'CLAUDE.md': '# C\n' });
        const { text } = decode(bytes);
        let start = text.length === 0 ? 0 : a % (text.length + 1);
        let end = text.length === 0 ? 0 : start + (b % (text.length - start + 1));
        // Keep CRLF pairs and surrogate pairs whole.
        while (start > 0 && text.charAt(start - 1) === '\r' && text.charAt(start) === '\n') start--;
        while (end < text.length && text.charAt(end - 1) === '\r' && text.charAt(end) === '\n')
          end++;
        const next = applyChanges(
          snapshot,
          edit('AGENTS.md', start, end - start, text.slice(start, end)),
        );
        expect(next.files).toEqual(snapshot.files);
        expect(next.files[0]).toBe(snapshot.files[0]);
        expect(next.paths).toEqual(snapshot.paths);
      }),
    );
  });

  it('keeps the encoding, byte order mark and line endings of the file', () => {
    fc.assert(
      fc.property(fileBytes, fc.string({ maxLength: 5 }), (bytes, inserted) => {
        const before = decode(bytes);
        const next = applyChanges(
          snapshotFrom({ 'AGENTS.md': bytes }),
          edit('AGENTS.md', 0, 0, `${inserted}\n`),
        );
        const after = decode(bytesOf(next, 'AGENTS.md'));
        expect(after.encoding).toBe(before.encoding);
        expect(after.hasBom).toBe(before.hasBom);
        if (before.lineEnding === 'lf' || before.lineEnding === 'crlf') {
          expect(after.lineEnding).toBe(before.lineEnding);
        }
        expect(after.text.endsWith('\n')).toBe(before.text === '' || before.text.endsWith('\n'));
      }),
    );
  });

  it('writes new line breaks with the ending around them', () => {
    expect(
      editedText(decode(new TextEncoder().encode('a\r\nb\r\n')), [
        { offset: 0, length: 0, text: 'x\ny\n' },
      ]),
    ).toBe('x\r\ny\r\na\r\nb\r\n');
    expect(
      editedText(decode(new TextEncoder().encode('a\nb\n')), [
        { offset: 0, length: 0, text: 'x\r\n' },
      ]),
    ).toBe('x\na\nb\n');
    const mixed = decode(new TextEncoder().encode('a\r\nb\nc\n'));
    // An insertion takes the ending of its line.
    expect(editedText(mixed, [{ offset: 3, length: 0, text: 'x\n' }])).toBe('a\r\nx\nb\nc\n');
    expect(editedText(mixed, [{ offset: 0, length: 0, text: 'x\n' }])).toBe('x\r\na\r\nb\nc\n');
    // Replacing several lines keeps the text as given.
    expect(editedText(mixed, [{ offset: 0, length: 5, text: 'x\r\ny\n' }])).toBe('x\r\ny\nc\n');
    // A file without line breaks takes the text as given.
    expect(
      editedText(decode(new TextEncoder().encode('a')), [{ offset: 1, length: 0, text: '\r\nb' }]),
    ).toBe('a\r\nb');
  });

  it('keeps the final newline, or its absence', () => {
    const lf = (text: string) => decode(new TextEncoder().encode(text));
    expect(editedText(lf('x\n'), [{ offset: 0, length: 2, text: 'y' }])).toBe('y\n');
    expect(editedText(lf('x\r\n'), [{ offset: 0, length: 3, text: 'y' }])).toBe('y\r\n');
    expect(editedText(lf('x'), [{ offset: 0, length: 1, text: 'y\n' }])).toBe('y');
    expect(editedText(lf(''), [{ offset: 0, length: 0, text: 'y\n' }])).toBe('y\n');
    expect(editedText(lf('x\n'), [{ offset: 0, length: 2, text: '' }])).toBe('');
  });

  it('renames a file, edits it under its new name and updates the paths', () => {
    const snapshot = snapshotFrom({
      '.cursor/rules/style.md': 'Use tabs.\n',
      'AGENTS.md': '# A\n',
    });
    const identified: Snapshot = {
      ...snapshot,
      files: snapshot.files.map((file) => ({
        ...file,
        imported: true,
        identity: { dev: 1n, ino: 2n, sha256: 'f'.repeat(64) },
      })),
      gitignoredConfig: new Set(['.cursor/rules/style.md']),
    };
    const next = applyChanges(
      identified,
      { kind: 'rename', from: '.cursor/rules/style.md', to: '.cursor/rules/new/style.mdc' },
      edit('.cursor/rules/new/style.mdc', 0, 0, '---\nalwaysApply: true\n---\n'),
    );
    expect(next.files.map((file) => file.path)).toEqual([
      '.cursor/rules/new/style.mdc',
      'AGENTS.md',
    ]);
    expect(textOf(next, '.cursor/rules/new/style.mdc')).toBe(
      '---\nalwaysApply: true\n---\nUse tabs.\n',
    );
    expect(next.files[0]).not.toHaveProperty('identity');
    expect(next.files[0]).not.toHaveProperty('imported');
    expect(next.files[1]).toBe(identified.files[1]);
    expect(next.paths.has('.cursor/rules/style.md')).toBe(false);
    expect(next.paths.has('.cursor/rules/new/')).toBe(true);
    expect(next.paths.has('.cursor/rules/')).toBe(true);
    expect([...(next.gitignoredConfig ?? [])]).toEqual(['.cursor/rules/new/style.mdc']);
    expect(identified.paths.has('.cursor/rules/style.md')).toBe(true);
  });

  it('keeps the bytes of a file that is only renamed, and the imported flag of an edited one', () => {
    const bytes = utf16('x\r\n');
    const snapshot = snapshotFrom({ 'a.md': bytes, 'b.md': 'b\n' }, { imported: ['a.md', 'b.md'] });
    const next = applyChanges(
      snapshot,
      { kind: 'rename', from: 'a.md', to: 'c.md' },
      edit('b.md', 0, 0, 'x'),
    );
    expect(bytesOf(next, 'c.md')).toBe(bytes);
    expect(next.files.find((file) => file.path === 'b.md')).toMatchObject({ imported: true });
  });

  it('edits and moves a file the same fix created', () => {
    const next = applyChanges(
      snapshotFrom({ 'AGENTS.md': '# A\n' }),
      { kind: 'create', path: 'docs/new.md', text: 'a\n' },
      edit('docs/new.md', 0, 0, 'b\n'),
      { kind: 'encoding', path: 'docs/new.md', to: 'utf-8', bom: false },
      { kind: 'rename', from: 'docs/new.md', to: 'docs/renamed.md' },
    );
    expect(next.files.map((file) => file.path)).toEqual(['AGENTS.md', 'docs/renamed.md']);
    expect(textOf(next, 'docs/renamed.md')).toBe('b\na\n');
    expect(next.paths.has('docs/new.md')).toBe(false);
  });

  it('creates files with their parent directories', () => {
    const next = applyChanges(snapshotFrom({ 'AGENTS.md': '# A\n' }), {
      kind: 'create',
      path: 'packages/api/CLAUDE.md',
      text: '@AGENTS.md\n',
    });
    expect(textOf(next, 'packages/api/CLAUDE.md')).toBe('@AGENTS.md\n');
    expect([...next.paths].sort()).toEqual([
      'AGENTS.md',
      'packages/',
      'packages/api/',
      'packages/api/CLAUDE.md',
    ]);
  });

  it('re-encodes a file as UTF-8 and edits it in the same fix', () => {
    const next = applyChanges(
      snapshotFrom({ 'AGENTS.md': utf16('# A\r\n') }),
      { kind: 'encoding', path: 'AGENTS.md', to: 'utf-8', bom: false },
      edit('AGENTS.md', 0, 0, 'x\n'),
    );
    expect(bytesOf(next, 'AGENTS.md')).toEqual(new TextEncoder().encode('x\r\n# A\r\n'));
  });

  it('merges identical edits of different fixes and applies disjoint ones', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': 'one\ntwo\n' });
    const next = applyPlan(snapshot, {
      fixes: [
        planned(fixOf([edit('AGENTS.md', 0, 0, '# A\n')], 'test/a#x'), 'test/a'),
        planned(
          fixOf(
            [edit('AGENTS.md', 0, 0, '# A\n'), edit('AGENTS.md', 12, 0, 'three\n')],
            'test/b#x',
          ),
          'test/b',
        ),
      ],
    });
    expect(textOf(next, 'AGENTS.md')).toBe('# A\none\ntwo\nthree\n');
  });

  it('refuses plans that do not fit the snapshot', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': 'abc\n', 'BAD.md': new Uint8Array([0x61, 0xff]) });
    const refuse =
      (...changes: FileChange[][]) =>
      () =>
        applyPlan(snapshot, {
          fixes: changes.map((list, index) => planned(fixOf(list, `test/r#${index}`))),
        });
    expect(refuse([edit('BAD.md', 0, 0, 'x')])).toThrow(FixApplyError);
    expect(refuse([edit('AGENTS.md', 9, 0, 'x')])).toThrow(/past the end/);
    expect(refuse([edit('AGENTS.md', 0, 2, 'x')], [edit('AGENTS.md', 1, 2, 'y')])).toThrow(
      /overlapping-edits/,
    );
    expect(refuse([edit('AGENTS.md', 0, 0, '\ud800')])).toThrow(/cannot be encoded/);
    expect(refuse([{ kind: 'create', path: 'NEW.md', text: '\ud800' }])).toThrow(
      /cannot be encoded/,
    );
    try {
      refuse([edit('MISSING.md', 0, 0, 'x')])();
    } catch (error) {
      expect(error).toBeInstanceOf(FixApplyError);
      expect((error as FixApplyError).path).toBe('MISSING.md');
    }
  });
});
