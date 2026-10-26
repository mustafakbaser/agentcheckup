/**
 * Read-only helpers over parsed JSON values. Parsed objects have a null prototype, so `__proto__`
 * and `constructor` are ordinary keys and `Object.hasOwn` is the only safe test.
 */
import type { Span } from '../core/types.js';
import { JSON_ISSUE } from './json.js';
import { TOML_ISSUE, TomlDatetime } from './toml.js';
import type { JsonDocument, JsonPathSegment, ParseIssue } from './types.js';

export type JsonObject = Readonly<Record<string, unknown>>;
export type JsonPath = readonly JsonPathSegment[];
export type ParsedJson = Extract<JsonDocument, { ok: true }>;

/**
 * What the span helpers and the configuration readers use of a parsed document: its value and
 * the spans of its keys and values. A JSON or TOML document is one, and so is frontmatter read as
 * configuration.
 */
export type SpannedDocument = Pick<ParsedJson, 'value' | 'valueSpan' | 'keySpan'>;

/**
 * `limit` and `unsupported` are not syntax errors: the agent may read the file fine, so callers
 * mark it incomplete instead of reporting it. `comment` and `trailing-comma` occur in JSON only.
 */
export type IssueKind = 'comment' | 'trailing-comma' | 'limit' | 'unsupported' | 'other';

/**
 * Limits of agentcheckup's own parsers, not syntax errors: agents' `JSON.parse` and Codex's TOML
 * parser accept such files. An unterminated comment (`unexpected-end-of-comment`) is a real
 * error and stays `other`.
 */
const LIMIT_CODES: ReadonlySet<string> = new Set([
  JSON_ISSUE.tooLarge,
  JSON_ISSUE.tooDeep,
  TOML_ISSUE.tooManyNodes,
  TOML_ISSUE.parseFailed,
]);

/** Input the TOML parser does not read: UTF-16 text. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([TOML_ISSUE.utf16]);

/**
 * What kind of problem a JSON or TOML parse issue is: a comment, a trailing comma, a limit,
 * unsupported input, or other (a syntax error).
 */
export function issueKind(issue: ParseIssue): IssueKind {
  if (issue.code === JSON_ISSUE.comment) return 'comment';
  if (issue.code === JSON_ISSUE.trailingComma) return 'trailing-comma';
  if (LIMIT_CODES.has(issue.code)) return 'limit';
  if (UNSUPPORTED_CODES.has(issue.code)) return 'unsupported';
  return 'other';
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for a JSON object or a TOML table. Unlike {@link isObject}, false for a TOML date-time,
 * which is an object without own properties where Codex expects a table.
 */
export function isTable(value: unknown): value is JsonObject {
  return isObject(value) && !(value instanceof TomlDatetime);
}

/** Own property `key` of `object`, or undefined. Never reads the prototype chain. */
export function own(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export function ownObject(object: JsonObject, key: string): JsonObject | undefined {
  const value = own(object, key);
  return isObject(value) ? value : undefined;
}

/** Most specific span for a value: the value itself, else its key, else undefined (whole file). */
export function spanOf(doc: SpannedDocument, path: JsonPath): Span | undefined {
  return (
    doc.valueSpan(path) ??
    (typeof path[path.length - 1] === 'string' ? doc.keySpan(path) : undefined)
  );
}

/** Span of the key at `path` when the last segment is a string, else the value span. */
export function keySpanOf(doc: SpannedDocument, path: JsonPath): Span | undefined {
  const last = path[path.length - 1];
  return (typeof last === 'string' ? doc.keySpan(path) : undefined) ?? doc.valueSpan(path);
}

export interface StringValue {
  readonly path: JsonPath;
  readonly value: string;
}

/** Bounds for {@link collectStrings}: hostile files cannot make a caller walk forever. */
export const MAX_STRINGS = 20_000;
export const MAX_DEPTH = 64;

/** Every string value under `root` (not keys), depth-first in document order, bounded. */
export function collectStrings(root: unknown, base: JsonPath = []): StringValue[] {
  const out: StringValue[] = [];
  const stack: { value: unknown; path: JsonPath }[] = [{ value: root, path: base }];
  while (stack.length > 0 && out.length < MAX_STRINGS) {
    const item = stack.pop();
    if (item === undefined) break;
    const { value, path } = item;
    if (typeof value === 'string') {
      out.push({ path, value });
      continue;
    }
    if (path.length - base.length >= MAX_DEPTH) continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--)
        stack.push({ value: value[i] as unknown, path: [...path, i] });
    } else if (isObject(value)) {
      const keys = Object.keys(value);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] ?? '';
        stack.push({ value: value[key], path: [...path, key] });
      }
    }
  }
  return out;
}
