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
 * value, or would delete a comment. The rule then offers no fix, or a manual step. Rules never
 * parse an edited text themselves: every check of an edit's result lives here. They throw a
 * RangeError only for arguments a rule controls: a span outside the text, a key that is not a
 * plain identifier, a line with a line break, a path that is not normalized.
 *
 * Copied content (ADR 0008): text taken from the repository goes through {@link safeCopiedText}
 * and is written as a quoted string ({@link quoteYaml} with `style: 'double'`, {@link quoteJson});
 * names derived from content go through {@link skillSlug}. Moved content: {@link moveSections}
 * moves whole Markdown sections, byte for byte, into new Markdown files next to the source.
 *
 * Pure. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 */
import { type Node as JsonNode, parseTree, type ParseError } from 'jsonc-parser';
import { lineText } from '../core/text.js';
import { locateFrontmatter, parseFrontmatter } from '../parse/frontmatter.js';
import { parseJsonWithComments } from '../parse/json.js';
import type { FrontmatterResult } from '../parse/types.js';
import type { Artifact, FileChange, Span, TextEdit } from '../core/types.js';
import { foldPath, pathProblem } from './paths.js';
import {
  applyEdits,
  compareEdits,
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
import { commentOffsets, entrySources, listSource } from './yaml-source.js';

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
// Markdown sections
// ---------------------------------------------------------------------------------------------

/** A Markdown section for {@link moveSections}: a heading and everything under it. */
export interface MarkdownSection {
  /**
   * The heading, as the position of an mdast `heading` node gives it: `## Usage`, or both lines
   * of a setext heading. Never its line ending.
   */
  readonly heading: Span;
  /**
   * Where the section ends: the offset of the heading that ends it, as its mdast position gives
   * it, or the length of the text.
   */
  readonly end: number;
}

/** Longest file name {@link moveSections} writes. */
export const MAX_SECTION_FILE_NAME_LENGTH = 128;

/** Words of ASCII letters, digits, `_` and `-`, joined by single dots. */
const SECTION_FILE_NAME = /^[\w-]+(?:\.[\w-]+)*$/;

/**
 * True when `name` can name a file {@link moveSections} creates: ASCII letters, digits, `_`, `-`
 * and single dots inside, ending in `.md`, at most 128 characters, and a name Windows allows
 * (`aux.md` is not). So it has no path separator, no `..` and no leading dot, and is safe inside
 * a Markdown link. Whether a file of that name exists, in any letter case, and whether an agent
 * reads it (`classify` in src/platforms/classify.ts) is for the rule to check.
 */
export function isSectionFileName(name: string): boolean {
  return (
    name.length <= MAX_SECTION_FILE_NAME_LENGTH &&
    name.endsWith('.md') &&
    SECTION_FILE_NAME.test(name) &&
    pathProblem(name) === undefined
  );
}

/** The line that replaces the body of a section moved to `name`. */
export function sectionLink(name: string): string {
  return `For this section, see [${name}](${name}).`;
}

/** The path of the file `name` in the directory of `path`, a path relative to the scan root. */
export function siblingPath(path: string, name: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1) + name;
}

function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}

/** Start of the line after the line that ends at `lineEnd`, or the end of the text. */
function nextLineStart(text: string, lineEnd: number): number {
  const newline = text.indexOf('\n', lineEnd);
  return newline === -1 ? text.length : newline + 1;
}

/** The terminator of the line that ends at `lineEnd`, or undefined at the end of the text. */
function terminatorAt(text: string, lineEnd: number): Eol | undefined {
  if (text.startsWith('\r\n', lineEnd)) return '\r\n';
  return text.charAt(lineEnd) === '\n' ? '\n' : undefined;
}

/** Where a section's parts are, as offsets into the text. */
interface SectionLines {
  /** Start of the heading's first line. */
  readonly start: number;
  /** Start of the first line of the body that is not blank. */
  readonly contentStart: number;
  /** End of the last line of the body that is not blank, before its line ending. */
  readonly contentEnd: number;
  /** Start of the line where the next section starts, or the end of the text. */
  readonly end: number;
}

/**
 * The lines of `section`. Undefined when the heading is empty or ends with a line break, other
 * text comes before it or after it on its lines, `end` is not at the start of a line (after
 * spaces) or comes before the heading's end, or the body has no line that is not blank.
 */
