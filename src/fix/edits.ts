/**
 * Builders for the changes a rule attaches to a finding (`Fix.changes`). Rules call them instead
 * of computing offsets by hand, so every fix keeps the file's style and cannot inject content.
 *
 * Every builder:
 * - works on an artifact's decoded text (BOM removed), with offsets in UTF-16 code units, as
 *   `TextEdit` defines; the applier encodes the result with the file's own encoding, byte order
 *   mark, line endings and final newline;
 * - takes the line ending, indentation and quote style from the neighboring lines;
 * - returns a {@link FileChange} for `Fix.changes`.
 *
 * Builders that edit structured text (YAML frontmatter, JSON) parse their result again and return
 * `undefined` when the edit would not give exactly the intended value, would change another
 * value, or would delete a comment. The rule then offers no fix, or a manual step. They throw a
 * RangeError only for arguments a rule controls: a span outside the text, a key that is not a
 * plain identifier, a line with a line break, a path that is not normalized.
 *
 * Copied content (ADR 0008): text taken from the repository goes through {@link safeCopiedText}
 * and is written as a quoted string ({@link quoteYaml} with `style: 'double'`, {@link quoteJson});
 * names derived from content go through {@link skillSlug}.
 *
 * Pure. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 */
import { type Node as JsonNode, parseTree, type ParseError } from 'jsonc-parser';
import { parseFrontmatter } from '../parse/frontmatter.js';
import { parseJsonWithComments } from '../parse/json.js';
import type { FrontmatterResult } from '../parse/types.js';
import type { Artifact, FileChange, Span, TextEdit } from '../core/types.js';
import { pathProblem } from './paths.js';
import {
  applyEdits,
  type Eol,
  editProblem,
  eolNear,
  hasLineBreak,
  indentAt,
  lineEndAfter,
  lineStartBefore,
  roundTrips,
  withEol,
} from './text.js';

type EditChange = Extract<FileChange, { kind: 'edit' }>;

function editChange(artifact: Artifact, edits: readonly TextEdit[]): EditChange {
  return { kind: 'edit', path: artifact.path, edits };
}

function checkPath(path: string): void {
  const problem = pathProblem(path);
  if (problem !== undefined) throw new RangeError(`Invalid fix path: ${problem}.`);
}

function checkSpan(artifact: Artifact, span: Span): void {
  const { offset, length } = span;
  const size = artifact.decoded.text.length;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  ) {
    throw new RangeError(`Span ${offset}+${length} is outside the text (${size} code units).`);
  }
}

