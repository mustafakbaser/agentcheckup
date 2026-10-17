/**
 * TOML 1.0, parsed the way Codex reads `.codex/config.toml`.
 *
 * Codex parses its configuration with the Rust `toml` crate (`toml::from_str` into a
 * `toml::Value`), so every TOML spelling of a key counts: `[mcp_servers.x]`,
 * `[mcp_servers."x"]`, a root-level `mcp_servers.x.command = …` and an inline
 * `mcp_servers = { x = { … } }` all define the same server. A grammar subset would let a pull
 * request hide a server, so this is the full TOML 1.0 grammar, and tables follow the crate's
 * rules: which keys may extend which tables comes from `descend_path`, `start_table` and
 * `finish_table` in toml 0.9 (`src/de/parser/document.rs`, `inline_table.rs`, read 2026-10-17).
 *
 * - The parse stops at the first error; the result holds that one issue and its span.
 * - TOML 1.1 syntax (newlines, comments and a trailing comma in an inline table, `\e`, `\xHH`,
 *   a time without seconds) is parsed and then reported as `unsupported`, unless the text also
 *   has a syntax error: whether Codex's crate accepts it has not been checked here.
 * - A byte order mark and UTF-16 text are reported as `bom` and `utf-16` and not parsed.
 * - Integers outside the i64 range and floats that overflow to infinity are errors, as in the
 *   crate when it builds a `toml::Value`.
 *
 * Security: tables are null-prototype objects, so `__proto__` and `constructor` are plain keys.
 * One linear pass over at most 1 MiB, at most 64 levels of keys and nesting, at most 100,000
 * values. Only nested arrays and inline tables recurse, and they stop at the depth bound.
 */
import { compareStrings } from '../core/compare.js';
import { formatInteger } from '../core/format.js';
import type { DecodedText, Span } from '../core/types.js';
import { MAX_CANONICAL_LENGTH } from './json.js';
import { cleanMessage, spanBetween } from './spans.js';
import type {
  JsonLocation,
  JsonPathSegment,
  ParseIssue,
  TomlDatetimeKind,
  TomlDocument,
  TomlLocation,
  TomlValueType,
} from './types.js';

/** Texts longer than this (UTF-16 code units) are not parsed. */
export const MAX_TOML_LENGTH = 1024 * 1024;
/** Keys and values nested deeper than this (path length from the root) are not parsed. */
export const MAX_TOML_DEPTH = 64;
/** Documents with more values than this (tables, arrays and scalars) are not parsed. */
export const MAX_TOML_NODES = 100_000;

/**
 * Issue codes. `too-large`, `too-deep`, `too-many-nodes` and `parse-failed` are limits;
 * `unsupported`, `bom` and `utf-16` are input the parser does not read; the rest are syntax
 * errors. `issueKind` in json-access.ts tells them apart.
 */
export const TOML_ISSUE = {
  tooLarge: 'too-large',
  tooDeep: 'too-deep',
  tooManyNodes: 'too-many-nodes',
  parseFailed: 'parse-failed',
  /** TOML 1.1 syntax. */
  unsupported: 'unsupported',
  bom: 'bom',
  utf16: 'utf-16',
  duplicateKey: 'duplicate-key',
  redefinedTable: 'redefined-table',
  /** A `[table]` header for a table that dotted keys already defined. */
  dottedTableRedefined: 'dotted-table-redefined',
  /** `[[x]]`, `[x.y]` or `x.y = …` where `x` is a static array. */
  staticArrayExtended: 'static-array-extended',
  inlineTableExtended: 'inline-table-extended',
  /** A key used as a table where it holds a string, number, boolean or date-time. */
  notATable: 'not-a-table',
  invalidEscape: 'invalid-escape',
  invalidUnicodeEscape: 'invalid-unicode-escape',
  controlCharacter: 'control-character',
  bareCarriageReturn: 'bare-carriage-return',
  invalidCharacter: 'invalid-character',
  integerOverflow: 'integer-overflow',
  floatOverflow: 'float-overflow',
  leadingZero: 'leading-zero',
  invalidNumber: 'invalid-number',
  invalidDatetime: 'invalid-datetime',
  invalidValue: 'invalid-value',
  invalidKey: 'invalid-key',
  unterminatedString: 'unterminated-string',
  unterminatedArray: 'unterminated-array',
  unterminatedInlineTable: 'unterminated-inline-table',
  expectedKey: 'expected-key',
  expectedEquals: 'expected-equals',
  expectedValue: 'expected-value',
  expectedComma: 'expected-comma',
  expectedBracket: 'expected-bracket',
  expectedNewline: 'expected-newline',
} as const;

/** What the caller knows about the file the text was decoded from (see `DecodedText`). */
export interface TomlSource {
  readonly encoding?: DecodedText['encoding'];
  /** The file started with a byte order mark, which decoding removed from the text. */
  readonly hasBom?: boolean;
}

/**
 * A TOML date-time: validated, kept opaque. It has no own properties, so JSON helpers that walk
 * values (`own`, `collectStrings`) see an empty object, much as serde sees a map where it
 * expects a string. `text` is the value as toml_datetime displays it: `T` and `Z` upper case,
 * seconds always present, a fraction cut to nanoseconds without trailing zeros, `-00:00` as
 * `+00:00`.
 */
export class TomlDatetime {
  readonly #kind: TomlDatetimeKind;
  readonly #text: string;

  constructor(kind: TomlDatetimeKind, text: string) {
    this.#kind = kind;
    this.#text = text;
    Object.freeze(this);
  }

  get kind(): TomlDatetimeKind {
    return this.#kind;
  }

  get text(): string {
    return this.#text;
  }

  toString(): string {
    return this.#text;
  }

  toJSON(): string {
    return this.#text;
  }
}

// ---------------------------------------------------------------------------------------------
// Value nodes
// ---------------------------------------------------------------------------------------------

interface NodeBase {
  parent: TableNode | ArrayNode | undefined;
  /** Key in the parent table, or index in the parent array. */
  segment: JsonPathSegment | undefined;
  /** Path length from the root. */
  readonly depth: number;
  /** The value span, as offsets. */
  start: number;
  end: number;
  /** The key span, as offsets; -1 when the value has no key. */
  keyStart: number;
  keyEnd: number;
  location: TomlLocation | undefined;
}

interface TableNode extends NodeBase {
  readonly kind: 'table';
  /**
   * A null-prototype object. While parsing it maps each key to its node, so one hash lookup
   * finds what a key holds; `parseToml` then replaces the nodes with their values.
   */
  readonly value: Record<string, unknown>;
  /** Child nodes in document order. */
  members: Node[];
  /** Keys to members for lookups after the parse, built on the first one. */
  index: Map<string, Node> | undefined;
  /** Created by a key on the way to another table, not defined by a header or an inline table. */
  implicit: boolean;
  /** Created by a dotted key in a key/value pair. */
  readonly dotted: boolean;
  /** An inline table, or a table a dotted key created inside one. */
  readonly inline: boolean;
}

interface ArrayNode extends NodeBase {
  readonly kind: 'array';
  readonly items: Node[];
  readonly value: unknown[];
  /** Built by `[[header]]`s rather than written as `[ … ]`. */
  readonly ofTables: boolean;
}

type ScalarType = Exclude<TomlValueType, 'table' | 'array'>;

interface ScalarNode extends NodeBase {
  readonly kind: 'scalar';
  readonly type: ScalarType;
  readonly value: string | number | boolean | TomlDatetime;
  /** An integer's exact decimal digits. */
  readonly digits: string | undefined;
}

