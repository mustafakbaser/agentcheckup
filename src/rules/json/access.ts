/**
 * Read-only helpers over values from `context.json()`. Parsed objects have a null prototype, so
 * `__proto__` and `constructor` are ordinary keys and `Object.hasOwn` is the only safe test.
 */
import type { Artifact, ReportDescriptor, Span } from '../../core/types.js';
import { dirnamePosix } from '../../core/paths.js';
import type { JsonDocument, JsonPathSegment } from '../../parse/types.js';
import { formatInteger, quote } from '../shared/format.js';

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

const IDENTIFIER = /^[a-z_$][\w$-]*$/i;

/** `['mcpServers', 'my server', 'args', 0]` -> `mcpServers["my server"].args[0]`. */
export function pathLabel(path: JsonPath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else if (IDENTIFIER.test(segment) && segment.length <= 60)
      out += out === '' ? segment : `.${segment}`;
    else out += `[${quote(segment)}]`;
  }
  return out;
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

/**
 * The directory that owns a configuration directory: `a/.claude/settings.json` -> `a`,
 * `.cursor/hooks.json` -> `` (the scan root).
 */
export function projectRootOf(artifact: Artifact): string {
  return dirnamePosix(dirnamePosix(artifact.path));
}

export interface StringValue {
  readonly path: JsonPath;
  readonly value: string;
}

/** Bounds for {@link collectStrings}: hostile files cannot make a rule walk forever. */
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

/** `{ span }` when known, `{}` otherwise (the finding then points at the whole file). */
export function at(span: Span | undefined): { readonly span?: Span } {
  return span === undefined ? {} : { span };
}

/** Findings one rule reports per file before the rest are summarized in one finding. */
export const MAX_FINDINGS_PER_FILE = 100;

/**
 * Reports at most {@link MAX_FINDINGS_PER_FILE} findings for one file, then one summary finding
 * at the first omitted location. A hostile file can hold thousands of entries; past this count
 * more findings add nothing for the reader and cost report time. Call `finish()` after the file.
 */
export class FileFindings {
  readonly #report: (descriptor: ReportDescriptor) => void;
  readonly #what: string;
  #count = 0;
  #omitted = 0;
  #first: ReportDescriptor | undefined;

  /** `what` names the omitted findings in the plural, e.g. "hooks with a missing script". */
  constructor(report: (descriptor: ReportDescriptor) => void, what: string) {
    this.#report = report;
    this.#what = what;
  }

  report(descriptor: ReportDescriptor): void {
    if (this.#count < MAX_FINDINGS_PER_FILE) {
      this.#count++;
      this.#report(descriptor);
      return;
    }
    this.#omitted++;
    this.#first ??= descriptor;
  }

  finish(): void {
    const first = this.#first;
    if (first === undefined) return;
    this.#report({
      ...first,
      message: `Only the first ${formatInteger(MAX_FINDINGS_PER_FILE)} ${this.#what} in this file are listed; ${formatInteger(this.#omitted)} more from here on ${this.#omitted === 1 ? 'is' : 'are'} not.`,
    });
  }
}
