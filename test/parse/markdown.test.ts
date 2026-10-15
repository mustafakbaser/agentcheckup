import type { Nodes } from 'mdast';
import { describe, expect, it } from 'vitest';
import type { Span } from '../../src/core/types.js';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import {
  guardMarkdown,
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_LINES,
  markdownWindowEnd,
} from '../../src/parse/markdown-guard.js';
import { parseMarkdown } from '../../src/parse/markdown.js';

const slice = (text: string, span: Span): string =>
  text.slice(span.offset, span.offset + span.length);
const parse = (text: string) => parseMarkdown(text, parseFrontmatter(text));

function types(node: Nodes): string[] {
  const out: string[] = [];
  const stack: Nodes[] = [node];
  for (let current = stack.pop(); current; current = stack.pop()) {
    out.push(current.type);
    if ('children' in current) stack.push(...[...current.children].reverse());
  }
  return out;
}

describe('frontmatter blanking', () => {
  it.each([
    ['valid', '---\ntitle: x\n---\n# Heading\n'],
    ['invalid', '---\ntitle: [\n---\n# Heading\n'],
    ['CRLF', '---\r\ntitle: x\r\n---\r\n# Heading\r\n'],
  ])('blanks %s frontmatter so --- is not a thematic break', (_name, text) => {
    const doc = parse(text);
    expect(doc.root.children.map((child) => child.type)).toEqual(['heading']);
    const heading = doc.root.children[0];
    expect(heading?.position?.start.offset).toBe(text.indexOf('# Heading'));
    expect(doc.root.position?.end.offset).toBe(text.length);
  });

  it('does not turn a frontmatter value into a setext heading', () => {
    const text = '---\ntitle: x\n---\nParagraph\n';
    expect(parse(text).root.children.map((child) => child.type)).toEqual(['paragraph']);
  });

  it.each([
    ['unclosed', '---\ntitle: x\n', ['thematicBreak', 'paragraph']],
    ['absent', 'Title\n---\n', ['heading']],
    ['unsupported', '+++\na = 1\n+++\n', ['paragraph']],
  ])('parses %s frontmatter text as-is', (_name, text, expected) => {
    expect(parse(text).root.children.map((child) => child.type)).toEqual(expected);
  });

  it('ignores a frontmatter span that does not fit the text', () => {
    const doc = parseMarkdown('# A\n', {
      kind: 'valid',
      span: { offset: 0, length: 100 },
      bodyOffset: 100,
      data: { values: {}, keys: [], keySpan: () => undefined, valueSpan: () => undefined },
      warnings: [],
    });
    expect(doc.root.children).toEqual([]);
  });
});

describe('code', () => {
  it('records fenced, indented and inline code, sorted and merged', () => {
    const text = 'a `x` b ``y``\n\n```\n---\n@a.md\n```\n\n    indented @b.md\n\n~~~\nunclosed';
    const doc = parse(text);
    expect(doc.codeSpans.map((span) => slice(text, span))).toEqual([
      '`x`',
      '``y``',
      '```\n---\n@a.md\n```',
      '    indented @b.md',
      '~~~\nunclosed',
    ]);
    expect(doc.root.children.map((child) => child.type)).toEqual([
      'paragraph',
      'code',
      'code',
      'code',
    ]);
  });

  it('answers isInCode at span boundaries', () => {
    const text = 'x `code` y';
    const doc = parse(text);
    expect(doc.isInCode(1)).toBe(false);
    expect(doc.isInCode(2)).toBe(true);
    expect(doc.isInCode(7)).toBe(true);
    expect(doc.isInCode(8)).toBe(false);
    expect(doc.isInCode(-1)).toBe(false);
    expect(doc.isInCode(text.length + 5)).toBe(false);
  });

  it('keeps offsets aligned when the text starts with U+FEFF', () => {
    // micromark drops a leading U+FEFF; a double BOM must not shift every span by one.
    const text = '\uFEFF`a` b';
    const doc = parse(text);
    expect(doc.codeSpans.map((span) => slice(text, span))).toEqual(['`a`']);
    expect(doc.root.position?.end.offset).toBe(text.length);
  });

  it('handles CRLF, tabs and astral characters in offsets', () => {
    const text = '🚀 `a`\r\n\r\n\t```js\r\n\tcode\r\n\t```\r\n';
    const doc = parse(text);
    expect(doc.codeSpans.map((span) => slice(text, span))).toEqual([
      '`a`',
      '\t```js\r\n\tcode\r\n\t```',
    ]);
  });
});