function checkSingleLine(text: string, what: string): void {
  if (hasLineBreak(text) || text.includes('\u2028') || text.includes('\u2029')) {
    throw new RangeError(`${what} must be one line.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Lines and spans
// ---------------------------------------------------------------------------------------------

export interface InsertLineOptions {
  /**
   * Separate the new line from the line after it with an empty line, as `@AGENTS.md` before a
   * heading. Nothing is added at the end of the file or when that line is already blank.
   */
  readonly blankAfter?: boolean;
  /** Separate the new line from the line before it with an empty line. Same exceptions. */
  readonly blankBefore?: boolean;
}

/** Number of lines: a final line break does not start another line. */
function lineCount(text: string, lineStarts: readonly number[]): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? lineStarts.length - 1 : lineStarts.length;
}

function isBlankLine(text: string, lineStarts: readonly number[], index: number): boolean {
  const start = lineStarts[index];
  if (start === undefined) return false;
  return lineEndAfter(text, start) === start + indentAt(text, start).length;
}

/**
 * Inserts `line` so that it becomes line `index` (0-based) of the file: before the current line
 * `index`, or after the last line when `index` equals the number of lines. The new line ends
 * with the ending of the line it is inserted before, or of the nearest line above it (LF in a
 * file without line breaks). Appending to a file without a final newline keeps it without one.
 *
 * Example: `insertLine(claudeMd, 0, '@AGENTS.md', { blankAfter: true })` adds an import and an
 * empty line at the top of CLAUDE.md.
 */
export function insertLine(
  artifact: Artifact,
  index: number,
  line: string,
  options: InsertLineOptions = {},
): FileChange {
  checkSingleLine(line, 'The inserted line');
  const { text, lineStarts } = artifact.decoded;
  const count = lineCount(text, lineStarts);
  if (!Number.isSafeInteger(index) || index < 0 || index > count) {
    throw new RangeError(`Line index ${index} is outside 0..${count}.`);
  }
  if (index < count) {
    const offset = lineStarts[index] ?? 0;
    const eol = eolNear(artifact.decoded, offset);
    const before =
      options.blankBefore === true && index > 0 && !isBlankLine(text, lineStarts, index - 1)
        ? eol
        : '';
    const after = options.blankAfter === true && !isBlankLine(text, lineStarts, index) ? eol : '';
    return editChange(artifact, [{ offset, length: 0, text: `${before}${line}${eol}${after}` }]);
  }
  const offset = text.length;
  if (count === 0) return editChange(artifact, [{ offset, length: 0, text: `${line}\n` }]);
  const eol = eolNear(artifact.decoded, Math.max(0, offset - 1));
  const before =
    options.blankBefore === true && !isBlankLine(text, lineStarts, count - 1) ? eol : '';
  const inserted = text.endsWith('\n') ? `${before}${line}${eol}` : `${eol}${before}${line}`;
  return editChange(artifact, [{ offset, length: 0, text: inserted }]);
}

/**
 * Replaces `span` with `text`. Line breaks in `text` take the ending of the line at the span, so
 * rules may write `\n`.
 */
export function replaceSpan(artifact: Artifact, span: Span, text: string): FileChange {
  checkSpan(artifact, span);
  const eol = eolNear(artifact.decoded, span.offset);
  return editChange(artifact, [
    { offset: span.offset, length: span.length, text: withEol(text, eol) },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** Renames the artifact's file to `to`, a normalized path relative to the scan root. */
export function renameFile(artifact: Artifact, to: string): FileChange {
  checkPath(to);
  return { kind: 'rename', from: artifact.path, to };
}

/**
 * Creates a file at `path` (a normalized path relative to the scan root) holding `text`, in UTF-8
 * without a byte order mark and with LF line endings. A final newline is added when missing.
 */
export function createFile(path: string, text: string): FileChange {
  checkPath(path);
  const lf = withEol(text, '\n');
  return { kind: 'create', path, text: lf.length === 0 || lf.endsWith('\n') ? lf : `${lf}\n` };
}

/**
 * Re-encodes the artifact's file as UTF-8 without a byte order mark, keeping its text and line
 * endings. Undefined when it already is, or when its bytes did not decode cleanly: such files
 * are never edited.
 */
export function reencode(artifact: Artifact): FileChange | undefined {
  const { decoded, file } = artifact;
  if (!roundTrips(file.bytes, decoded)) return undefined;
  if (decoded.encoding === 'utf-8' && !decoded.hasBom) return undefined;
  return { kind: 'encoding', path: artifact.path, to: 'utf-8', bom: false };
}

// ---------------------------------------------------------------------------------------------
// Copied and derived text
// ---------------------------------------------------------------------------------------------

/** Default bound of {@link safeCopiedText}, in code points. */
export const MAX_COPIED_LENGTH = 200;

/** Format characters that render as nothing or reorder text, and noncharacters. */
function isHiddenCodePoint(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x061c ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x17b4 ||
    code === 0x17b5 ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0x3164 ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff9 && code <= 0xfffb) ||
    code === 0xfffe ||
    code === 0xffff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/** C0 and C1 control characters, DEL, and lone surrogates. */
function isControlCodePoint(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
}

/**
 * Text copied from the repository into a fix, made safe to embed: trimmed, cut to `maxLength`
 * code points, and refused (undefined) when it is empty or contains a line break, a control
 * character, a bidirectional control, a tag character, or another invisible format character.
 * The result is one plain line; write it as a quoted string with {@link quoteYaml} (style
 * `double`) or {@link quoteJson}.
 */
export function safeCopiedText(text: string, maxLength = MAX_COPIED_LENGTH): string | undefined {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer.');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const kept: string[] = [];
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (isControlCodePoint(code) || isHiddenCodePoint(code) || code === 0x85) return undefined;
    if (kept.length < maxLength) kept.push(char);
  }
  const result = kept.join('').trimEnd();
  return result.length === 0 ? undefined : result;
}

/** Longest skill name Agent Skills allow. */
export const MAX_SKILL_NAME_LENGTH = 64;

function trimHyphens(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x2d) start++;
  while (end > start && text.charCodeAt(end - 1) === 0x2d) end--;
  return text.slice(start, end);
}

/**
 * A skill name derived from `text`: NFKC-normalized and lowercased; every run of characters
 * outside `a-z0-9` becomes one hyphen; leading and trailing hyphens are removed; a result longer
 * than 64 characters is cut at the last hyphen within the limit. Characters outside ASCII are
 * dropped, so a rule offers the result only when the name had none. May return `''`.
 */
export function skillSlug(text: string): string {
  const slug = trimHyphens(
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-'),
  );
  if (slug.length <= MAX_SKILL_NAME_LENGTH) return slug;
  const head = slug.slice(0, MAX_SKILL_NAME_LENGTH);
  if (slug.charCodeAt(MAX_SKILL_NAME_LENGTH) === 0x2d) return trimHyphens(head);
  const hyphen = head.lastIndexOf('-');
  return trimHyphens(hyphen > 0 ? head.slice(0, hyphen) : head);
}

// ---------------------------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------------------------

/** How a YAML string is written. */
export type YamlStyle = 'plain' | 'single' | 'double';

/** A value a YAML builder writes. Numbers must be finite. */
export type YamlScalar = string | number | boolean | null;

/** Plain scalars every YAML 1.1 and 1.2 parser reads as this same string. */
const PLAIN_YAML = /^[a-z_][\w./-]*(?: [\w./-]+)*$/i;

/** Words YAML 1.1 or 1.2 reads as a boolean or null. */
const YAML_KEYWORDS: ReadonlySet<string> = new Set([
  'y',
  'yes',
  'n',
  'no',
  'on',
  'off',
  'true',
  'false',
  'null',
]);

function hex(code: number, digits: number): string {
  return code.toString(16).toUpperCase().padStart(digits, '0');
}

/** True for code points a quoted string escapes so they stay visible. */
function needsEscape(code: number): boolean {
  return isControlCodePoint(code) || isHiddenCodePoint(code) || code === 0x85;
}

function yamlDoubleQuoted(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\t') out += '\\t';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (!needsEscape(code)) out += char;
    else if (code <= 0xff) out += `\\x${hex(code, 2)}`;
    else if (code <= 0xffff) out += `\\u${hex(code, 4)}`;
    else out += `\\U${hex(code, 8)}`;
  }
  return `${out}"`;
}

function canSingleQuote(value: string): boolean {
  for (const char of value) if (needsEscape(char.codePointAt(0) ?? 0)) return false;
  return true;
}

/**
 * A YAML scalar for `value` that every YAML 1.1 and 1.2 parser reads back as the same string:
 * plain when it is a simple word or phrase, double-quoted when a parser could read it as
 * something else (`on`, `yes`, `null`, `1e3`, `2026-10-16`), when it has YAML syntax (`: `,
 * `#`, a leading `-`), or when it has control or invisible characters, which are escaped.
 * `style: 'double'` always quotes; `style: 'single'` single-quotes unless escapes are needed.
 */
export function quoteYaml(value: string, style: YamlStyle = 'plain'): string {
  if (style === 'single' && canSingleQuote(value)) return `'${value.replaceAll("'", "''")}'`;
  if (style === 'plain' && PLAIN_YAML.test(value) && !YAML_KEYWORDS.has(value.toLowerCase())) {
    return value;
  }
  return yamlDoubleQuoted(value);
}

/**
 * A JSON string literal for `value`. Escapes what JSON requires, and also DEL, C1 controls, lone
 * surrogates, and bidirectional, tag and other invisible characters, so they stay visible in the
 * file and in diffs.
 */
export function quoteJson(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (!needsEscape(code)) out += char;
    else {
      for (let i = 0; i < char.length; i++) out += `\\u${hex(char.charCodeAt(i), 4).toLowerCase()}`;
    }
  }
  return `${out}"`;
}

function yamlScalarText(value: YamlScalar, style: YamlStyle): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('YAML numbers must be finite.');
    return String(value);
  }
  return quoteYaml(value, style);
}

