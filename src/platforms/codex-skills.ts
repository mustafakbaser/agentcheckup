/**
 * How Codex reads a SKILL.md, mirrored from codex-rs/skills/src/parser.rs: each function decides
 * one behavior. The skill rules use them to say what Codex does with a skill, and the Codex load
 * plan uses the same functions to say whether Codex lists it, so both always agree.
 */
import { codePointLength } from '../core/measure.js';
import { lineText } from '../core/text.js';
import type { DecodedText } from '../core/types.js';
import { locateFrontmatter } from '../parse/frontmatter.js';
import type { FrontmatterData, FrontmatterResult, ParseIssue } from '../parse/types.js';
import { codexRepair, parsesAsFrontmatter, rustTrim } from './skill-repair.js';
import { normalizeName } from './skills.js';

export type InvalidFrontmatter = Extract<FrontmatterResult, { kind: 'invalid' }>;

/** Codex skips a skill whose name is longer than this, after collapsing whitespace. */
export const CODEX_MAX_NAME_LENGTH = 64;

// ---------------------------------------------------------------------------------------------
// Finding the frontmatter
// ---------------------------------------------------------------------------------------------

/** Codex accepts a delimiter line whose trimmed text is `---` (codex-rs/skills/src/parser.rs). */
export function isCodexDelimiter(text: string): boolean {
  return rustTrim(text) === '---';
}

/**
 * The 1-based line of the `---` that closes the frontmatter as Codex finds it: line 1, trimmed,
 * is `---`, and so is a later line. Undefined when Codex finds no frontmatter block, so it skips
 * the skill. Lines are those of the decoded text, after the byte order mark is removed;
 * {@link bomHidesFrontmatter} covers the mark.
 */
export function codexFrontmatterClose(decoded: DecodedText): number | undefined {
  if (!isCodexDelimiter(lineText(decoded, 1))) return undefined;
  for (let line = 2; line <= decoded.lineStarts.length; line++) {
    if (isCodexDelimiter(lineText(decoded, line))) return line;
  }
  return undefined;
}

/**
 * True when a UTF-8 byte order mark hides a frontmatter block from Codex. Codex decodes SKILL.md
 * without removing the mark, and Rust's `trim()` keeps U+FEFF, so the first line is not `---`.
 * Without a block the file has no frontmatter for any reader, which `codexFrontmatterClose`
 * covers.
 */
export function bomHidesFrontmatter(decoded: DecodedText, result: FrontmatterResult): boolean {
  return (
    decoded.hasBom &&
    decoded.encoding === 'utf-8' &&
    (result.kind === 'valid' || result.kind === 'invalid')
  );
}

// ---------------------------------------------------------------------------------------------
// Frontmatter that does not parse
// ---------------------------------------------------------------------------------------------

/** Errors that come from agentcheckup's own resource limits, not from the YAML itself. */
export const FRONTMATTER_LIMIT_CODES: ReadonlySet<string> = new Set([
  'too-large',
  'too-deep',
  'excessive-aliases',
  'parse-failed',
]);

/** Fields that Codex deserializes; serde rejects a repeated field. */
export const CODEX_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'metadata']);

/**
 * Why frontmatter does not parse, judged by its first error.
 * - `limit`: agentcheckup's parser gave up, so nothing is known about the YAML.
 * - `not-a-mapping`: the YAML is a list or a scalar.
 * - `duplicate`: the only errors are repeated keys; `key` is the first one.
 * - `syntax`: any other YAML error; `issue` is the first that is not a repeated key.
 */
export type InvalidCause =
  | { readonly kind: 'limit' | 'not-a-mapping' | 'syntax'; readonly issue: ParseIssue }
  | { readonly kind: 'duplicate'; readonly issue: ParseIssue; readonly key: string };

/**
 * The key a duplicate-key error points at: the text of its span, which the parser sets to the
 * repeated key, without its quotes. In a flow mapping the key may have no `:` after it.
 */