type Node = TableNode | ArrayNode | ScalarNode;

// ---------------------------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------------------------

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const HASH = 0x23;
const APOSTROPHE = 0x27;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const COLON = 0x3a;
const EQUALS = 0x3d;
const LEFT_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RIGHT_BRACKET = 0x5d;
const UNDERSCORE = 0x5f;
const LEFT_BRACE = 0x7b;
const RIGHT_BRACE = 0x7d;
const DELETE = 0x7f;

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isHexDigit = (code: number): boolean =>
  isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
const isOctalDigit = (code: number): boolean => code >= 0x30 && code <= 0x37;
const isBinaryDigit = (code: number): boolean => code === 0x30 || code === 0x31;
const isLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

/** `unquoted-key = 1*( ALPHA / DIGIT / %x2D / %x5F )` */
const isBareKeyChar = (code: number): boolean =>
  isLetter(code) || isDigit(code) || code === MINUS || code === UNDERSCORE;

/** Characters of numbers, booleans, `inf`, `nan` and date-times. */
const isAtomChar = (code: number): boolean =>
  isBareKeyChar(code) || code === PLUS || code === DOT || code === COLON;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Value of a hexadecimal digit (callers check `isHexDigit` first). */
const hexValue = (code: number): number => (code <= 0x39 ? code - 0x30 : (code | 0x20) - 0x57);

/** The members of every table without keys. Never modified. */
const NO_MEMBERS: Node[] = [];

/** Largest i64 magnitudes, as 19 decimal digits. */
const I64_MAX_DIGITS = '9223372036854775807';
const I64_MIN_DIGITS = '9223372036854775808';

const DESCRIBED: Readonly<Record<ScalarType, string>> = {
  string: 'a string',
  integer: 'an integer',
  float: 'a float',
  boolean: 'a boolean',
  'offset-datetime': 'a date-time',
  'local-datetime': 'a date-time',
  'local-date': 'a date',
  'local-time': 'a time',
};

/**
 * A new object without a prototype. V8 keeps `{}` with its prototype removed in fast mode,
 * where `Object.create(null)` starts as a dictionary: three times slower to fill and freeze.
 */
function nullObject(): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  Object.setPrototypeOf(object, null);
  return object;
}

