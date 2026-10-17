import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CST, Lexer } from 'yaml';
import type { FileChange } from '../../src/core/types.js';
import {
  MAX_YAML_COMMENT_LENGTH,
  yamlInsertComment,
  yamlMoveUnderMapping,
  yamlRemoveKey,
} from '../../src/fix/edits.js';
import { commentOffsets, entrySources } from '../../src/fix/yaml-source.js';
import { snapshotFrom } from '../helpers/lint.js';
import { applyChanges, artifactOf, bytesOf, edited, utf8Bom } from './helpers.js';

const SKILL = '.claude/skills/demo/SKILL.md';

type Build = (parts: ReturnType<typeof artifactOf>) => FileChange | undefined;

/** The file's text after the change `build` makes, or undefined when it refuses. */
function after(content: string, build: Build): string | undefined {
  const parts = artifactOf(SKILL, content);
  const change = build(parts);
  return change === undefined ? undefined : edited(parts.artifact, change);
}

/** The frontmatter's keys and values, parsed again as a scan would. */
function data(content: string): { keys: readonly string[]; values: Record<string, unknown> } {
  const { analysis, artifact } = artifactOf(SKILL, content);
  const frontmatter = analysis.frontmatter(artifact);
  if (frontmatter.kind !== 'valid') throw new Error(`frontmatter is ${frontmatter.kind}`);
  return {
    keys: frontmatter.data.keys,
    values: JSON.parse(JSON.stringify(frontmatter.data.values)) as Record<string, unknown>,
  };
}

const skill = (yaml: string, body = 'Body.\n') => `---\n${yaml}---\n${body}`;

const remove = (content: string, key: string) =>
  after(content, ({ analysis, artifact }) =>
    yamlRemoveKey(artifact, analysis.frontmatter(artifact), key),
  );

const moveUnder = (content: string, keys: readonly string[], mapping?: string) =>
  after(content, ({ analysis, artifact }) =>
    yamlMoveUnderMapping(artifact, analysis.frontmatter(artifact), keys, mapping),
  );

const comment = (content: string, before: string | number, text: string) =>
  after(content, ({ analysis, artifact }) =>
    yamlInsertComment(artifact, analysis.frontmatter(artifact), before, text),
  );