function sectionLines(text: string, section: MarkdownSection): SectionLines | undefined {
  const { heading } = section;
  const headingEnd = heading.offset + heading.length;
  if (heading.length === 0 || hasLineBreak(text.charAt(headingEnd - 1))) return undefined;
  const start = lineStartBefore(text, heading.offset);
  if (!isBlank(text.slice(start, heading.offset))) return undefined;
  const headingLineEnd = lineEndAfter(text, headingEnd);
  if (!isBlank(text.slice(headingEnd, headingLineEnd))) return undefined;
  const bodyStart = nextLineStart(text, headingLineEnd);

  let end = text.length;
  if (section.end < text.length) {
    end = lineStartBefore(text, section.end);
    if (!isBlank(text.slice(end, section.end))) return undefined;
  }
  if (end < bodyStart) return undefined;

  let contentStart: number | undefined;
  let contentEnd = bodyStart;
  for (let lineStart = bodyStart; lineStart < end;) {
    const lineEnd = lineEndAfter(text, lineStart);
    if (!isBlank(text.slice(lineStart, lineEnd))) {
      contentStart ??= lineStart;
      contentEnd = lineEnd;
    }
    lineStart = nextLineStart(text, lineEnd);
  }
  if (contentStart === undefined) return undefined;
  return { start, contentStart, contentEnd, end };
}

/**
 * Moves whole Markdown sections into new files next to the artifact, one file per section:
 * `names[i]` receives `sections[i]`. The source keeps each heading and the blank lines around
 * the body; the body becomes one line, {@link sectionLink}: `For this section, see
 * [api.md](api.md).` Each new file holds its section verbatim, heading included, through its
 * last line that is not blank, and a line ending. New files are UTF-8 without a byte order mark
 * and take the source's line endings; the source keeps its own, and its byte order mark.
 *
 * Returns one edit of the source, then one `create` per section, in the order given. Undefined
 * when there are no sections; a frontmatter block is unclosed or in another language; a section
 * starts inside the frontmatter, overlaps the one before it or comes before it; a heading is
 * empty, ends with a line break, or shares its lines with other text; an end is not at the start
 * of a line (after spaces) or comes before its heading's end; a body has only blank lines; or a
 * name fails {@link isSectionFileName}, repeats another in any letter case, or is the source's
 * own name. Throws a RangeError when `names` and `sections` differ in length, or a span or end
 * is outside the text.
 *
 * Section spans come from the Markdown parse (`context.markdown()`), never from raw text.
 */
