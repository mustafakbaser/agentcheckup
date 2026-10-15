/**
 * Contracts for the hardened parsers. Rules consume these shapes through `RuleContext`;
 * they never parse raw text themselves.
 *
 * All spans are offsets into the artifact's full decoded text (see src/core/types.ts).
 */
import type { Root } from 'mdast';
import type { Span } from '../core/types.js';

// ---------------------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------------------

export interface ParseIssue {
  /** Stable machine-readable code, e.g. `duplicate-key`, `alias`, `not-a-mapping`. */
  readonly code: string;
  readonly message: string;
  readonly span: Span;
}

export interface FrontmatterData {
  /** Top-level mapping. Null-prototype object: `__proto__` and `constructor` are plain keys. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Top-level keys in source order. */
  readonly keys: readonly string[];
  keySpan(key: string): Span | undefined;
  valueSpan(key: string): Span | undefined;
}

export type FrontmatterResult =
  /** The text does not start with a frontmatter delimiter. */
  | { readonly kind: 'absent' }
  /** Starts with `---` but has no closing delimiter line. */
  | { readonly kind: 'unclosed'; readonly openSpan: Span }
  /** Starts with a delimiter for a format agents do not read (`+++` TOML, `---js`, `---json`). */
  | { readonly kind: 'unsupported'; readonly syntax: string; readonly span: Span }
  | {
      readonly kind: 'invalid';
      /** The whole block including delimiters. */
      readonly span: Span;
      /** Offset of the first character after the closing delimiter line. */
      readonly bodyOffset: number;
      readonly errors: readonly ParseIssue[];
    }
  | {
      readonly kind: 'valid';
      readonly span: Span;
      readonly bodyOffset: number;
      readonly data: FrontmatterData;
      /** Constructs that parse but behave differently across YAML implementations. */
      readonly warnings: readonly ParseIssue[];
    };

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

export interface MarkdownLink {
  readonly url: string;
  readonly span: Span;
  readonly kind: 'link' | 'image' | 'definition';
}

export interface HtmlComment {
  readonly value: string;
  readonly span: Span;
}

/**
 * How much of a Markdown document was analyzed. The parser bounds the cost of hostile or very
 * large files (see src/parse/markdown-guard.ts); when it does, rules see fewer constructs, and
 * agentcheck says so instead of silently reporting less.
 */
export interface MarkdownAnalysis {
  /** False when any limit below applied. */
  readonly complete: boolean;
  /** Characters analyzed, counted from the start of the text. */
  readonly analyzedLength: number;
  /** Lists, block quotes and setext headings were not parsed, to bound parser cost. */
  readonly flat: boolean;
  /** Paragraphs whose inline syntax (emphasis, links) was neutralized, to bound parser cost. */
  readonly defusedParagraphs: number;
  /** Lines changed by the per-line caps (container markers, indentation). */
  readonly cappedLines: number;
}

export interface MarkdownDocument {
  /** CommonMark AST of the body. Frontmatter is blanked before parsing so offsets stay aligned. */
  readonly root: Root;
  readonly analysis: MarkdownAnalysis;
  /** Inline code, fenced and indented code blocks. Sorted by offset, non-overlapping. */
  readonly codeSpans: readonly Span[];
  readonly htmlComments: readonly HtmlComment[];
  readonly links: readonly MarkdownLink[];
  /** True when `offset` falls inside any code span or block. */
  isInCode(offset: number): boolean;
}

export type ImportDialect = 'claude' | 'gemini';

export interface ImportReference {
  /** Text as written after `@`, e.g. `docs/a\ b.md`. */
  readonly raw: string;
  /** Unescaped path, e.g. `docs/a b.md`. */
  readonly path: string;
  /** Covers `@` and the path. */
  readonly span: Span;
  readonly kind: 'relative' | 'absolute' | 'home';
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

export type JsonPathSegment = string | number;

export type JsonDocument =
  | {
      readonly ok: true;
      readonly value: unknown;
      /** Constructs that parse but lose information, e.g. `duplicate-key` (the last value wins). */
      readonly warnings: readonly ParseIssue[];
      /** Span of the value at `path`, or undefined if absent. */
      valueSpan(path: readonly JsonPathSegment[]): Span | undefined;
      /** Span of the property key at `path` (last segment must be a string). */
      keySpan(path: readonly JsonPathSegment[]): Span | undefined;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ParseIssue[];
    };