describe('yamlRemoveKey', () => {
  it('removes a key with its whole value and keeps every other byte', () => {
    const cases: [string, string][] = [
      ['tags:\n  - a\n  - b\n', 'block list'],
      ['tags:\n- a\n- b\n', 'block list at the key indentation'],
      ['tags: [a, b]\n', 'flow list'],
      ['tags: [a,\n  b]\n', 'flow list over two lines'],
      ['tags: 1.10\n', 'number'],
      ['tags: true\n', 'boolean'],
      ['tags: "a # b"\n', 'double-quoted with a hash'],
      ["tags: 'it''s'\n", 'single-quoted'],
      ['tags: |\n  # a heading, not a comment\n  text\n', 'block scalar'],
      ['tags:\n  a: 1\n  b: [x]\n', 'nested mapping'],
      ['tags:\n', 'empty value'],
    ];
    for (const [entry, name] of cases) {
      expect(remove(skill(`name: demo\n${entry}description: d\n`), 'tags'), name).toBe(
        skill('name: demo\ndescription: d\n'),
      );
    }
    expect(remove(skill('name: demo\n'), 'name')).toBe(skill(''));
    expect(remove(skill('  name: demo\n  tags: [a]\n'), 'tags')).toBe(skill('  name: demo\n'));
  });

  it('keeps comments around the entry and refuses one on its lines', () => {
    expect(remove(skill('# about tags\ntags: [a]\n# next\nname: x\n'), 'tags')).toBe(
      skill('# about tags\n# next\nname: x\n'),
    );
    for (const entry of [
      'tags: [a, b] # all\n',
      'tags: # list\n  - a\n',
      'tags:\n  # first\n  - a\n',
      'tags:\n  - a # first\n',
      'tags: [a, # first\n  b]\n',
    ]) {
      expect(remove(skill(`name: x\n${entry}`), 'tags'), entry).toBeUndefined();
    }
  });

  it('refuses anchors, aliases and tags in the entry, and keeps them elsewhere', () => {
    expect(remove(skill('tags: &t [a]\nother: *t\n'), 'tags')).toBeUndefined();
    expect(remove(skill('tags: &t [a]\n'), 'tags')).toBeUndefined();
    expect(remove(skill('base: &b x\ntags: [*b]\n'), 'tags')).toBeUndefined();
    expect(remove(skill('tags: !!seq [a]\n'), 'tags')).toBeUndefined();
    expect(remove(skill('x: &x 1\ny: *x\ntags: [a]\n'), 'tags')).toBe(skill('x: &x 1\ny: *x\n'));
  });

  it('keeps CRLF and a byte order mark', () => {
    expect(remove('---\r\nname: x\r\ntags:\r\n  - a\r\nv: 1\r\n---\r\nBody.\r\n', 'tags')).toBe(
      '---\r\nname: x\r\nv: 1\r\n---\r\nBody.\r\n',
    );
    const content = utf8Bom('---\r\ntags: [a]\r\nname: x\r\n---\r\n');
    const { analysis, artifact } = artifactOf(SKILL, content);
    const change = yamlRemoveKey(artifact, analysis.frontmatter(artifact), 'tags');
    expect(bytesOf(applyChanges(snapshotFrom({ [SKILL]: content }), change), SKILL)).toEqual(
      utf8Bom('---\r\nname: x\r\n---\r\n'),
    );
  });

  it('refuses what it cannot remove as whole lines', () => {
    expect(remove(skill('{tags: [a], name: x}\n'), 'tags')).toBeUndefined();
    expect(remove(skill('{name: x,\n tags: [a]}\n'), 'tags')).toBeUndefined();
    expect(remove(skill('? tags\n: [a]\nname: x\n'), 'tags')).toBeUndefined();
    expect(remove(skill('name: x\n'), 'tags')).toBeUndefined();
    expect(remove(skill('tags: [a\n'), 'tags')).toBeUndefined();
    expect(remove('No frontmatter.\n', 'tags')).toBeUndefined();
  });
});

