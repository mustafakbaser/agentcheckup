/**
 * `41207` -> `41,207`. Locale-independent: `toLocaleString` would print `41.207` on a Turkish or
 * German machine, and output must be identical everywhere.
 */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.trunc(Math.abs(value)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return sign + out;
}
