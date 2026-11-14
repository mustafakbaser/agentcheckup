/**
 * The variable names of a `.env` file, read the way the `dotenv` package's `parse()` reads them,
 * which Gemini CLI calls on the `.env` file it loads (SOURCES.geminiSettingsSource,
 * `loadEnvironment`). Used by the security inventory, which lists names only: values are
 * returned for classification and must never be stored, shown or hashed.
 *
 * `parse()` normalizes `\r\n` and `\r` to `\n` and runs one global, multiline regular expression
 * over the text:
 *
 *     /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|
 *      \s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg
 *
 * Every match sets one variable, a later one overriding an earlier one. That expression
 * backtracks, so it is not run here; this scanner gives the same matches in linear time. Quirks
 * it keeps, because a file can use them to hide a variable from a line-by-line reader: `\s`
 * crosses lines, so `A\n=1` sets `A` and `A=\n"x"` sets `A` to `x`; a quoted value runs over
 * lines up to the last closing quote that ends a line; `^` and `$` also match at U+2028 and
 * U+2029; an unquoted value runs to `#` or a line break, U+2028 included.
 */

/** One variable a `.env` file sets. */
export interface DotenvEntry {
  readonly name: string;
  /** For classification only: never store, show or hash it. */
  readonly value: string;
  /** 1-based line of the name, counted in `\n`, `\r\n` and `\r` line breaks. */
  readonly line: number;
}

/** JavaScript's `\s`. */
function isSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** A line terminator for `^`, `$` and `.` under the `m` flag, once `\r` is gone. */
function isTerminator(code: number): boolean {
  return code === 0x0a || code === 0x2028 || code === 0x2029;
}

/** `[\w.-]`. */
function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2e ||
    code === 0x2d
  );
}

const HASH = 0x23;
const BACKSLASH = 0x5c;
const QUOTES = ["'", '"', '`'] as const;

/** Tables over the normalized text, each built in one pass. */
class Scanner {
  readonly #text: string;
  readonly #length: number;
  /** End of the run of `\s` that starts at each position (the position itself if none). */
  readonly #spaceEnd: Int32Array;
  /** Whether that run holds a line terminator. */
  readonly #spaceHasTerminator: Uint8Array;
  /** Per quote character: the first quote at or after each position not preceded by `\`. */
  readonly #nextUnescaped = new Map<string, Int32Array>();
  /** Per quote character: the last quote at or before each position that may close a value. */
  readonly #lastClosing = new Map<string, Int32Array>();

  constructor(text: string) {
    this.#text = text;
    const length = text.length;
    this.#length = length;
    this.#spaceEnd = new Int32Array(length + 1);
    this.#spaceHasTerminator = new Uint8Array(length + 1);
    this.#spaceEnd[length] = length;
    for (let i = length - 1; i >= 0; i--) {
      const code = text.charCodeAt(i);
      if (isSpace(code)) {
        this.#spaceEnd[i] = this.#spaceEnd[i + 1] ?? length;
        this.#spaceHasTerminator[i] =
          isTerminator(code) || this.#spaceHasTerminator[i + 1] === 1 ? 1 : 0;
      } else {
        this.#spaceEnd[i] = i;
      }
    }
    for (const quote of QUOTES) {
      const code = quote.charCodeAt(0);
      const next = new Int32Array(length + 2).fill(-1);
      for (let i = length - 1; i >= 0; i--) {
        const escaped = i > 0 && text.charCodeAt(i - 1) === BACKSLASH;
        next[i] = text.charCodeAt(i) === code && !escaped ? i : (next[i + 1] ?? -1);
      }
      const last = new Int32Array(length + 1).fill(-1);
      for (let i = 0; i < length; i++) {
        const closes = text.charCodeAt(i) === code && this.#tailFits(i + 1);
        last[i] = closes ? i : i > 0 ? (last[i - 1] ?? -1) : -1;
      }
      this.#nextUnescaped.set(quote, next);
      this.#lastClosing.set(quote, last);
    }
  }

