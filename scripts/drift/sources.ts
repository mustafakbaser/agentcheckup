/**
 * Which URLs the drift check watches, and who uses each one: the rules that cite it, and the
 * context loaders when it is in src/platforms/sources.ts, the table load plans and the security
 * inventory cite by key.
 */
import { compareStrings } from '../../src/core/compare.js';
import { REPOSITORY_URL } from '../../src/core/meta.js';
import type { RuleMeta, RuleSource } from '../../src/core/types.js';

/**
 * The user of a URL in src/platforms/sources.ts: load plans (src/platforms/load) and the
 * inventory (src/inventory) cite those sources by key, so a change there means re-reading them.
 */
export const CONTEXT_LOADERS = 'context loaders';

/**
 * Cited URL -> its users: ids of the rules that cite it, and {@link CONTEXT_LOADERS}. URLs and
 * users are sorted and unique.
 */
export type SourceIndex = ReadonlyMap<string, readonly string[]>;

/**
 * Builds the URL -> users index from rule metadata and the shared source table. Every URL in
 * `table` is watched, whether or not a rule cites it.
 */
export function buildSourceIndex(
  rules: readonly Pick<RuleMeta, 'id' | 'sources'>[],
  table: Readonly<Record<string, Pick<RuleSource, 'url'>>> = {},
): SourceIndex {
  const byUrl = new Map<string, Set<string>>();
  const add = (url: string, user: string): void => {
    const users = byUrl.get(url) ?? new Set<string>();
    users.add(user);
    byUrl.set(url, users);
  };
  for (const rule of rules) {
    for (const source of rule.sources) add(source.url, rule.id);
  }
  for (const source of Object.values(table)) add(source.url, CONTEXT_LOADERS);
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
