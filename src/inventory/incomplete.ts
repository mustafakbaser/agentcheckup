/**
 * The entries of `Inventory.incomplete`: what the inventory could not analyze, so items may be
 * missing. Pure. The gate (src/core/baseline.ts) and a policy (src/policy/evaluate.ts) read
 * entries here, so the tags have one meaning everywhere.
 *
 * An entry is `<tag>:<path>`, or a plain path:
 * - a plain path: a configuration file agentcheckup read but could not analyze: past a parser
 *   limit, in a format it does not model, or naming files it does not read;
 * - `invalid-json:<path>`, `invalid-toml:<path>`: a file that does not parse;
 * - `unread:<path>`: an agent configuration file the walk found but did not read (too large,
 *   past the byte budget, binary, unreadable, not a regular file);
 * - `excluded:<path>`: an agent configuration file the walk left out on purpose: matched by a
 *   `.gitignore` in a scan that honors it, or in build output or vendored code a trusted scan
 *   does not list (Snapshot.unscannedConfig);
 * - `unlisted:<dir>/`: a directory the walk could not list (too deep, unreadable), so anything
 *   below it is unknown;
 * - `file-limit:<path>`: the walk stopped at its entry limit before `<path>`, so every directory
 *   it had not listed yet is unknown. There is at most one.
 */

/** Tags, in the order entries sort. */
export const INCOMPLETE_TAGS = [
  'excluded',
  'file-limit',
  'invalid-json',
  'invalid-toml',
  'unlisted',
  'unread',
] as const;

export type IncompleteTag = (typeof INCOMPLETE_TAGS)[number];

/** An entry split into its tag, if any, and its path. */
export interface IncompleteEntry {
  readonly tag?: IncompleteTag;
  readonly path: string;
}

export function incompleteEntry(tag: IncompleteTag, path: string): string {
  return `${tag}:${path}`;
}

/** Reads an entry. A path that happens to start with something else and a colon is a path. */
export function parseIncomplete(entry: string): IncompleteEntry {
  const colon = entry.indexOf(':');
  if (colon > 0) {
    const tag = entry.slice(0, colon);
    if ((INCOMPLETE_TAGS as readonly string[]).includes(tag)) {
      return { tag: tag as IncompleteTag, path: entry.slice(colon + 1) };
    }
  }
  return { path: entry };
}

/**
 * Whether an entry is about a part of the tree rather than one file: anything may be there,
 * so the gate fails closed on it for every class.
 */
export function coversTree(entry: IncompleteEntry): boolean {
  return entry.tag === 'file-limit' || entry.tag === 'unlisted';
}

/**
 * Whether an entry is about a file the scan never read, so nothing in it was checked, not even
 * its text for hidden Unicode.
 */
export function isUnreadFile(entry: IncompleteEntry): boolean {
  return entry.tag === 'unread' || entry.tag === 'excluded';
}
