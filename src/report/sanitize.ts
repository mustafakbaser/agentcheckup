/**
 * Output sanitizers, one per output channel.
 *
 * Findings carry text from untrusted repositories: paths, messages that quote excerpts and
 * frontmatter values, symlink targets, configuration warnings, even rule-failure messages. That
 * text ends up in terminals, GitHub Actions logs, annotations, PR comments, job summaries and
 * code scanning. Every untrusted string must pass through the sanitizer of the channel it is
 * written to, at the point where it is written. Rule metadata ships with agentcheckup and is
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

/**
 * The prefix of the runner's older command syntax, `##[name k=v;k=v]data`, which it still reads
 * anywhere in a line (ActionCommand.TryParse looks for the first `##[`).
 */
const LEGACY_COMMAND = /##\[/g;

/**
 * Terminal output is also read by the GitHub Actions runner, which treats every log line whose
 * first non-blank characters are `::` as a workflow command (it trims leading white space before
 * parsing), and every line that contains `##[` as one in the older syntax. A scanned path printed
 * at the start of a line, or a skill or MCP server name anywhere in one, could therefore fake an
 * annotation, mask a word or switch command processing off with `::stop-commands::` or
 * `##[stop-commands]`. This renders the first colon of such a line as `<U+003A>` and the bracket
 * of each `##[` as `<U+005B>`. Apply it to the whole output, after {@link forTerminal}: line
 * breaks in untrusted text are already markers, so every `\n` here is one the formatter wrote.
 * It also breaks the lines that a problem matcher would annotate ({@link guardProblemMatchers}).
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionCommandManager.cs
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionCommand.cs
 */
export function guardWorkflowCommands(output: string): string {
  const text = guardProblemMatchers(output);
  if (!text.includes('::') && !text.includes('##[')) return text;
  return text
    .split('\n')
    .map((line) => {
      const start = line.length - line.trimStart().length;
      if (!line.startsWith('::', start)) return line;
      return `${line.slice(0, start)}${codePointLabel(0x3a)}${line.slice(start + 1)}`;
    })
    .join('\n')
    .replace(LEGACY_COMMAND, `##${codePointLabel(0x5b)}`);
}

/** The start of an SGR sequence, `ESC [ 1;31 m`: a color or style, which formatters add. */
const ESC_BRACKET = '\u001b[';
const SGR_PARAMETER: ReadonlySet<string> = new Set('0123456789;');
/**
 * The colon tsc's problem matcher needs after the error code:
 * `^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*(.*)$`.
 * The matchers are case-sensitive. These patterns run on one line at a time, and their `\s` is
 * more than the runner's, which applies matchers with RegexOptions.ECMAScript (IssueMatcher.cs).
 */
const TSC_PROBLEM = /(?:error|warning|info)\s+TS\d+\s*:/g;
/**
 * The colon eslint-compact's problem matcher needs before the position:
 * `^(.+):\sline\s(\d+),\scol\s(\d+),\s([Ee]rror|[Ww]arning|[Ii]nfo)\s-\s(.+)\s\((.+)\)$`.
 */
const ESLINT_COMPACT_PROBLEM =
  /:(?=\sline\s\d+,\scol\s\d+,\s(?:[Ee]rror|[Ww]arning|[Ii]nfo)\s-\s)/g;
/**
 * The colon eslint-stylish's problem matcher needs in the position of a finding line, which it
 * reads after any other line: `^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*)\s\s+(.*)$`.
 */
const ESLINT_STYLISH_PROBLEM = /^\s+\d+:(?=\d+\s+(?:error|warning|info)\s)/;

/**
 * actions/setup-node registers problem matchers for tsc, eslint-stylish and eslint-compact in
 * every job that runs it, and the runner turns each line of a step's output that one matches
 * into an annotation. A scanned path or name in a line could therefore fake an error such as
 * `x(1,1): error TS2: Security review passed`. This renders the colon each matcher needs as
 * `<U+003A>`: the one after `TS<code>`, the one before `line <n>, col <n>,`, and the one inside
 * the position at the start of an indented line. agentcheckup writes none of these shapes itself.
 * The shapes are matched as if without colors, which the runner means to remove first.
 * https://github.com/actions/setup-node/tree/main/.github
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/OutputManager.cs
 */
function guardProblemMatchers(text: string): string {
  return text.split('\n').map(guardProblemLine).join('\n');
}

function guardProblemLine(line: string): string {
  const colors = sgrSequences(line);
  let plain = line;
  if (colors.length > 0) {
    plain = '';
    let from = 0;
    for (const { index, length } of colors) {
      plain += line.slice(from, index);
      from = index + length;
    }
    plain += line.slice(from);
  }
  const colons: number[] = [];
  for (const match of plain.matchAll(TSC_PROBLEM)) colons.push(match.index + match[0].length - 1);
  for (const match of plain.matchAll(ESLINT_COMPACT_PROBLEM)) colons.push(match.index);
  const row = ESLINT_STYLISH_PROBLEM.exec(plain);
  if (row !== null) colons.push(row[0].length - 1);
  if (colons.length === 0) return line;
  colons.sort((a, b) => a - b);
  let out = '';
  let from = 0;
  // Offsets in `plain` move by the length of the color sequences before them in `line`.
  let shift = 0;
  let next = 0;
  for (const colon of colons) {
    for (let color = colors[next]; color && color.index - shift <= colon; color = colors[++next]) {
      shift += color.length;
    }
    const at = colon + shift;
    if (at < from) continue;
    out += `${line.slice(from, at)}${codePointLabel(0x3a)}`;
    from = at + 1;
  }
  return out + line.slice(from);
}

/** Where `text` has an SGR sequence. */
function sgrSequences(text: string): { readonly index: number; readonly length: number }[] {
  const found: { index: number; length: number }[] = [];
  for (let index = text.indexOf(ESC_BRACKET); index !== -1;) {
    let end = index + ESC_BRACKET.length;
    while (end < text.length && SGR_PARAMETER.has(text.charAt(end))) end++;
    if (text.charAt(end) === 'm') found.push({ index, length: end + 1 - index });
    index = text.indexOf(ESC_BRACKET, end);
  }
  return found;
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
 *
 * JSON printed in GitHub Actions is read by the runner too, which finds commands of the older
 * syntax anywhere in a line (see {@link guardWorkflowCommands}): the bracket of each `##[`
 * becomes the escape `\u005b`. Lossless as well: `##[` only occurs inside string literals,
 * where `[` is never part of an escape. No line can start with `::`: after its indentation,
 * every line of JSON.stringify output starts with a quote, a bracket, a brace or a literal.
 */
export function forJsonOutput(json: string): string {
  return json
    .replace(/[^\n\x20-\x7e]/gu, (ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return isControl(cp) || isSurrogate(cp) || isInvisible(cp) ? jsonUnicodeEscape(ch) : ch;
    })
    .replace(LEGACY_COMMAND, '##\\u005b');
}
