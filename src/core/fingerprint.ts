/**
 * Finding fingerprints: `<hash>:<occurrence>`, the identity `--baseline` matches findings by.
 * A fingerprint must survive edits that do not change the finding: lines inserted above,
 * re-indentation, a trailing comma added when a sibling is appended, sibling keys reordered.
 *
 * The hash covers the rule id, the file path and an anchor:
 * - In a JSON file that parses, the value the finding points at: its path from the root with
 *   array indices left out (`mcpServers.docs`, `permissions.allow[]`) and its value in
 *   canonical form ({@link jsonAnchor}). Formatting never reaches the anchor.
 * - In any other file, or a JSON file that does not parse, the text of the finding's first line,
 *   normalized ({@link normalizeExcerpt}).
 * - For a finding on the whole file, a fixed anchor, so it does not depend on the first line.
 *
 * Findings with the same rule, path and anchor are numbered in report order (`:1`, `:2`), so a
 * baseline comparison counts them as a multiset.
 *
 * Changing this scheme changes fingerprints: bump FINGERPRINT_VERSION in ./meta.ts, so a baseline
 * written with the old scheme is rejected instead of reporting every finding as new.
 */
import type { JsonLocation } from '../parse/types.js';

/**
 * 53-bit string hash (cyrb53, public domain). Deterministic across platforms and runtimes,
 * and needs no `node:crypto`, so the core stays I/O-free. Not for security purposes.
 */
export function hash53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

/**
 * Formatting-insensitive form of a source line: trimmed, whitespace runs collapsed to one space,
 * and trailing commas, semicolons and periods removed with the whitespace before them. Those
 * three only separate or end items and sentences: a comma appears when an item is appended after
 * this one, and a period is often added or dropped at the end of a list item. Colons, brackets
 * and quotes stay, since they change what a line says.
 */
export function normalizeExcerpt(line: string): string {
  const collapsed = line.trim().replace(/\s+/g, ' ');
  let end = collapsed.length;
  for (;;) {
    const char = collapsed.charCodeAt(end - 1);
    if (char === 0x2c || char === 0x3b || char === 0x2e) end--;
    else if (char === 0x20 && end < collapsed.length) end--;
    else break;
  }
  return collapsed.slice(0, end);
}

/** The anchor of a finding on a whole file. Hex hashes never equal it. */
export const WHOLE_FILE_ANCHOR = 'file';

/** The anchor of a finding on a line: a hash of the line's normalized text. */
export function lineAnchor(line: string): string {
  return hash53(normalizeExcerpt(line));
}

/**
 * The anchor of a finding on a JSON value: its path, with every array index replaced by `null`,
 * and its value. A string, number, boolean or null is identified by its canonical value, and so
 * is an object or array that is an element of an array, which has no key of its own. An object
 * or array under a key is identified by the key path alone: adding a field to an MCP server
 * leaves a finding on the server unchanged.
 */
export function jsonAnchor(location: JsonLocation): string {
  const path = location.path.map((segment) => (typeof segment === 'number' ? null : segment));
  const container = location.type === 'object' || location.type === 'array';
  const value = container && !location.inArray ? location.type : location.canonical();
  return hash53(`json\u0000${JSON.stringify([path, value])}`);
}