describe('HTML comments', () => {
  it('finds several comments in one block HTML node', () => {
    const text = '<!-- a --> <!-- b -->\n\ntext\n';
    const doc = parse(text);
    expect(doc.htmlComments.map((c) => [c.value, slice(text, c.span)])).toEqual([
      [' a ', '<!-- a -->'],
      [' b ', '<!-- b -->'],
    ]);
  });

  it('finds comments inside other HTML blocks and inline', () => {
    const text = '<div>\n<!-- in div -->\n</div>\n\nSome <!-- inline --> text.\n';
    const doc = parse(text);
    expect(doc.htmlComments.map((c) => c.value)).toEqual([' in div ', ' inline ']);
  });

  it('runs an unterminated comment to the end of its node', () => {
    // An HTML block that never meets `-->` runs to the end of the document, final newline included.
    const text = 'Intro\n\n<!-- never closed\n\nstill inside\n';
    const doc = parse(text);
    expect(doc.htmlComments.map((c) => [c.value, slice(text, c.span)])).toEqual([
      [' never closed\n\nstill inside\n', '<!-- never closed\n\nstill inside\n'],
    ]);
  });

  it('reads <!--> and <!---> as empty comments', () => {
    const text = '<!-->x <!--->y\n';
    expect(parse(text).htmlComments.map((c) => [c.value, slice(text, c.span)])).toEqual([
      ['', '<!-->'],
      ['', '<!--->'],
    ]);
  });

  it('keeps CRLF inside comment values and skips comments in code', () => {
    const text = '<!-- a\r\nb -->\r\n\r\n`<!-- no -->`\r\n';
    expect(parse(text).htmlComments.map((c) => c.value)).toEqual([' a\r\nb ']);
  });

  it('sees directive comments inside block quotes', () => {
    const text = '> <!-- agentcheckup-disable-file x -- y -->\n';
    expect(parse(text).htmlComments.map((c) => slice(text, c.span))).toEqual([
      '<!-- agentcheckup-disable-file x -- y -->',
    ]);
  });
});

describe('links', () => {
  it('collects links, images and definitions with spans', () => {
    const text = 'See [a](./x.md "t"), ![i](img.png) and <https://e.com>.\n\n[ref]: ./def.md\n';
    const doc = parse(text);
    expect(doc.links.map((link) => [link.kind, link.url, slice(text, link.span)])).toEqual([
      ['link', './x.md', '[a](./x.md "t")'],
      ['image', 'img.png', '![i](img.png)'],
      ['link', 'https://e.com', '<https://e.com>'],
      ['definition', './def.md', '[ref]: ./def.md'],
    ]);
  });
});

