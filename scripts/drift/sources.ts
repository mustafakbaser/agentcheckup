/**
 * Which URLs the drift check watches, and which rules cite each one.
 */
import { compareStrings } from '../../src/core/compare.js';
import { REPOSITORY_URL } from '../../src/core/meta.js';
import type { RuleMeta } from '../../src/core/types.js';

/** Cited URL -> ids of the rules that cite it. URLs and ids are sorted and unique. */
export type SourceIndex = ReadonlyMap<string, readonly string[]>;

/** Builds the URL -> rule ids index from rule metadata. */
export function buildSourceIndex(rules: readonly Pick<RuleMeta, 'id' | 'sources'>[]): SourceIndex {
  const byUrl = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const source of rule.sources) {
      const ids = byUrl.get(source.url) ?? new Set<string>();
      ids.add(rule.id);
      byUrl.set(source.url, ids);
    }
  }
  return new Map(
    [...byUrl]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([url, ids]) => [url, [...ids].sort(compareStrings)]),
  );
}

/**
 * Whether a URL points into this repository. Those files change through reviewed pull requests
 * in this repository, so they are not external evidence that can drift.
 */
export function isOwnRepositoryUrl(url: string): boolean {
  if (url === REPOSITORY_URL) return true;
  const next = url.charAt(REPOSITORY_URL.length);
  return url.startsWith(REPOSITORY_URL) && (next === '/' || next === '#' || next === '?');
}

export interface SplitIndex {
  /** URLs the drift check fetches. */
  readonly watched: SourceIndex;
  /** URLs into this repository, not fetched. */
  readonly own: SourceIndex;
}

export function splitOwnSources(index: SourceIndex): SplitIndex {
  const watched = new Map<string, readonly string[]>();
  const own = new Map<string, readonly string[]>();
  for (const [url, rules] of index) (isOwnRepositoryUrl(url) ? own : watched).set(url, rules);
  return { watched, own };
}