describe('yamlMoveUnderMapping', () => {
  it('creates the mapping last and writes each value as its source text', () => {
    expect(
      moveUnder(
        skill(
          [
            'name: demo',
            'version: 1.10',
            'beta: true',
            'legacy: yes',
            'released: 2026-10-17',
            'title: "a: b"',
            "quote: 'it''s'",
            'tags: [a, b]',
            'owners:',
            '  - ann',
            '  - 3',
            'summary: one, two',
            'description: d',
            '',
          ].join('\n'),
        ),
        ['version', 'beta', 'legacy', 'released', 'title', 'quote', 'tags', 'owners', 'summary'],
      ),
    ).toBe(
      skill(
        [
          'name: demo',
          'description: d',
          'metadata:',
          '  version: "1.10"',
          '  beta: "true"',
          '  legacy: "yes"',
          '  released: "2026-10-17"',
          '  title: "a: b"',
          '  quote: "it\'s"',
          '  tags: "a, b"',
          '  owners: "ann, 3"',
          '  summary: "one, two"',
          '',
        ].join('\n'),
      ),
    );
  });

  it('appends to an existing block mapping with its indentation', () => {
    expect(
      moveUnder(skill('name: x\nmetadata:\n    owner: me\n    # kept\nv: 2\nlicense: MIT\n'), [
        'v',
      ]),
    ).toBe(skill('name: x\nmetadata:\n    owner: me\n    v: "2"\n    # kept\nlicense: MIT\n'));
    expect(moveUnder(skill('metadata:\n  a: "1"\nv: 2\n'), ['v'])).toBe(
      skill('metadata:\n  a: "1"\n  v: "2"\n'),
    );
    expect(moveUnder(skill('v: 2\nmetadata:\n  a: "1"\nname: x\n'), ['v'])).toBe(
      skill('metadata:\n  a: "1"\n  v: "2"\nname: x\n'),
    );
  });

  it('keeps the moved keys as written, and escapes what must stay visible', () => {
    expect(moveUnder(skill('"my key": 1\n'), ['my key'])).toBe(
      skill('metadata:\n  "my key": "1"\n'),
    );
    expect(moveUnder(skill('notes: |\n  a\n  b\n'), ['notes'])).toBe(
      skill('metadata:\n  notes: "a\\nb\\n"\n'),
    );
    expect(moveUnder(skill('v: "a\\u202Eb"\n'), ['v'])).toBe(
      skill('metadata:\n  v: "a\\u202Eb"\n'),
    );
    expect(moveUnder(skill('  name: x\n  v: 1\n'), ['v'], 'extra')).toBe(
      skill('  name: x\n  extra:\n    v: "1"\n'),
    );
  });

  it('keeps CRLF and a byte order mark', () => {
    expect(moveUnder('---\r\nname: x\r\nv:\r\n  - a\r\n---\r\nBody.\r\n', ['v'])).toBe(
      '---\r\nname: x\r\nmetadata:\r\n  v: "a"\r\n---\r\nBody.\r\n',
    );
    const content = utf8Bom('---\r\nmetadata:\r\n  a: "1"\r\nv: [b, c]\r\n---\r\n');
    const { analysis, artifact } = artifactOf(SKILL, content);
    const change = yamlMoveUnderMapping(artifact, analysis.frontmatter(artifact), ['v']);
    expect(bytesOf(applyChanges(snapshotFrom({ [SKILL]: content }), change), SKILL)).toEqual(
      utf8Bom('---\r\nmetadata:\r\n  a: "1"\r\n  v: "b, c"\r\n---\r\n'),
    );
  });

  it('refuses a mapping that is not a block mapping, and a clash', () => {
    for (const metadata of [
      'metadata: {a: b}\n',
      'metadata: {}\n',
      'metadata:\n',
      'metadata: text\n',
      'metadata:\n  - a\n',
      'metadata: &m\n  a: b\n',
      'metadata: !!map\n  a: b\n',
      'metadata: {a: b,\n  c: d}\n',
    ]) {
      expect(moveUnder(skill(`${metadata}v: 1\n`), ['v']), metadata).toBeUndefined();
    }
    expect(moveUnder(skill('metadata:\n  v: "0"\nv: 1\n'), ['v'])).toBeUndefined();
  });

  it('refuses values that are not text or a list of text without commas', () => {
    for (const entry of [
      'v: ["a,b"]\n',
      'v:\n',
      'v: ~\n',
      'v: []\n',
      'v: [[a]]\n',
      'v: [a, ~]\n',
      'v:\n  nested: 1\n',
      'v: &a x\n',
      'v: !!str 5\n',
      'v: x # note\n',
      'v:\n  # first\n  - a\n',
      'v: [a, # first\n  b]\n',
    ]) {
      expect(moveUnder(skill(`name: x\n${entry}`), ['v']), entry).toBeUndefined();
    }
  });

  it('refuses keys it cannot move and throws for a mapping name that is not plain', () => {
    const content = skill('name: x\nv: 1\nw: 2\n');
    expect(moveUnder(content, [])).toBeUndefined();
    expect(moveUnder(content, ['v', 'v'])).toBeUndefined();
    expect(moveUnder(content, ['v', 'metadata'])).toBeUndefined();
    expect(moveUnder(content, ['v', 'absent'])).toBeUndefined();
    expect(moveUnder(skill('{name: x, v: 1}\n'), ['v'])).toBeUndefined();
    expect(moveUnder('No frontmatter.\n', ['v'])).toBeUndefined();
    const { analysis, artifact } = artifactOf(SKILL, content);
    expect(() =>
      yamlMoveUnderMapping(artifact, analysis.frontmatter(artifact), ['v'], 'a b'),
    ).toThrow(RangeError);
  });
});