// ---------------------------------------------------------------------------------------------
// YAML frontmatter
// ---------------------------------------------------------------------------------------------

/** Keys YAML builders write: plain identifiers. */
const YAML_KEY = /^[a-z_][\w-]*$/i;

function checkYamlKey(key: string): void {
  if (!YAML_KEY.test(key) || key.length > 128) {
    throw new RangeError(`"${key.slice(0, 40)}" is not a plain YAML key.`);
  }
}

type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies `edits` and parses the frontmatter again: the change stands only when the new
 * frontmatter is valid, has exactly the expected keys, `expected` values, and every other value
 * unchanged.
 */
function checkedFrontmatterEdit(
  artifact: Artifact,
  before: ValidFrontmatter | undefined,
  edits: readonly TextEdit[],
  expected: ReadonlyMap<string, YamlScalar>,
): FileChange | undefined {
  const text = applyEdits(artifact.decoded.text, edits);
  const after = parseFrontmatter(text);
  if (after.kind !== 'valid') return undefined;
  const keys = [...(before?.data.keys ?? [])];
  for (const key of expected.keys()) if (!keys.includes(key)) keys.push(key);
  const afterKeys = after.data.keys;
  if (afterKeys.length !== keys.length || keys.some((key) => !afterKeys.includes(key))) {
    return undefined;
  }
  for (const key of keys) {
    const value = after.data.values[key];
    const wanted = expected.has(key) ? expected.get(key) : before?.data.values[key];
    if (!sameValue(value, wanted)) return undefined;
  }
  return editChange(artifact, edits);
}

