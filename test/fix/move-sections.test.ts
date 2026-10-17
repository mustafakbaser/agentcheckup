import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Analysis } from '../../src/core/engine.js';
import type { Artifact, FileChange } from '../../src/core/types.js';
import {
  isSectionFileName,
  type MarkdownSection,
  moveSections,
  sectionLink,
  siblingPath,
} from '../../src/fix/edits.js';
import { snapshotFrom } from '../helpers/lint.js';
import { applyChanges, artifactOf, bytesOf, textOf, utf8Bom } from './helpers.js';

const SKILL = '.claude/skills/pdf/SKILL.md';
const DIR = '.claude/skills/pdf/';

/**
 * The sections at `depth` as a rule finds them in the Markdown parse: each runs to the next
 * heading of the same or a lower depth, or to the end of the text.
 */
function sectionsOf(analysis: Analysis, artifact: Artifact, depth = 2): MarkdownSection[] {
  const headings = analysis
    .markdown(artifact)
    .root.children.flatMap((node) =>
      node.type === 'heading' &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
        ? [{ depth: node.depth, start: node.position.start.offset, end: node.position.end.offset }]
        : [],
    );
  const sections: MarkdownSection[] = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.depth !== depth) continue;
    const next = headings.slice(index + 1).find((other) => other.depth <= depth);
    sections.push({
      heading: { offset: heading.start, length: heading.end - heading.start },
      end: next?.start ?? artifact.decoded.text.length,
    });
  }
  return sections;
}

interface Moved {
  readonly changes: FileChange[];
  /** The source's text and the new files' texts after applying the changes, by path. */
  readonly files: Readonly<Record<string, string>>;
}

/** Moves the sections at `depth` that `pick` selects into `names`. */
function move(
  content: string | Uint8Array,
  names: readonly string[],
  pick: (sections: MarkdownSection[]) => MarkdownSection[] = (sections) => sections,
  depth = 2,
): Moved | undefined {
  const { analysis, artifact } = artifactOf(SKILL, content);
  const changes = moveSections(artifact, pick(sectionsOf(analysis, artifact, depth)), names);
  if (changes === undefined) return undefined;
  const snapshot = applyChanges(snapshotFrom({ [SKILL]: content }), ...changes);
  const files: Record<string, string> = { [SKILL]: textOf(snapshot, SKILL) };
  for (const change of changes) {
    if (change.kind === 'create') files[change.path] = textOf(snapshot, change.path);
  }
  return { changes, files };
}

const DOC = [
  '---',
  'name: pdf',
  'description: Fills PDF forms. Use when the user asks about PDFs.',
  '---',
  '# PDF',
  '',
  'Intro.',
  '',
  '## Usage',
  '',
  'Run the script.',
  '',
  '## API reference',
  '',
  '### fill()',
  'Fills a form.',
  '',
  '## Examples',
  'One example.',
  '',
].join('\n');