describe('yamlInsertComment', () => {
  const DIRECTIVE = 'agentcheckup-disable-next-line skill/non-portable-field -- Claude Code only';

  it('inserts a comment before a key or a line, indented like it', () => {
    expect(comment(skill('name: x\nuser-invocable: false\n'), 'user-invocable', DIRECTIVE)).toBe(
      skill(`name: x\n# ${DIRECTIVE}\nuser-invocable: false\n`),
    );
    // Line 4 is "  - b".
    expect(comment(skill('name: x\ntags:\n  - b\n'), 4, 'why')).toBe(
      skill('name: x\ntags:\n  # why\n  - b\n'),
    );
    // Line 3 is the closing delimiter.
    expect(comment(skill('name: x\n'), 3, 'end')).toBe(skill('name: x\n# end\n'));
    expect(comment(skill('  name: x\n'), 'name', 'n')).toBe(skill('  # n\n  name: x\n'));
  });

  it('keeps CRLF and a byte order mark', () => {
    expect(comment('---\r\nname: x\r\n---\r\n', 'name', 'n')).toBe(
      '---\r\n# n\r\nname: x\r\n---\r\n',
    );
    const content = utf8Bom('---\r\nname: x\r\n---\r\n');
    const { analysis, artifact } = artifactOf(SKILL, content);
    const change = yamlInsertComment(artifact, analysis.frontmatter(artifact), 2, 'n');
    expect(bytesOf(applyChanges(snapshotFrom({ [SKILL]: content }), change), SKILL)).toEqual(
      utf8Bom('---\r\n# n\r\nname: x\r\n---\r\n'),
    );
  });

  it('refuses text that is not one visible line', () => {
    for (const text of [
      '',
      '   ',
      'a\nallowed-tools: Bash',
      'a\rb',
      'a\u2028b',
      'a\u0085b',
      'a\u202Eb',
      'a\u{E0041}b',
      'a\tb',
      'a\u0007b',
      'x'.repeat(MAX_YAML_COMMENT_LENGTH + 1),
    ]) {
      expect(comment(skill('name: x\n'), 'name', text), JSON.stringify(text)).toBeUndefined();
    }
    expect(comment(skill('name: x\n'), 'name', 'x'.repeat(MAX_YAML_COMMENT_LENGTH))).toBeDefined();
  });

  it('refuses a line outside the YAML, or where a comment would change a value', () => {
    const content = skill('name: x\nnotes: |\n  a\n  b\n', 'Body.\n');
    expect(comment(content, 1, 'c')).toBeUndefined();
    expect(comment(content, 7, 'c')).toBeUndefined();
    // Inside the block scalar, the comment would become text.
    expect(comment(content, 5, 'c')).toBeUndefined();
    expect(comment(content, 'absent', 'c')).toBeUndefined();
    expect(comment(skill('{name: x, v: 1}\n'), 'v', 'c')).toBeUndefined();
    expect(comment(skill('name: [a\n'), 2, 'c')).toBeUndefined();
    const { analysis, artifact } = artifactOf(SKILL, content);
    const frontmatter = analysis.frontmatter(artifact);
    for (const line of [0, 8, 1.5, Number.NaN]) {
      expect(() => yamlInsertComment(artifact, frontmatter, line, 'c'), String(line)).toThrow(
        RangeError,
      );
    }
  });
});