/** Style of an existing scalar from its first character; undefined for anything but a scalar. */
function existingStyle(raw: string): YamlStyle | undefined {
  if (raw.length === 0 || hasLineBreak(raw)) return undefined;
  const first = raw.charAt(0);
  if (first === "'") return 'single';
  if (first === '"') return 'double';
  if ('|>[{&*!'.includes(first)) return undefined;
  return 'plain';
}

export interface YamlValueOptions {
  /**
   * How to write a string. Default: the style of the value being replaced (plain for a new key),
   * quoting when plain would be read as something else.
   */
  readonly style?: YamlStyle;
}

/**
 * Sets the value of top-level frontmatter key `key` to a scalar, replacing only the value and
 * keeping its quote style (`name: "x"` stays double-quoted). Undefined when the frontmatter is
 * not valid, the key is absent (use {@link yamlInsertKey}), or the current value is not a
 * one-line scalar (a block scalar, a list, an alias).
 */
export function yamlSetScalar(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
  value: YamlScalar,
  options: YamlValueOptions = {},
): FileChange | undefined {
  checkYamlKey(key);
  if (frontmatter.kind !== 'valid') return undefined;
  const { text } = artifact.decoded;
  const keySpan = frontmatter.data.keySpan(key);
  if (keySpan === undefined) return undefined;
  const valueSpan = frontmatter.data.valueSpan(key);
  let edit: TextEdit;
  if (valueSpan === undefined || valueSpan.length === 0) {
    // `key:` with an empty value: write after the colon.
    let colon = keySpan.offset + keySpan.length;
    while (text.charAt(colon) === ' ' || text.charAt(colon) === '\t') colon++;
    if (text.charAt(colon) !== ':') return undefined;
    let end = colon + 1;
    while (text.charAt(end) === ' ' || text.charAt(end) === '\t') end++;
    const scalar = yamlScalarText(value, options.style ?? 'plain');
    const gap = text.charAt(end) === '#' ? ' ' : '';
    edit = { offset: colon + 1, length: end - colon - 1, text: ` ${scalar}${gap}` };
  } else {
    const raw = text.slice(valueSpan.offset, valueSpan.offset + valueSpan.length);
    const style = existingStyle(raw);
    if (style === undefined) return undefined;
    edit = {
      offset: valueSpan.offset,
      length: valueSpan.length,
      text: yamlScalarText(value, options.style ?? style),
    };
  }
  return checkedFrontmatterEdit(artifact, frontmatter, [edit], new Map([[key, value]]));
}

