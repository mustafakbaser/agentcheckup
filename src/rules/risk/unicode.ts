/**
 * Invisible-character scanner for risk/hidden-unicode. Linear in the text length, one pass,
 * bounded memory: decoded payloads are capped and findings past the cap are only counted.
 */
import type { DecodedText, Severity, Span } from '../../core/types.js';

export type HiddenKind = 'tag' | 'bidi' | 'zero-width' | 'selector';

export interface HiddenRun {
  readonly kind: HiddenKind;
  readonly span: Span;
  readonly severity: Severity;
  /** Number of hidden code points in the run (for `bidi`: on the line). */
  readonly count: number;
  /** Distinct code points in the run, in order of first appearance (at most 4). */
  readonly codePoints: readonly number[];
  /** Printable ASCII hidden in tag characters or variation selectors, capped. */
  readonly payload: string;
  /** For `bidi`: the line also contains right-to-left letters. */
  readonly rtlContext: boolean;
}

const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const CANCEL_TAG = 0xe007f;
const BLACK_FLAG = 0x1f3f4;
const VS16 = 0xfe0f;
/** Payload characters kept per run; longer payloads are cut and marked with an ellipsis. */
const PAYLOAD_LIMIT = 61;
const MAX_DISTINCT = 4;

export function hiddenKind(cp: number): HiddenKind | undefined {
  if (cp >= TAG_FIRST && cp <= TAG_LAST) return 'tag';
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi';
  if (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff ||
    cp === 0x180e
  ) {
    return 'zero-width';
  }
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 'selector';
  return undefined;
}

/** Hebrew, Arabic, Syriac, Thaana, NKo and other right-to-left scripts. */
function isRtlLetter(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) ||
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfefc) ||
    (cp >= 0x10800 && cp <= 0x10fff) ||
    (cp >= 0x1e800 && cp <= 0x1efff)
  );
}

/** Scripts that use ZERO WIDTH (NON-)JOINER inside words: Arabic family, Indic, Southeast Asian. */
function isJoiningScript(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x08ff) ||
    (cp >= 0x0900 && cp <= 0x0dff) ||
    (cp >= 0x0f00 && cp <= 0x0fff) ||
    (cp >= 0x1000 && cp <= 0x109f) ||
    (cp >= 0x1780 && cp <= 0x18af) ||
    (cp >= 0xa980 && cp <= 0xa9df) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfefc)
  );
}

/** Scripts written without spaces, where ZERO WIDTH SPACE marks word boundaries. */
function isSpacelessScript(cp: number): boolean {
  return (
    (cp >= 0x0e00 && cp <= 0x0fff) ||
    (cp >= 0x1000 && cp <= 0x109f) ||
    (cp >= 0x1780 && cp <= 0x17ff) ||
    (cp >= 0x3000 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  );
}

const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

function isEmojiPart(cp: number): boolean {
  if (cp < 0) return false;
  if (cp === VS16 || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === CANCEL_TAG) return true;
  return PICTOGRAPHIC.test(String.fromCodePoint(cp));
}

/**
 * A single zero-width character in a context where it is ordinary text: a joiner inside an emoji
 * ZWJ sequence or inside a word of a joining script, a zero width space between letters of a
 * script without spaces, or a byte order mark at the very start.
 */
function isOrdinaryZeroWidth(cp: number, previous: number, next: number, offset: number): boolean {
  if (cp === 0xfeff) return offset === 0;
  if (cp === 0x200d) {
    return (
      (isEmojiPart(previous) && next >= 0 && PICTOGRAPHIC.test(String.fromCodePoint(next))) ||
      (isJoiningScript(previous) && isJoiningScript(next))
    );
  }
  if (cp === 0x200c) return isJoiningScript(previous) && isJoiningScript(next);
  if (cp === 0x200b) return isSpacelessScript(previous) && isSpacelessScript(next);
  return false;
}

/** Tag characters spelling a subdivision flag after U+1F3F4 (UTS #51 Annex C), e.g. England. */
function isFlagTagSequence(tags: readonly number[], before: number, beforeThat: number): boolean {
  const base = before === BLACK_FLAG || (before === VS16 && beforeThat === BLACK_FLAG);
  if (!base || tags.length < 4 || tags.length > 8) return false;
  if (tags[tags.length - 1] !== CANCEL_TAG) return false;
  for (let i = 0; i < tags.length - 1; i++) {
    const cp = tags[i] ?? 0;
    const digit = cp >= 0xe0030 && cp <= 0xe0039;
    const lower = cp >= 0xe0061 && cp <= 0xe007a;
    if (!digit && !lower) return false;
  }
  return true;
}

function selectorByte(cp: number): number {
  return cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Printable ASCII decoded from variation-selector bytes, or '' when it is not mostly text. */
function decodeSelectorBytes(bytes: readonly number[]): string {
  const text = utf8.decode(Uint8Array.from(bytes));
  let printable = '';
  let total = 0;
  for (const char of text) {
    total++;
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e && printable.length < PAYLOAD_LIMIT) printable += char;
  }
  return total > 0 && printable.length >= 4 && printable.length / total >= 0.8 ? printable : '';
}

interface OpenRun {
  kind: Exclude<HiddenKind, 'bidi'>;
  start: number;
  end: number;
  count: number;
  codePoints: number[];
  /** Tag code points (capped) for the flag check and payload, or selector bytes. */
  units: number[];
  previous: number;
  beforePrevious: number;
}

interface BidiLine {
  start: number;
  count: number;
  codePoints: number[];
}

function pushDistinct(list: number[], cp: number): void {
  if (list.length < MAX_DISTINCT && !list.includes(cp)) list.push(cp);
}

/**
 * The code points {@link hiddenKind} classifies, range by range, and the four Mongolian free
 * variation selectors (U+180B-U+180D, U+180F), which `\p{Variation_Selector}` adds to its ranges.
 */
const HIDDEN_CODE_POINT =
  /[\u{180E}\u{200B}-\u{200D}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}\p{Variation_Selector}]/u;

