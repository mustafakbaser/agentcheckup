/**
 * Explicit units for every size limit. Platforms measure differently:
 * Codex counts UTF-8 bytes, the Agent Skills spec counts characters, JavaScript `.length`
 * counts UTF-16 code units (an emoji is 2). Rules must say which unit they mean.
 */

/** True when `code` is a high surrogate and `next` is a low one: one code point in two units. */
function isPair(code: number, next: number): boolean {
  return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/**
 * Bytes of `text` in UTF-8, as `TextEncoder` writes it: a lone surrogate becomes U+FFFD, three
 * bytes. Counted without encoding a copy.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isPair(code, text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Unicode code points (an emoji is 1, `İ` is 1); a lone surrogate counts as one. */
export function codePointLength(text: string): number {
  let pairs = 0;
  for (let i = 0; i + 1 < text.length; i++) {
    if (isPair(text.charCodeAt(i), text.charCodeAt(i + 1))) {
      pairs++;
      i++;
    }
  }
  return text.length - pairs;
}

/** Number of lines, counting a final line without a terminator. Empty text has 0 lines. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a && i < text.length - 1) lines++;
  }
  return lines;
}

/** Characters per token in agentcheckup's estimate: not a tokenizer count. */
export const CHARS_PER_TOKEN = 4;

/** The estimate of `chars` characters in tokens, rounded up: `Size.tokens` of the load plans. */
export function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Rough token estimate of `text`, {@link tokensOf} its characters. */
export function estimateTokens(text: string): number {
  return tokensOf(codePointLength(text));
}