/** Where {@link yamlInsertKey} puts the new key. */
export type YamlPosition = 'first' | 'last' | { readonly after: string };

export interface YamlInsertOptions extends YamlValueOptions {
  /** Default `last`: before the closing `---`. */
  readonly position?: YamlPosition;
}

/**
 * Adds `key: value` to the frontmatter as a new line, indented like the other top-level keys and
 * ending like the line before it. Undefined when the frontmatter is not valid, already has the
 * key, is a flow mapping (`{a: 1}`), or `after` names a missing key.
 */
export function yamlInsertKey(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
  value: YamlScalar,
  options: YamlInsertOptions = {},
): FileChange | undefined {
  checkYamlKey(key);
  if (frontmatter.kind !== 'valid') return undefined;
  const { data, span } = frontmatter;
  if (data.keySpan(key) !== undefined) return undefined;
  const { decoded } = artifact;
  const { text } = decoded;
  const yamlStart = text.indexOf('\n') + 1;
  const closingStart = lineStartBefore(text, span.offset + span.length);

  const firstKey = data.keys[0];
  const firstSpan = firstKey === undefined ? undefined : data.keySpan(firstKey);
  let indent = '';
  if (firstSpan !== undefined) {
    const lineStart = lineStartBefore(text, firstSpan.offset);
    indent = text.slice(lineStart, firstSpan.offset);
    if (indent.trim() !== '') return undefined;
  }

  const position = options.position ?? 'last';
  let offset: number;
  if (position === 'last') {
    offset = closingStart;
  } else if (position === 'first') {
    offset = firstSpan === undefined ? yamlStart : lineStartBefore(text, firstSpan.offset);
  } else {
    const anchor = data.valueSpan(position.after) ?? data.keySpan(position.after);
    if (anchor === undefined || data.keySpan(position.after) === undefined) return undefined;
    const newline = text.indexOf('\n', anchor.offset + anchor.length);
    if (newline === -1 || newline >= closingStart) offset = closingStart;
    else offset = newline + 1;
  }
  const eol: Eol = eolNear(decoded, Math.max(0, offset - 1));
  const line = `${indent}${key}: ${yamlScalarText(value, options.style ?? 'plain')}${eol}`;
  return checkedFrontmatterEdit(
    artifact,
    frontmatter,
    [{ offset, length: 0, text: line }],
    new Map([[key, value]]),
  );
}

/** One key of a new frontmatter block. */
export interface YamlEntry {
  readonly key: string;
  readonly value: YamlScalar;
  readonly style?: YamlStyle;
}

/**
 * Adds a frontmatter block with `entries` at the top of a file that has none, with the line
 * ending of the file's first line. Undefined when the file already starts a frontmatter block
 * (valid, invalid, unclosed or in another language), or `entries` is empty or repeats a key.
 */
