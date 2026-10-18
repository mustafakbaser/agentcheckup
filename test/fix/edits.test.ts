import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decode } from '../../src/core/text.js';
import type { Span } from '../../src/core/types.js';
import {
  createFile,
  insertLine,
  jsonInsertProperty,
  jsonRemoveProperty,
  jsonRenameKey,
  jsonReplaceValue,
  moveFrontmatterToTop,
  prependFrontmatter,
  quoteJson,
  quoteYaml,
  reencode,
  renameFile,
  replaceSpan,
  safeCopiedText,
  skillSlug,
  yamlInsertKey,
  yamlRenameKey,
  yamlReplaceScalar,
  yamlReplaceValue,
  yamlSetScalar,
} from '../../src/fix/edits.js';
import { snapshotFrom } from '../helpers/lint.js';
import { applyChanges, artifactOf, bytesOf, edited, utf16, utf8Bom } from './helpers.js';

const SKILL = '.claude/skills/demo/SKILL.md';

/** The artifact's text after a builder change, given a file and the builder. */
function after(
  path: string,
  content: string | Uint8Array,
  build: (artifact: ReturnType<typeof artifactOf>) => Parameters<typeof edited>[1],
): string {
  const parts = artifactOf(path, content);
  return edited(parts.artifact, build(parts));
}

/** The bytes of the artifact's file after a builder change. */
function bytesAfter(
  path: string,
  content: string | Uint8Array,
  build: (artifact: ReturnType<typeof artifactOf>) => Parameters<typeof edited>[1],
): Uint8Array {
  const parts = artifactOf(path, content);
  return bytesOf(applyChanges(snapshotFrom({ [path]: content }), build(parts)), path);
}

describe('insertLine', () => {
  const importLine = (content: string | Uint8Array, index = 0) =>
    after('CLAUDE.md', content, ({ artifact }) =>
      insertLine(artifact, index, '@AGENTS.md', { blankAfter: true }),
    );

  it('keeps LF and CRLF endings', () => {
    expect(importLine('# Acme\nbody\n')).toBe('@AGENTS.md\n\n# Acme\nbody\n');
    expect(importLine('# Acme\r\nbody\r\n')).toBe('@AGENTS.md\r\n\r\n# Acme\r\nbody\r\n');
  });

  it("takes the neighbor's ending in a file with mixed endings", () => {
    const mixed = '# A\nbody\r\nend';
    const at = (index: number) =>
      after('CLAUDE.md', mixed, ({ artifact }) => insertLine(artifact, index, 'new'));
    expect(at(0)).toBe('new\n# A\nbody\r\nend');
    expect(at(1)).toBe('# A\nnew\r\nbody\r\nend');
    // The last line has no ending: the line above decides.
    expect(at(2)).toBe('# A\nbody\r\nnew\r\nend');
    // Appending keeps the missing final newline.
    expect(at(3)).toBe('# A\nbody\r\nend\r\nnew');
  });

  it('keeps a UTF-8 byte order mark and UTF-16', () => {
    expect(
      bytesAfter('CLAUDE.md', utf8Bom('# A\n'), ({ artifact }) =>
        insertLine(artifact, 0, '@AGENTS.md', { blankAfter: true }),
      ),
    ).toEqual(utf8Bom('@AGENTS.md\n\n# A\n'));
    for (const encoding of ['utf-16le', 'utf-16be'] as const) {
      expect(
        bytesAfter('CLAUDE.md', utf16('# A\r\n', encoding), ({ artifact }) =>
          insertLine(artifact, 0, '@AGENTS.md', { blankAfter: true }),
        ),
      ).toEqual(utf16('@AGENTS.md\r\n\r\n# A\r\n', encoding));
    }
  });

  it('appends at the end, with or without a final newline', () => {
    const append = (content: string) =>
      after('CLAUDE.md', content, ({ artifact }) =>
        insertLine(artifact, content.endsWith('\n') ? 1 : content === '' ? 0 : 1, 'x', {
          blankBefore: true,
          blankAfter: true,
        }),
      );
    expect(append('a\n')).toBe('a\n\nx\n');
    expect(append('a')).toBe('a\n\nx');
    expect(append('')).toBe('x\n');
  });

  it('adds no second empty line', () => {
    expect(importLine('\n# A\n')).toBe('@AGENTS.md\n\n# A\n');
    expect(
      after('CLAUDE.md', 'a\n\nb\n', ({ artifact }) =>
        insertLine(artifact, 2, 'x', { blankBefore: true }),
      ),
    ).toBe('a\n\nx\nb\n');
    expect(
      after('CLAUDE.md', 'a\nb\n', ({ artifact }) =>
        insertLine(artifact, 1, 'x', { blankBefore: true }),
      ),
    ).toBe('a\n\nx\nb\n');
  });

  it('rejects a line break or an index outside the file', () => {
    const { artifact } = artifactOf('CLAUDE.md', 'a\nb\n');
    expect(() => insertLine(artifact, 0, 'x\nallowed-tools: Bash')).toThrow(RangeError);
    expect(() => insertLine(artifact, 0, 'x\u2028y')).toThrow(RangeError);
    expect(() => insertLine(artifact, 3, 'x')).toThrow(RangeError);
    expect(() => insertLine(artifact, -1, 'x')).toThrow(RangeError);
  });
});