describe('moveSections', () => {
  it('moves sections into new files and links them from the kept headings', () => {
    const moved = move(DOC, ['api-reference.md', 'examples.md'], (sections) => sections.slice(1));
    expect(moved?.changes.map((change) => change.kind)).toEqual(['edit', 'create', 'create']);
    expect(moved?.files).toEqual({
      [SKILL]: [
        '---',
        'name: pdf',
        'description: Fills PDF forms. Use when the user asks about PDFs.',
        '---',
        '# PDF',
        '',
        'Intro.',
        '',
        '## Usage',
        '',
        'Run the script.',
        '',
        '## API reference',
        '',
        'For this section, see [api-reference.md](api-reference.md).',
        '',
        '## Examples',
        'For this section, see [examples.md](examples.md).',
        '',
      ].join('\n'),
      [`${DIR}api-reference.md`]: '## API reference\n\n### fill()\nFills a form.\n',
      [`${DIR}examples.md`]: '## Examples\nOne example.\n',
    });
  });

  it('keeps CRLF and a byte order mark in the source; new files take CRLF without one', () => {
    const crlf = DOC.replaceAll('\n', '\r\n');
    const { analysis, artifact } = artifactOf(SKILL, utf8Bom(crlf));
    const changes = moveSections(artifact, sectionsOf(analysis, artifact).slice(2), [
      'examples.md',
    ]);
    if (changes === undefined) throw new Error('refused');
    const snapshot = applyChanges(snapshotFrom({ [SKILL]: utf8Bom(crlf) }), ...changes);
    expect(bytesOf(snapshot, SKILL)).toEqual(
      utf8Bom(crlf.replace('One example.', 'For this section, see [examples.md](examples.md).')),
    );
    expect(bytesOf(snapshot, `${DIR}examples.md`)).toEqual(
      new TextEncoder().encode('## Examples\r\nOne example.\r\n'),
    );
  });

  it('ends a new file with a line break when the source has no final one', () => {
    const moved = move('# A\n\n## B\n\nlast line', ['b.md']);
    expect(moved?.files).toEqual({
      [SKILL]: '# A\n\n## B\n\nFor this section, see [b.md](b.md).',
      [`${DIR}b.md`]: '## B\n\nlast line\n',
    });
  });

  it('keeps setext and indented headings, and moves nested sections whole', () => {
    const moved = move(
      'Intro\n\nUsage\n-----\nrun\n\n   ## Notes ##\n### Deep\nnote\n\n## End\nx\n',
      ['usage.md', 'notes.md'],
      (sections) => sections.slice(0, 2),
    );
    expect(moved?.files).toEqual({
      [SKILL]: [
        'Intro',
        '',
        'Usage',
        '-----',
        'For this section, see [usage.md](usage.md).',
        '',
        '   ## Notes ##',
        'For this section, see [notes.md](notes.md).',
        '',
        '## End',
        'x',
        '',
      ].join('\n'),
      [`${DIR}usage.md`]: 'Usage\n-----\nrun\n',
      [`${DIR}notes.md`]: '   ## Notes ##\n### Deep\nnote\n',
    });
  });

  it('keeps a mixed line ending in the moved text and ends the file like its last line', () => {
    const moved = move('# A\r\n## B\nx\r\ny\n## C\nz\n', ['b.md'], (sections) =>
      sections.slice(0, 1),
    );
    expect(moved?.files[`${DIR}b.md`]).toBe('## B\nx\r\ny\n');
    expect(moved?.files[SKILL]).toBe('# A\r\n## B\nFor this section, see [b.md](b.md).\n## C\nz\n');
  });

  it('writes files next to a source at the scan root', () => {
    const { analysis, artifact } = artifactOf('SKILL.md', '# A\n## B\nx\n');
    const changes = moveSections(artifact, sectionsOf(analysis, artifact), ['b.md']);
    expect(changes?.[1]).toEqual({ kind: 'create', path: 'b.md', text: '## B\nx\n' });
  });

  it('refuses names that could leave the directory or are not Markdown', () => {
    for (const name of [
      'a/b.md',
      'a\\b.md',
      '../x.md',
      '..md',
      'a..md',
      '.hidden.md',
      'x.txt',
      'x',
      'x.MD',
      'aux.md',
      'a b.md',
      'a(b).md',
      'ä.md',
      '',
      `${'a'.repeat(126)}.md`,
    ]) {
      expect(isSectionFileName(name), name).toBe(false);
      expect(
        move(DOC, [name], (sections) => sections.slice(0, 1)),
        name,
      ).toBeUndefined();
    }
    for (const name of ['usage.md', 'section-1.md', 'api_v2.md', 'v1.2.md', 'Usage.md']) {
      expect(isSectionFileName(name), name).toBe(true);
    }
  });

  it('refuses repeated names, in any case, and the source file name', () => {
    expect(move(DOC, ['a.md', 'A.md', 'b.md'])).toBeUndefined();
    expect(move(DOC, ['skill.md'], (sections) => sections.slice(0, 1))).toBeUndefined();
  });

  it('refuses sections that overlap, come out of order or start in the frontmatter', () => {
    const usage = DOC.indexOf('## Usage');
    const api = DOC.indexOf('## API');
    const usageSection = { heading: { offset: usage, length: 8 }, end: api };
    const apiSection = { heading: { offset: api, length: 16 }, end: DOC.length };
    const { artifact } = artifactOf(SKILL, DOC);
    expect(moveSections(artifact, [usageSection, apiSection], ['a.md', 'b.md'])).toHaveLength(3);
    expect(moveSections(artifact, [apiSection, usageSection], ['a.md', 'b.md'])).toBeUndefined();
    expect(
      moveSections(artifact, [{ ...usageSection, end: DOC.length }, apiSection], ['a.md', 'b.md']),
    ).toBeUndefined();
    // A "heading" on a frontmatter line, with the description line as its body.
    const inFrontmatter = { heading: { offset: 4, length: 9 }, end: DOC.indexOf('\n---') + 1 };
    expect(moveSections(artifact, [inFrontmatter], ['a.md'])).toBeUndefined();
  });

  it('refuses headings that do not start their line, and sections with an empty body', () => {
    const quoted = artifactOf(SKILL, '> ## Quoted\n> text\n\nafter\n').artifact;
    expect(
      moveSections(quoted, [{ heading: { offset: 2, length: 9 }, end: 26 }], ['q.md']),
    ).toBeUndefined();
    const { artifact } = artifactOf(SKILL, '## A\n\n\n## B\nx\n');
    expect(
      moveSections(artifact, [{ heading: { offset: 0, length: 4 }, end: 7 }], ['a.md']),
    ).toBeUndefined();
    // Text after the heading on its line, or an end inside a line.
    expect(
      moveSections(artifact, [{ heading: { offset: 0, length: 2 }, end: 7 }], ['a.md']),
    ).toBeUndefined();
    expect(
      moveSections(artifact, [{ heading: { offset: 7, length: 4 }, end: 13 }], ['a.md']),
    ).toBeUndefined();
    // A heading span with its line ending.
    expect(
      moveSections(artifact, [{ heading: { offset: 7, length: 5 }, end: 14 }], ['a.md']),
    ).toBeUndefined();
    expect(
      moveSections(artifact, [{ heading: { offset: 7, length: 4 }, end: 14 }], ['a.md']),
    ).toHaveLength(2);
  });

  it('refuses a source whose frontmatter block is unclosed', () => {
    expect(move('---\nname: x\n## A\nbody\n', ['a.md'])).toBeUndefined();
    expect(move('---\nname: x\n---\n## A\nbody\n', ['a.md'])).toBeDefined();
  });

  it('changes nothing without sections, and throws for arguments outside the text', () => {
    const { artifact } = artifactOf(SKILL, DOC);
    expect(moveSections(artifact, [], [])).toBeUndefined();
    const section = { heading: { offset: 0, length: 3 }, end: 10 };
    expect(() => moveSections(artifact, [section], [])).toThrow(RangeError);
    expect(() => moveSections(artifact, [{ ...section, end: DOC.length + 1 }], ['a.md'])).toThrow(
      RangeError,
    );
    expect(() =>
      moveSections(artifact, [{ heading: { offset: DOC.length, length: 1 }, end: 0 }], ['a.md']),
    ).toThrow(RangeError);
  });

  it('names the link and the files', () => {
    expect(sectionLink('api.md')).toBe('For this section, see [api.md](api.md).');
    expect(siblingPath(SKILL, 'api.md')).toBe(`${DIR}api.md`);
    expect(siblingPath('SKILL.md', 'api.md')).toBe('api.md');
  });

  const LINES = ['alpha beta', '- item', '1. step', '> quote', '`code` here', 'text # hash', '  '];

  const documents = fc.record({
    eol: fc.constantFrom('\n', '\r\n'),
    frontmatter: fc.boolean(),
    preamble: fc.array(fc.constantFrom(...LINES), { maxLength: 3 }),
    sections: fc.array(
      fc.record({
        title: fc.constantFrom('Usage', 'API', 'Notes ##', 'Edge cases'),
        before: fc.array(fc.constant(''), { maxLength: 2 }),
        body: fc.array(fc.constantFrom(...LINES, '', '### Sub'), { maxLength: 6 }),
        last: fc.constantFrom('alpha beta', '- item', 'end.'),
        after: fc.array(fc.constant(''), { maxLength: 2 }),
      }),
      { minLength: 1, maxLength: 6 },
    ),
    finalNewline: fc.boolean(),
  });

  it('moves every byte of a section to its file and keeps every other byte', () => {
    fc.assert(
      fc.property(documents, fc.infiniteStream(fc.boolean()), (doc, choices) => {
        const lines = [
          ...(doc.frontmatter ? ['---', 'name: x', '---'] : []),
          '# Title',
          ...doc.preamble,
          ...doc.sections.flatMap((section) => [
            `## ${section.title}`,
            ...section.before,
            ...section.body,
            section.last,
            ...section.after,
          ]),
        ];
        const text = lines.join(doc.eol) + (doc.finalNewline ? doc.eol : '');
        const { analysis, artifact } = artifactOf(SKILL, text);
        const all = sectionsOf(analysis, artifact);
        const picked = all.filter(() => choices.next().value);
        const names = picked.map((_, index) => `s${index}.md`);
        const changes = moveSections(artifact, picked, names);
        if (picked.length === 0) {
          expect(changes).toBeUndefined();
          return;
        }
        if (changes === undefined) throw new Error('refused');
        const snapshot = applyChanges(snapshotFrom({ [SKILL]: text }), ...changes);
        let rebuilt = textOf(snapshot, SKILL);
        // Put each section's body back in place of its link: the original comes back.
        for (const name of names.toReversed()) {
          const file = textOf(snapshot, `${DIR}${name}`);
          expect(file.endsWith(doc.eol)).toBe(true);
          let contentStart = file.indexOf('\n') + 1;
          for (;;) {
            const lineEnd = file.indexOf('\n', contentStart) + 1;
            if (lineEnd === 0 || file.slice(contentStart, lineEnd).trim() !== '') break;
            contentStart = lineEnd;
          }
          const link = sectionLink(name);
          const at = rebuilt.indexOf(link);
          expect(rebuilt.slice(at - contentStart, at)).toBe(file.slice(0, contentStart));
          const content = file.slice(contentStart, file.length - doc.eol.length);
          rebuilt = rebuilt.slice(0, at) + content + rebuilt.slice(at + link.length);
        }
        expect(rebuilt).toBe(text);
      }),
    );
  });
});
