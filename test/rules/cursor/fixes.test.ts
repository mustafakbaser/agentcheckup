import { describe, expect, it } from 'vitest';
import type { FileChange } from '../../../src/core/types.js';
import {
  editAt,
  joinPatterns,
  LinkReferences,
  mergeEdits,
  pathTaken,
} from '../../../src/rules/cursor/fixes.js';
import { artifactOf } from '../../fix/helpers.js';
import { snapshotFrom } from '../../helpers/lint.js';

const PATH = '.cursor/rules/x.mdc';

describe('joinPatterns', () => {
  it('joins one-line patterns', () => {
    expect(joinPatterns(['a/**', 'b/*.ts'], ', ')).toBe('a/**, b/*.ts');
  });

  it.each([
    ['not a list', 'a/**'],
    ['an empty list', []],
    ['too many items', Array.from({ length: 201 }, (_, index) => `p${index}`)],
    ['a number', ['a', 1]],
    ['a comma', ['src/{a,b}']],
    ['surrounding spaces', [' a']],
    ['a line break', ['a\nb']],
    ['a bidirectional control', ['a‮b']],
    ['an empty item', ['']],
  ])('refuses %s', (_label, value) => {
    expect(joinPatterns(value, ',')).toBeUndefined();
  });
});

describe('mergeEdits', () => {
  const { artifact } = artifactOf(PATH, 'abcdef\n');
  const edit = (offset: number, length: number): FileChange => ({
    kind: 'edit',
    path: PATH,
    edits: [{ offset, length, text: 'x' }],
  });

  it('sorts the edits of several changes', () => {
    expect(mergeEdits(artifact, [edit(4, 1), edit(0, 1)])).toEqual({
      kind: 'edit',
      path: PATH,
      edits: [
        { offset: 0, length: 1, text: 'x' },
        { offset: 4, length: 1, text: 'x' },
      ],
    });
  });

  it.each([
    ['overlapping edits', [edit(0, 3), edit(2, 1)]],
    ['two edits at one offset', [edit(1, 0), edit(1, 2)]],
    ['a missing change', [edit(0, 1), undefined]],
    ['another file', [{ kind: 'edit', path: 'AGENTS.md', edits: [] } as const]],
    ['a rename', [{ kind: 'rename', from: PATH, to: 'y.mdc' } as const]],
  ])('refuses %s', (_label, changes: readonly (FileChange | undefined)[]) => {
    expect(mergeEdits(artifact, changes)).toBeUndefined();
  });
});

describe('editAt', () => {
  it('moves only edits', () => {
    const rename: FileChange = { kind: 'rename', from: 'a', to: 'b' };
    expect(editAt('c', rename)).toBe(rename);
    expect(editAt('c', { kind: 'edit', path: 'a', edits: [] })).toEqual({
      kind: 'edit',
      path: 'c',
      edits: [],
    });
  });
});

describe('pathTaken', () => {
  const snapshot = snapshotFrom(
    { 'docs/a.md': 'x' },
    { opaqueDirectories: ['vendor/'], ignoredFiles: ['secret.md'] },
  );

  it.each([
    ['an existing file in another case', 'DOCS/A.MD', true],
    ['an existing directory', 'docs', true],
    ['a gitignored file', 'Secret.md', true],
    ['a path below an unlisted directory', 'vendor/x.md', true],
    ['a path a fix may not name', 'docs/aux.md', true],
    ['a free path', 'docs/b.md', false],
  ])('%s', (_label, path, taken) => {
    expect(pathTaken(snapshot, path)).toBe(taken);
  });
});

describe('LinkReferences', () => {
  it('keeps only relative links that resolve to a wanted path', () => {
    const text = [
      '[a](https://example.com/x.md) [b](mailto:a@b.c) [c](#top) [d](/abs/x.md) [e](~/x.md)',
      '[f](?q=1) [g](%E0%A4%A) [h](x.md?raw=1) [i](<x.md>) [j](\\x.md) [k](AGENTS.md)',
      '[l](../x.md)',
    ].join('\n');
    const { analysis } = artifactOf('AGENTS.md', `${text}\n`, {
      '.mcp.json': '{"mcpServers": {}}',
    });
    const references = new LinkReferences(analysis, analysis.artifacts, () => true);
    expect(references.note('x.md')).toBe(
      'Update the links to "x.md" in "AGENTS.md": they still point to the old name.',
    );
    expect(references.note('AGENTS.md')).toBeUndefined();
    expect(references.note('q=1')).toBeUndefined();
  });
});