describe('limits', () => {
  it('analyzes only the window', () => {
    const filler = 'Some words in a paragraph.\n\n'.repeat(
      Math.ceil(MAX_MARKDOWN_LENGTH / 28) + 10,
    );
    const text = `${filler}\`late code\` <!-- late -->\n`;
    const doc = parse(text);
    const end = markdownWindowEnd(text);
    expect(end).toBeLessThanOrEqual(MAX_MARKDOWN_LENGTH);
    expect(doc.root.position?.end.offset).toBe(end);
    expect(doc.codeSpans).toEqual([]);
    expect(doc.htmlComments).toEqual([]);
  });

  it('cuts the window at a line start, by length or by line count', () => {
    expect(markdownWindowEnd('short\ntext')).toBe(10);
    const manyLines = 'a\n'.repeat(MAX_MARKDOWN_LINES + 5);
    expect(markdownWindowEnd(manyLines)).toBe(MAX_MARKDOWN_LINES * 2);
    // Lines end at LF, CRLF or a lone CR, as in micromark.
    expect(markdownWindowEnd('a\r'.repeat(MAX_MARKDOWN_LINES + 5))).toBe(MAX_MARKDOWN_LINES * 2);
    expect(markdownWindowEnd('a\r\n'.repeat(MAX_MARKDOWN_LINES + 5))).toBe(MAX_MARKDOWN_LINES * 3);
    const longLine = 'x'.repeat(MAX_MARKDOWN_LENGTH + 10);
    expect(markdownWindowEnd(longLine)).toBe(MAX_MARKDOWN_LENGTH);
    const surrogate = `${'x'.repeat(MAX_MARKDOWN_LENGTH - 1)}😀tail`;
    expect(markdownWindowEnd(surrogate)).toBe(MAX_MARKDOWN_LENGTH - 1);
  });

  it('switches to flat mode when container churn is over budget', () => {
    const churn = '- a\n  - b\n'.repeat(4000);
    const guarded = guardMarkdown(churn);
    expect(guarded.flat).toBe(true);
    const doc = parse(churn);
    expect(types(doc.root)).not.toContain('list');
    expect(guardMarkdown('- a\n  - b\n> quote\n\nTitle\n---\n').flat).toBe(false);
    expect(types(parse('- a\n  - b\n').root)).toContain('list');
  });

  it('defuses the inline delimiters of an expensive paragraph without moving offsets', () => {
    const text = `${'*a_'.repeat(20_000)}\n\nok *em* \`code\`\n`;
    const guarded = guardMarkdown(text);
    expect(guarded.source).toHaveLength(text.length);
    expect(guarded.source).not.toBe(text);
    const doc = parse(text);
    expect(types(doc.root).filter((type) => type === 'emphasis')).toHaveLength(1);
    expect(doc.codeSpans.map((span) => slice(text, span))).toEqual(['`code`']);
  });

  it('keeps ordinary documents untouched', () => {
    const text = Array.from(
      { length: 300 },
      (_, i) =>
        `## S${i}\n\nText with [a link](./d${i}.md), \`code\`, *em* and _em_.\n\n- item\n  - nested\n`,
    ).join('\n');
    const guarded = guardMarkdown(text);
    expect(guarded.source).toBe(text);
    expect(guarded.flat).toBe(false);
  });

  it('caps nesting on one line and deep indentation', () => {
    const deepQuote = `${'> '.repeat(100)}x`;
    const guarded = guardMarkdown(deepQuote);
    expect(guarded.source).toHaveLength(deepQuote.length);
    expect(guarded.source.startsWith('> '.repeat(32))).toBe(true);
    // Markers past the 32nd are defused, and so is whitespace past column 128.
    expect(guarded.source.charCodeAt(64)).toBe(0xa0);
    expect(guarded.source.endsWith('x')).toBe(true);
    const quoteDepth = types(parse(deepQuote).root).filter((type) => type === 'blockquote');
    expect(quoteDepth.length).toBeLessThanOrEqual(32);

    const indented = `- a\n${' '.repeat(200)}- b\n`;
    expect(guardMarkdown(indented).source.slice(4, 4 + 128)).toBe(' '.repeat(128));
    expect(guardMarkdown(indented).source.charCodeAt(4 + 128)).toBe(0xa0);
  });

  it('protects fences, thematic breaks and HTML block starts when defusing', () => {
    const hot = '*a_'.repeat(3000);
    const text = `${hot}\n\`\`\`\n${hot}\n\`\`\`\n***\n<div>\n`;
    const { source } = guardMarkdown(text);
    expect(source).toContain('\n```\n');
    expect(source).toContain('\n***\n');
    expect(source).toContain('\n<div>');
    expect(parse(text).codeSpans).toHaveLength(1);
  });
});

