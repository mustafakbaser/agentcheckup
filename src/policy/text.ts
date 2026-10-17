/**
 * Small text helpers for policy messages.
 */
import { boundedDistance } from '../core/text.js';

/** Names longer than this are never compared, so a hostile name costs no quadratic time. */
const MAX_COMPARED = 64;

/**
 * The candidate closest to `name`, ignoring case, when it is at most `maxDistance` edits away;
 * the first one on a tie.
 */
export function nearest(
  name: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  if (name.length > MAX_COMPARED) return undefined;
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const d = boundedDistance(lower, candidate.toLowerCase(), maxDistance);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}
