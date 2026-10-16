/**
 * Strict JSON, parsed the way agents read their config files (`.mcp.json`, settings, hooks).
 *
 * Agents use `JSON.parse`, so comments and trailing commas are errors here. Gemini CLI reads its
 * settings.json as `JSON.parse(stripJsonComments(content))` (strip-json-comments 3.1.1,
 * https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts,
 * verified 2026-10-14): `parseJsonWithComments` models that exactly. Rules can also tell the
 * cases apart through `JSON_ISSUE.comment` and `JSON_ISSUE.trailingComma`.
 *
 * Security:
 * - Values are built here into null-prototype objects. jsonc-parser's `getNodeValue` assigns
 *   `obj[key] = …`, which for a `__proto__` key replaces the object's prototype.
 * - jsonc-parser's tree builder is recursive (it overflows the stack near 5,000 levels), so
 *   nesting is measured first with its linear scanner, and the parse is wrapped as a backstop.
 * - Error lists are bounded: hostile input can yield one error per character.
 */
import {
  createScanner,
  type Node as JsonNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import { compareStrings } from '../core/compare.js';
import type { Span } from '../core/types.js';
import { cleanMessage, spanBetween } from './spans.js';
import type { JsonDocument, JsonLocation, JsonPathSegment, ParseIssue } from './types.js';
import { formatInteger } from '../core/format.js';

/** Texts longer than this (UTF-16 code units) are not parsed. */
export const MAX_JSON_LENGTH = 2 * 1024 * 1024;
/** Deeper nesting is rejected (JSON.parse accepts it; no agent config needs it). */
export const MAX_JSON_DEPTH = 512;
const MAX_ISSUES = 100;

/** Issue codes that rules may rely on. Other codes are jsonc-parser's, in kebab case. */
export const JSON_ISSUE = {
  /** A complete `//` or `/* *\/` comment. Gemini CLI strips these; JSON.parse rejects them. */
  comment: 'invalid-comment-token',
  /** A comma before `}` or `]`. Fatal for JSON.parse and for Gemini CLI. */
  trailingComma: 'trailing-comma',
  tooLarge: 'too-large',
  tooDeep: 'too-deep',
} as const;

// jsonc-parser's `SyntaxKind` is an ambient const enum, unusable with isolatedModules.
const OPEN_BRACE = 1;
const CLOSE_BRACE = 2;
const OPEN_BRACKET = 3;
const CLOSE_BRACKET = 4;
const COMMA = 5;
const EOF = 17;

const PARSE_OPTIONS = {
  disallowComments: true,
  allowTrailingComma: false,
  allowEmptyContent: false,
};

const MESSAGES: Readonly<Record<string, string>> = {
  'invalid-symbol': 'Invalid symbol.',
  'invalid-number-format': 'Invalid number format.',
  'property-name-expected': 'Expected a property name in double quotes.',
  'value-expected': 'Expected a value.',
  'colon-expected': 'Expected a colon.',
  'comma-expected': 'Expected a comma.',
  'close-brace-expected': 'Expected a closing brace.',
  'close-bracket-expected': 'Expected a closing bracket.',
  'end-of-file-expected': 'Expected the end of the file after the JSON value.',
  'invalid-comment-token': 'Comments are not allowed in JSON.',
  'unexpected-end-of-comment': 'Unterminated comment.',
  'unexpected-end-of-string': 'Unterminated string.',
  'unexpected-end-of-number': 'Unterminated number.',
  'invalid-unicode': 'Invalid unicode escape sequence.',
  'invalid-escape-character': 'Invalid escape character in string.',
  'invalid-character': 'Invalid character in string; control characters must be escaped.',
  'trailing-comma': 'Trailing commas are not allowed in JSON.',
};

function failure(issues: readonly ParseIssue[]): JsonDocument {
  return { ok: false, errors: issues.slice(0, MAX_ISSUES) };
}

/** `InvalidCommentToken` -> `invalid-comment-token`. */
function kebab(name: string): string {
  if (!/^[A-Z][A-Za-z]*$/.test(name)) return 'syntax-error';
  return name.replace(
    /[A-Z]/g,
    (char, index: number) => (index === 0 ? '' : '-') + char.toLowerCase(),
  );
}

/**
 * Offset of the first `{`/`[` nested deeper than `MAX_JSON_DEPTH`, or -1. Uses jsonc-parser's
 * scanner, so strings and comments are skipped exactly as the parser skips them. Linear.
 */
function tooDeepAt(text: string): number {
  const scanner = createScanner(text, true);
  let depth = 0;
  for (let kind: number = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
    if (kind === OPEN_BRACE || kind === OPEN_BRACKET) {
      depth++;
      if (depth > MAX_JSON_DEPTH) return scanner.getTokenOffset();
    } else if ((kind === CLOSE_BRACE || kind === CLOSE_BRACKET) && depth > 0) {
      depth--;
    }
  }
  return -1;
}

/** Closing `}`/`]` offsets preceded by a comma (comments and whitespace skipped) -> comma offset. */
function trailingCommas(text: string): Map<number, number> {
  const scanner = createScanner(text, true);
  const commas = new Map<number, number>();
  let previousKind = 0;
  let previousOffset = 0;
  for (let kind: number = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
    const offset = scanner.getTokenOffset();
    if ((kind === CLOSE_BRACE || kind === CLOSE_BRACKET) && previousKind === COMMA) {
      commas.set(offset, previousOffset);
    }
    previousKind = kind;
    previousOffset = offset;
  }
  return commas;
}

/**
 * Maps jsonc-parser errors to issues, sorted by offset. jsonc-parser reports a trailing comma as
 * `property-name-expected` and/or `value-expected` at the closing bracket; those become one
 * `trailing-comma` issue on the comma itself.
 */
function issuesFor(text: string, errors: readonly ParseError[]): ParseIssue[] {
  const commas = trailingCommas(text);
  const issues: ParseIssue[] = [];
  const reportedCommas = new Set<number>();
  for (const error of errors) {
    let code = kebab(printParseErrorCode(error.error));
    let span = spanBetween(error.offset, error.offset + error.length, text.length);
    const comma = commas.get(error.offset);
    if (comma !== undefined && (code === 'property-name-expected' || code === 'value-expected')) {
      if (reportedCommas.has(comma)) continue;
      reportedCommas.add(comma);
      code = JSON_ISSUE.trailingComma;
      span = { offset: comma, length: 1 };
    }
    issues.push({ code, message: MESSAGES[code] ?? 'Invalid JSON.', span });
    if (issues.length >= MAX_ISSUES) break;
  }
  // A trailing comma is reported at its closing bracket, possibly after a comment in between.
  return issues.sort((a, b) => a.span.offset - b.span.offset);
}

const nodeSpan = (node: JsonNode): Span => ({ offset: node.offset, length: node.length });

/** `duplicate-key` warning on the earlier key that a later one overrides. */
function duplicateKey(name: string, overridden: JsonNode): ParseIssue {
  const shown = name.length > 60 ? `${name.slice(0, 60)}…` : name;
  return {
    code: 'duplicate-key',
    message: cleanMessage(
      `Duplicate key "${shown}": JSON.parse keeps the last value, so this one is ignored.`,
    ),
    span: nodeSpan(overridden),
  };
}

/**
 * Builds the JavaScript value JSON.parse would return, with null-prototype objects, and records
 * a `duplicate-key` warning for every key that a later duplicate overrides (at most
 * `MAX_ISSUES`).
 */
function toValue(node: JsonNode, warnings: ParseIssue[]): unknown {
  if (node.type === 'object') {
    const object = Object.create(null) as Record<string, unknown>;
    const seen = new Map<string, JsonNode>();
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (key === undefined || value === undefined) continue;
      const name = String(key.value);
      const earlier = seen.get(name);
      if (earlier !== undefined && warnings.length < MAX_ISSUES) {
        warnings.push(duplicateKey(name, earlier));
      }
      seen.set(name, key);
      // The last duplicate wins, as with JSON.parse. On a null-prototype object, assigning
      // `__proto__` creates an own property.
      object[name] = toValue(value, warnings);
    }
    return Object.freeze(object);
  }
  if (node.type === 'array') {
    return Object.freeze((node.children ?? []).map((child) => toValue(child, warnings)));
  }
  if (node.type === 'null') return null;
  return node.value as unknown;
}