/** A key as it can appear in a message: control characters removed, length bounded. */
function shown(name: string): string {
  return cleanMessage(name.length > 60 ? `${name.slice(0, 60)}…` : name);
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

/** Thrown inside the parser to stop at the first problem; never escapes `parseToml`. */
class Stop extends Error {
  readonly issue: ParseIssue;

  constructor(issue: ParseIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

/**
 * Spans that `locate` maps to values: keys, whole pairs, array items and table bodies (a
 * header and its pairs). The root covers the whole text.
 */
class Entries {
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  readonly targets: Node[] = [];

  add(start: number, end: number, target: Node): number {
    this.starts.push(start);
    this.ends.push(end);
    return this.targets.push(target) - 1;
  }
}

class Parser {
  readonly #text: string;
  readonly #length: number;
  #pos = 0;
  #values = 0;
  #current: TableNode;
  /** The `[header]` table whose pairs are being read; its span ends at its last pair. */
  #region: TableNode | undefined;
  /** The locate entry of `#region`, and where its last pair ends. */
  #regionEntry = 0;
  #regionEnd = 0;
  /** The key `#simpleKey` read last. */
  #key = '';
  readonly root: TableNode;
  readonly entries = new Entries();
  /** Every table and array, to fill and freeze their values at the end. */
  readonly tables: TableNode[] = [];
  readonly arrays: ArrayNode[] = [];
  /** The first TOML 1.1 construct, if any. */
  toml11: { readonly span: Span; readonly what: string } | undefined;

  constructor(text: string) {
    this.#text = text;
    this.#length = text.length;
    this.root = this.#newTable(0, false, false, false, 0, text.length);
    this.entries.add(0, text.length, this.root);
    this.#current = this.root;
  }

  /** `toml = expression *( newline expression )` */
  parse(): void {
    for (;;) {
      this.#skipWhitespace();
      if (this.#pos >= this.#length) break;
      const code = this.#code();
      if (code === HASH) {
        this.#comment();
      } else if (code === LEFT_BRACKET) {
        this.#header();
        this.#lineEnd();
      } else if (code !== LF && code !== CR) {
        this.#pair(this.#current, false);
        this.#lineEnd();
      }
      if (this.#pos >= this.#length) break;
      this.#newline('Expected a new line, found this.');
    }
    this.#closeRegion();
  }

  // -------------------------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------------------------

  #fail(code: string, message: string, start: number, end: number): never {
    throw new Stop({ code, message, span: spanBetween(start, end, this.#length) });
  }

  /** Fails on the character at the current position (or the end of the text). */
  #unexpected(code: string, message: string): never {
    const pos = this.#pos;
    if (pos >= this.#length) {
      this.#fail(code, message.replace('this', 'the end of the file'), pos, pos);
    }
    const width = isHighSurrogate(this.#code()) && isLowSurrogate(this.#codeAt(pos + 1)) ? 2 : 1;
    this.#fail(code, message, pos, pos + width);
  }

  #tooDeep(start: number, end: number): never {
    this.#fail(
      TOML_ISSUE.tooDeep,
      `Keys and values are nested deeper than ${MAX_TOML_DEPTH} levels.`,
      start,
      end,
    );
  }

  #bareCarriageReturn(pos: number): never {
    this.#fail(
      TOML_ISSUE.bareCarriageReturn,
      'A carriage return must be followed by a line feed.',
      pos,
      pos + 1,
    );
  }

  /** Records the first TOML 1.1 construct; parsing continues. */
  #toml11(start: number, end: number, what: string): void {
    this.toml11 ??= { span: spanBetween(start, end, this.#length), what };
  }

  // -------------------------------------------------------------------------------------------
  // Whitespace, comments, new lines
  // -------------------------------------------------------------------------------------------

  #code(): number {
    return this.#text.charCodeAt(this.#pos);
  }

  #codeAt(pos: number): number {
    return this.#text.charCodeAt(pos);
  }

  #skipWhitespace(): void {
    const text = this.#text;
    let pos = this.#pos;
    for (let code = text.charCodeAt(pos); code === SPACE || code === TAB;) {
      code = text.charCodeAt(++pos);
    }
    this.#pos = pos;
  }

  /**
   * Width of the character at `pos` in a comment or string (1, or 2 for a surrogate pair).
   * Fails on control characters other than tab and on lone surrogates. Callers handle line
   * breaks and delimiters first.
   */
  #textChar(pos: number, code: number): number {
    if (code >= SPACE && code !== DELETE && (code < 0xd800 || code > 0xdfff)) return 1;
    if (code === TAB) return 1;
    if (isHighSurrogate(code) && isLowSurrogate(this.#codeAt(pos + 1))) return 2;
    if (code < SPACE || code === DELETE) {
      this.#fail(
        TOML_ISSUE.controlCharacter,
        `Control character U+${code.toString(16).toUpperCase().padStart(4, '0')} is not allowed here; only tab is.`,
        pos,
        pos + 1,
      );
    }
    this.#fail(TOML_ISSUE.invalidCharacter, 'Unpaired surrogate code unit.', pos, pos + 1);
  }

  /** `comment = "#" *non-eol`, up to (not including) the line break. */
  #comment(): void {
    const text = this.#text;
    let pos = this.#pos + 1;
    while (pos < this.#length) {
      const code = text.charCodeAt(pos);
      if (code === LF) break;
      if (code === CR) {
        if (text.charCodeAt(pos + 1) === LF) break;
        this.#bareCarriageReturn(pos);
      }
      pos += this.#textChar(pos, code);
    }
    this.#pos = pos;
  }

  /** `newline = %x0A / %x0D.0A` */
  #newline(message: string): void {
    const code = this.#code();
    if (code === LF) {
      this.#pos++;
      return;
    }
    if (code === CR) {
      if (this.#codeAt(this.#pos + 1) === LF) {
        this.#pos += 2;
        return;
      }
      this.#bareCarriageReturn(this.#pos);
    }
    this.#unexpected(TOML_ISSUE.expectedNewline, message);
  }

  /** Whitespace and an optional comment after a pair or header; the line break follows. */
  #lineEnd(): void {
    this.#skipWhitespace();
    if (this.#code() === HASH) this.#comment();
  }

  /** `ws-comment-newline = *( wschar / [ comment ] newline )`, between array values. */
  #arrayGap(): void {
    for (;;) {
      this.#skipWhitespace();
      const code = this.#code();
      if (code === HASH) this.#comment();
      else if (code !== LF && code !== CR) return;
      if (this.#pos >= this.#length) return;
      this.#newline('Expected a new line after the comment.');
    }
  }

  /** Whitespace in an inline table. Line breaks and comments there are TOML 1.1. */
  #inlineGap(): void {
    for (;;) {
      this.#skipWhitespace();
      const code = this.#code();
      if (code !== HASH && code !== LF && code !== CR) return;
      this.#toml11(this.#pos, this.#pos + 1, 'a line break or comment inside an inline table');
      if (code === HASH) this.#comment();
      if (this.#pos >= this.#length) return;
      this.#newline('Expected a new line after the comment.');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------------------------

  #count(start: number, end: number): void {
    if (++this.#values > MAX_TOML_NODES) {
      this.#fail(
        TOML_ISSUE.tooManyNodes,
        `The document has more than ${formatInteger(MAX_TOML_NODES)} values.`,
        start,
        end,
      );
    }
  }

  #newTable(
    depth: number,
    implicit: boolean,
    dotted: boolean,
    inline: boolean,
    start: number,
    end: number,
  ): TableNode {
    if (depth > MAX_TOML_DEPTH) this.#tooDeep(start, end);
    if (depth > 0) this.#count(start, end);
    const table: TableNode = {
      kind: 'table',
      parent: undefined,
      segment: undefined,
      depth,
      start,
      end,
      keyStart: -1,
      keyEnd: -1,
      location: undefined,
      value: nullObject(),
      members: NO_MEMBERS,
      index: undefined,
      implicit,
      dotted,
      inline,
    };
    this.tables.push(table);
    return table;
  }

  #newArray(depth: number, ofTables: boolean, start: number, end: number): ArrayNode {
    if (depth > MAX_TOML_DEPTH) this.#tooDeep(start, end);
    this.#count(start, end);
    const array: ArrayNode = {
      kind: 'array',
      parent: undefined,
      segment: undefined,
      depth,
      start,
      end,
      keyStart: -1,
      keyEnd: -1,
      location: undefined,
      items: [],
      value: [],
      ofTables,
    };
    this.arrays.push(array);
    return array;
  }

  #scalar(
    depth: number,
    start: number,
    type: ScalarType,
    value: ScalarNode['value'],
    digits: string | undefined,
  ): ScalarNode {
    return {
      kind: 'scalar',
      parent: undefined,
      segment: undefined,
      depth,
      start,
      end: this.#pos,
      keyStart: -1,
      keyEnd: -1,
      location: undefined,
      type,
      value,
      digits,
    };
  }

  /** Adds `node` to `parent` under the key `name` at `start`…`end`. */
  #attach(parent: TableNode, name: string, start: number, end: number, node: Node): void {
    node.parent = parent;
    node.segment = name;
    node.keyStart = start;
    node.keyEnd = end;
    // Most tables hold a few keys: a one-element array is far smaller than a grown one.
    if (parent.members === NO_MEMBERS) parent.members = [node];
    else parent.members.push(node);
    // On a null-prototype object this creates an own property, even for `__proto__`.
    parent.value[name] = node;
  }

  #push(array: ArrayNode, node: Node): void {
    node.parent = array;
    node.segment = array.items.length;
    array.items.push(node);
    array.value.push(node.value);
  }

  /**
   * The table the key `name` (at `start`…`end`) names inside `parent`, created as an implicit
   * table when absent. `dotted`: a dotted key in a pair, not a header. `inline`: inside an
   * inline table.
   */
  #descend(
    parent: TableNode,
    name: string,
    start: number,
    end: number,
    dotted: boolean,
    inline: boolean,
  ): TableNode {
    const existing = parent.value[name] as Node | undefined;
    if (existing === undefined) {
      const table = this.#newTable(parent.depth + 1, true, dotted, inline, start, end);
      this.#attach(parent, name, start, end, table);
      this.entries.add(start, end, table);
      return table;
    }
    this.entries.add(start, end, existing);
    if (existing.kind === 'scalar') {
      this.#fail(
        TOML_ISSUE.notATable,
        `"${shown(name)}" is ${DESCRIBED[existing.type]}, not a table.`,
        start,
        end,
      );
    }
    if (existing.kind === 'table') {
      if (existing.inline && (!inline || !existing.implicit)) {
        this.#fail(
          TOML_ISSUE.inlineTableExtended,
          `"${shown(name)}" is an inline table; keys cannot be added to it from outside its braces.`,
          start,
          end,
        );
      }
      if (dotted && !existing.implicit) {
        this.#fail(
          TOML_ISSUE.redefinedTable,
          `Table "${shown(name)}" is already defined; dotted keys cannot add to it.`,
          start,
          end,
        );
      }
      return existing;
    }
    const last = existing.items[existing.items.length - 1];
    if (existing.ofTables && !inline && last?.kind === 'table') return last;
    this.#fail(
      TOML_ISSUE.staticArrayExtended,
      `"${shown(name)}" is an array value; keys cannot be added to it.`,
      start,
      end,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------------------------

  /** `simple-key = quoted-key / unquoted-key`, into `#key`. */
  #simpleKey(): void {
    const text = this.#text;
    const start = this.#pos;
    const code = this.#code();
    if (code === QUOTE || code === APOSTROPHE) {
      if (text.charCodeAt(start + 1) === code && text.charCodeAt(start + 2) === code) {
        this.#fail(TOML_ISSUE.invalidKey, 'A multi-line string cannot be a key.', start, start + 3);
      }
      this.#key = code === QUOTE ? this.#basicString() : this.#literalString();
      return;
    }
    let pos = start;
    while (isBareKeyChar(text.charCodeAt(pos))) pos++;
    if (pos === start) this.#unexpected(TOML_ISSUE.expectedKey, 'Expected a key, found this.');
    this.#key = text.slice(start, pos);
    this.#pos = pos;
  }

  // -------------------------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------------------------

  /** Ends the span of the current `[header]` table at its last pair. */
  #closeRegion(): void {
    const region = this.#region;
    if (region === undefined) return;
    region.end = this.#regionEnd;
    this.entries.ends[this.#regionEntry] = this.#regionEnd;
    this.#region = undefined;
  }

  /** `std-table = "[" ws key ws "]"`, `array-table = "[[" ws key ws "]]"` */
  #header(): void {
    this.#closeRegion();
    const text = this.#text;
    const start = this.#pos;
    const ofTables = text.charCodeAt(start + 1) === LEFT_BRACKET;
    this.#pos += ofTables ? 2 : 1;
    this.#skipWhitespace();
    let parent = this.root;
    let keyStart = this.#pos;
    this.#simpleKey();
    let keyEnd = this.#pos;
    let name = this.#key;
    this.#skipWhitespace();
    while (this.#code() === DOT) {
      parent = this.#descend(parent, name, keyStart, keyEnd, false, false);
      this.#pos++;
      this.#skipWhitespace();
      keyStart = this.#pos;
      this.#simpleKey();
      keyEnd = this.#pos;
      name = this.#key;
      this.#skipWhitespace();
    }
    if (
      this.#code() !== RIGHT_BRACKET ||
      (ofTables && text.charCodeAt(this.#pos + 1) !== RIGHT_BRACKET)
    ) {
      this.#unexpected(
        TOML_ISSUE.expectedBracket,
        ofTables
          ? 'Expected "]]" to close the table header, found this.'
          : 'Expected "]" to close the table header, found this.',
      );
    }
    this.#pos += ofTables ? 2 : 1;
    const end = this.#pos;
    const table = ofTables
      ? this.#arrayTable(parent, name, keyStart, keyEnd, start, end)
      : this.#standardTable(parent, name, keyStart, keyEnd, start, end);
    this.#current = table;
    this.#region = table;
    this.#regionEntry = this.entries.add(start, end, table);
    this.#regionEnd = end;
  }

  #standardTable(
    parent: TableNode,
    key: string,
    keyStart: number,
    keyEnd: number,
    start: number,
    end: number,
  ): TableNode {
    const existing = parent.value[key] as Node | undefined;
    if (existing === undefined) {
      const table = this.#newTable(parent.depth + 1, false, false, false, start, end);
      this.#attach(parent, key, keyStart, keyEnd, table);
      this.entries.add(keyStart, keyEnd, table);
      return table;
    }
    const name = shown(key);
    if (existing.kind === 'table') {
      if (existing.implicit && !existing.dotted) {
        // [a.b] came first and created `a`; [a] now defines it.
        existing.implicit = false;
        existing.start = start;
        existing.end = end;
        existing.keyStart = keyStart;
        existing.keyEnd = keyEnd;
        this.entries.add(keyStart, keyEnd, existing);
        return existing;
      }
      if (existing.dotted) {
        this.#fail(
          TOML_ISSUE.dottedTableRedefined,
          `Table "${name}" is already defined by dotted keys; a [table] header cannot define it again.`,
          keyStart,
          keyEnd,
        );
      }
      if (existing.inline) {
        this.#fail(
          TOML_ISSUE.inlineTableExtended,
          `"${name}" is an inline table; a [table] header cannot define it again.`,
          keyStart,
          keyEnd,
        );
      }
      this.#fail(
        TOML_ISSUE.redefinedTable,
        `Table "${name}" is defined more than once.`,
        keyStart,
        keyEnd,
      );
    }
    if (existing.kind === 'array' && existing.ofTables) {
      this.#fail(
        TOML_ISSUE.redefinedTable,
        `"${name}" is already an array of tables; a [table] header cannot define it as a table.`,
        keyStart,
        keyEnd,
      );
    }
    this.#fail(
      TOML_ISSUE.duplicateKey,
      `Key "${name}" already has a value; a [table] header cannot define it again.`,
      keyStart,
      keyEnd,
    );
  }

  #arrayTable(
    parent: TableNode,
    key: string,
    keyStart: number,
    keyEnd: number,
    start: number,
    end: number,
  ): TableNode {
    let array: ArrayNode;
    const existing = parent.value[key] as Node | undefined;
    const name = shown(key);
    if (existing === undefined) {
      array = this.#newArray(parent.depth + 1, true, keyStart, keyEnd);
      this.#attach(parent, key, keyStart, keyEnd, array);
      this.entries.add(keyStart, keyEnd, array);
    } else if (existing.kind === 'scalar') {
      this.#fail(
        TOML_ISSUE.duplicateKey,
        `Key "${name}" already has a value; [[${name}]] cannot define it again.`,
        keyStart,
        keyEnd,
      );
    } else if (existing.kind === 'array' && existing.ofTables) {
      array = existing;
      this.entries.add(keyStart, keyEnd, existing);
    } else if (existing.kind === 'array') {
      this.#fail(
        TOML_ISSUE.staticArrayExtended,
        `"${name}" is a static array; [[${name}]] cannot add tables to it.`,
        keyStart,
        keyEnd,
      );
    } else {
      this.#fail(
        existing.inline ? TOML_ISSUE.inlineTableExtended : TOML_ISSUE.redefinedTable,
        `"${name}" is already a table; [[${name}]] cannot make it an array of tables.`,
        keyStart,
        keyEnd,
      );
    }
    const element = this.#newTable(array.depth + 1, false, false, false, start, end);
    this.#push(array, element);
    return element;
  }

  // -------------------------------------------------------------------------------------------
  // Pairs
  // -------------------------------------------------------------------------------------------

  /** `keyval = key keyval-sep val`, added to `table`. Each key resolves as it is read. */
  #pair(table: TableNode, inline: boolean): void {
    const start = this.#pos;
    let parent = table;
    let keyStart = start;
    this.#simpleKey();
    let keyEnd = this.#pos;
    let name = this.#key;
    this.#skipWhitespace();
    while (this.#code() === DOT) {
      parent = this.#descend(parent, name, keyStart, keyEnd, true, inline);
      this.#pos++;
      this.#skipWhitespace();
      keyStart = this.#pos;
      this.#simpleKey();
      keyEnd = this.#pos;
      name = this.#key;
      this.#skipWhitespace();
    }
    if (parent.depth >= MAX_TOML_DEPTH) this.#tooDeep(keyStart, keyEnd);
    if (this.#code() !== EQUALS) {
      this.#unexpected(TOML_ISSUE.expectedEquals, 'Expected "=" after the key, found this.');
    }
    // toml: "using dotted keys to redefine tables already defined in [table] form is not allowed"
    if (parent.dotted !== (parent !== table)) {
      this.#fail(
        TOML_ISSUE.redefinedTable,
        'Dotted keys cannot add keys to a table that a table header created.',
        keyStart,
        keyEnd,
      );
    }
    if (parent.value[name] !== undefined) {
      this.#fail(
        TOML_ISSUE.duplicateKey,
        `Key "${shown(name)}" is defined more than once.`,
        keyStart,
        keyEnd,
      );
    }
    this.#pos++;
    this.#skipWhitespace();
    const code = this.#code();
    if (this.#pos >= this.#length || code === LF || code === CR || code === HASH) {
      this.#fail(TOML_ISSUE.expectedValue, 'Expected a value after "=".', this.#pos, this.#pos);
    }
    const value = this.#value(parent.depth + 1);
    this.#attach(parent, name, keyStart, keyEnd, value);
    // A span on the whole pair, or on its last key, points at the value.
    this.entries.add(start, this.#pos, value);
    this.entries.add(keyStart, keyEnd, value);
    if (!inline) this.#regionEnd = this.#pos;
  }

  // -------------------------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------------------------

  /** `val = string / boolean / array / inline-table / date-time / float / integer` */
  #value(depth: number): Node {
    const start = this.#pos;
    if (depth > MAX_TOML_DEPTH) this.#tooDeep(start, start + 1);
    const code = this.#code();
    if (code === LEFT_BRACKET) return this.#array(depth, start);
    if (code === LEFT_BRACE) return this.#inlineTable(depth, start);
    this.#count(start, start + 1);
    if (code === QUOTE) {
      const value = this.#startsTriple(QUOTE) ? this.#multilineBasicString() : this.#basicString();
      return this.#scalar(depth, start, 'string', value, undefined);
    }
    if (code === APOSTROPHE) {
      const value = this.#startsTriple(APOSTROPHE)
        ? this.#multilineLiteralString()
        : this.#literalString();
      return this.#scalar(depth, start, 'string', value, undefined);
    }
    return this.#atom(depth, start);
  }

  #startsTriple(code: number): boolean {
    return this.#codeAt(this.#pos + 1) === code && this.#codeAt(this.#pos + 2) === code;
  }

  /** `array = "[" [ array-values ] ws-comment-newline "]"`, trailing comma allowed. */
  #array(depth: number, start: number): ArrayNode {
    const array = this.#newArray(depth, false, start, start + 1);
    this.#pos++;
    for (;;) {
      this.#arrayGap();
      if (this.#pos >= this.#length) {
        this.#fail(TOML_ISSUE.unterminatedArray, 'Unterminated array.', start, start + 1);
      }
      if (this.#code() === RIGHT_BRACKET) break;
      const item = this.#value(depth + 1);
      this.#push(array, item);
      this.entries.add(item.start, item.end, item);
      this.#arrayGap();
      const code = this.#code();
      if (code === COMMA) {
        this.#pos++;
        continue;
      }
      if (code === RIGHT_BRACKET) break;
      if (this.#pos >= this.#length) {
        this.#fail(TOML_ISSUE.unterminatedArray, 'Unterminated array.', start, start + 1);
      }
      this.#unexpected(TOML_ISSUE.expectedComma, 'Expected "," or "]" in the array, found this.');
    }
    this.#pos++;
    array.end = this.#pos;
    return array;
  }

  /** `inline-table = "{" ws [ inline-table-keyvals ] ws "}"` */
  #inlineTable(depth: number, start: number): TableNode {
    const table = this.#newTable(depth, false, false, true, start, start + 1);
    this.#pos++;
    this.#inlineGap();
    if (this.#code() !== RIGHT_BRACE) {
      for (;;) {
        if (this.#pos >= this.#length) {
          this.#fail(
            TOML_ISSUE.unterminatedInlineTable,
            'Unterminated inline table.',
            start,
            start + 1,
          );
        }
        this.#pair(table, true);
        this.#inlineGap();
        const code = this.#code();
        if (code === COMMA) {
          const comma = this.#pos;
          this.#pos++;
          this.#inlineGap();
          if (this.#code() === RIGHT_BRACE) {
            this.#toml11(comma, comma + 1, 'a trailing comma in an inline table');
            break;
          }
          continue;
        }
        if (code === RIGHT_BRACE) break;
        if (this.#pos >= this.#length) {
          this.#fail(
            TOML_ISSUE.unterminatedInlineTable,
            'Unterminated inline table.',
            start,
            start + 1,
          );
        }
        this.#unexpected(
          TOML_ISSUE.expectedComma,
          'Expected "," or "}" in the inline table, found this.',
        );
      }
    }
    this.#pos++;
    table.end = this.#pos;
    return table;
  }

  // -------------------------------------------------------------------------------------------
  // Strings
  // -------------------------------------------------------------------------------------------

  #unterminated(start: number, end: number): never {
    this.#fail(TOML_ISSUE.unterminatedString, 'Unterminated string.', start, end);
  }

  /** `basic-string = quotation-mark *basic-char quotation-mark` */
  #basicString(): string {
    const text = this.#text;
    const start = this.#pos;
    let pos = start + 1;
    let chunk = pos;
    let out = '';
    for (;;) {
      if (pos >= this.#length) this.#unterminated(start, pos);
      const code = text.charCodeAt(pos);
      if (code === QUOTE) {
        this.#pos = pos + 1;
        return out + text.slice(chunk, pos);
      }
      if (code === BACKSLASH) {
        out += text.slice(chunk, pos);
        this.#pos = pos;
        out += this.#escape(false);
        pos = chunk = this.#pos;
        continue;
      }
      if (code === LF || code === CR) this.#unterminated(start, pos);
      pos += this.#textChar(pos, code);
    }
  }

  /** Skips the line break right after an opening `"""` or `'''`. */
  #skipFirstNewline(pos: number): number {
    const code = this.#codeAt(pos);
    if (code === LF) return pos + 1;
    if (code === CR) {
      if (this.#codeAt(pos + 1) === LF) return pos + 2;
      this.#bareCarriageReturn(pos);
    }
    return pos;
  }

  /**
   * Length of the closing delimiter at `pos` (a run of `quote`), with the one or two quotes
   * before it that belong to the content; 0 when fewer than three quotes follow. Longer runs
   * end the string after five quotes, and the parser rejects what is left.
   */
  #closing(pos: number, quote: number): number {
    let run = 1;
    while (run < 5 && this.#codeAt(pos + run) === quote) run++;
    return run >= 3 ? run : 0;
  }

  /** `ml-basic-string = ml-basic-string-delim [ newline ] ml-basic-body ml-basic-string-delim` */
  #multilineBasicString(): string {
    const text = this.#text;
    const start = this.#pos;
    let pos = this.#skipFirstNewline(start + 3);
    let chunk = pos;
    let out = '';
    for (;;) {
      if (pos >= this.#length) this.#unterminated(start, start + 3);
      const code = text.charCodeAt(pos);
      if (code === QUOTE) {
        const closing = this.#closing(pos, QUOTE);
        if (closing === 0) {
          pos++;
          continue;
        }
        this.#pos = pos + closing;
        return out + text.slice(chunk, pos + closing - 3);
      }
      if (code === BACKSLASH) {
        out += text.slice(chunk, pos);
        this.#pos = pos;
        out += this.#escape(true);
        pos = chunk = this.#pos;
        continue;
      }
      if (code === LF) {
        pos++;
        continue;
      }
      if (code === CR) {
        if (text.charCodeAt(pos + 1) !== LF) this.#bareCarriageReturn(pos);
        pos += 2;
        continue;
      }
      pos += this.#textChar(pos, code);
    }
  }

  /** `literal-string = apostrophe *literal-char apostrophe` */
  #literalString(): string {
    const text = this.#text;
    const start = this.#pos;
    let pos = start + 1;
    for (;;) {
      if (pos >= this.#length) this.#unterminated(start, pos);
      const code = text.charCodeAt(pos);
      if (code === APOSTROPHE) {
        this.#pos = pos + 1;
        return text.slice(start + 1, pos);
      }
      if (code === LF || code === CR) this.#unterminated(start, pos);
      pos += this.#textChar(pos, code);
    }
  }

  /** `ml-literal-string = ml-literal-string-delim [ newline ] ml-literal-body ml-literal-string-delim` */
  #multilineLiteralString(): string {
    const text = this.#text;
    const start = this.#pos;
    let pos = this.#skipFirstNewline(start + 3);
    const content = pos;
    for (;;) {
      if (pos >= this.#length) this.#unterminated(start, start + 3);
      const code = text.charCodeAt(pos);
      if (code === APOSTROPHE) {
        const closing = this.#closing(pos, APOSTROPHE);
        if (closing === 0) {
          pos++;
          continue;
        }
        this.#pos = pos + closing;
        return text.slice(content, pos + closing - 3);
      }
      if (code === LF) {
        pos++;
        continue;
      }
      if (code === CR) {
        if (text.charCodeAt(pos + 1) !== LF) this.#bareCarriageReturn(pos);
        pos += 2;
        continue;
      }
      pos += this.#textChar(pos, code);
    }
  }

  /** An escape sequence at the current backslash; returns the text it stands for. */
  #escape(multiline: boolean): string {
    const start = this.#pos;
    const code = this.#codeAt(start + 1);
    this.#pos = start + 2;
    switch (code) {
      case 0x62: // b
        return '\b';
      case 0x74: // t
        return '\t';
      case 0x6e: // n
        return '\n';
      case 0x66: // f
        return '\f';
      case 0x72: // r
        return '\r';
      case QUOTE:
        return '"';
      case BACKSLASH:
        return '\\';
      case 0x75: // u
        return this.#unicode(start, 4);
      case 0x55: // U
        return this.#unicode(start, 8);
      case 0x65: // e
        this.#toml11(start, start + 2, 'the \\e escape');
        return '\u001b';
      case 0x78: {
        // x
        const value = this.#hex(start, 2);
        this.#toml11(start, start + 4, 'the \\x escape');
        return String.fromCharCode(value);
      }
      default:
        break;
    }
    if (multiline && (code === SPACE || code === TAB || code === LF || code === CR)) {
      this.#lineEndingBackslash(start);
      return '';
    }
    this.#fail(
      TOML_ISSUE.invalidEscape,
      'Invalid escape sequence; TOML allows \\b \\t \\n \\f \\r \\" \\\\ \\uXXXX and \\UXXXXXXXX.',
      start,
      Number.isNaN(code) ? start + 1 : start + 2,
    );
  }

  /** The value of `length` hex digits after `\u`, `\U` or `\x` at `start`. */
  #hex(start: number, length: number): number {
    const text = this.#text;
    let value = 0;
    for (let i = 0; i < length; i++) {
      const code = text.charCodeAt(start + 2 + i);
      if (!isHexDigit(code)) {
        this.#fail(
          TOML_ISSUE.invalidEscape,
          `Invalid escape sequence; expected ${length} hexadecimal digits.`,
          start,
          start + 2 + i,
        );
      }
      value = value * 16 + hexValue(code);
    }
    this.#pos = start + 2 + length;
    return value;
  }

  #unicode(start: number, length: number): string {
    const value = this.#hex(start, length);
    if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
      this.#fail(
        TOML_ISSUE.invalidUnicodeEscape,
        'Escape is not a Unicode scalar value (surrogates and values above U+10FFFF are not allowed).',
        start,
        start + 2 + length,
      );
    }
    return String.fromCodePoint(value);
  }

  /** `mlb-escaped-nl = escape ws newline *( wschar / newline )` */
  #lineEndingBackslash(start: number): void {
    const text = this.#text;
    let pos = start + 1;
    while (text.charCodeAt(pos) === SPACE || text.charCodeAt(pos) === TAB) pos++;
    const code = text.charCodeAt(pos);
    if (code === CR && text.charCodeAt(pos + 1) !== LF) this.#bareCarriageReturn(pos);
    if (code !== LF && code !== CR) {
      this.#fail(
        TOML_ISSUE.invalidEscape,
        'A backslash followed by spaces must end the line.',
        start,
        pos,
      );
    }
    for (;;) {
      const next = text.charCodeAt(pos);
      if (next === SPACE || next === TAB || next === LF) {
        pos++;
      } else if (next === CR) {
        if (text.charCodeAt(pos + 1) !== LF) this.#bareCarriageReturn(pos);
        pos += 2;
      } else {
        break;
      }
    }
    this.#pos = pos;
  }

  // -------------------------------------------------------------------------------------------
  // Booleans, numbers, date-times
  // -------------------------------------------------------------------------------------------

  #atom(depth: number, start: number): ScalarNode {
    const text = this.#text;
    let end = start;
    while (isAtomChar(text.charCodeAt(end))) end++;
    if (end === start) this.#unexpected(TOML_ISSUE.expectedValue, 'Expected a value, found this.');
    // A local date, a space and a time are one date-time: `1979-05-27 07:32:00`.
    if (
      end - start === 10 &&
      text.charCodeAt(start + 4) === MINUS &&
      text.charCodeAt(end) === SPACE &&
      isDigit(text.charCodeAt(end + 1)) &&
      isDigit(text.charCodeAt(end + 2)) &&
      text.charCodeAt(end + 3) === COLON
    ) {
      end++;
      while (isAtomChar(text.charCodeAt(end))) end++;
    }
    this.#pos = end;
    const token = text.slice(start, end);
    if (token === 'true' || token === 'false') {
      return this.#scalar(depth, start, 'boolean', token === 'true', undefined);
    }
    const datetime =
      (isDigit(token.charCodeAt(0)) &&
        isDigit(token.charCodeAt(1)) &&
        isDigit(token.charCodeAt(2)) &&
        isDigit(token.charCodeAt(3)) &&
        token.charCodeAt(4) === MINUS) ||
      (isDigit(token.charCodeAt(0)) &&
        isDigit(token.charCodeAt(1)) &&
        token.charCodeAt(2) === COLON);
    if (datetime) {
      const value = this.#datetime(token, start, end);
      return this.#scalar(depth, start, value.kind, value, undefined);
    }
    return this.#number(depth, token, start, end);
  }

  #invalidNumber(token: string, start: number, end: number): never {
    const first = token.charCodeAt(0);
    if (isLetter(first) || first === UNDERSCORE) {
      this.#fail(
        TOML_ISSUE.invalidValue,
        'Invalid value; strings need quotes, and booleans are lowercase true or false.',
        start,
        end,
      );
    }
    this.#fail(TOML_ISSUE.invalidNumber, 'Invalid number.', start, end);
  }

  /** `integer`, `float` and `special-float`. */
  #number(depth: number, token: string, start: number, end: number): ScalarNode {
    const first = token.charCodeAt(0);
    const negative = first === MINUS;
    const offset = negative || first === PLUS ? 1 : 0;
    const body = offset === 0 ? token : token.slice(1);
    if (body === 'inf') {
      return this.#scalar(depth, start, 'float', negative ? -Infinity : Infinity, undefined);
    }
    if (body === 'nan') return this.#scalar(depth, start, 'float', Number.NaN, undefined);
    if (body.charCodeAt(0) === ZERO) {
      const prefix = body.charCodeAt(1);
      const radix = prefix === 0x78 ? 16 : prefix === 0x6f ? 8 : prefix === 0x62 ? 2 : 0;
      if (radix !== 0) {
        if (offset === 1) {
          this.#fail(
            TOML_ISSUE.invalidNumber,
            'Hexadecimal, octal and binary integers cannot have a sign.',
            start,
            end,
          );
        }
        return this.#radixInteger(depth, token, radix, start, end);
      }
    }
    let i = digitRun(token, offset, isDigit);
    if (i < 0) this.#invalidNumber(token, start, end);
    if (token.charCodeAt(offset) === ZERO && i - offset > 1) {
      this.#fail(
        TOML_ISSUE.leadingZero,
        'Leading zeros are not allowed in decimal numbers.',
        start,
        end,
      );
    }
    let float = false;
    if (token.charCodeAt(i) === DOT) {
      i = digitRun(token, i + 1, isDigit);
      if (i < 0) this.#invalidNumber(token, start, end);
      float = true;
    }
    const exponent = token.charCodeAt(i);
    if (exponent === 0x65 || exponent === 0x45) {
      i++;
      const sign = token.charCodeAt(i);
      if (sign === PLUS || sign === MINUS) i++;
      i = digitRun(token, i, isDigit);
      if (i < 0) this.#invalidNumber(token, start, end);
      float = true;
    }
    if (i !== token.length) this.#invalidNumber(token, start, end);
    const clean = token.includes('_') ? token.replaceAll('_', '') : token;
    if (float) {
      const value = Number(clean);
      if (!Number.isFinite(value)) {
        this.#fail(
          TOML_ISSUE.floatOverflow,
          'The float is too large: it overflows a 64-bit float.',
          start,
          end,
        );
      }
      return this.#scalar(depth, start, 'float', value, undefined);
    }
    const digits = offset === 0 ? clean : clean.slice(1);
    if (
      digits.length > 19 ||
      (digits.length === 19 && digits > (negative ? I64_MIN_DIGITS : I64_MAX_DIGITS))
    ) {
      this.#fail(
        TOML_ISSUE.integerOverflow,
        'The integer does not fit in a 64-bit signed integer.',
        start,
        end,
      );
    }
    const exact = negative && digits !== '0' ? `-${digits}` : digits;
    return this.#scalar(depth, start, 'integer', Number(exact), exact);
  }

  /** `hex-int`, `oct-int` and `bin-int`. */
  #radixInteger(
    depth: number,
    token: string,
    radix: 16 | 8 | 2,
    start: number,
    end: number,
  ): ScalarNode {
    const valid = radix === 16 ? isHexDigit : radix === 8 ? isOctalDigit : isBinaryDigit;
    if (digitRun(token, 2, valid) !== token.length) this.#invalidNumber(token, start, end);
    let significant = token.slice(2).replaceAll('_', '');
    let zeros = 0;
    while (zeros < significant.length - 1 && significant.charCodeAt(zeros) === ZERO) zeros++;
    significant = significant.slice(zeros).toLowerCase();
    const maxDigits = radix === 16 ? 16 : radix === 8 ? 21 : 63;
    if (
      significant.length > maxDigits ||
      (radix === 16 && significant.length === 16 && significant.charCodeAt(0) > 0x37)
    ) {
      this.#fail(
        TOML_ISSUE.integerOverflow,
        'The integer does not fit in a 64-bit signed integer.',
        start,
        end,
      );
    }
    const value = Number.parseInt(significant, radix);
    const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : '0b';
    const digits = Number.isSafeInteger(value)
      ? String(value)
      : BigInt(prefix + significant).toString();
    return this.#scalar(depth, start, 'integer', value, digits);
  }

  /** `date-time = offset-date-time / local-date-time / local-date / local-time` */
  #datetime(token: string, start: number, end: number): TomlDatetime {
    const invalid = (detail: string): never =>
      this.#fail(TOML_ISSUE.invalidDatetime, `Invalid date or time: ${detail}.`, start, end);
    const number = (at: number, length: number): number => {
      let value = 0;
      for (let i = at; i < at + length; i++) {
        const code = token.charCodeAt(i);
        if (!isDigit(code)) invalid('expected a digit');
        value = value * 10 + code - ZERO;
      }
      return value;
    };
    let i = 0;
    let date = '';
    if (token.charCodeAt(4) === MINUS) {
      const year = number(0, 4);
      const month = number(5, 2);
      if (token.charCodeAt(7) !== MINUS) invalid('expected YYYY-MM-DD');
      const day = number(8, 2);
      if (month < 1 || month > 12) invalid('the month must be 01 to 12');
      if (day < 1 || day > daysInMonth(year, month)) invalid('no such day in that month');
      date = token.slice(0, 10);
      i = 10;
      if (i === token.length) return new TomlDatetime('local-date', date);
      const delimiter = token.charCodeAt(i);
      if (delimiter !== 0x54 && delimiter !== 0x74 && delimiter !== SPACE) {
        invalid('expected T or a space between the date and the time');
      }
      i++;
    }
    const hour = number(i, 2);
    if (token.charCodeAt(i + 2) !== COLON) invalid('expected HH:MM:SS');
    const minute = number(i + 3, 2);
    i += 5;
    let second = 0;
    let fraction = '';
    if (token.charCodeAt(i) === COLON) {
      second = number(i + 1, 2);
      i += 3;
      if (token.charCodeAt(i) === DOT) {
        const fractionStart = ++i;
        while (isDigit(token.charCodeAt(i))) i++;
        if (i === fractionStart) invalid('expected digits after the decimal point');
        fraction = token.slice(fractionStart, Math.min(i, fractionStart + 9)).padEnd(9, '0');
        let trimmed = fraction.length;
        while (trimmed > 0 && fraction.charCodeAt(trimmed - 1) === ZERO) trimmed--;
        fraction = trimmed === 0 ? '' : `.${fraction.slice(0, trimmed)}`;
      }
    } else {
      this.#toml11(start, end, 'a time without seconds');
    }
    if (hour > 23) invalid('the hour must be 00 to 23');
    if (minute > 59) invalid('the minute must be 00 to 59');
    if (second > 60) invalid('the second must be 00 to 60');
    const time = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}${fraction}`;
    if (date === '') {
      if (i !== token.length) invalid('a local time has no offset');
      return new TomlDatetime('local-time', time);
    }
    const local = `${date}T${time}`;
    if (i === token.length) return new TomlDatetime('local-datetime', local);
    const sign = token.charCodeAt(i);
    if (sign === 0x5a || sign === 0x7a) {
      if (i + 1 !== token.length) invalid('unexpected text after the offset');
      return new TomlDatetime('offset-datetime', `${local}Z`);
    }
    if (sign !== PLUS && sign !== MINUS) invalid('expected Z or an offset such as +01:00');
    const offsetHours = number(i + 1, 2);
    if (token.charCodeAt(i + 3) !== COLON) invalid('expected an offset such as +01:00');
    const offsetMinutes = number(i + 4, 2);
    if (i + 6 !== token.length) invalid('unexpected text after the offset');
    if (offsetHours > 23) invalid('the offset hours must be 00 to 23');
    if (offsetMinutes > 59) invalid('the offset minutes must be 00 to 59');
    // toml_datetime keeps the offset in minutes, so -00:00 displays as +00:00.
    const zero = offsetHours === 0 && offsetMinutes === 0;
    const offset = `${sign === MINUS && !zero ? '-' : '+'}${pad2(offsetHours)}:${pad2(offsetMinutes)}`;
    return new TomlDatetime('offset-datetime', local + offset);
  }
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * End of a run of digits starting at `start` in which each underscore sits between two digits,
 * or -1 when there is no digit at `start` or an underscore is misplaced.
 */
function digitRun(token: string, start: number, valid: (code: number) => boolean): number {
  if (!valid(token.charCodeAt(start))) return -1;
  let i = start + 1;
  for (;;) {
    const code = token.charCodeAt(i);
    if (valid(code)) {
      i++;
    } else if (code === UNDERSCORE) {
      if (!valid(token.charCodeAt(i + 1))) return -1;
      i += 2;
    } else {
      return i;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** The member of `table` under `name`. The index is built on the first lookup. */
function member(table: TableNode, name: string): Node | undefined {
  if (table.index === undefined) {
    const index = new Map<string, Node>();
    for (const child of table.members) index.set(child.segment as string, child);
    table.index = index;
  }
  return table.index.get(name);
}

function find(root: TableNode, path: readonly JsonPathSegment[]): Node | undefined {
  let node: Node | undefined = root;
  for (const segment of path) {
    if (node === undefined) return undefined;
    if (typeof segment === 'string') {
      node = node.kind === 'table' ? member(node, segment) : undefined;
    } else if (node.kind === 'array' && Number.isInteger(segment) && segment >= 0) {
      node = node.items[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

function pathOf(node: Node): JsonPathSegment[] {
  const segments: JsonPathSegment[] = [];
  for (let current: Node | undefined = node; current?.segment !== undefined;) {
    segments.push(current.segment);
    current = current.parent;
  }
  return segments.reverse();
}

function tomlType(node: Node): TomlValueType {
  return node.kind === 'scalar' ? node.type : node.kind;
}

function jsonType(node: Node): JsonLocation['type'] {
  if (node.kind === 'table') return 'object';
  if (node.kind === 'array') return 'array';
  switch (node.type) {
    case 'integer':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
    case 'offset-datetime':
    case 'local-datetime':
    case 'local-date':
    case 'local-time':
      return 'string';
  }
}

function scalarText(node: ScalarNode): string {
  const { value } = node;
  if (node.digits !== undefined) return node.digits;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
    return JSON.stringify(value);
  }
  if (value instanceof TomlDatetime) return JSON.stringify(value.text);
  return JSON.stringify(value);
}

/**
 * Canonical text of a value, as {@link JsonLocation.canonical} describes, cut after
 * MAX_CANONICAL_LENGTH characters. Recursion is bounded by MAX_TOML_DEPTH.
 */
function canonicalText(node: Node): string {
  if (node.kind === 'scalar') return scalarText(node);
  const parts: string[] = [];
  let length = 0;
  const push = (part: string): boolean => {
    parts.push(part);
    length += part.length;
    return length < MAX_CANONICAL_LENGTH;
  };
  const visit = (current: Node): boolean => {
    if (current.kind === 'scalar') return push(scalarText(current));
    if (current.kind === 'array') {
      if (!push('[')) return false;
      let first = true;
      for (const item of current.items) {
        if ((!first && !push(',')) || !visit(item)) return false;
        first = false;
      }
      return push(']');
    }
    if (!push('{')) return false;
    let first = true;
    const members = [...current.members].sort((a, b) =>
      compareStrings(String(a.segment), String(b.segment)),
    );
    for (const child of members) {
      if (!push(`${first ? '' : ','}${JSON.stringify(child.segment)}:`) || !visit(child)) {
        return false;
      }
      first = false;
    }
    return push('}');
  };
  visit(node);
  const text = parts.join('');
  return text.length > MAX_CANONICAL_LENGTH ? text.slice(0, MAX_CANONICAL_LENGTH) : text;
}

function locationOf(node: Node): TomlLocation {
  if (node.location !== undefined) return node.location;
  let canonical: string | undefined;
  const location: TomlLocation = {
    path: pathOf(node),
    type: jsonType(node),
    tomlType: tomlType(node),
    inArray: node.parent?.kind === 'array',
    canonical: () => (canonical ??= canonicalText(node)),
  };
  node.location = location;
  return location;
}

/**
 * `locate` over the recorded spans. The spans nest (a value inside its pair, a pair inside its
 * table body), so after sorting by start, the innermost span containing a query is the last
 * span starting at or before it, or one of that span's ancestors. Built on the first call.
 */
class Locator {
  readonly #entries: Entries;
  readonly #length: number;
  #order: Int32Array | undefined;
  #parents: Int32Array | undefined;

  constructor(entries: Entries, length: number) {
    this.#entries = entries;
    this.#length = length;
  }

  #build(): { order: Int32Array; parents: Int32Array } {
    const { starts, ends } = this.#entries;
    const count = starts.length;
    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    // Outer spans first. Of equal spans the root, recorded first, is innermost: a pair that
    // fills the whole text must not hide it.
    order.sort(
      (a, b) => (starts[a] ?? 0) - (starts[b] ?? 0) || (ends[b] ?? 0) - (ends[a] ?? 0) || b - a,
    );
    const parents = new Int32Array(count).fill(-1);
    const stack: number[] = [];
    for (const entry of order) {
      const end = ends[entry] ?? 0;
      while (stack.length > 0 && end > (ends[stack[stack.length - 1] ?? 0] ?? 0)) stack.pop();
      parents[entry] = stack[stack.length - 1] ?? -1;
      stack.push(entry);
    }
    this.#order = order;
    this.#parents = parents;
    return { order, parents };
  }

  locate(span: Span): TomlLocation | undefined {
    const start = span.offset;
    const end = span.offset + span.length;
    if (!(start >= 0 && start <= end && end <= this.#length)) return undefined;
    const built =
      this.#order !== undefined && this.#parents !== undefined
        ? { order: this.#order, parents: this.#parents }
        : this.#build();
    const { order, parents } = built;
    const { starts, ends, targets } = this.#entries;
    let low = 0;
    let high = order.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((starts[order[mid] ?? 0] ?? 0) <= start) low = mid + 1;
      else high = mid;
    }
    for (let entry = order[low - 1] ?? -1; entry !== -1; entry = parents[entry] ?? -1) {
      if ((starts[entry] ?? 0) <= start && end <= (ends[entry] ?? 0)) {
        const target = targets[entry];
        return target === undefined ? undefined : locationOf(target);
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function failure(code: string, message: string, span: Span): TomlDocument {
  return { ok: false, errors: [{ code, message, span }] };
}

/**
 * Parses TOML 1.0. Never throws on any input. Pass the file's decoding as `source` (an
 * artifact's `decoded` works) so a byte order mark or UTF-16 text is reported, not parsed.
 */
export function parseToml(text: string, source: TomlSource = {}): TomlDocument {
  const start: Span = { offset: 0, length: 0 };
  if (source.encoding !== undefined && source.encoding !== 'utf-8') {
    return failure(
      TOML_ISSUE.utf16,
      'The file is UTF-16; TOML files must be UTF-8, and agentcheckup did not read this one.',
      start,
    );
  }
  if (source.hasBom === true || text.charCodeAt(0) === 0xfeff) {
    return failure(
      TOML_ISSUE.bom,
      'The file starts with a byte order mark; agentcheckup did not read it.',
      source.hasBom === true ? start : { offset: 0, length: 1 },
    );
  }
  if (text.length > MAX_TOML_LENGTH) {
    return failure(
      TOML_ISSUE.tooLarge,
      `TOML text is ${formatInteger(text.length)} characters; the limit is ${formatInteger(MAX_TOML_LENGTH)}.`,
      start,
    );
  }
  const parser = new Parser(text);
  try {
    parser.parse();
  } catch (error) {
    if (error instanceof Stop) return { ok: false, errors: [error.issue] };
    // Backstop: a bug must not crash the scan.
    const name = error instanceof Error ? error.name : 'Error';
    return failure(TOML_ISSUE.parseFailed, `TOML parser failed (${name}).`, start);
  }
  if (parser.toml11 !== undefined) {
    return failure(
      TOML_ISSUE.unsupported,
      `This file uses TOML 1.1 syntax (${parser.toml11.what}), which agentcheckup does not read yet.`,
      parser.toml11.span,
    );
  }
  // Swap the nodes in each table's value object for their values, then freeze.
  for (const table of parser.tables) {
    const { value } = table;
    for (const child of table.members) value[child.segment as string] = child.value;
    Object.freeze(value);
  }
  for (const array of parser.arrays) Object.freeze(array.value);
  const { root } = parser;
  const locator = new Locator(parser.entries, text.length);
  return {
    ok: true,
    value: root.value,
    warnings: [],
    valueSpan: (path) => {
      const node = find(root, path);
      return node === undefined ? undefined : { offset: node.start, length: node.end - node.start };
    },
    keySpan: (path) => {
      const node = typeof path[path.length - 1] === 'string' ? find(root, path) : undefined;
      return node === undefined || node.keyStart < 0
        ? undefined
        : { offset: node.keyStart, length: node.keyEnd - node.keyStart };
    },
    locate: (span) => locator.locate(span),
  };
}