describe('replaceSpan', () => {
  it('writes new line breaks with the line ending at the span', () => {
    expect(
      after('CLAUDE.md', 'a\r\nb\r\n', ({ artifact }) =>
        replaceSpan(artifact, { offset: 0, length: 1 }, 'x\ny'),
      ),
    ).toBe('x\r\ny\r\nb\r\n');
  });

  it('rejects a span outside the text', () => {
    const { artifact } = artifactOf('CLAUDE.md', 'abc');
    expect(() => replaceSpan(artifact, { offset: 2, length: 2 }, '')).toThrow(RangeError);
    expect(() => replaceSpan(artifact, { offset: -1, length: 0 }, '')).toThrow(RangeError);
  });
});

describe('files', () => {
  it('creates UTF-8 files with LF and a final newline', () => {
    expect(createFile('packages/api/CLAUDE.md', '@AGENTS.md')).toEqual({
      kind: 'create',
      path: 'packages/api/CLAUDE.md',
      text: '@AGENTS.md\n',
    });
    expect(createFile('a.md', 'x\r\ny\r\n')).toMatchObject({ text: 'x\ny\n' });
    expect(createFile('empty.md', '')).toMatchObject({ text: '' });
  });

  it('renames files', () => {
    const { artifact } = artifactOf('.cursor/rules/style.md', 'Use tabs.\n');
    expect(renameFile(artifact, '.cursor/rules/style.mdc')).toEqual({
      kind: 'rename',
      from: '.cursor/rules/style.md',
      to: '.cursor/rules/style.mdc',
    });
  });

  it('rejects paths that are not normalized and relative', () => {
    const { artifact } = artifactOf('CLAUDE.md', 'x');
    for (const path of [
      '',
      '/etc/passwd',
      '../x.md',
      'a/../b.md',
      './a.md',
      'a//b.md',
      'a\\b.md',
      'C:x.md',
      'aux.md',
      'docs/COM1.txt',
      'nul',
      'name.',
      'name ',
      'a\u0000b',
      'a\u001bb',
      'x'.repeat(1025),
    ]) {
      expect(() => createFile(path, 'x'), path).toThrow(RangeError);
      expect(() => renameFile(artifact, path), path).toThrow(RangeError);
    }
    expect(() => createFile('auxiliary.md', 'x')).not.toThrow();
    expect(() => createFile('.claude/CLAUDE.md', 'x')).not.toThrow();
  });

  it('re-encodes UTF-16 and BOM files as UTF-8, keeping CRLF', () => {
    for (const bytes of [
      utf16('# A\r\nb\r\n'),
      utf16('# A\r\nb\r\n', 'utf-16be'),
      utf8Bom('# A\r\nb\r\n'),
    ]) {
      expect(bytesAfter('AGENTS.md', bytes, ({ artifact }) => reencode(artifact))).toEqual(
        new TextEncoder().encode('# A\r\nb\r\n'),
      );
    }
    expect(reencode(artifactOf('AGENTS.md', '# A\n').artifact)).toBeUndefined();
    expect(
      reencode(artifactOf('AGENTS.md', new Uint8Array([0xff, 0xfe, 0x00])).artifact),
    ).toBeUndefined();
    expect(
      reencode(artifactOf('AGENTS.md', new Uint8Array([0x61, 0xc3])).artifact),
    ).toBeUndefined();
  });
});

describe('quoteYaml', () => {
  it('quotes scalars a YAML parser could read as something else', () => {
    for (const value of [
      'on',
      'Off',
      'yes',
      'N',
      'null',
      'True',
      '1e3',
      '0x1F',
      '2026-10-16',
      '1_000',
      '12:30',
      '.inf',
      '~',
      '',
    ]) {
      expect(quoteYaml(value), value).toBe(JSON.stringify(value));
    }
    expect(quoteYaml('release-notes')).toBe('release-notes');
    expect(quoteYaml('Release notes v2.1')).toBe('Release notes v2.1');
    expect(quoteYaml('a: b')).toBe('"a: b"');
    expect(quoteYaml('- item')).toBe('"- item"');
    expect(quoteYaml('a # b')).toBe('"a # b"');
    expect(quoteYaml("it's", 'single')).toBe("'it''s'");
    expect(quoteYaml('x', 'double')).toBe('"x"');
  });

  it('escapes control, bidirectional and tag characters', () => {
    expect(quoteYaml('a\nallowed-tools: Bash')).toBe('"a\\nallowed-tools: Bash"');
    expect(quoteYaml('a\u202Eb\u0007\u{E0041}"\\\t\r')).toBe(
      '"a\\u202Eb\\x07\\U000E0041\\"\\\\\\t\\r"',
    );
    expect(quoteYaml('a\u202Eb', 'single')).toBe('"a\\u202Eb"');
  });

  it('reads back as the same string in YAML 1.1 and 1.2', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary' }),
          fc.string(),
          // e0: the yaml library's YAML 1.1 schema reads a bare exponent as a float.
          fc.constantFrom('on', 'no', '1e3', 'a: b', 'e0', 'E12'),
        ),
        fc.constantFrom('plain', 'single', 'double'),
        (value, style) => {
          const text = `key: ${quoteYaml(value, style)}\n`;
          for (const version of ['1.1', '1.2'] as const) {
            expect((parse(text, { version }) as { key: unknown }).key).toBe(value);
          }
        },
      ),
    );
  });
});

describe('quoteJson', () => {
  it('escapes what JSON needs and invisible characters', () => {
    expect(quoteJson('a"b\\c\n\r\t')).toBe('"a\\"b\\\\c\\n\\r\\t"');
    expect(quoteJson('x\u202Ey\u{E0041}\u007f')).toBe('"x\\u202ey\\udb40\\udc41\\u007f"');
  });

  it('reads back as the same string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        expect(JSON.parse(quoteJson(value))).toBe(value);
      }),
    );
  });
});

