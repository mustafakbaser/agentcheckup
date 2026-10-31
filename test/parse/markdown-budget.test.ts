import { describe, expect, it, vi } from 'vitest';
import type { Span } from '../../src/core/types.js';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import { findImports } from '../../src/parse/imports.js';
import { MAX_MARKDOWN_LENGTH, parseMarkdown } from '../../src/parse/markdown.js';

// Counts calls into micromark, to prove that an empty window never reaches it.
const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fromMarkdown = actual['fromMarkdown'] as (...args: unknown[]) => unknown;
  return {
    ...actual,
    fromMarkdown: (...args: unknown[]) => {
      calls.count++;
      return fromMarkdown(...args);
    },
  };
});

const slice = (text: string, span: Span): string =>
  text.slice(span.offset, span.offset + span.length);
const parse = (text: string, maxAnalyzedChars?: number) =>
  parseMarkdown(
    text,
    parseFrontmatter(text),
    maxAnalyzedChars === undefined ? undefined : { maxAnalyzedChars },
  );

describe('maxAnalyzedChars', () => {
  it('analyzes nothing at 0, without calling micromark', () => {
    calls.count = 0;
    const text = `# Title\n\n\`code\` <!-- c --> [l](x.md)\n${'*a_'.repeat(300_000)}`;
    const started = performance.now();
    const doc = parse(text, 0);
    expect(performance.now() - started).toBeLessThan(500);
    expect(calls.count).toBe(0);
    expect(doc.root.children).toEqual([]);
    expect(doc.analysis).toEqual({
      complete: false,
      analyzedLength: 0,
      flat: false,
      defusedParagraphs: 0,
      cappedLines: 0,
      cost: { inline: 0, container: 0, lazy: 0 },
    });
    expect([doc.codeSpans, doc.htmlComments, doc.links]).toEqual([[], [], []]);
    expect(findImports('@./a.md\n', parse('@./a.md\n', 0), 'claude')).toEqual([]);
  });

  it.each([-5, Number.NaN])('treats %s as 0', (budget) => {
    expect(parse('text\n', budget).analysis.analyzedLength).toBe(0);
  });

  it('calls micromark when there is something to analyze', () => {
    calls.count = 0;
    parse('# Title\n');
    expect(calls.count).toBe(1);
  });

  it('cuts at a line start, keeping offsets', () => {
    const text = '`a` one\n`b` two\n`c` three\n';
    const doc = parse(text, 12);
    expect(doc.analysis).toMatchObject({ complete: false, analyzedLength: 8 });
    expect(doc.codeSpans.map((span) => slice(text, span))).toEqual(['`a`']);
    expect(doc.root.position?.end.offset).toBe(8);
  });

  it('cuts a single long line at the budget', () => {
    expect(parse('x'.repeat(100), 50).analysis.analyzedLength).toBe(50);
  });

  it('is complete when the budget covers the text', () => {
    const text = '# Title\n\nBody.\n';
    expect(parse(text, text.length).analysis).toMatchObject({
      complete: true,
      analyzedLength: text.length,
    });
    expect(parse(text, 1e9).analysis.complete).toBe(true);
  });

  it('never raises the default window', () => {
    const text = 'Words in a paragraph.\n\n'.repeat(10_000);
    expect(parse(text, Number.POSITIVE_INFINITY).analysis.analyzedLength).toBe(
      parse(text).analysis.analyzedLength,
    );
    expect(parse(text, 10 * MAX_MARKDOWN_LENGTH).analysis.analyzedLength).toBeLessThanOrEqual(
      MAX_MARKDOWN_LENGTH,
    );
  });

  it('limits import scanning to the analyzed window', () => {
    const text = '@./a.md\n@./b.md\n';
    expect(findImports(text, parse(text, 9), 'claude').map((r) => r.path)).toEqual(['./a.md']);
    expect(findImports(text, parse(text, 9), 'gemini').map((r) => r.path)).toEqual(['./a.md']);
  });

  it('treats empty text as fully analyzed', () => {
    expect(parse('', 0).analysis).toMatchObject({ complete: true, analyzedLength: 0 });
  });
});
