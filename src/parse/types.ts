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
  /**
   * Span of the value at `path`, a JSON path into {@link values}: mapping keys and sequence
   * indices. Undefined when the path does not exist; a key written without a value has an empty
   * span, as {@link valueSpan} gives it. A path through an alias continues at its anchor, so the
   * span is where the value is written.
   */
  valueSpanAt(path: readonly JsonPathSegment[]): Span | undefined;
  /** Span of the mapping key at `path`; undefined when the last segment is an index. */
  keySpanAt(path: readonly JsonPathSegment[]): Span | undefined;
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
 * agentcheckup says so instead of silently reporting less.
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

/** The value a span points at in a parsed JSON document. See `locate`. */
export interface JsonLocation {
  /**
   * Path from the root to the value: property names, and indices for array elements. A span on
   * a property key, or on a whole property, points at the property's value.
   */
  readonly path: readonly JsonPathSegment[];
  readonly type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** True when the value is an element of an array; false for an object member or the root. */
  readonly inArray: boolean;
  /**
   * The value as canonical JSON text: no whitespace, object keys sorted by code unit, the last of
   * duplicate keys, numbers as `JSON.stringify` writes them. An object or array is cut after a
   * few thousand characters; a string, number, boolean or null is never cut. Computed on the
   * first call.
   */
  canonical(): string;
}

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
      /**
       * The innermost value that contains `span`, or undefined when the span is not inside the
       * root value. The same value always gives the same object, so callers can cache by it.
       */
      locate(span: Span): JsonLocation | undefined;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ParseIssue[];
    };

// ---------------------------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------------------------

/** The four TOML date-time types. Values are validated and kept opaque (see `TomlDatetime`). */
export type TomlDatetimeKind = 'offset-datetime' | 'local-datetime' | 'local-date' | 'local-time';

/** The TOML type of a value: tells integers from floats, and date-times from strings. */
export type TomlValueType =
  'table' | 'array' | 'string' | 'integer' | 'float' | 'boolean' | TomlDatetimeKind;

/**
 * The value a span points at in a parsed TOML document. A span on a key, or on a whole
 * key/value pair, points at the value the key names. `type` maps tables to `object`, integers
 * and floats to `number`, and date-times to `string`, so JSON helpers and fingerprints work
 * unchanged. `canonical()` writes integers with all their digits (even past 2^53), infinities
 * and NaN as `inf`, `-inf` and `nan`, and date-times as JSON strings.
 */
export interface TomlLocation extends JsonLocation {
  readonly tomlType: TomlValueType;
}

/**
 * A parsed TOML document, in the same shape as {@link JsonDocument} so the JSON helpers
 * (`own`, `keySpanOf`, `collectStrings`, `hookHandlers`) and the engine fingerprints accept it.
 *
 * - `value` is the root table. Tables are frozen null-prototype objects (`__proto__` and
 *   `constructor` are plain keys), arrays are frozen arrays, integers and floats are numbers
 *   (an integer past 2^53 loses precision here, not in `canonical()`), date-times are
 *   `TomlDatetime` objects with no own properties.
 * - `valueSpan` of a scalar, array or inline table slices back to its source text. A table from
 *   a `[header]` spans the header and its key/value pairs; an array-of-tables element spans its
 *   `[[header]]` and pairs. A table or array of tables created only by a key (`[a.b]` creates
 *   `a`, `a.b = 1` creates `a`, `[[a]]` creates the array `a`) spans that key.
 * - `keySpan` is the key as written (quotes included): the last key of the pair or header that
 *   defined the value, or the key that created it; undefined for the root and array elements.
 * - `locate` maps keys, whole pairs, header bodies and values to the value they stand for.
 * - On failure, `errors` holds exactly one issue: the first problem in the text.
 */
export type TomlDocument =
  | {
      readonly ok: true;
      readonly value: unknown;
      /** Always empty: TOML has no construct that parses but loses information. */
      readonly warnings: readonly ParseIssue[];
      valueSpan(path: readonly JsonPathSegment[]): Span | undefined;
      keySpan(path: readonly JsonPathSegment[]): Span | undefined;
      locate(span: Span): TomlLocation | undefined;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ParseIssue[];
    };