/**
 * False when `text` holds no code point {@link hiddenKind} classifies. `scanHidden` reports runs
 * of such code points only, so it has nothing to visit in such text.
 */
export function mayHide(text: string): boolean {
  return HIDDEN_CODE_POINT.test(text);
}

/**
 * Finds runs of invisible characters. `visit` is called once per finding in text order, except
 * that a line's bidi finding is emitted when the line ends. Returns nothing; callers cap output.
 */
export function scanHidden(text: string, visit: (run: HiddenRun) => void): void {
  // Most files have none of these characters: one pass of the regular expression engine then
  // replaces the scan code point by code point.
  if (!mayHide(text)) return;
  let open: OpenRun | undefined;
  let bidi: BidiLine | undefined;
  let lineHasRtl = false;
  let previous = -1;
  let beforePrevious = -1;

  const closeRun = (next: number): void => {
    const run = open;
    open = undefined;
    if (run === undefined) return;
    const span = { offset: run.start, length: run.end - run.start };
    if (run.kind === 'tag') {
      if (isFlagTagSequence(run.units, run.previous, run.beforePrevious)) return;
      let payload = '';
      for (const cp of run.units) {
        if (cp >= 0xe0020 && cp <= 0xe007e && payload.length < PAYLOAD_LIMIT) {
          payload += String.fromCharCode(cp - TAG_FIRST);
        }
      }
      visit({
        kind: 'tag',
        span,
        severity: 'error',
        count: run.count,
        codePoints: run.codePoints,
        payload,
        rtlContext: false,
      });
      return;
    }
    if (run.kind === 'selector') {
      if (run.count < 2) return;
      const payload = decodeSelectorBytes(run.units);
      visit({
        kind: 'selector',
        span,
        severity: 'warn',
        count: run.count,
        codePoints: run.codePoints,
        payload,
        rtlContext: false,
      });
      return;
    }
    const only = run.codePoints[0] ?? 0;
    if (run.count === 1 && isOrdinaryZeroWidth(only, run.previous, next, run.start)) return;
    visit({
      kind: 'zero-width',
      span,
      severity: 'warn',
      count: run.count,
      codePoints: run.codePoints,
      payload: '',
      rtlContext: false,
    });
  };

  const closeBidi = (): void => {
    const line = bidi;
    bidi = undefined;
    if (line === undefined) return;
    visit({
      kind: 'bidi',
      span: { offset: line.start, length: 1 },
      severity: lineHasRtl ? 'warn' : 'error',
      count: line.count,
      codePoints: line.codePoints,
      payload: '',
      rtlContext: lineHasRtl,
    });
  };

  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) ?? 0;
    const size = cp > 0xffff ? 2 : 1;
    const kind = hiddenKind(cp);

    if (open !== undefined && kind !== open.kind) closeRun(cp);

    if (kind === 'bidi') {
      bidi ??= { start: i, count: 0, codePoints: [] };
      bidi.count++;
      pushDistinct(bidi.codePoints, cp);
    } else if (kind !== undefined) {
      open ??= {
        kind,
        start: i,
        end: i,
        count: 0,
        codePoints: [],
        units: [],
        previous,
        beforePrevious,
      };
      open.end = i + size;
      open.count++;
      pushDistinct(open.codePoints, cp);
      if (kind === 'tag' && open.units.length < 4 * PAYLOAD_LIMIT) open.units.push(cp);
      if (kind === 'selector' && open.units.length < 4 * PAYLOAD_LIMIT)
        open.units.push(selectorByte(cp));
    }

    if (cp === 0x0a) {
      closeBidi();
      lineHasRtl = false;
    } else if (!lineHasRtl && isRtlLetter(cp)) {
      lineHasRtl = true;
    }
    beforePrevious = previous;
    previous = cp;
    i += size;
  }
  closeRun(-1);
  closeBidi();
}

/** Most runs kept per file: a hostile file can hold one run every other character. */
const MAX_KEPT_RUNS = 1024;
const NO_RUNS: readonly HiddenRun[] = Object.freeze([]);
const RUNS = new WeakMap<DecodedText, readonly HiddenRun[]>();

/**
 * The runs `scanHidden` finds in a decoded file, in its order. Kept per decoding, unless there are
 * more than {@link MAX_KEPT_RUNS}: three rules ask, in every scan that `fix` runs to verify its
 * fixes, and a file the fixes leave alone keeps its decoding.
 */
export function hiddenRuns(decoded: DecodedText): readonly HiddenRun[] {
  const kept = RUNS.get(decoded);
  if (kept !== undefined) return kept;
  const runs: HiddenRun[] = [];
  scanHidden(decoded.text, (run) => runs.push(run));
  if (runs.length === 0) RUNS.set(decoded, NO_RUNS);
  else if (runs.length <= MAX_KEPT_RUNS) RUNS.set(decoded, runs);
  return runs;
}
