/**
 * The committed baseline (scripts/drift/baseline.json) and the comparison against it.
 *
 * The baseline maps each cited URL to the SHA-256 of its normalized content. Keys are sorted and
 * there are no timestamps, so the file only changes when a source's content changes.
 */
import { compareStrings } from '../../src/core/compare.js';
import type { Outcome } from './fetch.js';
import type { SourceIndex } from './sources.js';

export type Baseline = ReadonlyMap<string, string>;

const HASH = /^[\da-f]{64}$/;

/** Parses baseline.json. Throws with every problem listed. */
export function parseBaseline(text: string): Baseline {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('the baseline must be a JSON object');
  }
  const problems: string[] = [];
  const baseline = new Map<string, string>();
  for (const [url, hash] of Object.entries(raw)) {
    if (!URL.canParse(url) || !url.startsWith('https://'))
      problems.push(`not an https URL: ${url}`);
    if (typeof hash !== 'string' || !HASH.test(hash)) {
      problems.push(`not a SHA-256 hex digest for ${url}`);
      continue;
    }
    baseline.set(url, hash);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return baseline;
}

export function serializeBaseline(baseline: Baseline): string {
  const sorted = [...baseline].sort(([a], [b]) => compareStrings(a, b));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

export interface ChangedSource {
  readonly url: string;
  readonly rules: readonly string[];
  /** Hash in the baseline, or null when the URL is not in the baseline yet. */
  readonly previous: string | null;
  readonly current: string;
}

/**
 * A source whose request ended at another URL after redirects: the page moved, or its host
 * sends it elsewhere. Reported as moved whatever its content, because the cited URL needs an
 * update either way; the hashes say whether the content changed too.
 */
export interface MovedSource {
  readonly url: string;
  readonly rules: readonly string[];
  /** The URL the request ended at. From the network: sanitize before printing. */
  readonly location: string;
  /** Hash in the baseline, or null when the URL is not in the baseline yet. */
  readonly previous: string | null;
  readonly current: string;
}

export interface UnreachableSource {
  readonly url: string;
  readonly rules: readonly string[];
  readonly reason: string;
}

export interface CitedSource {
  readonly url: string;
  readonly rules: readonly string[];
}

export const REPORT_VERSION = 2;

export interface DriftReport {
  readonly version: typeof REPORT_VERSION;
  /** URLs fetched. */
  readonly checked: number;
  readonly changed: readonly ChangedSource[];
  readonly moved: readonly MovedSource[];
  readonly unreachable: readonly UnreachableSource[];
  readonly unchanged: number;
  /** In the baseline but no longer cited by any rule or loader. `--update` removes them. */
  readonly uncited: readonly string[];
  /** Cited URLs into this repository, which are not fetched. */
  readonly skipped: readonly CitedSource[];
}

export interface CompareInput {
  /** The URLs that were fetched, with the rules citing them. */
  readonly watched: SourceIndex;
  /** Cited URLs that were not fetched because they point into this repository. */
  readonly own: SourceIndex;
  readonly outcomes: ReadonlyMap<string, Outcome>;
  readonly baseline: Baseline;
  /**
   * Whether `watched` is every cited URL. A partial check (`--only`) cannot tell which
   * baseline entries are no longer cited.
   */
  readonly complete: boolean;
}

export function compareWithBaseline(input: CompareInput): DriftReport {
  const changed: ChangedSource[] = [];
  const moved: MovedSource[] = [];
  const unreachable: UnreachableSource[] = [];
  let unchanged = 0;
  for (const [url, rules] of input.watched) {
    const outcome = input.outcomes.get(url) ?? { ok: false, reason: 'not fetched' };
    if (!outcome.ok) {
      unreachable.push({ url, rules, reason: outcome.reason });
      continue;
    }
    const previous = input.baseline.get(url);
    if (outcome.location !== undefined) {
      const { location, hash: current } = outcome;
      moved.push({ url, rules, location, previous: previous ?? null, current });
    } else if (previous === outcome.hash) {
      unchanged++;
    } else {
      changed.push({ url, rules, previous: previous ?? null, current: outcome.hash });
    }
  }
  const uncited = input.complete
    ? [...input.baseline.keys()].filter((url) => !input.watched.has(url)).sort(compareStrings)
    : [];
  return {
    version: REPORT_VERSION,
    checked: input.watched.size,
    changed,
    moved,
    unreachable,
    unchanged,
    uncited,
    skipped: [...input.own].map(([url, rules]) => ({ url, rules })),
  };
}

/** Whether the report needs a maintainer: exit code 1. */
export function needsAttention(report: DriftReport): boolean {
  return report.changed.length > 0 || report.moved.length > 0 || report.unreachable.length > 0;
}

export interface UpdateResult {
  readonly baseline: Baseline;
  /** Unreachable URLs whose previous hash was kept. */
  readonly kept: readonly string[];
  /** Unreachable URLs that have no hash at all. */
  readonly missing: readonly string[];
  /** URLs whose hash was added or replaced. */
  readonly updated: readonly string[];
  /** Entries removed because no rule cites them any more. */
  readonly removed: readonly string[];
}

/**
 * The baseline after `--update`. Reachable URLs get their current hash. Unreachable ones keep
 * their previous hash, so a temporary outage never drops a source. With `complete`, entries no
 * rule cites any more are removed; a partial update leaves every other entry alone.
 */
export function updateBaseline(input: CompareInput): UpdateResult {
  const next = new Map(input.baseline);
  const kept: string[] = [];
  const missing: string[] = [];
  const updated: string[] = [];
  for (const url of input.watched.keys()) {
    const outcome = input.outcomes.get(url);
    if (outcome?.ok === true) {
      if (next.get(url) !== outcome.hash) updated.push(url);
      next.set(url, outcome.hash);
    } else if (next.has(url)) {
      kept.push(url);
    } else {
      missing.push(url);
    }
  }
  const removed = input.complete ? [...next.keys()].filter((url) => !input.watched.has(url)) : [];
  for (const url of removed) next.delete(url);
  return { baseline: next, kept, missing, updated, removed: removed.sort(compareStrings) };
}
