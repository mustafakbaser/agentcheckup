import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { yamlReplaceListItems } from '../../src/fix/edits.js';
import { listSource } from '../../src/fix/yaml-source.js';
import { artifactOf, edited } from './helpers.js';

const SKILL = '.claude/skills/demo/SKILL.md';

/** The file after replacing the items of `key`, or undefined when the builder refuses. */
function replace(
  content: string,
  items: readonly (readonly string[])[],
  key = 'allowed-tools',
): string | undefined {
  const { analysis, artifact } = artifactOf(SKILL, content);
  const change = yamlReplaceListItems(artifact, analysis.frontmatter(artifact), key, items);
  return change === undefined ? undefined : edited(artifact, change);
}

const skill = (yaml: string) => `---\nname: demo\n${yaml}---\nBody.\n`;

describe('yamlReplaceListItems', () => {
  it('rewrites a block list item by item and keeps the rest byte for byte', () => {
    const before = skill("allowed-tools:\n  - Read\n  - 'Bash'\n  - Write\n  - Grep\n");
    expect(
      replace(before, [['Read'], ['Bash(git status *)', 'Bash(npm test)'], [], ['Grep']]),
    ).toBe(
      skill('allowed-tools:\n  - Read\n  - "Bash(git status *)"\n  - "Bash(npm test)"\n  - Grep\n'),
    );
  });

  it('keeps the dash indentation and line endings of the item', () => {
    const crlf = '---\r\nallowed-tools:\r\n- Bash\r\n-   Write\r\n---\r\n';
    expect(replace(crlf, [['Bash(make)', 'Read'], ['Write']])).toBe(
      '---\r\nallowed-tools:\r\n- "Bash(make)"\r\n- Read\r\n-   Write\r\n---\r\n',
    );
  });

  it('writes a flow list on one line', () => {
    const before = skill('allowed-tools: [Read, "Bash", Write]\nlicense: MIT\n');
    expect(replace(before, [['Read'], ['Bash(make test)'], []])).toBe(
      skill('allowed-tools: [Read, "Bash(make test)"]\nlicense: MIT\n'),
    );
  });

  it('quotes what a parser would read as something else', () => {
    const before = skill('tags:\n  - a\n');
    expect(replace(before, [['yes', 'a: b', '#x', 'plain']], 'tags')).toBe(
      skill('tags:\n  - "yes"\n  - "a: b"\n  - "#x"\n  - plain\n'),
    );
  });

  it('refuses what it cannot rewrite exactly', () => {
    const cases: [string, (readonly string[])[]][] = [
      [skill('allowed-tools: Bash\n'), [['Read']]],
      [skill('allowed-tools:\n  - Bash\n'), [[]]],
      [skill('allowed-tools:\n  - Bash\n'), [['a'], ['b']]],
      [skill('allowed-tools:\n  - Bash # all\n'), [['Read']]],
      [skill('allowed-tools:\n  # tools\n  - Bash\n'), [['Read']]],
      [skill('allowed-tools: &t\n  - Bash\nother: *t\n'), [['Read']]],
      [skill('allowed-tools:\n  - !!str Bash\n'), [['Read']]],
      [skill('allowed-tools:\n  - [Bash]\n'), [['Read']]],
      [skill('allowed-tools:\n  - >\n    Bash\n'), [['Read']]],
      [skill('allowed-tools:\n  -\n    Bash\n'), [['Read']]],
      [skill('allowed-tools: [Read,\n  Bash]\n'), [['Read'], ['x']]],
      [skill('allowed-tools:\n  - ~\n'), [['Read']]],
      ['---\nallowed-tools: [\n---\n', [['Read']]],
    ];
    for (const [content, items] of cases) expect(replace(content, items), content).toBeUndefined();
    expect(replace(skill('tags:\n  - a\n'), [['b']], 'allowed-tools')).toBeUndefined();
  });

  it('parses back to the new list for any replacement', () => {
    const word = fc.constantFrom('Read', 'Bash', 'Bash(git status *)', 'a: b', 'yes', "it's", '#');
    fc.assert(
      fc.property(
        fc.array(fc.array(word, { maxLength: 3 }), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (items, flow) => {
          const list = flow
            ? `allowed-tools: [${items.map((_, i) => `t${String(i)}`).join(', ')}]\n`
            : `allowed-tools:\n${items.map((_, i) => `  - t${String(i)}\n`).join('')}`;
          const result = replace(skill(list), items);
          if (items.flat().length === 0) {
            expect(result).toBeUndefined();
            return;
          }
          expect(result).toBeDefined();
          const { analysis, artifact } = artifactOf(SKILL, result ?? '');
          const frontmatter = analysis.frontmatter(artifact);
          expect(frontmatter.kind).toBe('valid');
          if (frontmatter.kind === 'valid') {
            expect(frontmatter.data.values['allowed-tools']).toEqual(items.flat());
            expect(frontmatter.data.values['name']).toBe('demo');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('listSource', () => {
  it('finds the items of a block and a flow list', () => {
    const yaml = 'a:\n  - x\n  - "y"\nb: [p, \'q\']\n';
    expect(listSource(yaml, 0)).toEqual({
      flow: false,
      start: 5,
      end: 17,
      items: [
        { start: 7, end: 8 },
        { start: 13, end: 16 },
      ],
    });
    expect(listSource(yaml, 17)).toMatchObject({
      flow: true,
      items: [{ start: 21 }, { start: 24 }],
    });
    expect(listSource(yaml, 3)).toBeUndefined();
    expect(listSource('a: []\n', 0)).toBeUndefined();
    expect(listSource('a: x\n', 0)).toBeUndefined();
  });
});