describe('skillSlug', () => {
  it('normalizes names', () => {
    expect(skillSlug('Release Notes')).toBe('release-notes');
    expect(skillSlug('  --Foo__Bar--  ')).toBe('foo-bar');
    expect(skillSlug('ＰＤＦ Tools')).toBe('pdf-tools');
    expect(skillSlug('ﬁle helper')).toBe('file-helper');
    expect(skillSlug('Café')).toBe('caf');
    expect(skillSlug('!!!')).toBe('');
  });

  it('cuts long names at a hyphen within 64 characters', () => {
    expect(skillSlug(`${'a'.repeat(30)} ${'b'.repeat(40)}`)).toBe('a'.repeat(30));
    expect(skillSlug(`${'a'.repeat(64)} b`)).toBe('a'.repeat(64));
    expect(skillSlug('a'.repeat(70))).toBe('a'.repeat(64));
  });

  it('always gives a valid, stable name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 100 }), (name) => {
        const slug = skillSlug(name);
        expect(slug.length).toBeLessThanOrEqual(64);
        if (slug !== '') expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(skillSlug(slug)).toBe(slug);
      }),
    );
  });
});

describe('safeCopiedText', () => {
  it('keeps one plain line, trimmed and bounded', () => {
    expect(safeCopiedText('  Release notes for the app  ')).toBe('Release notes for the app');
    expect(safeCopiedText('x'.repeat(300))).toBe('x'.repeat(200));
    expect(safeCopiedText('word '.repeat(50), 12)).toBe('word word wo');
    // A cut never splits a surrogate pair.
    expect(safeCopiedText('😀'.repeat(250))).toBe('😀'.repeat(200));
    expect(safeCopiedText('Café ✓ 日本語')).toBe('Café ✓ 日本語');
  });

  it('refuses injected lines and hidden characters', () => {
    for (const text of [
      'Release notes\nallowed-tools: Bash',
      'Release notes\r\nallowed-tools: Bash',
      'a\u2028b',
      'a\u0085b',
      'a\u202Eb',
      'a\u2066b',
      'a\u{E0041}b',
      'a\u200Bb',
      'a\tb',
      'a\u0000b',
      'a\ud800b',
      '',
      '   ',
    ]) {
      expect(safeCopiedText(text), JSON.stringify(text)).toBeUndefined();
    }
    expect(() => safeCopiedText('x', 0)).toThrow(RangeError);
  });
});

