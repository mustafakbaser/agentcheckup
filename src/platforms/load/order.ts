/**
 * The order of a plan's lists (docs/adr/0007, design section 1), shared by the plan assembly and
 * the steps that add to a loader's plan. Pure.
 */
import { compareStrings } from '../../core/compare.js';
import { type LoadEntry, type OutOfScope, type SkippedLoad, TRIGGER_RANK } from './types.js';

/** Startup position, then trigger, then path, then id. */
export function compareEntries(a: LoadEntry, b: LoadEntry): number {
  return (
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
    TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
    compareStrings(a.path, b.path) ||
    compareStrings(a.id, b.id)
  );
}

export function compareSkips(a: SkippedLoad, b: SkippedLoad): number {
  return compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
}

export function compareOutOfScope(a: OutOfScope, b: OutOfScope): number {
  return compareStrings(a.path, b.path) || compareStrings(a.because, b.because);
}
