// The table lives in src/platforms/sources.ts, so the loaders can cite the same entries.

/**
 * Canonical evidence for rules. Every rule cites at least one of these.
 * `checked` is the date a maintainer last verified the behavior against the source.
 * The weekly Source drift workflow fetches every cited URL outside this repository, compares a
 * hash of its content with scripts/drift/baseline.json, and opens an issue when a source changed
 * or cannot be fetched. It never changes `checked`. See docs/maintainers/source-drift.md.
 */
export { SOURCES } from '../platforms/sources.js';