describe('YAML source facts', () => {
  it('finds comments and not hashes inside scalars', () => {
    const yaml = 'a: 1 # one\n# own\nb: |\n  # text\nc: "q # no"\nd: [x, # in\n  y]\n';
    expect(commentOffsets(yaml).map((offset) => yaml.slice(offset, offset + 4))).toEqual([
      '# on',
      '# ow',
      '# in',
    ]);
  });

  it('gives scalar texts before resolution and flags shared nodes', () => {
    const entries = entrySources('v: 1.10\nw: [a, "b", 0x1F]\nx: &a 1\ny:\nz: {a: 1}\n');
    expect([...entries.values()]).toEqual([
      { sharesNodes: false, text: '1.10' },
      { sharesNodes: false, text: ['a', 'b', '0x1F'] },
      { sharesNodes: true, text: '1' },
      { sharesNodes: false, text: undefined },
      { sharesNodes: false, text: undefined },
    ]);
    expect(entrySources('- a\n').size).toBe(0);
  });

  it('accounts for every character of any text, so comment offsets are exact', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom('a', ' ', '#', '\n', '"', "'", ':', '-', '[', ']', '|', '\r'),
        }),
        (yaml) => {
          const tokens = [...new Lexer().lex(yaml)].filter(
            (token) => token !== CST.SCALAR && token !== CST.DOCUMENT && token !== CST.FLOW_END,
          );
          expect(tokens.join('')).toBe(yaml);
          for (const offset of commentOffsets(yaml)) expect(yaml.charAt(offset)).toBe('#');
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

interface ValueCase {
  /** The text after `key:`, with `\n` for line breaks. */
  readonly yaml: string;
  /** The string the value becomes under `metadata`, or undefined when it cannot move. */
  readonly moved: string | undefined;
  /** A comment, an anchor or a tag on the entry's lines: it can be neither moved nor removed. */
  readonly fixed?: boolean;
}

const VALUES: readonly ValueCase[] = [
  { yaml: ' x', moved: 'x' },
  { yaml: ' hello world', moved: 'hello world' },
  { yaml: ' 1.10', moved: '1.10' },
  { yaml: ' true', moved: 'true' },
  { yaml: ' yes', moved: 'yes' },
  { yaml: ' 2026-10-17', moved: '2026-10-17' },
  { yaml: ' "a: b # c"', moved: 'a: b # c' },
  { yaml: " 'it''s'", moved: "it's" },
  { yaml: ' one, two', moved: 'one, two' },
  { yaml: ' [a, b]', moved: 'a, b' },
  { yaml: ' [1, "x"]', moved: '1, x' },
  { yaml: '\n  - a\n  - b', moved: 'a, b' },
  { yaml: '\n- c\n- d', moved: 'c, d' },
  { yaml: ' |\n  # not a comment\n  text', moved: '# not a comment\ntext\n' },
  { yaml: ' >-\n  folded\n  text', moved: 'folded text' },
  { yaml: ' ["a,b"]', moved: undefined },
  { yaml: '', moved: undefined },
  { yaml: ' []', moved: undefined },
  { yaml: '\n  nested: 1', moved: undefined },
  { yaml: ' [[a]]', moved: undefined },
  { yaml: ' x # note', moved: undefined, fixed: true },
  { yaml: '\n  # c\n  - a', moved: undefined, fixed: true },
  { yaml: ' &anchor x', moved: undefined, fixed: true },
  { yaml: ' !!str 5', moved: undefined, fixed: true },
];

const KEYS = ['name', 'version', 'tags', 'user-invocable', 'argument-hint', 'x_y', 'z'];

interface Entry {
  readonly key: string;
  readonly value: ValueCase;
}

/** A frontmatter with unique keys, optional comment and blank lines between entries. */
const frontmatters = fc.record({
  entries: fc.uniqueArray(
    fc.record({ key: fc.constantFrom(...KEYS), value: fc.constantFrom(...VALUES) }),
    { minLength: 1, maxLength: 6, selector: (entry) => entry.key },
  ),
  gaps: fc.array(fc.constantFrom('', '# between', '\n'), { minLength: 7, maxLength: 7 }),
  metadata: fc.constantFrom('none', 'block', 'flow'),
  eol: fc.constantFrom('\n', '\r\n'),
});

interface Rendered {
  readonly text: string;
  /** Each entry's text, its lines with their line endings. */
  readonly entries: readonly string[];
  readonly eol: string;
}

function render(
  entries: readonly Entry[],
  gaps: readonly string[],
  metadata: string,
  eol: string,
): Rendered {
  const parts: string[] = [];
  const texts: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const gap = gaps[index] ?? '';
    if (gap !== '') parts.push(gap === '\n' ? eol : `${gap}${eol}`);
    const lines = `${entry.key}:${entry.value.yaml}`.split('\n').join(eol) + eol;
    texts.push(lines);
    parts.push(lines);
  }
  if (metadata === 'block') parts.push(`metadata:${eol}  owner: me${eol}`);
  if (metadata === 'flow') parts.push(`metadata: {owner: me}${eol}`);
  return { text: `---${eol}${parts.join('')}---${eol}Body.${eol}`, entries: texts, eol };
}

/** True when each of `parts` is in `text`, in order and without overlapping. */
function inOrder(text: string, parts: readonly string[]): boolean {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

describe('YAML entry builders: properties', () => {
  it('yamlRemoveKey removes exactly the entry, and re-parses', () => {
    fc.assert(
      fc.property(frontmatters, fc.nat(), (input, pick) => {
        const { text, entries } = render(input.entries, input.gaps, input.metadata, input.eol);
        const index = pick % input.entries.length;
        const target = input.entries[index]!;
        const result = remove(text, target.key);
        if (target.value.fixed === true) {
          expect(result).toBeUndefined();
          return;
        }
        const entry = entries[index]!;
        const at = text.indexOf(entry);
        expect(result).toBe(text.slice(0, at) + text.slice(at + entry.length));
        const before = data(text);
        const parsed = data(result!);
        expect(parsed.keys).toEqual(before.keys.filter((key) => key !== target.key));
        for (const key of parsed.keys) expect(parsed.values[key]).toEqual(before.values[key]);
      }),
    );
  });

  it('yamlMoveUnderMapping moves exactly the entries, and re-parses to text values', () => {
    fc.assert(
      fc.property(frontmatters, fc.infiniteStream(fc.boolean()), (input, choices) => {
        const { text, entries } = render(input.entries, input.gaps, input.metadata, input.eol);
        const chosen = input.entries.filter(() => choices.next().value);
        const keys = chosen.map((entry) => entry.key);
        const result = moveUnder(text, keys);
        const movable =
          keys.length > 0 &&
          input.metadata !== 'flow' &&
          chosen.every((entry) => entry.value.moved !== undefined);
        if (!movable) {
          expect(result).toBeUndefined();
          return;
        }
        if (result === undefined) throw new Error('refused');
        const kept = entries.filter((_, index) => !keys.includes(input.entries[index]!.key));
        expect(inOrder(result, kept)).toBe(true);
        const before = data(text);
        const parsed = data(result);
        const others = before.keys.filter((key) => !keys.includes(key));
        expect(parsed.keys).toEqual(input.metadata === 'none' ? [...others, 'metadata'] : others);
        for (const key of others) {
          if (key !== 'metadata') expect(parsed.values[key]).toEqual(before.values[key]);
        }
        expect(parsed.values['metadata']).toEqual({
          ...(input.metadata === 'block' ? { owner: 'me' } : {}),
          ...Object.fromEntries(chosen.map((entry) => [entry.key, entry.value.moved])),
        });
      }),
      { numRuns: 300 },
    );
  });

  it('yamlInsertComment adds one line and changes nothing else', () => {
    fc.assert(
      fc.property(frontmatters, fc.nat(), fc.boolean(), (input, pick, byKey) => {
        const { text } = render(input.entries, input.gaps, input.metadata, input.eol);
        const lines = text.split('\n');
        const closing = lines.indexOf(input.eol === '\n' ? '---' : '---\r', 1) + 1;
        const target = byKey
          ? input.entries[pick % input.entries.length]!.key
          : 2 + (pick % (closing - 1));
        const result = comment(text, target, 'note');
        if (byKey) expect(result).toBeDefined();
        if (result === undefined) return;
        const resultLines = result.split('\n');
        const line =
          typeof target === 'number'
            ? target
            : lines.findIndex((candidate) => candidate.startsWith(`${target}:`)) + 1;
        expect(resultLines[line - 1]?.trim()).toBe('# note');
        expect(resultLines.toSpliced(line - 1, 1).join('\n')).toBe(text);
        expect(data(result)).toEqual(data(text));
      }),
    );
  });
});