function duplicatedKey(text: string, issue: ParseIssue): string {
  const { offset, length } = issue.span;
  const key = text.slice(offset, offset + length).trim();
  const quoted = key.length >= 2 && (key.startsWith('"') || key.startsWith("'"));
  return quoted && key.endsWith(key.charAt(0)) ? key.slice(1, -1) : key;
}

/** The cause of an `invalid` result, read from the decoded `text`. Undefined without errors. */
export function invalidCause(text: string, result: InvalidFrontmatter): InvalidCause | undefined {
  const first = result.errors[0];
  if (first === undefined) return undefined;
  if (FRONTMATTER_LIMIT_CODES.has(first.code)) return { kind: 'limit', issue: first };
  if (first.code === 'not-a-mapping') return { kind: 'not-a-mapping', issue: first };
  if (result.errors.every((issue) => issue.code === 'duplicate-key')) {
    return { kind: 'duplicate', issue: first, key: duplicatedKey(text, first) };
  }
  const syntax = result.errors.find((issue) => issue.code !== 'duplicate-key') ?? first;
  return { kind: 'syntax', issue: syntax };
}

/** True when Codex rejects frontmatter that repeats `key`, and skips the skill. */
export function codexRejectsDuplicate(key: string): boolean {
  return CODEX_FIELDS.has(key);
}

/** The YAML between the frontmatter delimiters of the decoded `text`, '' without a block. */
export function frontmatterYaml(text: string): string {
  const location = locateFrontmatter(text);
  return location.kind === 'block' ? text.slice(location.yamlStart, location.yamlEnd) : '';
}

/**
 * The YAML Codex parses after its one repair attempt, when that attempt parses. Undefined when
 * the repair changes nothing or still fails, so Codex skips the skill.
 */
export function codexRepairedYaml(yaml: string): string | undefined {
  const repaired = codexRepair(yaml);
  return repaired !== undefined && parsesAsFrontmatter(repaired) ? repaired : undefined;
}

// ---------------------------------------------------------------------------------------------
// Field values
// ---------------------------------------------------------------------------------------------

/**
 * The `description` field as agents see it:
 * - `text`: present, and neither empty nor a list or mapping.
 * - `missing`: the key is absent.
 * - `not-text`: a list or a mapping. Codex cannot deserialize it and skips the skill.
 * - `empty`: null, or only whitespace.
 * Codex skips the skill in every state but `text`.
 */
export type DescriptionState = 'text' | 'missing' | 'not-text' | 'empty';

export function descriptionState(data: FrontmatterData): DescriptionState {
  const present = data.keys.includes('description');
  const value = data.values['description'];
  const notText = Array.isArray(value) || (typeof value === 'object' && value !== null);
  const empty = value === null || (typeof value === 'string' && value.trim() === '');
  if (present && !notText && !empty) return 'text';
  if (notText) return 'not-text';
  return present ? 'empty' : 'missing';
}

/**
 * True when Codex cannot deserialize a `metadata` value and skips the skill: text, a number or a
 * boolean, where Codex expects a mapping. An empty value and a list are not claimed.
 */
export function codexRejectsMetadata(value: unknown): boolean {
  const isMap = typeof value === 'object' && value !== null && !Array.isArray(value);
  return value !== null && !isMap && !Array.isArray(value);
}

/** Runs of whitespace collapsed to one space, and trimmed: how Codex reads `name`. */
export function collapseWhitespace(value: string): string {
  return value
    .split(/\s+/u)
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * True when a text `name` is too long for Codex, which then skips the skill: over
 * {@link CODEX_MAX_NAME_LENGTH} characters both after NFKC normalization and after Codex
 * collapses its whitespace.
 */
export function codexNameTooLong(raw: string): boolean {
  const name = normalizeName(raw);
  return (
    name !== '' &&
    codePointLength(name) > CODEX_MAX_NAME_LENGTH &&
    codePointLength(collapseWhitespace(raw)) > CODEX_MAX_NAME_LENGTH
  );
}

/** True when `name` is a list or a mapping, which Codex cannot deserialize. */
export function nameNotText(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}
