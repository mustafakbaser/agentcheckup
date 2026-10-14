/**
 * Output sanitizers, one per output channel.
 *
 * Findings carry text from untrusted repositories: paths, messages that quote excerpts and
 * frontmatter values, symlink targets, configuration warnings, even rule-failure messages. That
 * text ends up in terminals, GitHub Actions logs, annotations, PR comments, job summaries and
 * code scanning. Every untrusted string must pass through the sanitizer of the channel it is
 * written to, at the point where it is written. Rule metadata ships with agentcheck and is
 * trusted, but goes through the same functions: it costs nothing and removes a class of mistakes.
 *
 * All channels share one neutralization policy (`neutralize`):
 *
 * - C0 controls other than TAB and line breaks, DEL, and C1 controls (U+0080 to U+009F, which
 *   include the 8-bit CSI U+009B and OSC U+009D) are rendered visibly as `<U+XXXX>`. An ESC can
 *   therefore never start an escape sequence: an OSC 52 clipboard write `ESC]52;c;…BEL` is shown
 *   as `<U+001B>]52;c;…<U+0007>`. Rendering instead of deleting shows the reader the attempt.
 * - Invisible or deceptive code points are rendered as `<U+XXXX>` too: bidi controls, zero-width
 *   characters, Unicode tag characters (U+E0000 to U+E007F, used for "ASCII smuggling" prompt
 *   injection), variation selectors outside emoji context, fillers and other format characters.
 *   See INVISIBLE_RANGES.
 * - Lone surrogates (invalid UTF-16) are rendered as `<U+D800>` style escapes.
 * - CR, LF and CRLF are line breaks. Single-line fields render each one as `⏎` (or the two
 *   characters `\n` in ASCII mode) so a value can never fake a new output line; multi-line fields
 *   normalize them to LF. A lone CR never survives: it is how text overwrites a terminal line.
 *
 * Emoji context: U+FE0E/U+FE0F (text/emoji presentation) are kept directly after an
 * Extended_Pictographic character or in a keycap sequence (`1\uFE0F\u20E3`), and ZERO WIDTH JOINER is kept
 * between emoji (`👨\u200D👩\u200D👧`). Everything else in those ranges is escaped, which defeats data
 * smuggled into long runs of variation selectors after an emoji. Known trade-offs: ideographic
 * variation sequences (CJK + U+E0100..) and subdivision flags (tag characters) render escaped.
 */

/** Marker for a line break inside a single-line field. */
export const NEWLINE_MARKER = '⏎';
/** ASCII fallback for {@link NEWLINE_MARKER}. */
export const ASCII_NEWLINE_MARKER = '\\n';

/**
 * Invisible or deceptive code points, inclusive ranges, sorted. Deliberately an explicit list
 * rather than `\p{Cf}`: output must not change with the Unicode version of the Node.js runtime.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x034f, 0x034f], // COMBINING GRAPHEME JOINER
  [0x061c, 0x061c], // ARABIC LETTER MARK (bidi)
  [0x115f, 0x1160], // HANGUL CHOSEONG/JUNGSEONG FILLER
  [0x17b4, 0x17b5], // KHMER VOWEL INHERENT AQ/AA
  [0x180b, 0x180f], // MONGOLIAN FREE VARIATION SELECTORS, VOWEL SEPARATOR
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x2028, 0x202e], // LINE/PARAGRAPH SEPARATOR, bidi embeddings and overrides (LRE..RLO)
  [0x2060, 0x206f], // WORD JOINER, invisible operators, bidi isolates (LRI..PDI), deprecated
  [0x3164, 0x3164], // HANGUL FILLER
  [0xfe00, 0xfe0f], // VARIATION SELECTOR-1..16
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE (BOM)
  [0xffa0, 0xffa0], // HALFWIDTH HANGUL FILLER
  [0xfff9, 0xfffb], // INTERLINEAR ANNOTATION controls
  [0xfffe, 0xffff], // noncharacters
  [0x1bca0, 0x1bca3], // SHORTHAND FORMAT controls
  [0x1d173, 0x1d17a], // MUSICAL SYMBOL format controls
  [0xe0000, 0xe007f], // TAG characters
  [0xe0100, 0xe01ef], // VARIATION SELECTOR-17..256
];

const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
/** Printable ASCII only: nothing to neutralize. */
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

/** C0 (except TAB, LF, CR, which callers handle), DEL, C1. */
function isControl(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f);
}

function isSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdfff;
}