export function prependFrontmatter(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  entries: readonly YamlEntry[],
): FileChange | undefined {
  for (const entry of entries) checkYamlKey(entry.key);
  if (frontmatter.kind !== 'absent' || entries.length === 0) return undefined;
  const expected = new Map(entries.map((entry) => [entry.key, entry.value]));
  if (expected.size !== entries.length) return undefined;
  const eol = eolNear(artifact.decoded, 0);
  const lines = entries.map(
    (entry) => `${entry.key}: ${yamlScalarText(entry.value, entry.style ?? 'plain')}${eol}`,
  );
  const block = `---${eol}${lines.join('')}---${eol}`;
  return checkedFrontmatterEdit(
    artifact,
    undefined,
    [{ offset: 0, length: 0, text: block }],
    expected,
  );
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

/** A value the JSON builders write, on one line. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A path into a JSON document: property names and array indices. */
export type JsonPath = readonly (string | number)[];

const MAX_JSON_VALUE_DEPTH = 32;

function jsonText(value: JsonValue, depth = 0): string {
  if (depth > MAX_JSON_VALUE_DEPTH) throw new RangeError('The JSON value is nested too deeply.');
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteJson(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('JSON numbers must be finite.');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${(value as readonly JsonValue[]).map((item) => jsonText(item, depth + 1)).join(', ')}]`;
  }
  const object = value as Readonly<Record<string, JsonValue>>;
  const members = Object.keys(object).map(
    (name) => `${quoteJson(name)}: ${jsonText(object[name] ?? null, depth + 1)}`,
  );
  return `{${members.join(', ')}}`;
}

const JSON_TREE_OPTIONS = { disallowComments: false, allowTrailingComma: false };
const trees = new WeakMap<Artifact, JsonNode | null>();

/**
 * The jsonc-parser tree of a text that parses as JSON once comments are removed (as Gemini CLI
 * reads settings). The parse in src/parse/json.ts goes first: it bounds size and nesting, so the
 * recursive tree builder cannot overflow the stack.
 */
function treeOf(text: string): JsonNode | undefined {
  if (!parseJsonWithComments(text).ok) return undefined;
  try {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, JSON_TREE_OPTIONS);
    return errors.length === 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

function artifactTree(artifact: Artifact): JsonNode | undefined {
  const cached = trees.get(artifact);
  if (cached !== undefined) return cached ?? undefined;
  const root = treeOf(artifact.decoded.text);
  trees.set(artifact, root ?? null);
  return root;
}

function keyOf(property: JsonNode): string | undefined {
  const key = property.children?.[0];
  return key?.type === 'string' ? (key.value as string) : undefined;
}

/** The value node at `path`; for object members also the property node. Last duplicate wins. */
function nodeAt(
  root: JsonNode,
  path: JsonPath,
): { value: JsonNode; property?: JsonNode } | undefined {
  let value: JsonNode = root;
  let property: JsonNode | undefined;
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (value.type !== 'object') return undefined;
      property = (value.children ?? []).findLast((child) => keyOf(child) === segment);
      const next = property?.children?.[1];
      if (next === undefined) return undefined;
      value = next;
    } else {
      if (value.type !== 'array') return undefined;
      const next = value.children?.[segment];
      if (next === undefined) return undefined;
      property = undefined;
      value = next;
    }
  }
  return property === undefined ? { value } : { value, property };
}

function countKey(object: JsonNode, key: string): number {
  return (object.children ?? []).filter((child) => keyOf(child) === key).length;
}

/** True when `text` holds a `//` or `/*` comment outside strings. */
function hasComment(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 0x5c) i++;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x2f) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x2f || next === 0x2a) return true;
    }
  }
  return false;
}

/** The indentation step of a document: a tab, or the first indented line's spaces. Default 2. */
function indentUnit(text: string, lineStarts: readonly number[]): string {
  for (const start of lineStarts) {
    const indent = indentAt(text, start);
    if (indent.length === 0) continue;
    if (indent.startsWith('\t')) return '\t';
    if (lineEndAfter(text, start) > start + indent.length) return indent.replaceAll('\t', '');
  }
  return '  ';
}

/** Applies the edits and checks the new document with `accept`. */
function checkedJsonEdit(
  artifact: Artifact,
  edits: readonly TextEdit[],
  accept: (root: JsonNode) => boolean,
): FileChange | undefined {
  if (editProblem(artifact.decoded.text, edits) !== undefined) return undefined;
  const root = treeOf(applyEdits(artifact.decoded.text, edits));
  if (root === undefined || !accept(root)) return undefined;
  return editChange(artifact, edits);
}

/** Whether a node starts its line (only spaces or tabs before it). */
function startsLine(text: string, offset: number): boolean {
  const lineStart = lineStartBefore(text, offset);
  return text.slice(lineStart, offset).trim() === '';
}