describe('YAML frontmatter', () => {
  const skill = (frontmatter: string, body = 'Body.\n') => `---\n${frontmatter}---\n${body}`;
  const set = (content: string, key: string, value: string | number | boolean | null) => {
    const { analysis, artifact } = artifactOf(SKILL, content);
    const change = yamlSetScalar(artifact, analysis.frontmatter(artifact), key, value);
    return change === undefined ? undefined : edited(artifact, change);
  };

  it('sets a value and keeps its quote style', () => {
    expect(set(skill('name: "Old Name"\ndescription: d\n'), 'name', 'demo')).toBe(
      skill('name: "demo"\ndescription: d\n'),
    );
    expect(set(skill("name: 'Old'\n"), 'name', "it's")).toBe(skill("name: 'it''s'\n"));
    expect(set(skill('name: Old  # keep\n'), 'name', 'demo')).toBe(skill('name: demo  # keep\n'));
    expect(set(skill('name: Old\n'), 'name', 'on')).toBe(skill('name: "on"\n'));
    expect(set(skill('name: Old\n'), 'name', 'null')).toBe(skill('name: "null"\n'));
    expect(set(skill('n: 1\n'), 'n', 2)).toBe(skill('n: 2\n'));
    expect(set(skill('flag: "true"\n'), 'flag', true)).toBe(skill('flag: true\n'));
  });

  it('fills an empty value after the colon', () => {
    expect(set(skill('name:\ndescription: d\n'), 'name', 'demo')).toBe(
      skill('name: demo\ndescription: d\n'),
    );
    expect(set(skill('name: # todo\n'), 'name', 'demo')).toBe(skill('name: demo # todo\n'));
    expect(set(skill('name: ~\n'), 'name', 'demo')).toBe(skill('name: demo\n'));
  });

  it('refuses values that are not one-line scalars', () => {
    expect(set(skill('name: |\n  x\n'), 'name', 'demo')).toBeUndefined();
    expect(set(skill('name: [a, b]\n'), 'name', 'demo')).toBeUndefined();
    expect(set(skill('a: &x 1\nname: *x\n'), 'name', 'demo')).toBeUndefined();
    expect(set(skill('other: 1\n'), 'name', 'demo')).toBeUndefined();
    expect(set(skill('name: [unclosed\n'), 'name', 'demo')).toBeUndefined();
    expect(set('No frontmatter.\n', 'name', 'demo')).toBeUndefined();
    const { analysis, artifact } = artifactOf(SKILL, skill('name: x\n'));
    expect(() => yamlSetScalar(artifact, analysis.frontmatter(artifact), 'a b', 'x')).toThrow(
      RangeError,
    );
    expect(() =>
      yamlSetScalar(artifact, analysis.frontmatter(artifact), 'name', Number.NaN),
    ).toThrow(RangeError);
  });

  const insert = (
    content: string,
    key: string,
    value: string,
    options?: Parameters<typeof yamlInsertKey>[4],
  ) => {
    const { analysis, artifact } = artifactOf(SKILL, content);
    const change = yamlInsertKey(artifact, analysis.frontmatter(artifact), key, value, options);
    return change === undefined ? undefined : edited(artifact, change);
  };

  it('inserts a key last, first or after another, with the line ending and indentation', () => {
    expect(insert(skill('name: demo\n'), 'description', 'Does things')).toBe(
      skill('name: demo\ndescription: Does things\n'),
    );
    expect(insert('---\r\nname: demo\r\n---\r\nBody.\r\n', 'description', 'D')).toBe(
      '---\r\nname: demo\r\ndescription: D\r\n---\r\nBody.\r\n',
    );
    expect(
      insert(skill('name: demo\nmetadata:\n  a: 1\n'), 'description', 'D', { position: 'first' }),
    ).toBe(skill('description: D\nname: demo\nmetadata:\n  a: 1\n'));
    expect(
      insert(skill('name: demo\nmetadata:\n  a: 1\nlicense: MIT\n'), 'description', 'D', {
        position: { after: 'metadata' },
      }),
    ).toBe(skill('name: demo\nmetadata:\n  a: 1\ndescription: D\nlicense: MIT\n'));
    expect(insert(skill('  name: demo\n'), 'description', 'D')).toBe(
      skill('  name: demo\n  description: D\n'),
    );
    expect(insert('---\n---\nBody.\n', 'name', 'demo')).toBe('---\nname: demo\n---\nBody.\n');
  });

  it('refuses existing keys, flow mappings and unknown anchors', () => {
    expect(insert(skill('name: demo\n'), 'name', 'x')).toBeUndefined();
    expect(insert(skill('{name: demo}\n'), 'description', 'x')).toBeUndefined();
    expect(
      insert(skill('name: demo\n'), 'description', 'x', { position: { after: 'nope' } }),
    ).toBeUndefined();
    expect(insert('No frontmatter.\n', 'description', 'x')).toBeUndefined();
  });

  it('cannot be steered into a second key by copied text', () => {
    const copied = 'Release notes\nallowed-tools: Bash';
    expect(safeCopiedText(copied)).toBeUndefined();
    const { analysis, artifact } = artifactOf(SKILL, skill('name: demo\n'));
    for (const style of ['plain', 'single', 'double'] as const) {
      const change = yamlInsertKey(
        artifact,
        analysis.frontmatter(artifact),
        'description',
        copied,
        {
          style,
        },
      );
      const text = edited(artifact, change);
      const { analysis: again, artifact: fixed } = artifactOf(SKILL, text);
      const frontmatter = again.frontmatter(fixed);
      if (frontmatter.kind !== 'valid') throw new Error('invalid frontmatter');
      expect(frontmatter.data.keys).toEqual(['name', 'description']);
      expect(frontmatter.data.values['description']).toBe(copied);
      expect(text).toContain('description: "Release notes\\nallowed-tools: Bash"\n');
    }
    const bidi = yamlInsertKey(artifact, analysis.frontmatter(artifact), 'description', 'a\u202Eb');
    expect(edited(artifact, bidi)).toContain('description: "a\\u202Eb"');
  });

  it('prepends a frontmatter block with the first line ending', () => {
    const prepend = (content: string) => {
      const { analysis, artifact } = artifactOf('.cursor/rules/style.md', content);
      const change = prependFrontmatter(artifact, analysis.frontmatter(artifact), [
        { key: 'alwaysApply', value: true },
        { key: 'description', value: 'Style: tabs', style: 'double' },
      ]);
      return change === undefined ? undefined : edited(artifact, change);
    };
    expect(prepend('Use tabs.\n')).toBe(
      '---\nalwaysApply: true\ndescription: "Style: tabs"\n---\nUse tabs.\n',
    );
    expect(prepend('Use tabs.\r\nMore.\r\n')).toBe(
      '---\r\nalwaysApply: true\r\ndescription: "Style: tabs"\r\n---\r\nUse tabs.\r\nMore.\r\n',
    );
    expect(prepend('Use tabs.')).toBe(
      '---\nalwaysApply: true\ndescription: "Style: tabs"\n---\nUse tabs.',
    );
    expect(prepend('---\nglobs: x\n---\nUse tabs.\n')).toBeUndefined();
    expect(prepend('---\nunclosed\n')).toBeUndefined();
    const { analysis, artifact } = artifactOf('.cursor/rules/style.md', 'x\n');
    const frontmatter = analysis.frontmatter(artifact);
    expect(prependFrontmatter(artifact, frontmatter, [])).toBeUndefined();
    expect(
      prependFrontmatter(artifact, frontmatter, [
        { key: 'a', value: 1 },
        { key: 'a', value: 2 },
      ]),
    ).toBeUndefined();
  });
});

