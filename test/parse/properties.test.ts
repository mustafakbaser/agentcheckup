import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Span } from '../../src/core/types.js';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import { findImports } from '../../src/parse/imports.js';
import { guardMarkdown, markdownWindowEnd } from '../../src/parse/markdown-guard.js';
import { parseMarkdown } from '../../src/parse/markdown.js';
import { parseJson } from '../../src/parse/json.js';
import type { FrontmatterResult } from '../../src/parse/types.js';

/** Override for deeper local fuzzing, e.g. `PARSE_PROPERTY_RUNS=20000 vitest run test/parse`. */
const RUNS = Number(process.env['PARSE_PROPERTY_RUNS'] ?? 300);

/** Fragments that matter to YAML, CommonMark, imports and JSON, plus awkward characters. */
const FRAGMENTS = [
  '---',
  '---js',
  '+++',
  '...',
  '\n',
  '\r\n',
  '\r',
  ' ',
  '  ',
  '    ',
  '\t',
  ' ',
  ' ',
  '```',
  '~~~',
  '`',
  '``',
  '@',
  '@./a.md',
  '@~/b.md',
  '@"c.md"',
  '\\ ',
  'x.md',
  '<!--',
  '-->',
  '<div>',
  '</div>',
  '[',
  ']',
  '(',
  ')',
  '![',
  '*',
  '**',
  '_',
  '>',
  '> ',
  '- ',
  '* ',
  '1. ',
  '#',
  '=',
  '===',
  'a',
  'é',
  'ğüşıöç',
  '🚀',
  '\ud800',
  '\udc00',
  '\u0000',
  '﻿',
  ':',
  ': ',
  '&a',
  '*a',
  '!!str',
  '!x',
  '{',
  '}',
  '"',
  "'",
  ',',
  '//',
  '/*',
  '*/',
  'null',
  '~',
  '1.10',
  'yes',
  '__proto__',
  '<<',
  '|',
  '>-',
  '?',
  '%YAML 1.1',
  '\\',
  'true',
  '-0',
  '1e3',
];

const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code));
const soup = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 80 })
  .map((parts) => parts.join(''));
const frontmatterSoup = fc.tuple(soup, soup).map(([yaml, body]) => `---\n${yaml}\n---\n${body}`);

/** Unicode (including astral), raw UTF-16 code units (lone surrogates), and token soups. */
const anyText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.string({ unit: codeUnit, maxLength: 200 }),
  soup,
  frontmatterSoup,
);

function expectInBounds(span: Span | undefined, length: number): void {
  if (span === undefined) return;
  expect(Number.isInteger(span.offset)).toBe(true);
  expect(Number.isInteger(span.length)).toBe(true);
  expect(span.offset).toBeGreaterThanOrEqual(0);
  expect(span.length).toBeGreaterThanOrEqual(0);
  expect(span.offset + span.length).toBeLessThanOrEqual(length);
}

function frontmatterSpans(result: FrontmatterResult): (Span | undefined)[] {
  switch (result.kind) {
    case 'absent':
      return [];
    case 'unclosed':
      return [result.openSpan];
    case 'unsupported':
      return [result.span];
    case 'invalid':
      return [result.span, ...result.errors.map((error) => error.span)];
    case 'valid':
      return [
        result.span,
        ...result.warnings.map((warning) => warning.span),
        ...result.data.keys.flatMap((key) => [
          result.data.keySpan(key),
          result.data.valueSpan(key),
        ]),
      ];
  }
}

