/**
 * Read-only helpers over parsed JSON values. Parsed objects have a null prototype, so `__proto__`
 * and `constructor` are ordinary keys and `Object.hasOwn` is the only safe test.
 */
import type { Span } from '../core/types.js';
import type { JsonDocument, JsonPathSegment } from './types.js';

export type JsonObject = Readonly<Record<string, unknown>>;
export type JsonPath = readonly JsonPathSegment[];
export type ParsedJson = Extract<JsonDocument, { ok: true }>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export function spanOf(doc: ParsedJson, path: JsonPath): Span | undefined {
  return (
    doc.valueSpan(path) ??
    (typeof path[path.length - 1] === 'string' ? doc.keySpan(path) : undefined)
  );
}

/** Span of the key at `path` when the last segment is a string, else the value span. */
export function keySpanOf(doc: ParsedJson, path: JsonPath): Span | undefined {
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
