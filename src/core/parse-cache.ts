/**
 * Parses shared across scans of related snapshots, such as the in-memory copies that
 * `agentcheckup fix` scans to verify each round of fixes: a file whose text did not change is not
 * decoded or parsed again. Pass one cache as `parseCache` in the options of every scan that
 * should share it (`AnalyzeOptions` in ./engine.ts). Pure: no I/O.
 *
 * Results stay exactly those of a scan without the cache:
 * - Decoding depends only on the bytes, and is cached per byte array: the fix applier keeps the
 *   `SourceFile` of every file it does not change.
 * - Frontmatter and JSON parses depend only on the text (and, for JSON, on whether comments are
 *   allowed), and are cached by text.
 * - A Markdown parse depends on the text and on the analysis window, which the scan's Markdown
 *   budget decides (`markdownWindowEnd` of the characters left). The cache is keyed by both, so
 *   a file parsed with less budget left than before is parsed again, and the scan spends the
 *   same budget, in the same order, as without the cache.
 *
 * Parsed documents are shared, read-only, between the scans and the artifacts that use them, as
 * they already are between the rules of one scan. The cache keeps every version it sees: use one
 * per group of related scans, not one per process.
 */
import type { FrontmatterResult, JsonDocument, MarkdownDocument } from '../parse/types.js';
import type { DecodedText } from './types.js';

export interface ParseCache {
  /** The decoded text of `bytes`, from `compute` the first time. */
  decoded(bytes: Uint8Array, compute: () => DecodedText): DecodedText;
  /** The frontmatter of `text`, from `compute` the first time. */
  frontmatter(text: string, compute: () => FrontmatterResult): FrontmatterResult;
  /**
   * The Markdown document of `text` analyzed up to `windowEnd` characters, from `compute` the
   * first time. `windowEnd` must be the window `compute` analyzes.
   */
  markdown(text: string, windowEnd: number, compute: () => MarkdownDocument): MarkdownDocument;
  /** The JSON document of `text`, read with or without comments, from `compute` the first time. */
  json(text: string, comments: boolean, compute: () => JsonDocument): JsonDocument;
}

function cached<K, V>(map: Map<K, V>, key: K, compute: () => V): V {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  map.set(key, value);
  return value;
}

/** A new, empty cache. */
export function createParseCache(): ParseCache {
  const decoded = new WeakMap<Uint8Array, DecodedText>();
  const frontmatter = new Map<string, FrontmatterResult>();
  const markdown = new Map<string, Map<number, MarkdownDocument>>();
  const strictJson = new Map<string, JsonDocument>();
  const commentedJson = new Map<string, JsonDocument>();
  return {
    decoded(bytes, compute) {
      const hit = decoded.get(bytes);
      if (hit !== undefined) return hit;
      const value = compute();
      decoded.set(bytes, value);
      return value;
    },
    frontmatter: (text, compute) => cached(frontmatter, text, compute),
    markdown(text, windowEnd, compute) {
      let windows = markdown.get(text);
      if (windows === undefined) {
        windows = new Map();
        markdown.set(text, windows);
      }
      const doc = cached(windows, windowEnd, compute);
      if (doc.analysis.analyzedLength !== windowEnd) {
        throw new Error('A cached Markdown parse must be keyed by the window it analyzed.');
      }
      return doc;
    },
    json: (text, comments, compute) => cached(comments ? commentedJson : strictJson, text, compute),
  };
}