  /** `\s*(?:#.*)?$` can match at `at`. */
  #tailFits(at: number): boolean {
    const end = this.#spaceEnd[at] ?? at;
    return (
      this.#spaceHasTerminator[at] === 1 ||
      end === this.#length ||
      this.#text.charCodeAt(end) === HASH
    );
  }

  /** Where `\s*(?:#.*)?$` ends when it matches at `at`. */
  #tailEnd(at: number): number {
    const end = this.#spaceEnd[at] ?? at;
    if (end === this.#length) return end;
    if (this.#text.charCodeAt(end) === HASH) return this.#lineEnd(end);
    // Back off to the last line terminator of the run: `$` matches before it.
    for (let i = end - 1; i >= at; i--) {
      if (isTerminator(this.#text.charCodeAt(i))) return i;
    }
    return at;
  }

  /** The next line terminator at or after `at`, or the end. */
  #lineEnd(at: number): number {
    let i = at;
    while (i < this.#length && !isTerminator(this.#text.charCodeAt(i))) i++;
    return i;
  }

  spaceEnd(at: number): number {
    return this.#spaceEnd[at] ?? at;
  }

  /** The value and the end of the match, for a value that starts at `at`. */
  value(at: number): { readonly raw: string; readonly end: number } {
    const text = this.#text;
    // `\s*'(?:\\'|[^'])*'`, then the same for `"` and `` ` ``: the longest quoted value whose
    // closing quote the rest of the expression can follow.
    const open = this.spaceEnd(at);
    for (const quote of QUOTES) {
      if (text[open] !== quote) continue;
      const first = open + 1;
      const next = this.#nextUnescaped.get(quote);
      const last = this.#lastClosing.get(quote);
      if (next === undefined || last === undefined) continue;
      // Content stops at the first quote that is not part of an escaped `\'` pair.
      const stop =
        text[first] === quote ? first : first + 1 <= this.#length ? (next[first + 1] ?? -1) : -1;
      const close = last[stop === -1 ? this.#length - 1 : stop] ?? -1;
      if (close >= first) {
        return { raw: text.slice(at, close + 1), end: this.#tailEnd(close + 1) };
      }
    }
    // `[^#\r\n]+`: always followed by `#`, a line break or the end, where the rest matches.
    let i = at;
    while (i < this.#length) {
      const code = text.charCodeAt(i);
      if (code === HASH || code === 0x0a) break;
      i++;
    }
    if (i > at) return { raw: text.slice(at, i), end: this.#tailEnd(i) };
    // No value: the group is optional, and the rest always matches here.
    return { raw: '', end: this.#tailEnd(at) };
  }
}

/** `export` followed by `\s+`, at `at`: where the name starts after it. */
function afterExport(text: string, scanner: Scanner, at: number): number | undefined {
  if (!text.startsWith('export', at)) return undefined;
  const end = scanner.spaceEnd(at + 6);
  return end > at + 6 ? end : undefined;
}

/** The match of the expression at a name starting at `at`, if any. */
function matchName(
  text: string,
  scanner: Scanner,
  at: number,
):
  | { readonly name: string; readonly nameAt: number; readonly raw: string; readonly end: number }
  | undefined {
  let end = at;
  while (end < text.length && isNameChar(text.charCodeAt(end))) end++;
  if (end === at) return undefined;
  const name = text.slice(at, end);
  // `\s*=\s*?`: the lazy part takes nothing, as the value's own `\s*` does the rest.
  const equals = scanner.spaceEnd(end);
  if (text.charCodeAt(equals) === 0x3d) {
    return { name, nameAt: at, ...scanner.value(equals + 1) };
  }
  // `:\s+?`: one space at least.
  if (text.charCodeAt(end) === 0x3a && isSpace(text.charCodeAt(end + 1))) {
    return { name, nameAt: at, ...scanner.value(end + 2) };
  }
  return undefined;
}

/**
 * What `dotenv`'s `parse()` does to a value: trim it, run `replace(/^(['"`])([\s\S]*)\1$/mg,
 * '$2')`, and turn `\n` and `\r` into line breaks when it started with `"`. Under the `m` flag
 * that replacement unquotes from any line start to the last matching quote that ends a line.
 */
function cleanValue(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  // The last position of each quote character that ends a line or the value.
  const closing = new Map<string, number>();
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    const ends = i + 1 === value.length || isTerminator(value.charCodeAt(i + 1));
    if (ends && (char === "'" || char === '"' || char === '`')) closing.set(char, i);
  }
  let out = '';
  let copied = 0;
  for (let i = 0; i < value.length; i++) {
    const lineStart = i === 0 || isTerminator(value.charCodeAt(i - 1));
    const close = lineStart ? closing.get(value.charAt(i)) : undefined;
    if (close === undefined || close <= i) continue;
    out += value.slice(copied, i) + value.slice(i + 1, close);
    copied = close + 1;
    i = close;
  }
  out += value.slice(copied);
  return first === '"' ? out.replaceAll('\\n', '\n').replaceAll('\\r', '\r') : out;
}

/**
 * The variables a `.env` file sets, each name once, in the order of the line that sets it last:
 * a later line overrides an earlier one. `__proto__` sets nothing.
 */
export function parseDotenv(input: string): DotenvEntry[] {
  const text = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const scanner = new Scanner(text);
  const found = new Map<string, { readonly value: string; readonly nameAt: number }>();
  // `^` under the `m` flag: the start, and after each line terminator.
  let at = 0;
  const lineAt: { offset: number; line: number } = { offset: 0, line: 1 };
  const lineOf = (offset: number): number => {
    for (; lineAt.offset < offset; lineAt.offset++) {
      if (text.charCodeAt(lineAt.offset) === 0x0a) lineAt.line++;
    }
    return lineAt.line;
  };
  const lines = new Map<string, number>();
  while (at <= text.length) {
    const start = scanner.spaceEnd(at);
    const exported = afterExport(text, scanner, start);
    const match =
      (exported === undefined ? undefined : matchName(text, scanner, exported)) ??
      matchName(text, scanner, start);
    let next: number;
    if (match === undefined) {
      // Every line start up to `start` reaches the same place and fails the same way.
      next = start;
    } else {
      if (match.name !== '__proto__') {
        found.delete(match.name);
        found.set(match.name, { value: cleanValue(match.raw), nameAt: match.nameAt });
        lines.set(match.name, lineOf(match.nameAt));
      }
      next = Math.max(match.end, start);
    }
    // The next line start after `next`.
    let i = Math.max(next, at);
    while (i < text.length && !isTerminator(text.charCodeAt(i))) i++;
    if (i >= text.length) break;
    at = i + 1;
  }
  return [...found].map(([name, { value }]) => ({ name, value, line: lines.get(name) ?? 1 }));
}
