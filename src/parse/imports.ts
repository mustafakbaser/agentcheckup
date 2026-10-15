/**
 * `@path` imports in CLAUDE.md (and AGENTS.md read by Claude Code) and GEMINI.md.
 *
 * Claude Code, https://code.claude.com/docs/en/memory (verified 2026-10-14):
 * - "CLAUDE.md files can import additional files using `@path/to/import` syntax", anywhere in
 *   the file. Relative paths resolve against the importing file; absolute and `~/` paths are
 *   allowed; imports nest up to four hops.
 * - "To import a file whose path contains spaces, put a backslash before each space. Without the
 *   backslashes, the path ends at the first space […]. A path wrapped in quotes isn't imported
 *   at all, with or without the backslashes."
 * - "Import parsing skips Markdown code spans and fenced code blocks."
 * - Documented examples include extensionless names: `@README`, `@package.json`, `@AGENTS.md`.
 * - Not documented: what may precede `@`, trailing punctuation, and imports inside HTML comments
 *   or frontmatter. We accept `@` at a line start or after whitespace or `(`, strip trailing
 *   sentence punctuation, and skip HTML comments (Claude strips block-level comments before
 *   loading the file) and the frontmatter block.
 *
 * Gemini CLI, https://geminicli.com/docs/reference/memport/ and the implementation in
 * https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts
 * (verified 2026-10-14; the source is more precise than the page):
 * - `@` must start the text or follow a space, tab, CR or LF.
 * - The path runs to the next space, tab, CR or LF: no escapes, and trailing punctuation is part
 *   of the path (`@./a.md.` loads `./a.md.`, which fails).
 * - It must start with `.`, `/` or an ASCII letter: bare `@file.md` is an import, `@~/x.md` and
 *   `@"x.md"` are not. `file://`, `http://` and `https://` paths are rejected, and the resolved
 *   path must stay inside the project root. Imports nest up to five levels.
 * - Code regions are found with /(`+)([\s\S]*?)\1/g on the raw text (the page says `marked`). We
 *   use CommonMark code spans and blocks instead; they differ for `~~~` fences and indented code.
 * - HTML comments are not special: an import inside `<!-- -->` is loaded.
 *
 * Precision trade-off (both dialects): agents try to load any token, but most `@words` in prose
 * are mentions, decorators or package names (`@username`, `@Override`, `@types/node`). We only
 * report tokens that are clearly paths: starting with `./`, `../`, `~/`, `/` or a drive letter,
 * or ending in a file extension of 1-8 letters and digits with at least one letter (so versions
 * like `@scope/pkg@1.2.3` are not paths), or naming a dotfile (`@.cursorrules`) or a well-known
 * extensionless file (`@README`).
 * Missing an import is a false negative for rules; a mention reported as a broken import would be
 * noise on almost every README.
 *
 * Only the window that `parseMarkdown` analyzed is scanned (`doc.analysis.analyzedLength`):
 * beyond it we cannot tell code from prose.
 */
import type { Span } from '../core/types.js';
import { locateFrontmatter } from './frontmatter.js';
import { isJsWhitespace, mergeSpans, nextSpanStart, spansContain } from './spans.js';
import type { ImportDialect, ImportReference, MarkdownDocument } from './types.js';

/** Gemini CLI's `isWhitespace`: space, tab, LF, CR only. */
const isGeminiWhitespace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

const isAsciiLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

interface DialectRules {
  /** May `code` precede `@`? (The start of the text always may.) */
  readonly boundary: (code: number) => boolean;
  /** Does `code` end the path (outside an escape)? */
  readonly terminator: (code: number) => boolean;
  /** Is `code` an acceptable first character of the path? */
  readonly firstChar: (code: number) => boolean;
  /** `\ ` is an escaped space. */
  readonly escapedSpaces: boolean;
  /** Trailing sentence punctuation is not part of the path. */
  readonly stripPunctuation: boolean;
  /** Imports inside HTML comments are ignored, and a comment ends a path. */
  readonly skipComments: boolean;
  /** A code span ends a path (the tokenizer sees text and code separately). */
  readonly stopAtCode: boolean;
  /** Imports inside the frontmatter block are ignored. */
  readonly skipFrontmatter: boolean;
}

/** Characters that never start a Claude import: quotes (never imported), brackets, `@`. */
const CLAUDE_REJECTED_FIRST = new Set([0x22, 0x27, 0x60, 0x40, 0x28, 0x5b, 0x7b, 0x3c]);

const DIALECTS: Readonly<Record<ImportDialect, DialectRules>> = {
  claude: {
    boundary: (code) => isJsWhitespace(code) || code === 0x28,
    terminator: isJsWhitespace,
    firstChar: (code) => !isJsWhitespace(code) && !CLAUDE_REJECTED_FIRST.has(code),
    escapedSpaces: true,
    stripPunctuation: true,
    skipComments: true,
    stopAtCode: true,
    skipFrontmatter: true,
  },
  gemini: {
    boundary: isGeminiWhitespace,
    terminator: isGeminiWhitespace,
    firstChar: (code) => code === 0x2e || code === 0x2f || isAsciiLetter(code),
    escapedSpaces: false,
    stripPunctuation: false,
    skipComments: false,
    stopAtCode: false,
    skipFrontmatter: false,
  },
};

