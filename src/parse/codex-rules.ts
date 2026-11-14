/**
 * The literal calls of a Codex exec-policy file (`.codex/rules/*.rules`). Codex evaluates these
 * files as Starlark (codex-rs/execpolicy/src/parser.rs), which can compute anything a program
 * can. agentcheckup never evaluates them: it reads only a file made of top-level calls whose
 * arguments are literals, such as
 *
 *     prefix_rule(pattern = ["git", ["status", "diff"]], decision = "allow")
 *
 * and gives up, with the offset of what it did not understand, on anything else: a variable, an
 * expression, a `load`, a loop, a function definition, a string prefix (`r"`, `f"`, `b"`), a
 * triple-quoted string or an escape other than `\\`, `\"`, `\'`, `\n`, `\r` and `\t`. Callers
 * treat such a file as not analyzed, so a gate fails closed on it.
 *
 * Linear in the length of the text, without regular expressions, and bounded: at most
 * {@link MAX_CALLS} calls, {@link MAX_VALUES} literal values in all and lists nested at most
 * {@link MAX_DEPTH} deep. Pure.
 */
import type { Span } from '../core/types.js';

/** A literal value: a string, a boolean, `None` (null), or a list of literals. */
export type StarlarkLiteral = string | boolean | null | readonly StarlarkLiteral[];

export interface StarlarkCall {
  /** The function called, such as `prefix_rule`. */
  readonly name: string;
  /** The span of the whole call, from the name to the closing parenthesis. */
  readonly span: Span;
  /** Positional arguments, in order. */
  readonly args: readonly StarlarkLiteral[];
  /** Keyword arguments in source order; a repeated keyword is a failure (Starlark rejects it). */
  readonly kwargs: readonly { readonly name: string; readonly value: StarlarkLiteral }[];
}

export type StarlarkCallsResult =
  | { readonly ok: true; readonly calls: readonly StarlarkCall[] }
  | {
      readonly ok: false;
      /** Where reading stopped. */
      readonly offset: number;
      readonly reason: 'unsupported' | 'limit';
    };

/** Most calls read from one file. */
export const MAX_CALLS = 2000;
/** Most literal values read from one file, list items included. */
export const MAX_VALUES = 50_000;
/** Deepest nesting of lists. */
export const MAX_DEPTH = 8;

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  '"': '"',
  "'": "'",
  n: '\n',
  r: '\r',
  t: '\t',
};

class Stop extends Error {
  readonly offset: number;
  readonly reason: 'unsupported' | 'limit';

  constructor(offset: number, reason: 'unsupported' | 'limit') {
    super(reason);
    this.offset = offset;
    this.reason = reason;
  }
}

function isIdentStart(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f // a-z A-Z _
  );
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 0x30 && code <= 0x39);
}