/** Path lookups. Object properties are indexed lazily; with duplicates the last one wins. */
class Locator {
  readonly #root: JsonNode;
  readonly #index = new WeakMap<JsonNode, Map<string, JsonNode>>();

  constructor(root: JsonNode) {
    this.#root = root;
  }

  #properties(object: JsonNode): Map<string, JsonNode> {
    let properties = this.#index.get(object);
    if (properties === undefined) {
      properties = new Map();
      for (const property of object.children ?? []) {
        const key = property.children?.[0];
        if (key !== undefined) properties.set(String(key.value), property);
      }
      this.#index.set(object, properties);
    }
    return properties;
  }

  /** The property node for `segment` in `node`, or the array element. */
  #child(node: JsonNode, segment: JsonPathSegment): JsonNode | undefined {
    if (typeof segment === 'string') {
      return node.type === 'object' ? this.#properties(node).get(segment) : undefined;
    }
    if (node.type !== 'array' || !Number.isInteger(segment) || segment < 0) return undefined;
    return node.children?.[segment];
  }

  /** The value node at `path`, and the property node holding it (for object members). */
  find(path: readonly JsonPathSegment[]): { value: JsonNode; property?: JsonNode } | undefined {
    let value: JsonNode | undefined = this.#root;
    let property: JsonNode | undefined;
    for (const segment of path) {
      if (value === undefined) return undefined;
      const child = this.#child(value, segment);
      if (child === undefined) return undefined;
      property = child.type === 'property' ? child : undefined;
      value = property ? property.children?.[1] : child;
    }
    if (value === undefined) return undefined;
    return property ? { value, property } : { value };
  }
}