/** Sentence punctuation (and emphasis `*`) that ends a sentence rather than a path. */
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  '>',
  "'",
  '"',
  '*',
]);

function stripTrailingPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(raw.charAt(end - 1))) end--;
  return raw.slice(0, end);
}

/** Files commonly imported without an extension (Claude's docs use `@README`). */
const EXTENSIONLESS_FILES = new Set([
  'README',
  'LICENSE',
  'LICENCE',
  'CHANGELOG',
  'CONTRIBUTING',
  'AUTHORS',
  'NOTICE',
  'Makefile',
  'Dockerfile',
  'Justfile',
  'Gemfile',
  'Procfile',
  'Rakefile',
]);

function hasDriveLetter(path: string): boolean {
  const separator = path.charAt(2);
  return (
    isAsciiLetter(path.charCodeAt(0)) &&
    path.charAt(1) === ':' &&
    (separator === '/' || separator === '\\')
  );
}

/** `.md`, `.mdc`, `.json`, `.yaml`, `.env`: 1-8 letters and digits, at least one letter. */
function hasFileExtension(segment: string): boolean {
  const dot = segment.lastIndexOf('.');
  const extension = segment.slice(dot + 1);
  if (dot === -1 || extension.length === 0 || extension.length > 8) return false;
  let letter = false;
  for (let i = 0; i < extension.length; i++) {
    const code = extension.charCodeAt(i);
    if (isAsciiLetter(code)) letter = true;
    else if (!isAsciiDigit(code)) return false;
  }
  return letter;
}

/** `.cursorrules`, `.windsurfrules`, `.clinerules`: agent config files without an extension. */
const isDotfile = (segment: string): boolean =>
  segment.length > 1 && segment.startsWith('.') && isAsciiLetter(segment.charCodeAt(1));

function isClearlyPath(path: string): boolean {
  if (path.length === 0 || path.includes('://')) return false;
  if (
    path.startsWith('./') ||
    path.startsWith('../') ||
    path.startsWith('.\\') ||
    path.startsWith('..\\') ||
    path.startsWith('~/') ||
    path.startsWith('/') ||
    hasDriveLetter(path)
  ) {
    return true;
  }
  const segment = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return hasFileExtension(segment) || isDotfile(segment) || EXTENSIONLESS_FILES.has(segment);
}

function kindOf(path: string): ImportReference['kind'] {
  if (path.startsWith('~/')) return 'home';
  if (path.startsWith('/') || hasDriveLetter(path)) return 'absolute';
  return 'relative';
}

function unescape(value: string, rules: DialectRules): string {
  return rules.escapedSpaces ? value.replaceAll('\\ ', ' ') : value;
}

/** End of the path token starting at `start`, stopping at `limit`. */
function tokenEnd(text: string, start: number, limit: number, rules: DialectRules): number {
  let end = start;
  while (end < limit) {
    const code = text.charCodeAt(end);
    if (
      rules.escapedSpaces &&
      code === 0x5c &&
      text.charCodeAt(end + 1) === 0x20 &&
      end + 1 < limit
    ) {
      end += 2;
      continue;
    }
    if (rules.terminator(code)) break;
    end++;
  }
  return end;
}

/**
 * Finds `@path` imports the way `dialect` reads them. `doc` must be `parseMarkdown(text, …)`.
 * Linear apart from binary searches over code and comment spans.
 */
export function findImports(
  text: string,
  doc: MarkdownDocument,
  dialect: ImportDialect,
): ImportReference[] {
  const rules = DIALECTS[dialect];
  const limit = Math.min(doc.analysis.analyzedLength, text.length);
  const comments: Span[] = rules.skipComments
    ? mergeSpans(doc.htmlComments.map((c) => c.span))
    : [];
  const frontmatter = rules.skipFrontmatter ? locateFrontmatter(text) : undefined;
  const from = frontmatter?.kind === 'block' ? frontmatter.bodyOffset : 0;
  const imports: ImportReference[] = [];

  for (let at = text.indexOf('@', from); at !== -1 && at < limit; at = text.indexOf('@', at + 1)) {
    if (at > 0 && !rules.boundary(text.charCodeAt(at - 1))) continue;
    if (doc.isInCode(at) || spansContain(comments, at)) continue;

    const stop = rules.stopAtCode
      ? Math.min(nextSpanStart(doc.codeSpans, at, limit), nextSpanStart(comments, at, limit))
      : limit;
    const end = tokenEnd(text, at + 1, stop, rules);
    const token = text.slice(at + 1, end);
    const raw = rules.stripPunctuation ? stripTrailingPunctuation(token) : token;
    const candidate = unescape(stripTrailingPunctuation(token), rules);
    if (rules.firstChar(token.charCodeAt(0)) && isClearlyPath(candidate)) {
      const path = unescape(raw, rules);
      imports.push({ raw, path, span: { offset: at, length: raw.length + 1 }, kind: kindOf(path) });
    }
    // Like both agents' tokenizers, continue after the token, never inside it.
    at = Math.max(at, end - 1);
  }
  return imports;
}
