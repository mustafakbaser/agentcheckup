/**
 * Explicit units for every size limit. Platforms measure differently:
 * Codex counts UTF-8 bytes, the Agent Skills spec counts characters, JavaScript `.length`
 * counts UTF-16 code units (an emoji is 2). Rules must say which unit they mean.
 */

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Unicode code points (an emoji is 1, `İ` is 1). */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
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