export interface JsonInsertOptions {
  /** Default `last`. `first` puts the property before the existing ones, as `"type"` in a server. */
  readonly position?: 'first' | 'last';
}

/**
 * Adds property `key` with `value` to the object at `objectPath`, on its own line indented like
 * its siblings when the object spans lines, inline otherwise, with commas where JSON needs them.
 * Undefined when the document does not parse, the path is not an object, or the key exists.
 */
export function jsonInsertProperty(
  artifact: Artifact,
  objectPath: JsonPath,
  key: string,
  value: JsonValue,
  options: JsonInsertOptions = {},
): FileChange | undefined {
  const root = artifactTree(artifact);
  const object = root === undefined ? undefined : nodeAt(root, objectPath)?.value;
  if (object?.type !== 'object' || countKey(object, key) > 0) return undefined;
  const { text, lineStarts } = artifact.decoded;
  const properties = object.children ?? [];
  const first = properties[0];
  const last = properties.at(-1);
  const valueText = jsonText(value);
  const separator = (() => {
    const key0 = first?.children?.[0];
    const value0 = first?.children?.[1];
    if (key0 === undefined || value0 === undefined) return ': ';
    const between = text.slice(key0.offset + key0.length, value0.offset);
    return between.trim() === ':' && !hasLineBreak(between) ? between : ': ';
  })();
  const member = `${quoteJson(key)}${separator}${valueText}`;
  const open = object.offset;
  const close = object.offset + object.length - 1;
  const edits: TextEdit[] = [];

  if (first === undefined || last === undefined) {
    const inner = text.slice(open + 1, close);
    if (inner.trim() !== '') return undefined;
    if (hasLineBreak(inner)) {
      const eol = eolNear(artifact.decoded, open);
      const closeIndent = startsLine(text, close)
        ? text.slice(lineStartBefore(text, close), close)
        : indentAt(text, lineStartBefore(text, open));
      const unit = indentUnit(text, lineStarts);
      edits.push({
        offset: open + 1,
        length: inner.length,
        text: `${eol}${closeIndent}${unit}${member}${eol}${closeIndent}`,
      });
    } else {
      edits.push({
        offset: open + 1,
        length: inner.length,
        text: inner === '' ? member : ` ${member} `,
      });
    }
  } else if (startsLine(text, first.offset)) {
    const eol = eolNear(artifact.decoded, first.offset);
    if (options.position === 'first') {
      const indent = text.slice(lineStartBefore(text, first.offset), first.offset);
      edits.push({ offset: first.offset, length: 0, text: `${member},${eol}${indent}` });
    } else {
      const lastStart = startsLine(text, last.offset) ? last.offset : first.offset;
      const indent = text.slice(lineStartBefore(text, lastStart), lastStart);
      const end = last.offset + last.length;
      const rest = text.slice(end, lineEndAfter(text, end)).trim();
      if (rest.startsWith('//')) {
        edits.push(
          { offset: end, length: 0, text: ',' },
          { offset: lineEndAfter(text, end), length: 0, text: `${eol}${indent}${member}` },
        );
      } else {
        edits.push({ offset: end, length: 0, text: `,${eol}${indent}${member}` });
      }
    }
  } else {
    const second = properties[1];
    const gap =
      second === undefined ? ', ' : text.slice(first.offset + first.length, second.offset);
    const comma = gap.trim() === ',' && !hasLineBreak(gap) ? gap.slice(gap.indexOf(',')) : ', ';
    if (options.position === 'first') {
      edits.push({ offset: first.offset, length: 0, text: `${member}${comma}` });
    } else {
      edits.push({ offset: last.offset + last.length, length: 0, text: `${comma}${member}` });
    }
  }
  return checkedJsonEdit(artifact, edits, (after) => {
    const found = nodeAt(after, [...objectPath, key])?.value;
    return (
      found !== undefined &&
      applyEdits(text, edits).slice(found.offset, found.offset + found.length) === valueText
    );
  });
}

