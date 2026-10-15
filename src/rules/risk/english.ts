/**
 * English-language heuristics for risk rules. They only ever decide to report less: text that is
 * not predominantly English prose is skipped, so the heuristics cannot misfire on other languages.
 */

const LETTER = /^\p{L}$/u;
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'to',
  'and',
  'or',
  'of',
  'in',
  'on',
  'is',
  'are',
  'be',
  'you',
  'your',
  'this',
  'that',
  'for',
  'with',
  'all',
  'any',
  'not',
  'do',
  'if',
  'when',
  'it',
  'must',
  'should',
  'never',
]);

export interface WordToken {
  readonly word: string;
  /** Offset of the word's first character in the scanned text. */
  readonly offset: number;
}

/**
 * Lower-case ASCII words of `text[from, to)` with their offsets, in order. Linear: one pass, no
 * regular expression backtracking. Apostrophes (' and ’) inside a word are kept as `'`.
 */
export function wordTokens(text: string, from = 0, to = text.length): WordToken[] {
  const out: WordToken[] = [];
  let current = '';
  let start = from;
  const flush = (): void => {
    if (current !== '') {
      out.push({ word: current.endsWith("'") ? current.slice(0, -1) : current, offset: start });
    }
    current = '';
  };
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (
      (lower >= 0x61 && lower <= 0x7a) ||
      (lower === 0x27 && current !== '') ||
      lower === 0x2019
    ) {
      if (lower === 0x2019) {
        if (current !== '') current += "'";
      } else {
        if (current === '') start = i;
        current += String.fromCharCode(lower);
      }
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/** Lower-case ASCII words, in order. */
export function words(text: string): string[] {
  return wordTokens(text).map((token) => token.word);
}

/**
 * True when `text` reads as English prose: at least 20 letters, at least 90% of them ASCII, and at
 * least two common English function words.
 */
export function isEnglishProse(text: string): boolean {
  let letters = 0;
  let ascii = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      letters++;
      ascii++;
    } else if (code > 0x7f && LETTER.test(char)) {
      letters++;
    }
  }
  if (letters < 20 || ascii / letters < 0.9) return false;
  let functionWords = 0;
  for (const word of words(text)) {
    if (FUNCTION_WORDS.has(word) && ++functionWords >= 2) return true;
  }
  return false;
}