describe('YAML frontmatter: whole entries', () => {
  const RULE = '.cursor/rules/x.mdc';
  const replace = (
    content: string | Uint8Array,
    key: string,
    value: string | number | boolean | null,
    options?: Parameters<typeof yamlReplaceValue>[4],
  ) => {
    const { analysis, artifact } = artifactOf(RULE, content);
    const change = yamlReplaceValue(artifact, analysis.frontmatter(artifact), key, value, options);
    return change === undefined ? undefined : edited(artifact, change);
  };
  const rename = (content: string, key: string, newKey: string) => {
    const { analysis, artifact } = artifactOf(RULE, content);
    const change = yamlRenameKey(artifact, analysis.frontmatter(artifact), key, newKey);
    return change === undefined ? undefined : edited(artifact, change);
  };
  const double = { style: 'double' } as const;

  it('replaces a block list with one scalar on the key line', () => {
    expect(
      replace(
        '---\nglobs:\n  - a/**\n  - b/*.ts\nx: 1\n---\nBody.\n',
        'globs',
        'a/**, b/*.ts',
        double,
      ),
    ).toBe('---\nglobs: "a/**, b/*.ts"\nx: 1\n---\nBody.\n');
    expect(
      replace('---\nallowed-tools:\n- Read\n- Bash\n---\n', 'allowed-tools', 'Read Bash'),
    ).toBe('---\nallowed-tools: Read Bash\n---\n');
  });

  it('replaces a flow list, also inside a flow mapping', () => {
    expect(replace('---\nglobs: [a, b]\n---\n', 'globs', 'a, b')).toBe('---\nglobs: "a, b"\n---\n');
    expect(
      replace('---\n{paths: [a, b], x: 1}\n---\n', 'paths', 'a, b', {
        ...double,
        renameTo: 'globs',
      }),
    ).toBe('---\n{globs: "a, b", x: 1}\n---\n');
  });

  it('replaces a nested mapping and keeps the entries around it', () => {
    expect(
      replace(
        '---\nname: n\nmetadata:\n  a: 1\n  b:\n    - c\nlicense: MIT\n---\n',
        'metadata',
        'none',
      ),
    ).toBe('---\nname: n\nmetadata: none\nlicense: MIT\n---\n');
  });

  it('quotes what a parser would read as something else, and escapes', () => {
    expect(replace('---\nv: [a]\n---\n', 'v', 'yes')).toBe('---\nv: "yes"\n---\n');
    expect(replace('---\nv: [a]\n---\n', 'v', '1.0')).toBe('---\nv: "1.0"\n---\n');
    expect(replace("---\nglobs: ['a\"b\\\\c']\n---\n", 'globs', 'a"b\\c', double)).toBe(
      '---\nglobs: "a\\"b\\\\c"\n---\n',
    );
    expect(replace('---\nv: [a]\n---\n', 'v', 'a\u202Eb')).toBe('---\nv: "a\\u202Eb"\n---\n');
    expect(replace('---\nv: [a]\n---\n', 'v', 2)).toBe('---\nv: 2\n---\n');
  });

  it('keeps a comment after the value and refuses one inside it', () => {
    expect(replace('---\nglobs: [a, b] # all\n---\n', 'globs', 'a, b', double)).toBe(
      '---\nglobs: "a, b" # all\n---\n',
    );
    expect(replace('---\nglobs:\n  - a # first\n  - b\n---\n', 'globs', 'a, b')).toBeUndefined();
    expect(replace('---\nglobs: [a, # x\n  b]\n---\n', 'globs', 'a, b')).toBeUndefined();
    expect(replace('---\nglobs: # list\n  - a\n---\n', 'globs', 'a')).toBeUndefined();
  });

  it('refuses anchors, aliases and tags anywhere in the frontmatter', () => {
    expect(replace('---\nglobs: &g [a, b]\nx: *g\n---\n', 'globs', 'a, b')).toBeUndefined();
    expect(replace('---\nbase: &b a\nglobs: [*b, c]\n---\n', 'globs', 'a, c')).toBeUndefined();
    expect(replace('---\nx: &x 1\nglobs: [a]\n---\n', 'globs', 'a')).toBeUndefined();
    expect(replace('---\nglobs: !!seq [a]\n---\n', 'globs', 'a')).toBeUndefined();
    expect(rename('---\npaths: &p a\n---\n', 'paths', 'globs')).toBeUndefined();
  });

  it('refuses a value it cannot replace in place', () => {
    expect(replace('---\nglobs:\n---\n', 'globs', 'a')).toBeUndefined();
    expect(replace('---\nx: 1\n---\n', 'globs', 'a')).toBeUndefined();
    expect(replace('---\n? globs\n: [a]\n---\n', 'globs', 'a')).toBeUndefined();
    expect(replace('---\nglobs: [a\n---\n', 'globs', 'a')).toBeUndefined();
    expect(replace('No frontmatter.\n', 'globs', 'a')).toBeUndefined();
    expect(
      replace('---\npaths: [a]\nglobs: b\n---\n', 'paths', 'a', { renameTo: 'globs' }),
    ).toBeUndefined();
  });

  it('renames a key in place and keeps its value', () => {
    expect(rename('---\ndescription: d\npaths: src/**\nx: 1\n---\n', 'paths', 'globs')).toBe(
      '---\ndescription: d\nglobs: src/**\nx: 1\n---\n',
    );
    expect(rename('---\napplyTo:\n  - a\n---\n', 'applyTo', 'globs')).toBe(
      '---\nglobs:\n  - a\n---\n',
    );
    expect(rename('---\npaths: a\nglobs: b\n---\n', 'paths', 'globs')).toBeUndefined();
    expect(rename('---\npaths: a\n---\n', 'paths', 'paths')).toBeUndefined();
    expect(rename('---\nx: 1\n---\n', 'paths', 'globs')).toBeUndefined();
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    expect(
      replace(
        '---\r\nglobs:\r\n  - a\r\n  - b\r\nx: 1\r\n---\r\nBody.\r\n',
        'globs',
        'a, b',
        double,
      ),
    ).toBe('---\r\nglobs: "a, b"\r\nx: 1\r\n---\r\nBody.\r\n');
    expect(
      bytesAfter(RULE, utf8Bom('---\r\nglobs: [a, b]\r\n---\r\n'), ({ analysis, artifact }) =>
        yamlReplaceValue(artifact, analysis.frontmatter(artifact), 'globs', 'a, b', double),
      ),
    ).toEqual(utf8Bom('---\r\nglobs: "a, b"\r\n---\r\n'));
  });

  it('rejects keys that are not plain', () => {
    const { analysis, artifact } = artifactOf(RULE, '---\nglobs: [a]\n---\n');
    const frontmatter = analysis.frontmatter(artifact);
    expect(() => yamlReplaceValue(artifact, frontmatter, 'a b', 'x')).toThrow(RangeError);
    expect(() => yamlRenameKey(artifact, frontmatter, 'globs', 'a: b')).toThrow(RangeError);
  });
});