export interface JsonRemoveOptions {
  /**
   * Offset of the key to remove when the object repeats it, as `keySpan` gives it. Default: the
   * last one, the one JSON.parse keeps.
   */
  readonly keyOffset?: number;
}

/**
 * Removes the property at `path` (its last segment is the key) with the comma that separated it,
 * and its line when it had one to itself. Undefined when the document does not parse, the
 * property is absent, or the removal would delete a comment.
 */
export function jsonRemoveProperty(
  artifact: Artifact,
  path: JsonPath,
  options: JsonRemoveOptions = {},
): FileChange | undefined {
  const key = path.at(-1);
  const root = artifactTree(artifact);
  if (typeof key !== 'string' || root === undefined) return undefined;
  const object = nodeAt(root, path.slice(0, -1))?.value;
  if (object?.type !== 'object') return undefined;
  const properties = object.children ?? [];
  const index =
    options.keyOffset === undefined
      ? properties.findLastIndex((child) => keyOf(child) === key)
      : properties.findIndex(
          (child) => keyOf(child) === key && child.children?.[0]?.offset === options.keyOffset,
        );
  const property = properties[index];
  if (property === undefined) return undefined;
  const { text } = artifact.decoded;
  let start: number;
  let end: number;
  if (properties.length === 1) {
    start = object.offset + 1;
    end = object.offset + object.length - 1;
  } else if (index < properties.length - 1) {
    start = property.offset;
    end = properties[index + 1]?.offset ?? property.offset + property.length;
  } else {
    const previous = properties[index - 1];
    start = previous === undefined ? property.offset : previous.offset + previous.length;
    end = property.offset + property.length;
  }
  if (hasComment(text.slice(start, end))) return undefined;
  const before = countKey(object, key);
  const edits = [{ offset: start, length: end - start, text: '' }];
  return checkedJsonEdit(artifact, edits, (after) => {
    const parent = nodeAt(after, path.slice(0, -1))?.value;
    return parent?.type === 'object' && countKey(parent, key) === before - 1;
  });
}

/**
 * Renames the property at `path` (its last segment is the key) to `newKey`, keeping its value
 * and position. Undefined when the document does not parse, the property is absent, or the
 * object already has `newKey`.
 */
export function jsonRenameKey(
  artifact: Artifact,
  path: JsonPath,
  newKey: string,
): FileChange | undefined {
  const key = path.at(-1);
  const root = artifactTree(artifact);
  if (typeof key !== 'string' || root === undefined) return undefined;
  const object = nodeAt(root, path.slice(0, -1))?.value;
  const keyNode = nodeAt(root, path)?.property?.children?.[0];
  if (object?.type !== 'object' || keyNode === undefined || countKey(object, newKey) > 0) {
    return undefined;
  }
  const before = countKey(object, key);
  const edits = [{ offset: keyNode.offset, length: keyNode.length, text: quoteJson(newKey) }];
  return checkedJsonEdit(artifact, edits, (after) => {
    const parent = nodeAt(after, path.slice(0, -1))?.value;
    return (
      parent?.type === 'object' &&
      countKey(parent, newKey) === 1 &&
      countKey(parent, key) === before - 1
    );
  });
}

/**
 * Replaces the value at `path` with `value`, written on one line; only the value's own text
 * changes, so a number stays where it was in `"timeout": 30`. Undefined when the document does
 * not parse or the value is absent.
 */
export function jsonReplaceValue(
  artifact: Artifact,
  path: JsonPath,
  value: JsonValue,
): FileChange | undefined {
  const root = artifactTree(artifact);
  const node = root === undefined ? undefined : nodeAt(root, path)?.value;
  if (node === undefined) return undefined;
  const valueText = jsonText(value);
  const edits = [{ offset: node.offset, length: node.length, text: valueText }];
  const text = applyEdits(artifact.decoded.text, edits);
  return checkedJsonEdit(artifact, edits, (after) => {
    const found = nodeAt(after, path)?.value;
    return (
      found !== undefined && text.slice(found.offset, found.offset + found.length) === valueText
    );
  });
}