describe('properties', () => {
  it('parseFrontmatter never throws and keeps spans in bounds', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const result = parseFrontmatter(text);
        for (const span of frontmatterSpans(result)) expectInBounds(span, text.length);
        if (result.kind === 'valid' || result.kind === 'invalid') {
          expect(result.bodyOffset).toBeGreaterThanOrEqual(result.span.offset + result.span.length);
          expect(result.bodyOffset).toBeLessThanOrEqual(text.length);
        }
        if (result.kind === 'valid') {
          expect(new Set(result.data.keys).size).toBe(result.data.keys.length);
          expect(Object.getPrototypeOf(result.data.values)).toBeNull();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('parseMarkdown never throws, keeps the text length and keeps spans in bounds', () => {
    fc.assert(
      fc.property(anyText, fc.nat(), (text, probe) => {
        const doc = parseMarkdown(text, parseFrontmatter(text));
        expect(doc.root.position?.end.offset).toBe(markdownWindowEnd(text));
        const { analysis } = doc;
        expect(analysis.analyzedLength).toBe(markdownWindowEnd(text));
        expect(analysis.defusedParagraphs).toBeGreaterThanOrEqual(0);
        expect(analysis.cappedLines).toBeGreaterThanOrEqual(0);
        expect(analysis.complete).toBe(
          analysis.analyzedLength === text.length &&
            !analysis.flat &&
            analysis.defusedParagraphs === 0 &&
            analysis.cappedLines === 0,
        );
        let previousEnd = -1;
        for (const span of doc.codeSpans) {
          expectInBounds(span, text.length);
          expect(span.offset).toBeGreaterThan(previousEnd);
          previousEnd = span.offset + span.length;
        }
        for (const comment of doc.htmlComments) expectInBounds(comment.span, text.length);
        for (const link of doc.links) expectInBounds(link.span, text.length);
        const offset = text.length === 0 ? 0 : probe % text.length;
        const inSpan = doc.codeSpans.some(
          (s) => offset >= s.offset && offset < s.offset + s.length,
        );
        expect(doc.isInCode(offset)).toBe(inSpan);
      }),
      { numRuns: RUNS },
    );
  });

  it('maxAnalyzedChars bounds the window and keeps offsets', () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: -2, max: 400 }), (text, budget) => {
        const doc = parseMarkdown(text, parseFrontmatter(text), { maxAnalyzedChars: budget });
        const { analyzedLength } = doc.analysis;
        expect(analyzedLength).toBeLessThanOrEqual(Math.max(0, budget));
        expect(analyzedLength).toBeLessThanOrEqual(markdownWindowEnd(text));
        expect(doc.root.position?.end.offset).toBe(analyzedLength);
        for (const span of doc.codeSpans)
          expect(span.offset + span.length).toBeLessThanOrEqual(analyzedLength);
        if (analyzedLength < text.length) expect(doc.analysis.complete).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('blanked frontmatter never yields AST nodes', () => {
    fc.assert(
      fc.property(frontmatterSoup, (text) => {
        const frontmatter = parseFrontmatter(text);
        if (frontmatter.kind !== 'valid' && frontmatter.kind !== 'invalid') return;
        const doc = parseMarkdown(text, frontmatter);
        for (const child of doc.root.children) {
          expect(child.position?.start.offset).toBeGreaterThanOrEqual(frontmatter.bodyOffset);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('guardMarkdown never changes whitespace-only lines', () => {
    const blankish = fc
      .array(fc.constantFrom(' ', '\t', ' '.repeat(140), '\n', '\r\n', '\r', 'x', '- ', '> '), {
        maxLength: 40,
      })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(blankish, (text) => {
        const { source } = guardMarkdown(text);
        for (const match of text.matchAll(/[^\n\r]+/g)) {
          if (match[0].trim() === '') {
            expect(source.slice(match.index, match.index + match[0].length)).toBe(match[0]);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('guardMarkdown preserves length and line breaks', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const { source } = guardMarkdown(text);
        expect(source).toHaveLength(text.length);
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code === 0x0a || code === 0x0d) expect(source.charCodeAt(i)).toBe(code);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('findImports never throws and returns exact spans outside code', () => {
    fc.assert(
      fc.property(
        anyText,
        fc.constantFrom('claude' as const, 'gemini' as const),
        (text, dialect) => {
          const doc = parseMarkdown(text, parseFrontmatter(text));
          for (const reference of findImports(text, doc, dialect)) {
            expectInBounds(reference.span, text.length);
            expect(text.charAt(reference.span.offset)).toBe('@');
            expect(
              text.slice(reference.span.offset + 1, reference.span.offset + reference.span.length),
            ).toBe(reference.raw);
            expect(doc.isInCode(reference.span.offset)).toBe(false);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('parseJson never throws and agrees with JSON.parse', () => {
    const jsonish = fc.oneof(
      anyText,
      fc.json({ maxDepth: 4 }),
      fc.json({ maxDepth: 2 }).map((json) => `${json},`),
    );
    fc.assert(
      fc.property(jsonish, (text) => {
        const doc = parseJson(text);
        let expected: unknown;
        let parses = true;
        try {
          expected = JSON.parse(text);
        } catch {
          parses = false;
        }
        expect(doc.ok).toBe(parses);
        if (doc.ok) {
          expect(JSON.stringify(doc.value)).toBe(JSON.stringify(expected));
          let previous = -1;
          for (const warning of doc.warnings) {
            expect(warning.code).toBe('duplicate-key');
            expectInBounds(warning.span, text.length);
            expect(warning.span.offset).toBeGreaterThan(previous);
            previous = warning.span.offset;
          }
          const root = doc.valueSpan([]);
          expectInBounds(root, text.length);
          expect(text.slice(root?.offset, (root?.offset ?? 0) + (root?.length ?? 0)).trim()).toBe(
            text.trim(),
          );
        } else {
          expect(doc.errors.length).toBeGreaterThan(0);
          for (const error of doc.errors) expectInBounds(error.span, text.length);
        }
      }),
      { numRuns: RUNS },
    );
  });
});