describe('analysis', () => {
  const analysis = (text: string) => parse(text).analysis;
  const complete = (text: string) => ({
    complete: true,
    analyzedLength: text.length,
    flat: false,
    defusedParagraphs: 0,
    cappedLines: 0,
  });

  it.each([
    [
      'an ordinary document',
      '# Title\n\nText with *em*, [a link](x.md) and `code`.\n\n- a\n  - b\n',
    ],
    ['frontmatter', '---\nname: x\n---\nbody\n'],
    ['a leading U+FEFF (an offset fix, not a limit)', '\uFEFF# Title\n'],
    ['empty text', ''],
    ['long whitespace-only lines', `a\n${' '.repeat(300)}\n\t${' '.repeat(300)}\nb\n`],
    ['long whitespace after a quote marker', `> a\n>${' '.repeat(300)}\n> b\n`],
    ['long whitespace-only lines between lone CRs', `a\r${' '.repeat(300)}\rb`],
    ['deep indentation in an indented code block', `    code\n${' '.repeat(200)}more code\n`],
    ['deep indentation of list item text', `- a\n${' '.repeat(200)}text\n`],
  ])('is complete for %s', (_name, text) => {
    expect(analysis(text)).toEqual(complete(text));
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('is complete for a SKILL.md with very long frontmatter values (%s)', (_name, eol) => {
    const text = [
      '---',
      'name: article-writing',
      `description: ${'Write long-form articles in the house style. '.repeat(45)}`,
      `allowed-tools: ${'Read, '.repeat(100)}Write`,
      '---',
      '',
      '# Article writing',
      '',
      'Body text.',
      '',
    ].join(eol);
    const frontmatter = parseFrontmatter(text);
    expect(frontmatter.kind).toBe('valid');
    const doc = parseMarkdown(text, frontmatter);
    expect(doc.analysis).toEqual(complete(text));
    // The blanked frontmatter yields no nodes: everything starts in the body.
    expect(doc.root.children.map((child) => child.type)).toEqual(['heading', 'paragraph']);
    if (frontmatter.kind === 'valid') {
      for (const child of doc.root.children) {
        expect(child.position?.start.offset).toBeGreaterThanOrEqual(frontmatter.bodyOffset);
      }
    }
  });

  it('is complete for invalid frontmatter with long lines', () => {
    const text = `---\ndescription: ${'Use when: editing. '.repeat(120)}\n---\n# Title\n`;
    expect(parseFrontmatter(text).kind).toBe('invalid');
    const doc = parse(text);
    expect(doc.analysis).toEqual(complete(text));
    expect(doc.root.children.map((child) => child.type)).toEqual(['heading']);
  });

  it('records a window cut', () => {
    const text = 'a\n'.repeat(MAX_MARKDOWN_LINES + 1);
    expect(analysis(text)).toEqual({
      complete: false,
      analyzedLength: MAX_MARKDOWN_LINES * 2,
      flat: false,
      defusedParagraphs: 0,
      cappedLines: 0,
    });
  });

  it('records flat mode', () => {
    const text = '- a\n  - b\n'.repeat(4000);
    expect(analysis(text)).toEqual({
      complete: false,
      analyzedLength: text.length,
      flat: true,
      defusedParagraphs: 0,
      cappedLines: 0,
    });
  });

  it('switches to flat mode for long lazy continuations (security review case)', () => {
    const stair = Array.from({ length: 63 }, (_, i) => `${' '.repeat(i * 2)}- a\n`).join('');
    const text = stair + 'b\n'.repeat(8192 - 63);
    const started = performance.now();
    expect(analysis(text)).toMatchObject({ complete: false, flat: true });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(guardMarkdown(`- a\n${'b\n'.repeat(8191)}`).flat).toBe(true);
    expect(guardMarkdown(`> a\n${'b\n'.repeat(8191)}`).flat).toBe(true);
    // Lines that continue only the outer container are lazy too.
    expect(guardMarkdown(`> > a\n${'> b\n'.repeat(8191)}`).flat).toBe(true);
    expect(guardMarkdown(`- - a\n${'  b\n'.repeat(8191)}`).flat).toBe(true);
    expect(guardMarkdown(`> - a\n${'> b\n'.repeat(8191)}`).flat).toBe(true);
    // A long list after a nested item is not lazy: every line starts a new item.
    expect(guardMarkdown(`- a\n  - b\n${'- c\n'.repeat(5000)}`).flat).toBe(false);
    // Properly indented continuation lines are cheap and stay in full mode.
    expect(guardMarkdown(`- a\n${'  b\n'.repeat(8191)}`).flat).toBe(false);
    expect(guardMarkdown(`> a\n${'> b\n'.repeat(8191)}`).flat).toBe(false);
  });

  it('keeps ordinary lazy continuations in full mode', () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `- item ${i} text that wraps\nonto a lazy line\n\n> quote ${i}\ncontinued lazily\n`,
    ).join('\n');
    const doc = parse(text);
    expect(doc.analysis).toEqual(complete(text));
    expect(types(doc.root)).toContain('list');
    expect(types(doc.root)).toContain('blockquote');
  });

  it('counts defused paragraphs', () => {
    const hot = '*a_'.repeat(20_000);
    const text = `${hot}\n\nplain *em*\n\n${hot}\n`;
    expect(analysis(text)).toEqual({
      complete: false,
      analyzedLength: text.length,
      flat: false,
      defusedParagraphs: 2,
      cappedLines: 0,
    });
  });

  it.each([
    ['too many container markers on a line', `${'> '.repeat(40)}x\n`, 1],
    ['two such lines', `${'> '.repeat(40)}x\n${'- '.repeat(40)}y\n`, 2],
    ['deep indentation before a list marker', `- a\n${' '.repeat(200)}- b\n`, 1],
  ])('records per-line caps: %s', (_name, text, cappedLines) => {
    expect(analysis(text)).toEqual({
      complete: false,
      analyzedLength: text.length,
      flat: false,
      defusedParagraphs: 0,
      cappedLines,
    });
  });
});