function isInvisible(cp: number): boolean {
  if (cp < 0xad) return false;
  for (const [low, high] of INVISIBLE_RANGES) {
    if (cp < low) return false;
    if (cp <= high) return true;
  }
  return false;
}

function isPictographic(cp: number): boolean {
  return cp >= 0 && PICTOGRAPHIC.test(String.fromCodePoint(cp));
}

function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

function isKeycapBase(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a;
}

/**
 * Whether an invisible code point is legitimate here: a presentation selector right after an
 * emoji or in a keycap sequence, or a ZWJ between two emoji.
 */
function keptInEmojiContext(
  cp: number,
  previous: number,
  next: number,
  emojiTail: boolean,
): boolean {
  if (cp === VS15 || cp === VS16) {
    return (emojiTail && isPictographic(previous)) || (isKeycapBase(previous) && next === KEYCAP);
  }
  return cp === ZWJ && emojiTail && isPictographic(next);
}

/** `<U+XXXX>`, at least four upper-case hex digits. */
export function codePointLabel(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

interface NeutralizeOptions {
  /** Replacement for each line break (CR, LF or CRLF). */
  readonly lineBreak: string;
}

/**
 * The shared policy described in the module comment. Iterates by code point, so astral
 * characters stay intact and lone surrogates are seen individually.
 */
function neutralize(text: string, options: NeutralizeOptions): string {
  if (PLAIN_ASCII.test(text)) return text;
  let out = '';
  // True while the last emitted code point can be continued by ZWJ or a presentation selector.
  let emojiTail = false;
  let previous = -1;
  for (let index = 0; index < text.length;) {
    const cp = text.codePointAt(index) ?? 0;
    const size = cp > 0xffff ? 2 : 1;
    const next = text.codePointAt(index + size) ?? -1;
    index += size;

    if (cp === 0x0d || cp === 0x0a) {
      if (cp === 0x0d && next === 0x0a) index += 1;
      out += options.lineBreak;
      emojiTail = false;
    } else if (isControl(cp) || isSurrogate(cp)) {
      out += codePointLabel(cp);
      emojiTail = false;
    } else if (isInvisible(cp)) {
      const keep = keptInEmojiContext(cp, previous, next, emojiTail);
      out += keep ? String.fromCodePoint(cp) : codePointLabel(cp);
      emojiTail = keep && cp === VS16;
    } else {
      out += String.fromCodePoint(cp);
      emojiTail = isPictographic(cp) || (emojiTail && isSkinTone(cp));
    }
    previous = cp;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------------------------

export interface TerminalTextOptions {
  /** Keep line breaks (normalized to LF). Default false: render them as `⏎`. */
  readonly multiline?: boolean | undefined;
  /** Use `\n` instead of `⏎` as the line-break marker. */
  readonly ascii?: boolean | undefined;
}

/**
 * Text for a terminal. TAB is kept. Every other control character, ESC included, is rendered
 * as `<U+XXXX>`, so no escape sequence (colors, cursor movement, OSC 52 clipboard writes,
 * OSC 8 hyperlinks, window-title changes) can reach the terminal from untrusted input.
 */
export function forTerminal(text: string, options: TerminalTextOptions = {}): string {
  let lineBreak = options.ascii === true ? ASCII_NEWLINE_MARKER : NEWLINE_MARKER;
  if (options.multiline === true) lineBreak = '\n';
  return neutralize(text, { lineBreak });
}

// ---------------------------------------------------------------------------------------------
// GitHub Actions workflow commands
// ---------------------------------------------------------------------------------------------

/**
 * `escapeData` from @actions/core (packages/core/src/command.ts). The runner parses one command
 * per line and decodes these escapes after parsing, so escaped data cannot end the line.
 * https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
 */
function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * `escapeProperty` from @actions/core: `escapeData` plus `:` and `,`, which delimit the
 * property list (`::name k=v,k=v::data`). An unescaped `::` in a property would end the
 * property list early; an unescaped `,` would inject a property.
 */
function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/**
 * The data part of a workflow command (`::error …::<data>`). Neutralizes control and invisible
 * characters first, then applies @actions/core's escaping, so a message can never start a new
 * line and therefore never a new command (`::stop-commands::`, `::add-mask::`, a fake `::error`).
 * Line breaks survive as `%0A`: annotations display them as line breaks.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */
export function forWorkflowCommand(data: string): string {
  return escapeData(neutralize(data, { lineBreak: '\n' }));
}

/**
 * A property value of a workflow command (`file=`, `title=`). Single-line: line breaks become
 * `⏎` before @actions/core's property escaping.
 */
export function forWorkflowProperty(value: string): string {
  return escapeProperty(neutralize(value, { lineBreak: NEWLINE_MARKER }));
}

// ---------------------------------------------------------------------------------------------
// Markdown (GitHub-flavored, for PR comments and job summaries)
// ---------------------------------------------------------------------------------------------

/** Breaks GitHub's @mention and issue-reference autolinking; renders as nothing. */
const ZERO_WIDTH_SPACE_ENTITY = '&#8203;';

/** ASCII punctuation with a Markdown meaning, escaped with a backslash (CommonMark 2.4). */
const MARKDOWN_PUNCTUATION = new Set([
  '\\',
  '`',
  '*',
  '_',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '#',
  '+',
  '-',
  '.',
  '!',
  '|',
  '~',
  '$',
  ':',
]);

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const ALPHANUMERIC = /^[\da-z]$/i;
const DIGIT = /^\d$/;

/**
 * Inline Markdown text that renders literally on GitHub, single-line (line breaks become `⏎`),
 * safe inside a table cell.
 *
 * - `<`, `>`, `&`, `"` become entities: no raw HTML, no `<https://…>` autolinks.
 * - Markdown punctuation is backslash-escaped: no links, images, emphasis, code, tables (`|`),
 *   math (`$`). Escaping `:` and `.` also stops GFM's extended autolinks (`https://`, `www.`)
 *   and makes `javascript:` impossible in the output.
 * - `@name` and `#123`/`GH-123` get a zero-width space entity after `@`, `#` or `-`, the approach
 *   Renovate uses, so nobody is notified and no issue is cross-referenced.
 * - Invisible characters are rendered as `<U+XXXX>` (shown as text through the entities).
 */
export function forMarkdown(text: string): string {
  const neutral = neutralize(text, { lineBreak: NEWLINE_MARKER });
  let out = '';
  for (let index = 0; index < neutral.length; index++) {
    // Code-unit iteration is fine: only ASCII is rewritten, surrogate pairs pass through in order.
    const ch = neutral.charAt(index);
    const next = neutral.charAt(index + 1);
    const entity = HTML_ENTITIES[ch];
    if (entity !== undefined) {
      out += entity;
    } else if (ch === '@') {
      out += `@${ZERO_WIDTH_SPACE_ENTITY}`;
    } else if (ch === '#') {
      out += ALPHANUMERIC.test(next) ? `\\#${ZERO_WIDTH_SPACE_ENTITY}` : '\\#';
    } else if (ch === '-') {
      const isGhReference =
        neutral.slice(Math.max(0, index - 2), index).toLowerCase() === 'gh' && DIGIT.test(next);
      out += isGhReference ? `\\-${ZERO_WIDTH_SPACE_ENTITY}` : '\\-';
    } else if (MARKDOWN_PUNCTUATION.has(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------------------------

export interface SarifTextOptions {
  /** Keep line breaks (normalized to LF). Default false: render them as `⏎`. */
  readonly multiline?: boolean | undefined;
}

/**
 * Plain text for SARIF string properties that are not `message` objects (`shortDescription`,
 * `fullDescription`, `help.text`, suppression `justification`).
 */
export function forSarifText(text: string, options: SarifTextOptions = {}): string {
  return neutralize(text, { lineBreak: options.multiline === true ? '\n' : NEWLINE_MARKER });
}

/**
 * Plain text for a SARIF `message.text`. In addition to {@link forSarifText}, escapes square
 * brackets (and backslashes that would otherwise read as an escape) so untrusted text cannot
 * form an embedded link `[text](id)` (SARIF 2.1.0 §3.11.6).
 */
export function forSarifMessage(text: string): string {
  return forSarifText(text).replace(/\\(?=[[\\\]])|[[\]]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

function jsonUnicodeEscape(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    out += `\\u${text.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return out;
}

/**
 * Hardens serialized JSON (from `JSON.stringify`) for display. JSON.stringify already escapes
 * C0 controls and lone surrogates, but leaves DEL, C1 controls, bidi and invisible characters
 * raw, and people `cat` reports. This rewrites them as `\uXXXX` escapes: lossless, because every
 * JSON parser decodes them back to the same string. Outside string literals JSON.stringify
 * output is pure ASCII, so only string contents are touched.
 */
export function forJsonOutput(json: string): string {
  return json.replace(/[^\n\x20-\x7e]/gu, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return isControl(cp) || isSurrogate(cp) || isInvisible(cp) ? jsonUnicodeEscape(ch) : ch;
  });
}
