import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import { findImports } from '../../src/parse/imports.js';
import { MAX_MARKDOWN_LENGTH } from '../../src/parse/markdown-guard.js';
import { parseMarkdown } from '../../src/parse/markdown.js';
import type { ImportDialect, ImportReference } from '../../src/parse/types.js';

function find(text: string, dialect: ImportDialect): ImportReference[] {
  const imports = findImports(text, parseMarkdown(text, parseFrontmatter(text)), dialect);
  for (const reference of imports) {
    // Every span covers `@` and the raw path, exactly.
    expect(text.slice(reference.span.offset, reference.span.offset + reference.span.length)).toBe(
      `@${reference.raw}`,
    );
  }
  return imports;
}

const paths = (text: string, dialect: ImportDialect): string[] =>
  find(text, dialect).map((reference) => reference.path);

describe('both dialects', () => {
  it.each<[string, string, string[]]>([
    ['relative', '@./a.md', ['./a.md']],
    ['parent', 'See @../shared/rules.md', ['../shared/rules.md']],
    ['absolute', '@/etc/agent/rules.md', ['/etc/agent/rules.md']],
    ['bare file name (documented by both)', '@AGENTS.md', ['AGENTS.md']],
    ['documented extensionless example', 'See @README for an overview', ['README']],
    [
      'several on one line',
      '@./header.md @./content.md @./footer.md',
      ['./header.md', './content.md', './footer.md'],
    ],
    ['line start after CRLF', 'intro\r\n@docs/a.md\r\n', ['docs/a.md']],
    ['dotfile', 'Load @.env.example and @.cursorrules', ['.env.example', '.cursorrules']],
    ['Turkish path', 'Kurallar: @docs/çalışma-notları.md', ['docs/çalışma-notları.md']],
    ['emoji path', '@./📚/kılavuz.md', ['./📚/kılavuz.md']],
    ['Windows drive', '@C:/Users/me/rules.md', ['C:/Users/me/rules.md']],
  ])('%s', (_name, text, expected) => {
    expect(paths(text, 'claude')).toEqual(expected);
    expect(paths(text, 'gemini')).toEqual(expected);
  });

  it.each([
    ['email address', 'Mail user@example.com today'],
    ['npm scope', 'Install @types/node first'],
    ['Java annotation', 'Use @Override on every method'],
    ['mention', 'Thanks @username and @team-lead'],
    ['package with version', 'Pin @scope/pkg@1.2.3 and @v2.0'],
    ['URL', 'See @https://example.com/a.md'],
    ['lone @', 'a @ b @'],
    ['double @', '@@a.md'],
    ['inline code', 'Write `@a.md` literally'],
    ['fenced code', '```\n@a.md\n```\n'],
    ['indented code', 'para\n\n    @a.md\n'],
    ['code fence containing ---', '```\n---\n@a.md\n---\n```\n'],
  ])('%s is not an import', (_name, text) => {
    expect(find(text, 'claude')).toEqual([]);
    expect(find(text, 'gemini')).toEqual([]);
  });

  it('reports kind and span', () => {
    expect(find('x @~/.claude/my.md y', 'claude')).toEqual([
      {
        raw: '~/.claude/my.md',
        path: '~/.claude/my.md',
        span: { offset: 2, length: 16 },
        kind: 'home',
      },
    ]);
    expect(find('@/abs.md', 'gemini')[0]?.kind).toBe('absolute');
    expect(find('@C:\\dir\\x.md', 'claude')[0]?.kind).toBe('absolute');
    expect(find('@sub/x.md', 'gemini')[0]?.kind).toBe('relative');
  });
});