describe('YAML frontmatter: scalars inside values', () => {
  const at = (text: string, scalar: string): Span => {
    const offset = text.indexOf(scalar);
    if (offset === -1) throw new Error(`${scalar} is not in the text`);
    return { offset, length: scalar.length };
  };
  const scalar = (
    content: string,
    span: Span,
    value: string | number | boolean | null,
    options?: Parameters<typeof yamlReplaceScalar>[4],
  ) => {
    const { analysis, artifact } = artifactOf(SKILL, content);
    const change = yamlReplaceScalar(
      artifact,
      analysis.frontmatter(artifact),
      span,
      value,
      options,
    );
    return change === undefined ? undefined : edited(artifact, change);
  };
  const quote = (content: string, source: string) =>
    scalar(content, at(content, source), source, { style: 'double' });

  it('quotes a top-level value, a list item and a nested value', () => {
    expect(quote('---\nbeta: yes\n---\n', 'yes')).toBe('---\nbeta: "yes"\n---\n');
    expect(quote('---\nv: [1.0, on]\n---\n', 'on')).toBe('---\nv: [1.0, "on"]\n---\n');
    expect(quote('---\ntools:\n  - Read\n  - 1.0\n---\n', '1.0')).toBe(
      '---\ntools:\n  - Read\n  - "1.0"\n---\n',
    );
    expect(quote('---\nname: n\nmetadata:\n  version: 1.0\n  beta: yes\n---\n', '1.0')).toBe(
      '---\nname: n\nmetadata:\n  version: "1.0"\n  beta: yes\n---\n',
    );
  });

  it('writes a top-level value as another scalar only when it parses to that value', () => {
    expect(scalar('---\nbeta: yes # x\n---\n', { offset: 10, length: 3 }, true)).toBe(
      '---\nbeta: true # x\n---\n',
    );
    // A key is not a value: writing `true` there would rename it.
    expect(scalar('---\nyes: 1\n---\n', { offset: 4, length: 3 }, true)).toBeUndefined();
  });

  it('refuses quoted scalars, anchors, aliases, tags and spans outside an entry', () => {
    expect(quote("---\nv: 'yes'\n---\n", "'yes'")).toBeUndefined();
    expect(quote('---\nv: "1.0"\n---\n', '"1.0"')).toBeUndefined();
    expect(quote('---\na: &x 1\nb: 2\n---\n', '&x')).toBeUndefined();
    expect(quote('---\na: &x 1\nb: *x\n---\n', '*x')).toBeUndefined();
    expect(quote('---\na: !!str 1\n---\n', '!!str')).toBeUndefined();
    expect(quote('---\na: x y\n---\n', ' y')).toBeUndefined();
    expect(scalar('---\na: 1\n---\n', { offset: 0, length: 3 }, 'x')).toBeUndefined();
    expect(scalar('---\na: 1\n---\n', { offset: 7, length: 0 }, 'x')).toBeUndefined();
    expect(scalar('No frontmatter.\n', { offset: 0, length: 2 }, 'x')).toBeUndefined();
  });

  it('refuses an edit that changes another value', () => {
    // Quoting the anchored scalar would leave the alias without its anchor.
    expect(quote('---\na: &x 1.0\nb: *x\n---\n', '1.0')).toBeUndefined();
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    const text = '---\r\nmetadata:\r\n  beta: on\r\n---\r\nBody.\r\n';
    expect(quote(text, 'on')).toBe('---\r\nmetadata:\r\n  beta: "on"\r\n---\r\nBody.\r\n');
    expect(
      bytesAfter(SKILL, utf8Bom(text), ({ analysis, artifact }) =>
        yamlReplaceScalar(artifact, analysis.frontmatter(artifact), at(text, 'on'), 'on', {
          style: 'double',
        }),
      ),
    ).toEqual(utf8Bom('---\r\nmetadata:\r\n  beta: "on"\r\n---\r\nBody.\r\n'));
  });

  it('rejects a span outside the text', () => {
    const { analysis, artifact } = artifactOf(SKILL, '---\na: 1\n---\n');
    expect(() =>
      yamlReplaceScalar(artifact, analysis.frontmatter(artifact), { offset: 9, length: 9 }, 'x'),
    ).toThrow(RangeError);
  });
});