export function moveSections(
  artifact: Artifact,
  sections: readonly MarkdownSection[],
  names: readonly string[],
): FileChange[] | undefined {
  if (names.length !== sections.length) {
    throw new RangeError(`${names.length} names for ${sections.length} sections.`);
  }
  const { decoded } = artifact;
  const { text } = decoded;
  for (const section of sections) {
    checkSpan(artifact, section.heading);
    if (!Number.isSafeInteger(section.end) || section.end < 0 || section.end > text.length) {
      throw new RangeError(`Section end ${section.end} is outside the text.`);
    }
  }
  if (sections.length === 0) return undefined;
  const location = locateFrontmatter(text);
  if (location.kind === 'unclosed' || location.kind === 'unsupported') return undefined;

  const taken = new Set([foldPath(artifact.path.slice(artifact.path.lastIndexOf('/') + 1))]);
  const edits: TextEdit[] = [];
  const creates: FileChange[] = [];
  let previousEnd = location.kind === 'block' ? location.bodyOffset : 0;
  for (const [index, section] of sections.entries()) {
    const name = names[index] ?? '';
    if (!isSectionFileName(name) || taken.has(foldPath(name))) return undefined;
    taken.add(foldPath(name));
    const lines = sectionLines(text, section);
    if (lines === undefined || lines.start < previousEnd) return undefined;
    previousEnd = lines.end;
    const path = siblingPath(artifact.path, name);
    if (pathProblem(path) !== undefined) return undefined;
    const moved = text.slice(lines.start, lines.contentEnd);
    const eol = terminatorAt(text, lines.contentEnd) ?? eolNear(decoded, lines.contentEnd);
    creates.push({ kind: 'create', path, text: `${moved}${eol}` });
    edits.push({
      offset: lines.contentStart,
      length: lines.contentEnd - lines.contentStart,
      text: sectionLink(name),
    });
  }
  if (editProblem(text, edits) !== undefined) return undefined;
  return [editChange(artifact, edits), ...creates];
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
// YAML frontmatter: whole entries, scalars inside values, the block itself
// ---------------------------------------------------------------------------------------------

/** True when an anchor, an alias or a tag is in the frontmatter: one node may serve two keys. */
function sharesNodes(frontmatter: ValidFrontmatter): boolean {
  return frontmatter.warnings.some((issue) => issue.code === 'alias' || issue.code === 'tag');
}

/** Offset of the `:` after a key and any spaces or tabs; undefined for an explicit `? key`. */
function colonAfter(text: string, keySpan: Span): number | undefined {
  let colon = keySpan.offset + keySpan.length;
  while (text.charAt(colon) === ' ' || text.charAt(colon) === '\t') colon++;
  return text.charAt(colon) === ':' ? colon : undefined;
}

const contains = (outer: Span | undefined, inner: Span): boolean =>
  outer !== undefined &&
  inner.offset >= outer.offset &&
  inner.offset + inner.length <= outer.offset + outer.length;

/**
 * Applies `edits` and parses the frontmatter again: the change stands only when the new
 * frontmatter is valid, has the same top-level keys in the same order (`owner` renamed to
 * `renamedTo`), every other value unchanged, and `accept` agrees with the new value of `owner`.
 */
function checkedEntryEdit(
  artifact: Artifact,
  before: ValidFrontmatter,
  edits: readonly TextEdit[],
  owner: string,
  accept: (value: unknown) => boolean,
  renamedTo = owner,
): FileChange | undefined {
  const { text } = artifact.decoded;
  if (editProblem(text, edits) !== undefined) return undefined;
  const after = parseFrontmatter(applyEdits(text, edits));
  if (after.kind !== 'valid') return undefined;
  const keys = before.data.keys.map((key) => (key === owner ? renamedTo : key));
  const afterKeys = after.data.keys;
  if (afterKeys.length !== keys.length || keys.some((key, index) => afterKeys[index] !== key)) {
    return undefined;
  }
  for (const key of before.data.keys) {
    if (key === owner) {
      if (!accept(after.data.values[renamedTo])) return undefined;
    } else if (!sameValue(after.data.values[key], before.data.values[key])) {
      return undefined;
    }
  }
  return editChange(artifact, edits);
}

/** The new scalar of {@link rewriteEntry}. */
interface NewValue {
  readonly value: YamlScalar;
  readonly style: YamlStyle;
}

/** Renames top-level key `key` to `newKey`, replaces its value, or both, checked by a re-parse. */
function rewriteEntry(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
  newKey: string,
  replacement: NewValue | undefined,
): FileChange | undefined {
  checkYamlKey(key);
  checkYamlKey(newKey);
  if (frontmatter.kind !== 'valid' || sharesNodes(frontmatter)) return undefined;
  const { data } = frontmatter;
  if (newKey !== key && Object.hasOwn(data.values, newKey)) return undefined;
  const keySpan = data.keySpan(key);
  if (keySpan === undefined) return undefined;
  const { text } = artifact.decoded;
  const colon = colonAfter(text, keySpan);
  if (colon === undefined) return undefined;

  const edits: TextEdit[] = [];
  if (newKey !== key) edits.push({ offset: keySpan.offset, length: keySpan.length, text: newKey });
  if (replacement !== undefined) {
    const valueSpan = data.valueSpan(key);
    if (valueSpan === undefined || valueSpan.length === 0) return undefined;
    const end = valueSpan.offset + valueSpan.length;
    // Everything from the colon to the end of the value is replaced: a comment there would go.
    if (end <= colon || text.slice(colon + 1, end).includes('#')) return undefined;
    edits.push({
      offset: colon + 1,
      length: end - colon - 1,
      text: ` ${yamlScalarText(replacement.value, replacement.style)}`,
    });
  }
  if (edits.length === 0) return undefined;
  const wanted = replacement === undefined ? data.values[key] : replacement.value;
  return checkedEntryEdit(
    artifact,
    frontmatter,
    edits,
    key,
    (value) => sameValue(value, wanted),
    newKey,
  );
}

export interface YamlReplaceOptions extends YamlValueOptions {
  /** A new name for the key, written in place of the old one. */
  readonly renameTo?: string;
}

/**
 * Replaces the whole value of top-level frontmatter key `key`, which may be a scalar, a block or
 * flow list, or a nested mapping, with one scalar on the key's line, and renames the key to
 * `renameTo` when given: `globs:\n  - a\n  - b` becomes `globs: "a, b"`. Strings are written
 * plain unless `style` says otherwise or a parser could read them as something else.
 *
 * Undefined when the frontmatter is not valid or has an anchor, an alias or a tag, the key is
 * absent or not followed by `:`, its value is empty (use {@link yamlSetScalar}), a comment lies
 * between the colon and the end of the value, `renameTo` exists, or the edited frontmatter does
 * not parse to exactly the intended data with the keys in the same order.
 */
export function yamlReplaceValue(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
  value: YamlScalar,
  options: YamlReplaceOptions = {},
): FileChange | undefined {
  return rewriteEntry(artifact, frontmatter, key, options.renameTo ?? key, {
    value,
    style: options.style ?? 'plain',
  });
}

/**
 * Renames top-level frontmatter key `key` to `newKey`, keeping its value and position:
 * `paths: src/**` becomes `globs: src/**`. Undefined when the frontmatter is not valid or has an
 * anchor, an alias or a tag, the key is absent or not followed by `:`, `newKey` exists, or the
 * edited frontmatter does not parse to the same data with the key renamed in place.
 */
export function yamlRenameKey(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
  newKey: string,
): FileChange | undefined {
  return rewriteEntry(artifact, frontmatter, key, newKey, undefined);
}

/**
 * Replaces the plain scalar at `span` with `value`, wherever the scalar is in a top-level entry:
 * the value, a list item, a nested key or value. `version: 1.0` with the string `"1.0"` and
 * style `double` becomes `version: "1.0"`, which every YAML parser reads as that text. Strings
 * are written plain unless `style` says otherwise or a parser could read them as something else.
 *
 * Undefined when the frontmatter is not valid, `span` is not inside a top-level entry or not a
 * one-line plain scalar (empty, quoted, with surrounding spaces, an anchor, an alias or a tag),
 * or the edited frontmatter is not valid with the same top-level keys in the same order and every
 * other top-level value unchanged. When `span` is a whole top-level value, that value must also
 * parse to `value`.
 */
export function yamlReplaceScalar(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  span: Span,
  value: YamlScalar,
  options: YamlValueOptions = {},
): FileChange | undefined {
  checkSpan(artifact, span);
  if (frontmatter.kind !== 'valid') return undefined;
  const { data } = frontmatter;
  const owner = data.keys.find(
    (key) => contains(data.valueSpan(key), span) || contains(data.keySpan(key), span),
  );
  if (owner === undefined) return undefined;
  const source = artifact.decoded.text.slice(span.offset, span.offset + span.length);
  if (source === '' || source.trim() !== source || hasLineBreak(source)) return undefined;
  if ('"\'&*!'.includes(source.charAt(0))) return undefined;
  const text = yamlScalarText(value, options.style ?? 'plain');
  const whole = data.valueSpan(owner);
  const topValue = whole?.offset === span.offset && whole.length === span.length;
  return checkedEntryEdit(
    artifact,
    frontmatter,
    [{ offset: span.offset, length: span.length, text }],
    owner,
    (after) => !topValue || sameValue(after, value),
  );
}

/** Spaces and tabs at the start of `line`, or undefined when other whitespace is among them. */
function blankIndent(line: string): string | undefined {
  const indent = line.slice(0, line.length - line.trimStart().length);
  for (const char of indent) if (char !== ' ' && char !== '\t') return undefined;
  return indent;
}

/**
 * Moves a frontmatter block that opens on line `openLine` and closes on line `closeLine` (1-based)
 * to the start of the file: the lines before it are deleted, and indented delimiter lines lose
 * their indentation. When every non-blank line between them starts with the opening line's
 * indentation, the whole block is dedented, so its YAML keeps its structure.
 *
 * Undefined when there is nothing to move, an indentation is not spaces and tabs, or the file
 * does not then start with valid frontmatter. Throws a RangeError when the lines are not in the
 * file or `closeLine` is not after `openLine`.
 */
export function moveFrontmatterToTop(
  artifact: Artifact,
  openLine: number,
  closeLine: number,
): FileChange | undefined {
  const { decoded } = artifact;
  const lines = decoded.lineStarts.length;
  if (
    !Number.isSafeInteger(openLine) ||
    !Number.isSafeInteger(closeLine) ||
    openLine < 1 ||
    closeLine <= openLine ||
    closeLine > lines
  ) {
    throw new RangeError(`Lines ${openLine}..${closeLine} are not a block in 1..${lines}.`);
  }
  const indent = blankIndent(lineText(decoded, openLine));
  const closeIndent = blankIndent(lineText(decoded, closeLine));
  if (indent === undefined || closeIndent === undefined) return undefined;
  const start = (line: number): number => decoded.lineStarts[line - 1] ?? 0;

  const edits: TextEdit[] = [];
  const dedent = (line: number, length: number): void => {
    if (length > 0) edits.push({ offset: start(line), length, text: '' });
  };
  // The lines before the block go, with the opening line's indentation.
  if (openLine > 1) edits.push({ offset: 0, length: start(openLine) + indent.length, text: '' });
  else dedent(openLine, indent.length);
  const inner: number[] = [];
  for (let line = openLine + 1; line < closeLine; line++) inner.push(line);
  const whole =
    indent !== '' &&
    inner.every((line) => {
      const text = lineText(decoded, line);
      return text.trim() === '' || text.startsWith(indent);
    });
  if (whole) {
    for (const line of inner) {
      if (lineText(decoded, line).startsWith(indent)) dedent(line, indent.length);
    }
  }
  dedent(closeLine, closeIndent.length);
  if (edits.length === 0 || editProblem(decoded.text, edits) !== undefined) return undefined;
  if (parseFrontmatter(applyEdits(decoded.text, edits)).kind !== 'valid') return undefined;
  return editChange(artifact, edits);
}

// ---------------------------------------------------------------------------------------------
// YAML frontmatter: removing, moving and commenting whole entries
// ---------------------------------------------------------------------------------------------

/** The YAML between the delimiters of a valid frontmatter block, and facts about its source. */
interface YamlSource {
  /** Offset of the YAML's first line, and of the closing delimiter line. */
  readonly start: number;
  readonly end: number;
  /** Offsets of the comments, into the full text. */
  readonly comments: readonly number[];
  entry(key: string): YamlEntrySource | undefined;
}

interface YamlEntrySource {
  /** Start of the key's line, and its indentation. */
  readonly lineStart: number;
  readonly indent: string;
  /** Start of the line after the value's last line. */
  readonly lineEnd: number;
  /** The key as written. */
  readonly keyText: string;
  readonly sharesNodes: boolean;
  /** See `EntrySource.text` in yaml-source.ts. */
  readonly text: string | readonly string[] | undefined;
}

function yamlSource(artifact: Artifact, frontmatter: ValidFrontmatter): YamlSource | undefined {
  const { text } = artifact.decoded;
  const location = locateFrontmatter(text);
  if (location.kind !== 'block') return undefined;
  const { yamlStart, yamlEnd } = location;
  const yaml = text.slice(yamlStart, yamlEnd);
  const comments = commentOffsets(yaml).map((offset) => yamlStart + offset);
  const sources = entrySources(yaml);
  const { data } = frontmatter;
  return {
    start: yamlStart,
    end: yamlEnd,
    comments,
    entry(key) {
      const keySpan = data.keySpan(key);
      if (keySpan === undefined) return undefined;
      const source = sources.get(keySpan.offset - yamlStart);
      const lineStart = lineStartBefore(text, keySpan.offset);
      const indent = text.slice(lineStart, keySpan.offset);
      const colon = colonAfter(text, keySpan);
      if (source === undefined || colon === undefined || !isBlank(indent)) return undefined;
      const keyText = text.slice(keySpan.offset, keySpan.offset + keySpan.length);
      if (hasLineBreak(keyText)) return undefined;
      const valueSpan = data.valueSpan(key);
      const last =
        valueSpan === undefined || valueSpan.length === 0
          ? colon + 1
          : valueSpan.offset + valueSpan.length;
      const valueLineEnd = lineEndAfter(text, last);
      // After the value only spaces or a comment: not the rest of a flow mapping.
      const rest = text.slice(last, valueLineEnd).trimStart();
      if (rest !== '' && !rest.startsWith('#')) return undefined;
      return {
        lineStart,
        indent,
        lineEnd: Math.min(nextLineStart(text, valueLineEnd), yamlEnd),
        keyText,
        sharesNodes: source.sharesNodes,
        text: source.text,
      };
    },
  };
}

/** True when a comment starts in `[start, end)`. */
function hasCommentIn(source: YamlSource, start: number, end: number): boolean {
  return source.comments.some((offset) => offset >= start && offset < end);
}

/**
 * Applies `edits` and parses the frontmatter again: the change stands only when the new
 * frontmatter is valid, has exactly `keys` in that order, the values in `changed` for those
 * keys, and every other value unchanged.
 */
function checkedYamlEdit(
  artifact: Artifact,
  before: ValidFrontmatter,
  edits: readonly TextEdit[],
  keys: readonly string[],
  changed: ReadonlyMap<string, unknown>,
): FileChange | undefined {
  const { text } = artifact.decoded;
  const sorted = [...edits].sort(compareEdits);
  if (sorted.length === 0 || editProblem(text, sorted) !== undefined) return undefined;
  const after = parseFrontmatter(applyEdits(text, sorted));
  if (after.kind !== 'valid') return undefined;
  const afterKeys = after.data.keys;
  if (afterKeys.length !== keys.length || keys.some((key, index) => afterKeys[index] !== key)) {
    return undefined;
  }
  for (const key of keys) {
    const wanted = changed.has(key) ? changed.get(key) : before.data.values[key];
    if (!sameValue(after.data.values[key], wanted)) return undefined;
  }
  return editChange(artifact, sorted);
}

/**
 * Removes top-level frontmatter key `key` with its whole value, block or flow, and the lines
 * they are on; every other byte stays. `tags:\n  - a\n  - b\nname: x` becomes `name: x`.
 *
 * Undefined when the frontmatter is not valid, the key is absent, does not start its line (a
 * flow mapping, an explicit `? key`) or is not followed by `:`, the key or value has an anchor,
 * an alias or a tag, a comment is on the removed lines, or the edited frontmatter does not parse
 * to the same data without the key.
 */
export function yamlRemoveKey(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
): FileChange | undefined {
  if (frontmatter.kind !== 'valid') return undefined;
  const source = yamlSource(artifact, frontmatter);
  const entry = source?.entry(key);
  if (source === undefined || entry === undefined || entry.sharesNodes) return undefined;
  if (hasCommentIn(source, entry.lineStart, entry.lineEnd)) return undefined;
  return checkedYamlEdit(
    artifact,
    frontmatter,
    [{ offset: entry.lineStart, length: entry.lineEnd - entry.lineStart, text: '' }],
    frontmatter.data.keys.filter((other) => other !== key),
    new Map(),
  );
}

/** What comes before a block list item on its line: indentation, `-` and spaces. */
const BLOCK_ITEM_PREFIX = /^[\t ]*-[\t ]+$/;

/**
 * Rewrites the list that is the value of top-level frontmatter key `key`, item by item: item `i`
 * becomes the strings of `items[i]`. An item that stays its own value is not touched; an empty
 * array removes the item, and in a block list its line; several strings become several items
 * in its place, each on a line that starts like the item's own (`  - "Bash(git status *)"`), or
 * joined with `, ` in a flow list, which is then written on one line. New strings are written
 * plain when every parser reads them back as the same string, else double-quoted. So
 * `allowed-tools:\n  - Read\n  - Bash\n  - Write` with `[['Read'], ['Bash(git status *)',
 * 'Bash(npm test)'], []]` keeps `Read`, puts two items in place of `Bash` and drops `Write`.
 *
 * Undefined when the frontmatter is not valid; the value is not a list of one-line plain or
 * quoted scalars, or `items` does not have one entry for each; a block list item does not sit
 * alone on its line after `-`, or a flow list spans lines; the key or the list has an anchor, an
 * alias, a tag or a comment; no item would be left (use {@link yamlRemoveKey}); or the edited
 * frontmatter does not parse to exactly the new list with every other value unchanged.
 */
export function yamlReplaceListItems(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
  items: readonly (readonly string[])[],
): FileChange | undefined {
  checkYamlKey(key);
  if (frontmatter.kind !== 'valid') return undefined;
  const { data } = frontmatter;
  const current = data.values[key];
  const keySpan = data.keySpan(key);
  const source = yamlSource(artifact, frontmatter);
  const entry = source?.entry(key);
  if (source === undefined || entry === undefined || keySpan === undefined) return undefined;
  if (entry.sharesNodes || hasCommentIn(source, entry.lineStart, entry.lineEnd)) return undefined;
  const { text } = artifact.decoded;
  const list = listSource(text.slice(source.start, source.end), keySpan.offset - source.start);
  if (
    list === undefined ||
    !Array.isArray(current) ||
    current.length !== list.items.length ||
    items.length !== list.items.length
  ) {
    return undefined;
  }
  const values = items.flat();
  if (values.length === 0) return undefined;
  const unchanged = (index: number): boolean => {
    const replacement = items[index] ?? [];
    return replacement.length === 1 && replacement[0] === current[index];
  };

  const edits: TextEdit[] = [];
  if (list.flow) {
    const start = source.start + list.start;
    const end = source.start + list.end;
    if (hasLineBreak(text.slice(start, end))) return undefined;
    const written = list.items.flatMap((item, index) =>
      unchanged(index)
        ? [text.slice(source.start + item.start, source.start + item.end)]
        : (items[index] ?? []).map((value) => quoteYaml(value)),
    );
    edits.push({ offset: start, length: end - start, text: `[${written.join(', ')}]` });
  } else {
    for (const [index, item] of list.items.entries()) {
      if (unchanged(index)) continue;
      const replacement = items[index] ?? [];
      const start = source.start + item.start;
      const end = source.start + item.end;
      const lineStart = lineStartBefore(text, start);
      const prefix = text.slice(lineStart, start);
      const lineEnd = lineEndAfter(text, end);
      const eol = terminatorAt(text, lineEnd);
      if (!BLOCK_ITEM_PREFIX.test(prefix) || !isBlank(text.slice(end, lineEnd))) return undefined;
      if (eol === undefined) return undefined;
      const [first, ...rest] = replacement;
      if (first === undefined) {
        edits.push({
          offset: lineStart,
          length: nextLineStart(text, lineEnd) - lineStart,
          text: '',
        });
        continue;
      }
      const more = rest.map((value) => `${eol}${prefix}${quoteYaml(value)}`).join('');
      edits.push({ offset: start, length: end - start, text: `${quoteYaml(first)}${more}` });
    }
  }
  return checkedYamlEdit(artifact, frontmatter, edits, data.keys, new Map([[key, values]]));
}

/** Indentation of entries under a new mapping, below the top-level keys' own. */
const MAPPING_INDENT = '  ';

/**
 * Moves top-level frontmatter keys under the block mapping `mapping`, each value written as a
 * double-quoted string: a scalar as its source text (`version: 1.10` becomes `version:
 * "1.10"`), a list of scalars as its items' texts joined with `, ` (`tags: [a, b]` becomes `tags:
 * "a, b"`). The keys keep their source order and are written as in the source. New entries go
 * after the last entry of an existing block mapping, indented like its first one; without the
 * mapping, a new one goes last, before the closing `---`, indented two spaces deeper than the
 * top-level keys.
 *
 * Undefined when the frontmatter is not valid; `keys` is empty, repeats a key or names
 * `mapping`; a key is absent or would clash with a key of the mapping; a value is null, a
 * mapping, an empty list, or a list with a comma in an item, a null item or a nested
 * collection; an entry is not one {@link yamlRemoveKey} could remove; `mapping` exists but is
 * not a block mapping, starts on its key's line, or has an anchor, an alias or a tag; or the
 * edited frontmatter does not parse to exactly the moved values with every other value
 * unchanged. Throws a RangeError when `mapping` is not a plain key.
 */
export function yamlMoveUnderMapping(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  keys: readonly string[],
  mapping = 'metadata',
): FileChange | undefined {
  checkYamlKey(mapping);
  if (frontmatter.kind !== 'valid') return undefined;
  const moving = new Set(keys);
  if (keys.length === 0 || moving.size !== keys.length || moving.has(mapping)) return undefined;
  const source = yamlSource(artifact, frontmatter);
  if (source === undefined) return undefined;
  const { data } = frontmatter;
  const { decoded } = artifact;
  const { text } = decoded;

  // Where the entries go, and how they are indented.
  const existing = data.values[mapping];
  const present = data.keySpan(mapping) !== undefined;
  let offset = source.end;
  let indent: string;
  let header = '';
  const merged = Object.create(null) as Record<string, unknown>;
  if (present) {
    const entry = source.entry(mapping);
    const valueSpan = data.valueSpan(mapping);
    const keySpan = data.keySpan(mapping);
    if (
      entry === undefined ||
      entry.sharesNodes ||
      valueSpan === undefined ||
      keySpan === undefined ||
      typeof existing !== 'object' ||
      existing === null ||
      Array.isArray(existing)
    ) {
      return undefined;
    }
    const childStart = lineStartBefore(text, valueSpan.offset);
    indent = text.slice(childStart, valueSpan.offset);
    // A block mapping starts on a later line, with its first key.
    if (childStart <= keySpan.offset || !isBlank(indent) || indent.length <= entry.indent.length) {
      return undefined;
    }
    offset = entry.lineEnd;
    Object.assign(merged, existing);
  } else {
    const first = data.keys[0] === undefined ? undefined : source.entry(data.keys[0]);
    if (first === undefined) return undefined;
    header = `${first.indent}${mapping}:`;
    indent = `${first.indent}${MAPPING_INDENT}`;
  }

  const eol = eolNear(decoded, Math.max(0, offset - 1));
  const lines: string[] = header === '' ? [] : [`${header}${eol}`];
  const edits: TextEdit[] = [];
  for (const key of data.keys) {
    if (!moving.has(key)) continue;
    moving.delete(key);
    const entry = source.entry(key);
    if (entry === undefined || entry.sharesNodes || entry.text === undefined) return undefined;
    if (hasCommentIn(source, entry.lineStart, entry.lineEnd)) return undefined;
    if (Object.hasOwn(merged, key)) return undefined;
    let value: string;
    if (typeof entry.text === 'string') {
      value = entry.text;
    } else {
      if (entry.text.some((item) => item.includes(','))) return undefined;
      value = entry.text.join(', ');
    }
    merged[key] = value;
    lines.push(`${indent}${entry.keyText}: ${quoteYaml(value, 'double')}${eol}`);
    edits.push({ offset: entry.lineStart, length: entry.lineEnd - entry.lineStart, text: '' });
  }
  if (moving.size > 0) return undefined;
  edits.push({ offset, length: 0, text: lines.join('') });
  const after = data.keys.filter((key) => !keys.includes(key));
  return checkedYamlEdit(
    artifact,
    frontmatter,
    edits,
    present ? after : [...after, mapping],
    new Map([[mapping, merged]]),
  );
}

/** Longest comment {@link yamlInsertComment} writes. */
export const MAX_YAML_COMMENT_LENGTH = 1000;

/**
 * Inserts the comment `# text` as a new line in the frontmatter, indented like the line it goes
 * before: the line of top-level key `before`, or line `before` (1-based, as findings report
 * lines), which may be any line of the YAML or the closing `---`. So `# agentcheckup-disable-
 * next-line skill/non-portable-field -- Claude Code only` before `user-invocable: false`
 * suppresses that finding.
 *
 * Undefined when the frontmatter is not valid; `text` is empty, longer than 1,000 characters, or
 * has a line break, a control character, or a bidirectional, tag or other invisible character;
 * the key is absent or does not start its line; the line is outside the YAML; or the edited
 * frontmatter does not parse to the same data, as when the line is inside a block scalar. Throws
 * a RangeError when `before` is a line number outside the file.
 */
export function yamlInsertComment(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  before: string | number,
  text: string,
): FileChange | undefined {
  const { decoded } = artifact;
  const lines = lineCount(decoded.text, decoded.lineStarts);
  if (
    typeof before === 'number' &&
    (!Number.isSafeInteger(before) || before < 1 || before > lines)
  ) {
    throw new RangeError(`Line ${before} is outside 1..${lines}.`);
  }
  if (frontmatter.kind !== 'valid' || !isCommentText(text)) return undefined;
  const source = yamlSource(artifact, frontmatter);
  if (source === undefined) return undefined;
  let offset: number;
  if (typeof before === 'string') {
    const entry = source.entry(before);
    if (entry === undefined) return undefined;
    offset = entry.lineStart;
  } else {
    offset = decoded.lineStarts[before - 1] ?? 0;
    if (offset < source.start || offset > source.end) return undefined;
  }
  const eol = eolNear(decoded, offset);
  const line = `${indentAt(decoded.text, offset)}# ${text}${eol}`;
  return checkedYamlEdit(
    artifact,
    frontmatter,
    [{ offset, length: 0, text: line }],
    frontmatter.data.keys,
    new Map(),
  );
}

/** One line of visible text for a comment: see {@link yamlInsertComment}. */
function isCommentText(text: string): boolean {
  if (text.trim() === '' || text.length > MAX_YAML_COMMENT_LENGTH) return false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isControlCodePoint(code) || isHiddenCodePoint(code) || code === 0x85) return false;
  }
  return true;
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