/** An object or array's canonical text is cut after this many characters. */
export const MAX_CANONICAL_LENGTH = 4096;

/** Index of the last node in `nodes` (sorted by offset) that starts at or before `offset`. */
function lastStartingAtOrBefore(nodes: readonly JsonNode[], offset: number): number {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((nodes[mid]?.offset ?? 0) <= offset) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

/** The innermost node containing `[start, end]`, or undefined outside `root`. Logarithmic per level. */
function innermostNode(root: JsonNode, start: number, end: number): JsonNode | undefined {
  if (start < root.offset || end > root.offset + root.length) return undefined;
  let node = root;
  for (;;) {
    const children = node.children ?? [];
    const child = children[lastStartingAtOrBefore(children, start)];
    if (child === undefined || end > child.offset + child.length) return node;
    node = child;
  }
}

/** Path segments from the root to `node`. Iterative: nesting is at most MAX_JSON_DEPTH. */
function pathOf(node: JsonNode): JsonPathSegment[] {
  const segments: JsonPathSegment[] = [];
  let current = node;
  for (let parent = current.parent; parent !== undefined; parent = current.parent) {
    if (parent.type === 'property') {
      segments.push(String(parent.children?.[0]?.value));
    } else if (parent.type === 'array') {
      segments.push(lastStartingAtOrBefore(parent.children ?? [], current.offset));
    }
    current = parent;
  }
  return segments.reverse();
}

/**
 * Canonical JSON text of a node, as {@link JsonLocation.canonical} describes. Containers stop
 * growing once the text reaches {@link MAX_CANONICAL_LENGTH}, so the work per call is bounded
 * by that length plus the object keys sorted on the way.
 */
function canonicalText(node: JsonNode): string {
  if (node.type !== 'object' && node.type !== 'array') {
    return node.type === 'null' ? 'null' : JSON.stringify(node.value);
  }
  const parts: string[] = [];
  let length = 0;
  const push = (part: string): boolean => {
    parts.push(part);
    length += part.length;
    return length < MAX_CANONICAL_LENGTH;
  };
  const visit = (current: JsonNode): boolean => {
    if (current.type === 'object') {
      // The last duplicate wins, as with JSON.parse.
      const members = new Map<string, JsonNode>();
      for (const property of current.children ?? []) {
        const [key, value] = property.children ?? [];
        if (key !== undefined && value !== undefined) members.set(String(key.value), value);
      }
      if (!push('{')) return false;
      let first = true;
      for (const name of [...members.keys()].sort(compareStrings)) {
        const value = members.get(name);
        if (value === undefined) continue;
        if (!push(`${first ? '' : ','}${JSON.stringify(name)}:`) || !visit(value)) return false;
        first = false;
      }
      return push('}');
    }
    if (current.type === 'array') {
      if (!push('[')) return false;
      let first = true;
      for (const element of current.children ?? []) {
        if ((!first && !push(',')) || !visit(element)) return false;
        first = false;
      }
      return push(']');
    }
    return push(current.type === 'null' ? 'null' : JSON.stringify(current.value));
  };
  visit(node);
  const text = parts.join('');
  return text.length > MAX_CANONICAL_LENGTH ? text.slice(0, MAX_CANONICAL_LENGTH) : text;
}

/** `locate` of a parsed document: one cached {@link JsonLocation} per value node. */
function locator(root: JsonNode): (span: Span) => JsonLocation | undefined {
  const cache = new WeakMap<JsonNode, JsonLocation>();
  return (span) => {
    let node = innermostNode(root, span.offset, span.offset + span.length);
    // A key, or a whole property, stands for the property's value.
    if (node?.type === 'property') node = node.children?.[1];
    else if (node?.parent?.type === 'property' && node.parent.children?.[0] === node) {
      node = node.parent.children[1];
    }
    if (node === undefined || node.type === 'property') return undefined;
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
    const target = node;
    let canonical: string | undefined;
    const location: JsonLocation = {
      path: pathOf(target),
      type: target.type as JsonLocation['type'],
      inArray: target.parent?.type === 'array',
      canonical: () => (canonical ??= canonicalText(target)),
    };
    cache.set(target, location);
    return location;
  };
}

/** Parses strict JSON. Never throws on any input. */
export function parseJson(text: string): JsonDocument {
  if (text.length > MAX_JSON_LENGTH) {
    return failure([
      {
        code: JSON_ISSUE.tooLarge,
        message: `JSON text is ${formatInteger(text.length)} characters; the limit is ${formatInteger(MAX_JSON_LENGTH)}.`,
        span: { offset: 0, length: 0 },
      },
    ]);
  }
  try {
    const deep = tooDeepAt(text);
    if (deep !== -1) {
      return failure([
        {
          code: JSON_ISSUE.tooDeep,
          message: `Nesting is deeper than ${MAX_JSON_DEPTH} levels.`,
          span: { offset: deep, length: 1 },
        },
      ]);
    }
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, PARSE_OPTIONS);
    if (errors.length > 0 || root === undefined) {
      const issues = issuesFor(text, errors);
      return failure(
        issues.length > 0
          ? issues
          : [
              {
                code: 'value-expected',
                message: 'Expected a value.',
                span: { offset: 0, length: 0 },
              },
            ],
      );
    }
    const warnings: ParseIssue[] = [];
    const value = toValue(root, warnings);
    const paths = new Locator(root);
    return {
      ok: true,
      value,
      warnings: warnings.sort((a, b) => a.span.offset - b.span.offset),
      valueSpan: (path) => {
        const found = paths.find(path);
        return found ? nodeSpan(found.value) : undefined;
      },
      keySpan: (path) => {
        const key = paths.find(path)?.property?.children?.[0];
        return key ? nodeSpan(key) : undefined;
      },
      locate: locator(root),
    };
  } catch (error) {
    // Backstop: a stack overflow or library failure must not crash the scan.
    const message = error instanceof Error ? error.name : 'Error';
    return failure([
      {
        code: 'parse-failed',
        message: `JSON parser failed (${message}).`,
        span: { offset: 0, length: 0 },
      },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------
// Gemini CLI: comments stripped, then JSON.parse
// ---------------------------------------------------------------------------------------------

/** strip-json-comments' `isEscaped`: an odd number of backslashes before the quote. */
function isEscaped(text: string, quote: number): boolean {
  let index = quote - 1;
  while (index >= 0 && text.charCodeAt(index) === 0x5c) index--;
  return (quote - 1 - index) % 2 === 1;
}

/**
 * Replaces comments the way strip-json-comments 3.1.1 does with its default `whitespace: true`:
 * every non-whitespace character of a comment becomes a space, so offsets do not move. Quirks
 * kept on purpose: a `//` comment ends at LF or CRLF but not at a lone CR, an unterminated
 * `/*` comment runs to the end, and whitespace inside comments (including U+00A0, which
 * JSON.parse then rejects) is left in place. Linear: each backslash run is counted once.
 */
export function stripJsonComments(text: string): string {
  const ranges: [number, number][] = [];
  let insideString = false;
  let comment: 'line' | 'block' | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (comment === undefined && char === 0x22 && !isEscaped(text, i)) insideString = !insideString;
    if (insideString) continue;
    if (comment === undefined && char === 0x2f && next === 0x2f) {
      comment = 'line';
      start = i;
      i++;
    } else if (comment === 'line' && char === 0x0d && next === 0x0a) {
      i++;
      ranges.push([start, i]);
      comment = undefined;
    } else if (comment === 'line' && char === 0x0a) {
      ranges.push([start, i]);
      comment = undefined;
    } else if (comment === undefined && char === 0x2f && next === 0x2a) {
      comment = 'block';
      start = i;
      i++;
    } else if (comment === 'block' && char === 0x2a && next === 0x2f) {
      i++;
      ranges.push([start, i + 1]);
      comment = undefined;
    }
  }
  if (comment !== undefined) ranges.push([start, text.length]);
  if (ranges.length === 0) return text;
  let out = '';
  let offset = 0;
  for (const [from, to] of ranges) {
    out += text.slice(offset, from) + text.slice(from, to).replace(/\S/g, ' ');
    offset = to;
  }
  return out + text.slice(offset);
}

/**
 * Parses JSON the way Gemini CLI reads settings.json: comments are stripped as described in
 * `stripJsonComments`, then the text must be strict JSON (trailing commas stay fatal). Spans
 * refer to the original text.
 */
export function parseJsonWithComments(text: string): JsonDocument {
  return parseJson(stripJsonComments(text));
}
