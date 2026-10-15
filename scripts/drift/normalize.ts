/**
 * Turns fetched content into stable text for hashing.
 *
 * The goal is a hash that changes when the text a reader sees changes, and not when a site is
 * rebuilt. HTML is reduced to its visible text: script, style, navigation, header and footer
 * content is dropped and tags are removed, which also removes build ids, hashed asset names,
 * nonces and other attributes. When a page marks its content with exactly one `<main>`, only
 * that element is used, so sidebars and "related posts" outside it do not count.
 *
 * Fetched content is untrusted. The HTML scanner below uses `indexOf` and single-character
 * checks only, so its running time is linear in the input.
 */
import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const BOM = String.fromCharCode(0xfeff);

/**
 * Plain text and Markdown: no byte order mark, LF line endings, no trailing spaces, no leading or
 * trailing blank lines.
 */
export function normalizeText(text: string): string {
  const lines = (text.startsWith(BOM) ? text.slice(1) : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end).join('\n');
}

/** Elements whose content is not part of the page text. */
const DROPPED = new Set([
  'canvas',
  'footer',
  'head',
  'header',
  'iframe',
  'nav',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
  'template',
]);

/** Elements whose content is raw text: tags inside them are not tags. */
const RAW_TEXT = new Set(['noscript', 'script', 'style', 'template', 'textarea', 'title', 'xmp']);

/** Elements that never have content or an end tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

type Token =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'start'; readonly name: string; readonly selfClosing: boolean }
  | { readonly type: 'end'; readonly name: string };

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isNameChar(ch: string): boolean {
  return isAsciiLetter(ch) || (ch >= '0' && ch <= '9') || ch === '-' || ch === ':';
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/** Index just past the `>` that ends a tag, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number {
  for (let index = from; index < html.length; index++) {
    const ch = html.charAt(index);
    if (ch === '>') return index + 1;
    if (ch !== '=') continue;
    let value = index + 1;
    while (value < html.length && isSpace(html.charAt(value))) value++;
    const quote = html.charAt(value);
    if (quote !== '"' && quote !== "'") continue;
    const close = html.indexOf(quote, value + 1);
    if (close < 0) return html.length;
    index = close;
  }
  return html.length;
}

/** Start and end of the `</name ...>` tag that closes a raw text element, or the end of input. */
function closingTag(html: string, from: number, name: string): { start: number; end: number } {
  for (let index = html.indexOf('</', from); index >= 0; index = html.indexOf('</', index + 2)) {
    const after = index + 2 + name.length;
    const next = html.charAt(after);
    if (
      html.slice(index + 2, after).toLowerCase() === name &&
      (next === '' || next === '>' || next === '/' || isSpace(next))
    ) {
      return { start: index, end: tagEnd(html, after) };
    }
  }
  return { start: html.length, end: html.length };
}

/** A forgiving HTML tokenizer: enough to find text and element boundaries, nothing more. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const text = (end: number): void => {
    if (end > index) tokens.push({ type: 'text', text: html.slice(index, end) });
  };
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt < 0) break;
    const next = html.charAt(lt + 1);
    if (html.startsWith('<!--', lt)) {
      text(lt);
      const close = html.indexOf('-->', lt + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    if (next === '!' || next === '?') {
      text(lt);
      const close = html.indexOf('>', lt + 2);
      index = close < 0 ? html.length : close + 1;
      continue;
    }
    const closing = next === '/';
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isAsciiLetter(html.charAt(nameStart))) {
      // A literal `<`, as in `a < b`: keep it as text.
      text(lt + 1);
      index = lt + 1;
      continue;
    }
    text(lt);
    let nameEnd = nameStart;
    while (nameEnd < html.length && isNameChar(html.charAt(nameEnd))) nameEnd++;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    index = end;
    if (closing) {
      tokens.push({ type: 'end', name });
      continue;
    }
    const selfClosing = html.charAt(end - 2) === '/';
    tokens.push({ type: 'start', name, selfClosing });
    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = closingTag(html, end, name);
      if (close.start > end) tokens.push({ type: 'text', text: html.slice(end, close.start) });
      tokens.push({ type: 'end', name });
      index = close.end;
    }
  }
  text(html.length);
  return tokens;
}

function hasContent(token: Token & { type: 'start' }): boolean {
  return !token.selfClosing && !VOID.has(token.name);
}

/** The tokens inside the only `<main>` element, or all tokens when there is not exactly one. */
function mainContent(tokens: readonly Token[]): readonly Token[] {
  const starts = tokens.flatMap((token, index) =>
    token.type === 'start' && token.name === 'main' && hasContent(token) ? [index] : [],
  );
  const [start] = starts;
  if (starts.length !== 1 || start === undefined) return tokens;
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.type === 'start' && token.name === 'main' && hasContent(token)) depth++;
    if (token?.type === 'end' && token.name === 'main') depth--;
    if (depth === 0) return tokens.slice(start + 1, index);
  }
  return tokens.slice(start + 1);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rarr: '→',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  times: '×',
  trade: '™',
};

const ENTITY = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z][\da-z]{1,31}));/gi;

/** Decodes numeric entities and common named ones; unknown entities stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
    const cp = decimal === undefined ? Number.parseInt(hex ?? '', 16) : Number(decimal);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
    return String.fromCodePoint(cp);
  });
}

/** The visible text of an HTML page as one line with single spaces. */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  let dropped: string | undefined;
  let depth = 0;
  for (const token of mainContent(tokenize(html))) {
    if (dropped !== undefined) {
      if (token.type === 'start' && token.name === dropped && hasContent(token)) depth++;
      if (token.type === 'end' && token.name === dropped && --depth === 0) dropped = undefined;
      continue;
    }
    if (token.type === 'text') {
      parts.push(token.text);
    } else if (token.type === 'start' && DROPPED.has(token.name) && hasContent(token)) {
      dropped = token.name;
      depth = 1;
    } else {
      // Tag boundaries separate words: `<li>a</li><li>b</li>` reads as `a b`.
      parts.push(' ');
    }
  }
  return decodeEntities(parts.join('')).replace(/\s+/gu, ' ').trim();
}

/** Whether a body looks like HTML even though it was served as something else. */
export function looksLikeHtml(text: string): boolean {
  const start = text.trimStart().slice(0, 15).toLowerCase();
  return start.startsWith('<!doctype html') || start.startsWith('<html');
}

/** Normalizes content for hashing according to its kind. */
export function normalizeContent(text: string, kind: 'html' | 'text'): string {
  return kind === 'html' ? htmlToText(text) : normalizeText(text);
}