describe('Claude Code', () => {
  it.each<[string, string, string[]]>([
    [
      'documented examples',
      'See @README for project overview and @package.json for available npm commands.',
      ['README', 'package.json'],
    ],
    ['list item', '- git workflow @docs/git-instructions.md', ['docs/git-instructions.md']],
    ['trailing period', 'Read @a.md.', ['a.md']],
    ['trailing punctuation run', 'Read @a.md!), then @b.json;', ['a.md', 'b.json']],
    ['parenthesized', '(see @./b.md)', ['./b.md']],
    ['after an opening parenthesis', 'call(@lib/x.ts)', ['lib/x.ts']],
    ['emphasis marker', 'Use **@rules.md**', []],
    ['emphasis after the path', 'Use @rules.md**', ['rules.md']],
    ['parenthesis inside the path', '@docs/a(1).md)', ['docs/a(1).md']],
    ['ends at a code span', '@a.md`code`', ['a.md']],
    ['ends at a comment', '@a.md<!-- c -->', ['a.md']],
    ['non-breaking space boundary', 'x\u00a0@./a.md', ['./a.md']],
    ['home directory', '@~/notes.md', ['~/notes.md']],
  ])('%s', (_name, text, expected) => {
    expect(paths(text, 'claude')).toEqual(expected);
  });

  it('unescapes spaces but keeps the raw text', () => {
    expect(find('- API conventions @Design\\ Docs/api-conventions.md', 'claude')).toEqual([
      {
        raw: 'Design\\ Docs/api-conventions.md',
        path: 'Design Docs/api-conventions.md',
        span: { offset: 18, length: 32 },
        kind: 'relative',
      },
    ]);
    expect(paths('@my\\ notes.md.', 'claude')).toEqual(['my notes.md']);
  });

  it.each([
    ['double-quoted', '@"x.md"'],
    ['single-quoted', "@'x.md'"],
    ['quoted with escapes', '@"Design\\ Docs/x.md"'],
    ['quote before @', '"@x.md"'],
    ['inside an HTML comment', '<!-- @a.md -->'],
    ['inside a multi-line comment', '<!--\n@a.md\n-->\n'],
    ['in frontmatter', '---\ndescription: see @a.md\n---\nbody\n'],
  ])('%s is not an import', (_name, text) => {
    expect(find(text, 'claude')).toEqual([]);
  });

  it('still finds imports after the frontmatter', () => {
    expect(paths('---\ndescription: see @a.md\n---\n@b.md\n', 'claude')).toEqual(['b.md']);
  });
});

describe('Gemini CLI', () => {
  it.each<[string, string, string[]]>([
    ['keeps trailing punctuation (the load fails)', 'Read @./a.md.', ['./a.md.']],
    ['bare name with punctuation', 'Read @AGENTS.md,', ['AGENTS.md,']],
    ['no escaped spaces', '@./a\\ b.md', ['./a\\']],
    ['HTML comments are not skipped', '<!-- @./a.md -->', ['./a.md']],
    ['frontmatter is not skipped', '---\ndescription: see @a.md\n---\n@b.md\n', ['a.md', 'b.md']],
    ['tab boundary', 'x\t@./a.md', ['./a.md']],
    ['leading tab is indented code', '\t@./a.md', []],
    ['home directory is rejected', '@~/notes.md', []],
    ['quoted is rejected', '@"x.md"', []],
    ['parenthesis is not a boundary', 'call(@lib/x.ts)', []],
    ['non-breaking space is not a boundary', 'x\u00a0@./a.md', []],
    ['token runs through a code span', '@./a.md`code`', ['./a.md`code`']],
  ])('%s', (_name, text, expected) => {
    expect(paths(text, 'gemini')).toEqual(expected);
  });
});

describe('limits', () => {
  it('only reports imports inside the analyzed window', () => {
    const filler = 'Some words in a paragraph.\n\n'.repeat(
      Math.ceil(MAX_MARKDOWN_LENGTH / 28) + 10,
    );
    expect(find(`@./early.md\n\n${filler}@./late.md\n`, 'claude').map((r) => r.path)).toEqual([
      './early.md',
    ]);
  });

  it('is linear on a long run of @', () => {
    const text = `${'@'.repeat(500_000)} ${'@a'.repeat(100_000)} ${'@ '.repeat(100_000)}`;
    const started = performance.now();
    expect(find(text, 'claude')).toEqual([]);
    expect(find(text, 'gemini')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
