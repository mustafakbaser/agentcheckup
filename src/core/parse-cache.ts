/**
 * Parses shared across scans of related snapshots, such as the in-memory copies that
 * `agentcheckup fix` scans to verify each round of fixes: a file whose text did not change is not
 * decoded or parsed again. Pass one cache as `parseCache` in the options of every scan that
 * should share it (`AnalyzeOptions` in ./engine.ts). Pure: no I/O.
 *
 * Results stay exactly those of a scan without the cache:
 * - Decoding depends only on the bytes, and is cached per byte array: the fix applier keeps the
 *   `SourceFile` of every file it does not change.
 * - Frontmatter and JSON parses depend only on the text (and, for JSON, on the dialect the
 *   reading agent uses), and are cached by text.
 * - A TOML parse depends on the text and on how it was decoded (UTF-16, a byte order mark the
 *   decoder removed, bytes that were not valid UTF-8), and is cached by both.
 * - A Markdown parse depends on the text, on the analysis window and on the parser work it may
 *   cost, which the scan's Markdown budget decides (`markdownWindowEnd` of the characters left,
 *   and the units of the cost budget that are spent). The cache is keyed by all three, so a file
 *   parsed with less budget left than before is parsed again, and the scan spends the same
 *   budget, in the same order, as without the cache.
 *
 * Parsed documents are shared, read-only, between the scans and the artifacts that use them, as
 * they already are between the rules of one scan. The cache keeps every version it sees: use one
 * per group of related scans, not one per process.
 */
import type {
  FrontmatterResult,
  JsonDocument,
  MarkdownDocument,
  TomlDocument,
} from '../parse/types.js';
import type { DecodedText } from './types.js';

/**
 * How a JSON file is read: strict JSON (`JSON.parse`), Gemini CLI's comments stripped before
 * `JSON.parse`, or VS Code's JSONC with comments and trailing commas.
 */
export type JsonDialect = 'strict' | 'comments' | 'jsonc';

export interface ParseCache {
  /** The decoded text of `bytes`, from `compute` the first time. */
  decoded(bytes: Uint8Array, compute: () => DecodedText): DecodedText;
  /** The frontmatter of `text`, from `compute` the first time. */
  frontmatter(text: string, compute: () => FrontmatterResult): FrontmatterResult;
  /**
   * The Markdown document of `text` analyzed up to `windowEnd` characters, from `compute` the
   * first time. `windowEnd` must be the window `compute` analyzes, and `allowance` names the
   * parser work it allows when that is less than a whole file's ('' or absent otherwise).
   */
  markdown(
    text: string,
    windowEnd: number,
    compute: () => MarkdownDocument,
    allowance?: string,
  ): MarkdownDocument;
  /** The JSON document of `text` read in `dialect`, from `compute` the first time. */
  json(text: string, dialect: JsonDialect, compute: () => JsonDocument): JsonDocument;
  /** The TOML document of `decoded`, from `compute` the first time. */
  toml(decoded: DecodedText, compute: () => TomlDocument): TomlDocument;
}

function cached<K, V>(map: Map<K, V>, key: K, compute: () => V): V {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  map.set(key, value);
  return value;
}

/** What a TOML parse reads from the decoding besides the text (`TomlSource`). */
function tomlVariant(decoded: DecodedText): string {
  return `${decoded.encoding}:${decoded.hasBom ? 'bom' : ''}:${decoded.hadDecodeErrors ? 'invalid' : ''}`;
}

/** A new, empty cache. */
export function createParseCache(): ParseCache {
  const decoded = new WeakMap<Uint8Array, DecodedText>();
  const frontmatter = new Map<string, FrontmatterResult>();
  const markdown = new Map<string, Map<string, MarkdownDocument>>();
  const json: Record<JsonDialect, Map<string, JsonDocument>> = {
    strict: new Map(),
    comments: new Map(),
    jsonc: new Map(),
  };
  const toml = new Map<string, Map<string, TomlDocument>>();
  return {
    decoded(bytes, compute) {
      const hit = decoded.get(bytes);
      if (hit !== undefined) return hit;
      const value = compute();
      decoded.set(bytes, value);
      return value;
    },
    frontmatter: (text, compute) => cached(frontmatter, text, compute),
    markdown(text, windowEnd, compute, allowance = '') {
      let windows = markdown.get(text);
      if (windows === undefined) {
        windows = new Map();
        markdown.set(text, windows);
      }
      const doc = cached(windows, `${String(windowEnd)}:${allowance}`, compute);
      if (doc.analysis.analyzedLength !== windowEnd) {
        throw new Error('A cached Markdown parse must be keyed by the window it analyzed.');
      }
      return doc;
    },
    json: (text, dialect, compute) => cached(json[dialect], text, compute),
    toml(source, compute) {
      let variants = toml.get(source.text);
      if (variants === undefined) {
        variants = new Map();
        toml.set(source.text, variants);
      }
      return cached(variants, tomlVariant(source), compute);
    },
  };
}
