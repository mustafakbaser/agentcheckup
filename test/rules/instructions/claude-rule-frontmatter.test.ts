import { describe, expect, it } from 'vitest';
import {
  claudeRuleFrontmatterRule,
  escapeUnclosedBrackets,
  splitPatterns,
  unclosedBracket,
} from '../../../src/rules/instructions/claude-rule-frontmatter.js';
import { findings, lint } from '../../helpers/lint.js';
import { fixedText, fixFiles, repairs, selectRule } from './fix-helpers.js';

const RULE = 'instr/claude-rule-frontmatter';
const rules = [claudeRuleFrontmatterRule];
const PATH = '.claude/rules/api.md';

function run(text: string) {
  return findings(lint({ [PATH]: text }, { rules }), RULE);
}

describe('instr/claude-rule-frontmatter', () => {
  describe('does not report', () => {
    it.each([
      ['a rule without frontmatter', '# API rules\n'],
      ['a paths list', '---\npaths:\n  - "src/api/**/*.ts"\n  - "lib/**/*.{ts,tsx}"\n---\nBody\n'],
      ['a comma-separated string', '---\npaths: "src/**/*.ts, test/**/*.ts"\n---\nBody\n'],
      ['an escaped bracket', "---\npaths: 'photos \\[2024/**'\n---\n"],
      ['a bracket expression', '---\npaths: "src/[abc]/*.ts"\n---\n'],
      ['empty frontmatter', '---\n---\nBody\n'],
      ['unclosed frontmatter', '---\npaths: src/**\nBody\n'],
    ])('%s', (_label, text) => {
      expect(run(text)).toEqual([]);
    });
  });

  it('warns about invalid YAML that mentions paths', () => {
    const result = run('---\npaths: [src/**\n---\nBody\n');
    expect(result.map((finding) => finding.severity)).toEqual(['warn']);
    expect(result[0]?.message).toMatch(
      /^The frontmatter is not valid YAML \(.+\), so Claude Code ignores it and loads this rule in every session instead of only for the files in "paths"\.$/,
    );
  });

  it('notes invalid YAML without paths as info', () => {
    const result = run('---\ndescription: "unclosed\n---\nBody\n');
    expect(result.map((finding) => finding.severity)).toEqual(['info']);
    expect(result[0]?.message).toMatch(
      /^The frontmatter is not valid YAML \(.+\), so Claude Code ignores it and loads this rule in every session\.$/,
    );
  });

  it.each([
    ['an unquoted glob that YAML reads as an alias', '---\npaths: **/*.ts\n---\n'],
    ['a colon in a value', '---\npaths: src/**\ndescription: Use when: editing\n---\n'],
  ])('does not report YAML mistakes lenient readers accept: %s', (_label, text) => {
    expect(run(text).filter((finding) => finding.message.startsWith('The frontmatter'))).toEqual(
      [],
    );
  });

  it('reports a pattern with an unclosed bracket at the pattern', () => {
    expect(run('---\npaths:\n  - "src/**/*.ts"\n  - "photos [2024/**"\n---\n')).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: PATH,
        message:
          'Pattern "photos [2024/**" has a "[" with no closing "]", so Claude Code treats it as invalid and it matches no files. Write "\\[" for a literal bracket.',
        range: { start: { line: 4, column: 6 }, end: { line: 4, column: 21 } },
      },
    ]);
  });

  it('checks a string paths value for an unclosed bracket', () => {
    expect(run('---\npaths: docs/[draft/**\n---\n').map((finding) => finding.severity)).toEqual([
      'warn',
    ]);
  });

  it.each([
    [
      '42',
      '"paths" is a number, but Claude Code reads it only as a glob pattern or a list of glob patterns.',
    ],
    [
      'true',
      '"paths" is the boolean true, but Claude Code reads it only as a glob pattern or a list of glob patterns.',
    ],
    [
      '{src: ts}',
      '"paths" is a mapping, but Claude Code reads it only as a glob pattern or a list of glob patterns.',
    ],
    [
      '[src/**, 42]',
      'Item 2 of "paths" is a number, not a glob pattern. Write each pattern as a quoted string, such as "src/**/*.ts".',
    ],
    ['', '"paths" has no value. List the glob patterns this rule applies to, or remove the field.'],
  ])('notes paths: %s as information, since the effect is undocumented', (value, message) => {
    expect(
      run(`---\npaths: ${value}\n---\nBody\n`).map((finding) => [
        finding.severity,
        finding.message,
      ]),
    ).toEqual([['info', message]]);
  });

  it('warns when a Cursor or Copilot scoping key replaces paths', () => {
    expect(run('---\nglobs: src/**/*.ts\ndescription: API rules\n---\nBody\n')).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: PATH,
        message:
          'Claude Code ignores "globs" in rule frontmatter, so this rule loads in every session instead of only for matching files. Rename the field to "paths".',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
      },
      {
        ruleId: RULE,
        severity: 'info',
        path: PATH,
        message: 'Claude Code ignores "description" in rule frontmatter; it reads only "paths".',
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
      },
    ]);
  });

  it('notes other ignored keys once, as info', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => `${key}: 1`).join('\n');
    expect(run(`---\npaths: src/**\napplyTo: "**"\n${keys}\n---\n`)).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          'Claude Code ignores "applyTo", "a", "b", "c", "d" and more in rule frontmatter; it reads only "paths".',
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 8 } },
      }),
    ]);
  });

  it('finds unclosed brackets in linear time on hostile input', () => {
    const hostile = `${'['.repeat(100_000)}]`;
    expect(unclosedBracket(hostile)).toBe(-1);
    expect(unclosedBracket(`]${'['.repeat(100_000)}`)).toBe(1);
    expect(unclosedBracket('[')).toBe(0);
    expect(unclosedBracket('a\\[b')).toBe(-1);
  });

  it('does not run when Claude Code is not targeted', () => {
    const result = lint({ [PATH]: '---\nglobs: x\n---\n' }, { rules, targets: ['cursor'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});

describe('instr/claude-rule-frontmatter fix', () => {
  function fixed(text: string): string | undefined {
    const result = fixFiles({ [PATH]: text }, { rules }, selectRule(RULE));
    expect(result.verification.introduced).toEqual([]);
    return result.files.length === 0 ? undefined : fixedText(result, PATH);
  }

  it('renames globs to paths for review, and lists a comma-separated string', () => {
    const result = lint({ [PATH]: '---\nglobs: src/**/*.ts, test/**\n---\nBody\n' }, { rules });
    expect(repairs(result, RULE)).toEqual([
      {
        path: PATH,
        fix: {
          id: `${RULE}#paths`,
          class: 'review',
          title: `Rename "globs" to "paths" in ${PATH} and list its 2 patterns`,
          changes: [
            {
              kind: 'edit',
              path: PATH,
              edits: [
                {
                  offset: 4,
                  length: 27,
                  text: 'paths:\n  - "src/**/*.ts"\n  - "test/**"',
                },
              ],
            },
          ],
          notes: [
            'Claude Code then loads this rule only when it works with files that match these patterns, instead of in every session.',
          ],
        },
      },
    ]);
  });

  it.each([
    ['one pattern', '---\nglobs: "src/**"\n---\nB\n', '---\npaths: "src/**"\n---\nB\n'],
    [
      'applyTo with another ignored field',
      '---\napplyTo: "**/*.ts,**/*.tsx"\ndescription: TS\n---\nB\n',
      '---\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"\ndescription: TS\n---\nB\n',
    ],
    [
      'a flow list',
      '---\nglobs: ["a/**", "b/**"]\n---\nB\n',
      '---\npaths: ["a/**", "b/**"]\n---\nB\n',
    ],
    [
      'an unclosed bracket in a flow list',
      '---\npaths: ["a/**", "b [x"]\n---\nB\n',
      '---\npaths: ["a/**", "b \\\\[x"]\n---\nB\n',
    ],
    [
      'an unclosed bracket in a single-quoted string',
      "---\npaths: 'shots [2024/**'\n---\nB\n",
      "---\npaths: 'shots \\[2024/**'\n---\nB\n",
    ],
  ])('%s', (_label, before, after) => {
    expect(fixed(before)).toBe(after);
  });

  describe('leaves to the user', () => {
    it('invalid YAML', () => {
      const result = lint({ [PATH]: '---\npaths: [src/**\n---\nB\n' }, { rules });
      expect(repairs(result, RULE)).toEqual([
        {
          path: PATH,
          guidance:
            'correct the YAML; write each glob pattern as a quoted string, such as "src/**/*.ts", because a pattern that starts with "*" or "{" is not plain YAML',
        },
      ]);
    });

    it.each([
      ['unbalanced braces', '---\nglobs: src/{a,b, c/**\n---\nB\n'],
      ['an empty pattern', '---\nglobs: "a/**,,b/**"\n---\nB\n'],
      ['an empty value', '---\nglobs:\n---\nB\n'],
      ['a value that is not a pattern', '---\nglobs: 3\n---\nB\n'],
      ['a value on its own line', '---\nglobs:\n  a/**, b/**\n---\nB\n'],
      ['a list with a comment', '---\npaths:\n  - a [x # photos\n  - b/** # docs\n---\nB\n'],
    ])('%s', (_label, text) => {
      expect(fixed(text)).toBeUndefined();
      expect(repairs(lint({ [PATH]: text }, { rules }), RULE).some((item) => item.fix)).toBe(false);
    });

    it('a rule that another path links to', () => {
      const result = lint(
        {
          [PATH]: '---\nglobs: a/**\n---\nB\n',
          '.claude/rules/b.md': '---\nglobs: a/**\n---\nB\n',
        },
        { rules, symlinks: { '.claude/rules/b.md': PATH } },
      );
      expect(repairs(result, RULE)).toEqual([
        {
          path: PATH,
          guidance:
            'rename "globs" to "paths" by hand: ".claude/rules/b.md" is a symbolic link to this file',
        },
      ]);
    });
  });

  it('splits patterns at commas outside braces', () => {
    expect(splitPatterns('src/*.{ts,tsx}, docs/**')).toEqual(['src/*.{ts,tsx}', 'docs/**']);
    expect(splitPatterns('a/**')).toEqual(['a/**']);
    expect(splitPatterns('a/{b,c')).toBeUndefined();
    expect(splitPatterns('a/}b{')).toBeUndefined();
    expect(splitPatterns('a/**,\u202Eb')).toBeUndefined();
  });

  it('escapes exactly the brackets the rule reports', () => {
    for (const pattern of ['photos [2024/**', 'a[b]c[d', '[', 'a\\[b[c', 'x[[y']) {
      expect(unclosedBracket(escapeUnclosedBrackets(pattern))).toBe(-1);
    }
    expect(escapeUnclosedBrackets('a[b]c[d')).toBe('a[b]c\\[d');
    expect(escapeUnclosedBrackets('src/[ab]/**')).toBe('src/[ab]/**');
  });
});
