/**
 * CommonMark parsing for instruction files (AGENTS.md, CLAUDE.md, SKILL.md bodies, rules).
 *
 * Offsets in the returned AST are offsets into the full text: frontmatter is blanked (replaced by
 * spaces, line breaks kept) rather than cut off, so nothing needs shifting. Parsing is bounded:
 * see `markdown-guard.ts` for the analysis window, flat mode and hotspot defusing.
 */
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Span } from '../core/types.js';
import { FLAT_MODE, guardMarkdown, markdownWindowEnd } from './markdown-guard.js';

export { MAX_MARKDOWN_LENGTH, MAX_MARKDOWN_LINES } from './markdown-guard.js';
import { mergeSpans, spanBetween, spansContain } from './spans.js';
import type {
  FrontmatterResult,
  HtmlComment,
  MarkdownAnalysis,
  MarkdownDocument,
  MarkdownLink,
} from './types.js';

/**
 * Replaces every character of `span` except line breaks with a space, so CommonMark does not
 * read the `---` delimiters as a thematic break or setext underline, and offsets stay aligned.
 */
function blank(text: string, span: Span): string {
  const end = Math.min(text.length, span.offset + span.length);
  const start = Math.min(Math.max(0, span.offset), end);
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n\r]/g, ' ') + text.slice(end);
}

function nodeSpan(node: Nodes, limit: number): Span | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  return spanBetween(start, end, limit);
}

/**
 * Finds `<!-- ... -->` comments inside one HTML node. A node can hold several comments
 * (`<!-- a --> <!-- b -->`, or a `<div>` block containing comments). An unterminated `<!--` runs
 * to the end of the node, as CommonMark's HTML block does. `<!-->` and `<!--->` are empty
 * comments (CommonMark 0.31 and the HTML parser agree). Scans only the node's own slice, so the
 * total work is linear.
 */
function commentsIn(text: string, span: Span, out: HtmlComment[]): void {
  const slice = text.slice(span.offset, span.offset + span.length);
  for (let open = slice.indexOf('<!--'); open !== -1; open = slice.indexOf('<!--', open)) {
    const close = slice.indexOf('-->', open + 2);
    const end = close === -1 ? slice.length : close + 3;
    const valueEnd = close === -1 ? slice.length : close;
    out.push({
      value: valueEnd > open + 4 ? slice.slice(open + 4, valueEnd) : '',
      span: { offset: span.offset + open, length: end - open },
    });
    if (close === -1) break;
    open = end;
  }
}

interface Extracted {
  readonly code: Span[];
  readonly comments: HtmlComment[];
  readonly links: MarkdownLink[];
}

/** Collects code, HTML comments and links. Iterative, so deep ASTs cannot overflow the stack. */
function extract(root: Root, text: string, limit: number): Extracted {
  const result: Extracted = { code: [], comments: [], links: [] };
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const span = nodeSpan(node, limit);
    if (span !== undefined) {
      if (node.type === 'code' || node.type === 'inlineCode') {
        result.code.push(span);
      } else if (node.type === 'html') {
        commentsIn(text, span, result.comments);
      } else if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
        result.links.push({ url: node.url, span, kind: node.type });
      }
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
  return result;
}

const byOffset = (a: { readonly span: Span }, b: { readonly span: Span }): number =>
  a.span.offset - b.span.offset;

export interface ParseMarkdownOptions {
  /**
   * Analyze at most this many characters (a scan-wide budget). Lowers the default window of
   * `MAX_MARKDOWN_LENGTH`, never raises it; 0 or less analyzes nothing.
   */
  readonly maxAnalyzedChars?: number;
}

/** An empty document, for a zero-length window: micromark is not called. */
function emptyRoot(): Root {
  const point = { line: 1, column: 1, offset: 0 };
  return { type: 'root', children: [], position: { start: point, end: { ...point } } };
}

/**
 * Parses `text` as CommonMark (no extensions). `frontmatter` must be the result of
 * `parseFrontmatter(text)`; a `valid` or `invalid` block is blanked before parsing.
 *
 * Only the first `MAX_MARKDOWN_LENGTH` characters / `MAX_MARKDOWN_LINES` lines are analyzed, or
 * fewer with `options.maxAnalyzedChars` (see `markdownWindowEnd`); the AST, code spans, comments
 * and links cover that window. `analysis` records every limit that applied (window cut, flat
 * mode, defused paragraphs, per-line nesting caps), so rules can say a file was only partly
 * analyzed.
 */
export function parseMarkdown(
  text: string,
  frontmatter: FrontmatterResult,
  options: ParseMarkdownOptions = {},
): MarkdownDocument {
  const windowEnd = markdownWindowEnd(text, options.maxAnalyzedChars);
  let window = text.slice(0, windowEnd);
  if (frontmatter.kind === 'valid' || frontmatter.kind === 'invalid') {
    window = blank(window, frontmatter.span);
  }
  const { source, flat, defusedParagraphs, cappedLines } = guardMarkdown(window);
  let root: Root;
  if (windowEnd === 0) root = emptyRoot();
  else root = flat ? fromMarkdown(source, FLAT_MODE) : fromMarkdown(source);
  const { code, comments, links } = extract(root, text, windowEnd);
  const codeSpans = mergeSpans(code);
  const analysis: MarkdownAnalysis = {
    complete: windowEnd === text.length && !flat && defusedParagraphs === 0 && cappedLines === 0,
    analyzedLength: windowEnd,
    flat,
    defusedParagraphs,
    cappedLines,
  };
  return {
    root,
    analysis,
    codeSpans,
    htmlComments: comments.sort(byOffset),
    links: links.sort(byOffset),
    isInCode: (offset) => spansContain(codeSpans, offset),
  };
}