class Reader {
  #at = 0;
  #values = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  get offset(): number {
    return this.#at;
  }

  /** Skips spaces, tabs, line breaks, a backslash before a line break, and comments. */
  skip(): void {
    const text = this.#text;
    while (this.#at < text.length) {
      const char = text.charAt(this.#at);
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f') {
        this.#at++;
      } else if (char === '#') {
        while (this.#at < text.length && text.charAt(this.#at) !== '\n') this.#at++;
      } else {
        return;
      }
    }
  }

  done(): boolean {
    this.skip();
    return this.#at >= this.#text.length;
  }

  peek(): string {
    return this.#text.charAt(this.#at);
  }

  expect(char: string): void {
    this.skip();
    if (this.#text.charAt(this.#at) !== char) throw new Stop(this.#at, 'unsupported');
    this.#at++;
  }

  /** Consumes `char` when it is next, after whitespace. */
  accept(char: string): boolean {
    this.skip();
    if (this.#text.charAt(this.#at) !== char) return false;
    this.#at++;
    return true;
  }

  identifier(): string {
    this.skip();
    const start = this.#at;
    if (!isIdentStart(this.#text.charCodeAt(start))) throw new Stop(start, 'unsupported');
    let end = start + 1;
    while (end < this.#text.length && isIdentPart(this.#text.charCodeAt(end))) end++;
    this.#at = end;
    return this.#text.slice(start, end);
  }

  /** True when an identifier followed by `=` (not `==`) comes next. */
  atKeyword(): boolean {
    this.skip();
    const text = this.#text;
    let end = this.#at;
    if (!isIdentStart(text.charCodeAt(end))) return false;
    while (end < text.length && isIdentPart(text.charCodeAt(end))) end++;
    while (end < text.length && (text.charAt(end) === ' ' || text.charAt(end) === '\t')) end++;
    return text.charAt(end) === '=' && text.charAt(end + 1) !== '=';
  }

  value(depth: number): StarlarkLiteral {
    this.skip();
    this.#values++;
    if (this.#values > MAX_VALUES) throw new Stop(this.#at, 'limit');
    const char = this.peek();
    if (char === '"' || char === "'") return this.string();
    if (char === '[') {
      if (depth >= MAX_DEPTH) throw new Stop(this.#at, 'limit');
      this.#at++;
      const items: StarlarkLiteral[] = [];
      while (!this.accept(']')) {
        items.push(this.value(depth + 1));
        if (!this.accept(',')) {
          this.expect(']');
          break;
        }
      }
      return items;
    }
    const start = this.#at;
    const word = isIdentStart(this.#text.charCodeAt(start)) ? this.identifier() : '';
    if (word === 'True') return true;
    if (word === 'False') return false;
    if (word === 'None') return null;
    throw new Stop(start, 'unsupported');
  }

  /** A single-line string in `"` or `'`, with the simple escapes only. */
  string(): string {
    const text = this.#text;
    const quote = text.charAt(this.#at);
    const start = this.#at;
    // `""` followed by the same quote opens a triple-quoted string.
    if (text.charAt(start + 1) === quote && text.charAt(start + 2) === quote) {
      throw new Stop(start, 'unsupported');
    }
    this.#at++;
    let out = '';
    while (this.#at < text.length) {
      const char = text.charAt(this.#at);
      if (char === quote) {
        this.#at++;
        return out;
      }
      if (char === '\n' || char === '\r') break;
      if (char === '\\') {
        const escaped = ESCAPES[text.charAt(this.#at + 1)];
        if (escaped === undefined) throw new Stop(this.#at, 'unsupported');
        out += escaped;
        this.#at += 2;
        continue;
      }
      out += char;
      this.#at++;
    }
    throw new Stop(start, 'unsupported');
  }
}

function readCall(reader: Reader): StarlarkCall {
  reader.skip();
  const start = reader.offset;
  const name = reader.identifier();
  reader.expect('(');
  const args: StarlarkLiteral[] = [];
  const kwargs: { name: string; value: StarlarkLiteral }[] = [];
  while (!reader.accept(')')) {
    if (reader.atKeyword()) {
      const at = reader.offset;
      const keyword = reader.identifier();
      reader.expect('=');
      if (kwargs.some((item) => item.name === keyword)) throw new Stop(at, 'unsupported');
      kwargs.push({ name: keyword, value: reader.value(0) });
    } else {
      // A positional argument after a keyword argument is a Starlark syntax error.
      if (kwargs.length > 0) throw new Stop(reader.offset, 'unsupported');
      args.push(reader.value(0));
    }
    if (!reader.accept(',')) {
      reader.expect(')');
      break;
    }
  }
  return { name, span: { offset: start, length: reader.offset - start }, args, kwargs };
}

/**
 * The calls of `text` when it is made only of top-level calls with literal arguments, separated
 * by line breaks or `;`, with comments anywhere between tokens. Never throws.
 */
export function readStarlarkCalls(text: string): StarlarkCallsResult {
  const reader = new Reader(text);
  const calls: StarlarkCall[] = [];
  try {
    while (!reader.done()) {
      if (calls.length >= MAX_CALLS) return { ok: false, offset: reader.offset, reason: 'limit' };
      calls.push(readCall(reader));
      reader.accept(';');
    }
  } catch (error) {
    if (error instanceof Stop) return { ok: false, offset: error.offset, reason: error.reason };
    throw error;
  }
  return { ok: true, calls };
}