describe('YAML frontmatter: the block', () => {
  const move = (content: string, open: number, close: number) => {
    const { artifact } = artifactOf(SKILL, content);
    const change = moveFrontmatterToTop(artifact, open, close);
    return change === undefined ? undefined : edited(artifact, change);
  };

  it('deletes the lines before the block', () => {
    expect(move('\n\n---\nname: x\n---\nBody.\n', 3, 5)).toBe('---\nname: x\n---\nBody.\n');
    expect(move('Draft\n---\nname: x\n---\n', 2, 4)).toBe('---\nname: x\n---\n');
  });

  it('removes the indentation of the delimiters, or of the whole block', () => {
    expect(move('  ---\nname: x\n  ---\n', 1, 3)).toBe('---\nname: x\n---\n');
    expect(move('  ---\n  name: x\n  metadata:\n    a: 1\n\n  ---\n', 1, 6)).toBe(
      '---\nname: x\nmetadata:\n  a: 1\n\n---\n',
    );
    expect(move('\n\t---\n\tname: x\n\t---\n', 2, 4)).toBe('---\nname: x\n---\n');
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    expect(move('\r\n  ---\r\n  name: x\r\n  ---\r\nBody.\r\n', 2, 4)).toBe(
      '---\r\nname: x\r\n---\r\nBody.\r\n',
    );
    expect(
      bytesAfter(SKILL, utf8Bom('\r\n---\r\nname: x\r\n---\r\n'), ({ artifact }) =>
        moveFrontmatterToTop(artifact, 2, 4),
      ),
    ).toEqual(utf8Bom('---\r\nname: x\r\n---\r\n'));
  });

  it('refuses nothing to move, other whitespace and a block that does not parse', () => {
    expect(move('---\nname: x\n---\n', 1, 3)).toBeUndefined();
    expect(move('\u00a0---\nname: x\n---\n', 1, 3)).toBeUndefined();
    expect(move('\n---\nname: [x\n---\n', 2, 4)).toBeUndefined();
    // Only the delimiters move: the indented key under an unindented one breaks the mapping.
    expect(move('\n  ---\nname: x\n  b: 1\n  ---\n', 2, 5)).toBeUndefined();
  });

  it('rejects lines that are not a block in the file', () => {
    const { artifact } = artifactOf(SKILL, '\n---\nname: x\n---\n');
    expect(() => moveFrontmatterToTop(artifact, 2, 2)).toThrow(RangeError);
    expect(() => moveFrontmatterToTop(artifact, 0, 2)).toThrow(RangeError);
    expect(() => moveFrontmatterToTop(artifact, 2, 99)).toThrow(RangeError);
  });
});

