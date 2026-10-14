/**
 * Ordinal string comparison by UTF-16 code unit. Locale-independent, so output order is
 * identical on every machine (a tr-TR locale must not reorder `I` and `ı`).
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