describe('JSON', () => {
  const SERVER =
    '{\n  "mcpServers": {\n    "docs": {\n      "url": "https://docs.example.com/mcp"\n    }\n  }\n}\n';

  const json = (
    content: string,
    build: (artifact: ReturnType<typeof artifactOf>['artifact']) => Parameters<typeof edited>[1],
    path = '.mcp.json',
  ) => {
    const { artifact } = artifactOf(path, content);
    const change = build(artifact);
    return change === undefined ? undefined : edited(artifact, change);
  };

  it('inserts a property first or last, matching the indentation', () => {
    expect(
      json(SERVER, (a) =>
        jsonInsertProperty(a, ['mcpServers', 'docs'], 'type', 'http', { position: 'first' }),
      ),
    ).toBe(SERVER.replace('"url"', '"type": "http",\n      "url"'));
    expect(json(SERVER, (a) => jsonInsertProperty(a, ['mcpServers', 'docs'], 'type', 'http'))).toBe(
      SERVER.replace('/mcp"', '/mcp",\n      "type": "http"'),
    );
    const crlf = SERVER.replaceAll('\n', '\r\n');
    expect(
      json(crlf, (a) =>
        jsonInsertProperty(a, ['mcpServers', 'docs'], 'type', 'http', { position: 'first' }),
      ),
    ).toBe(crlf.replace('"url"', '"type": "http",\r\n      "url"'));
    const tabs = '{\n\t"a": 1\n}\n';
    expect(json(tabs, (a) => jsonInsertProperty(a, [], 'b', [1, 'x']))).toBe(
      '{\n\t"a": 1,\n\t"b": [1, "x"]\n}\n',
    );
  });

  it('inserts into one-line and empty objects', () => {
    expect(json('{"a": 1}', (a) => jsonInsertProperty(a, [], 'b', 2))).toBe('{"a": 1, "b": 2}');
    expect(json('{"a":1,"c":3}', (a) => jsonInsertProperty(a, [], 'b', 2))).toBe(
      '{"a":1,"c":3,"b":2}',
    );
    expect(json('{"a": 1}', (a) => jsonInsertProperty(a, [], 'b', 2, { position: 'first' }))).toBe(
      '{"b": 2, "a": 1}',
    );
    expect(json('{}', (a) => jsonInsertProperty(a, [], 'b', { c: null }))).toBe(
      '{"b": {"c": null}}',
    );
    expect(json('{ }', (a) => jsonInsertProperty(a, [], 'b', true))).toBe('{ "b": true }');
    expect(
      json('{\n  "mcpServers": {\n  }\n}\n', (a) =>
        jsonInsertProperty(a, ['mcpServers'], 'x', { command: 'node' }),
      ),
    ).toBe('{\n  "mcpServers": {\n    "x": {"command": "node"}\n  }\n}\n');
  });

  it('keeps a trailing comment on its property', () => {
    expect(
      json(
        '{\n  "a": 1 // note\n}\n',
        (a) => jsonInsertProperty(a, [], 'b', 2),
        '.gemini/settings.json',
      ),
    ).toBe('{\n  "a": 1, // note\n  "b": 2\n}\n');
  });

  it('refuses existing keys, non-objects and invalid JSON', () => {
    expect(
      json(SERVER, (a) => jsonInsertProperty(a, ['mcpServers', 'docs'], 'url', 'x')),
    ).toBeUndefined();
    expect(json('{"a": [1]}', (a) => jsonInsertProperty(a, ['a'], 'b', 1))).toBeUndefined();
    expect(json('{"a": 1,}', (a) => jsonInsertProperty(a, [], 'b', 1))).toBeUndefined();
    expect(
      json(
        '{"a": {/* c */}}',
        (a) => jsonInsertProperty(a, ['a'], 'b', 1),
        '.gemini/settings.json',
      ),
    ).toBeUndefined();
    const { artifact } = artifactOf('.mcp.json', '{}');
    expect(() => jsonInsertProperty(artifact, [], 'n', Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('removes a property with its comma', () => {
    const three = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
    expect(json(three, (a) => jsonRemoveProperty(a, ['a']))).toBe('{\n  "b": 2,\n  "c": 3\n}\n');
    expect(json(three, (a) => jsonRemoveProperty(a, ['b']))).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
    expect(json(three, (a) => jsonRemoveProperty(a, ['c']))).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
    expect(json('{\n  "a": 1\n}\n', (a) => jsonRemoveProperty(a, ['a']))).toBe('{}\n');
    expect(json('{"a": 1, "b": 2}', (a) => jsonRemoveProperty(a, ['a']))).toBe('{"b": 2}');
    expect(json('{"a": 1, "b": 2}', (a) => jsonRemoveProperty(a, ['b']))).toBe('{"a": 1}');
    const settings =
      '{\r\n  "permissions": {\r\n    "defaultMode": "bypassPermissions",\r\n    "allow": []\r\n  }\r\n}\r\n';
    expect(
      json(
        settings,
        (a) => jsonRemoveProperty(a, ['permissions', 'defaultMode']),
        '.claude/settings.json',
      ),
    ).toBe('{\r\n  "permissions": {\r\n    "allow": []\r\n  }\r\n}\r\n');
  });

  it('removes the duplicate it is told to', () => {
    const duplicate = '{"a": 1, "a": 2}';
    expect(json(duplicate, (a) => jsonRemoveProperty(a, ['a']))).toBe('{"a": 1}');
    expect(json(duplicate, (a) => jsonRemoveProperty(a, ['a'], { keyOffset: 1 }))).toBe('{"a": 2}');
    expect(json(duplicate, (a) => jsonRemoveProperty(a, ['a'], { keyOffset: 2 }))).toBeUndefined();
  });

  it('never deletes a comment', () => {
    const commented = '{\n  "a": 1, // keep\n  "b": 2\n}\n';
    const settings = '.gemini/settings.json';
    expect(json(commented, (a) => jsonRemoveProperty(a, ['a']), settings)).toBeUndefined();
    expect(json(commented, (a) => jsonRemoveProperty(a, ['b']), settings)).toBeUndefined();
    expect(json('{"a": "http://x//y", "b": 1}', (a) => jsonRemoveProperty(a, ['a']))).toBe(
      '{"b": 1}',
    );
    expect(json('{"a": "q\\"//", "b": 1}', (a) => jsonRemoveProperty(a, ['a']))).toBe('{"b": 1}');
    expect(json('{"a": 1}', (a) => jsonRemoveProperty(a, ['x']))).toBeUndefined();
    expect(json('{"a": 1}', (a) => jsonRemoveProperty(a, [0]))).toBeUndefined();
    expect(json('[1]', (a) => jsonRemoveProperty(a, ['a']))).toBeUndefined();
  });

  it('renames a key in place', () => {
    const hooks = '{"hooks": {"PreToolUs": [], "Stop": []}}';
    expect(
      json(
        hooks,
        (a) => jsonRenameKey(a, ['hooks', 'PreToolUs'], 'PreToolUse'),
        '.claude/settings.json',
      ),
    ).toBe('{"hooks": {"PreToolUse": [], "Stop": []}}');
    expect(
      json(hooks, (a) => jsonRenameKey(a, ['hooks', 'PreToolUs'], 'Stop'), '.claude/settings.json'),
    ).toBeUndefined();
    expect(
      json(hooks, (a) => jsonRenameKey(a, ['hooks', 'Nope'], 'X'), '.claude/settings.json'),
    ).toBeUndefined();
    expect(json(hooks, (a) => jsonRenameKey(a, [], 'X'), '.claude/settings.json')).toBeUndefined();
  });

  it('replaces only the value', () => {
    const timeout = '{"hooks": [{"timeout": 30000, "command": "x"}]}';
    expect(
      json(
        timeout,
        (a) => jsonReplaceValue(a, ['hooks', 0, 'timeout'], 30),
        '.claude/settings.json',
      ),
    ).toBe('{"hooks": [{"timeout": 30, "command": "x"}]}');
    expect(
      json('{"url": "http://x"}', (a) => jsonReplaceValue(a, ['url'], 'https://x\u202E')),
    ).toBe('{"url": "https://x\\u202e"}');
    expect(json('{"a": 1}', (a) => jsonReplaceValue(a, ['b'], 1))).toBeUndefined();
    expect(json('{"a": [1]}', (a) => jsonReplaceValue(a, ['a', 3], 1))).toBeUndefined();
    expect(json('{"a": [1]}', (a) => jsonReplaceValue(a, ['a', 'x'], 1))).toBeUndefined();
    expect(json('{"a": 1}', (a) => jsonReplaceValue(a, [0], 1))).toBeUndefined();
    expect(json('{"a" 1}', (a) => jsonReplaceValue(a, ['a'], 1))).toBeUndefined();
    const { artifact } = artifactOf('.mcp.json', '{"a": 1}');
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => jsonReplaceValue(artifact, ['a'], deep as never)).toThrow(RangeError);
  });

  it('keeps UTF-16 JSON in UTF-16', () => {
    const bytes = bytesAfter('.mcp.json', utf16('{"a": 1}\r\n'), ({ artifact }) =>
      jsonInsertProperty(artifact, [], 'b', 'é'),
    );
    expect(decode(bytes)).toMatchObject({
      encoding: 'utf-16le',
      hasBom: true,
      text: '{"a": 1, "b": "é"}\r\n',
    });
  });
});
