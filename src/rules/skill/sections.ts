/**
 * Splitting a long skill body for skill/body-too-long: which Markdown sections move into new files
 * next to SKILL.md, and under which names. The move itself is built by `moveSections` in
 * src/fix/edits.ts, which copies each section byte for byte and leaves its heading and a link.
 *
 * Section boundaries come from the Markdown parse (`context.markdown()`), never from raw text.
 * A section stays where moving it could change what an agent reads, hide something a scan
 * reports, or break a link; see {@link splitBody}.
 *
 * Pure. See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 */
import type { Heading, Nodes } from 'mdast';
import { estimateTokens, lineCount } from '../../core/measure.js';
import { dirnamePosix, joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, FileChange, Snapshot, Span } from '../../core/types.js';
import {
  isSectionFileName,
  type MarkdownSection,
  moveSections,
  siblingPath,
  skillSlug,
} from '../../fix/edits.js';
import { foldPath } from '../../fix/paths.js';
import { applyEdits } from '../../fix/text.js';
import type { MarkdownDocument } from '../../parse/types.js';
import { classify } from '../../platforms/classify.js';
import { findRemoteExecutionInLine } from '../risk/remote-script.js';
import { scanHidden } from '../risk/unicode.js';
import { relativeLinkPath } from './broken-reference.js';
import { hasNonAsciiLetters } from './fixes.js';
import { injectedCommands } from './shell-preprocessing.js';

/** Most files one split creates. */
export const MAX_MOVED_SECTIONS = 8;
/** Sections shorter than this many lines stay: a link would save too little. */
export const MIN_MOVED_LINES = 10;
/** Suffixes tried after the plain name: `-2` through `-9`. */
const MAX_NAME_SUFFIX = 9;

export interface BodyLimits {
  readonly maxLines: number;
  readonly maxTokens: number;
}

/** A body's size as skill/body-too-long measures it. */
export interface BodySize {
  readonly lines: number;
  readonly tokens: number;
}

export interface BodySplit {
  /** The edit of SKILL.md, then one create per moved section, in document order. */
  readonly changes: readonly FileChange[];
  /** Names of the new files, in document order. */
  readonly names: readonly string[];
  readonly before: BodySize;
  readonly after: BodySize;
}

export interface SplitInput {
  readonly artifact: Artifact;
  readonly doc: MarkdownDocument;
  /** Offset of the body: the end of the frontmatter, or 0. */
  readonly bodyStart: number;
  readonly limits: BodyLimits;
  readonly snapshot: Snapshot;
  /** Names the frontmatter declares in `arguments`, which Claude Code replaces as `$name`. */
  readonly argumentNames: readonly string[];
  /** Every path of the snapshot, files and directories, case-folded with `foldPath`. */
  readonly takenPaths: () => ReadonlySet<string>;
}

/** A section at the split level, with what decides whether and in which order it moves. */
interface Candidate {
  readonly section: MarkdownSection;
  /** 1-based position among the sections of its level, for the `section-<n>.md` fallback. */
  readonly ordinal: number;
  /** Base of its file name: the heading's slug, or `section-<n>`. */
  readonly base: string;
  /** Lines from the heading through the last line of content. */
  readonly lines: number;
  readonly tokens: number;
}

/** A top-level heading of the body. */
interface TopHeading {
  readonly node: Heading;
  readonly depth: number;
  readonly start: number;
  readonly end: number;
}

/** The text of a heading as a reader sees it: text, code and image descriptions. */
function plainText(root: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'text' || node.type === 'inlineCode') parts.push(node.value);
    else if (node.type === 'image' && typeof node.alt === 'string') parts.push(node.alt);
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
  return parts.join('');
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The letters and digits of a heading or a fragment, lowercased. Anchors differ between
 * renderers (GitHub keeps `-` and `_`, others do not), so comparing only letters and digits errs
 * towards keeping a section.
 */
function anchorKey(text: string): string {
  let key = '';
  for (const char of text.toLowerCase()) if (LETTER_OR_DIGIT.test(char)) key += char;
  return key;
}

/** The fragment of a link to a heading of this file (`#usage`, `SKILL.md#usage`), or undefined. */
function ownFragment(url: string, fileName: string): string | undefined {
  const trimmed = url.trim();
  const hash = trimmed.indexOf('#');
  if (hash === -1) return undefined;
  let path = trimmed.slice(0, hash);
  if (path.startsWith('./')) path = path.slice(2);
  if (path !== '' && path !== fileName) return undefined;
  try {
    return decodeURIComponent(trimmed.slice(hash + 1));
  } catch {
    return trimmed.slice(hash + 1);
  }
}

/** Keys a fragment may match: itself, and without a duplicate suffix such as `-2`. */
function fragmentKeys(fragment: string): string[] {
  const keys = [anchorKey(fragment)];
  let end = fragment.length;
  while (end > 0 && fragment.charCodeAt(end - 1) >= 0x30 && fragment.charCodeAt(end - 1) <= 0x39) {
    end--;
  }
  if (end < fragment.length && end > 0 && fragment.charAt(end - 1) === '-') {
    keys.push(anchorKey(fragment.slice(0, end - 1)));
  }
  return keys.filter((key) => key !== '');
}

/** Offsets of the two ends of a link to a heading of this file: the link and the heading. */
interface FragmentPair {
  readonly link: number;
  readonly heading: number;
}

/** What the whole document holds that pins a section in place. */
interface Pins {
  /**
   * Spans that must not move: render-time constructs, hidden text, references, risky commands,
   * and links skill/broken-reference may report, which it does not check in other files.
   */
  readonly spans: readonly Span[];
  /** Links to headings of this file. A section stays when it holds one end but not the other. */
  readonly fragments: readonly FragmentPair[];
}

function nodeSpan(node: Nodes): Span | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined
    ? undefined
    : { offset: start, length: end - start };
}

/** Bidirectional marks that `scanHidden` leaves to the context: LRM, RLM and ALM. */
const BIDI_MARKS: ReadonlySet<number> = new Set([0x200e, 0x200f, 0x061c]);

/**
 * Text Claude Code replaces before the model reads the skill: `$ARGUMENTS`, `$ARGUMENTS[N]`,
 * `$N`, `$name` for a declared argument, and `${CLAUDE_…}` variables. In a linked file they would
 * reach the model as written.
 */
function placeholderSpans(text: string, from: number, argumentNames: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (let at = text.indexOf('$', from); at !== -1; at = text.indexOf('$', at + 1)) {
    const next = text.charCodeAt(at + 1);
    const digit = next >= 0x30 && next <= 0x39;
    if (
      digit ||
      text.startsWith('ARGUMENTS', at + 1) ||
      text.startsWith('{CLAUDE_', at + 1) ||
      argumentNames.some((name) => text.startsWith(name, at + 1))
    ) {
      spans.push({ offset: at, length: 2 });
    }
  }
  return spans;
}

function collectPins(input: SplitInput): Pins {
  const { artifact, doc, bodyStart, argumentNames } = input;
  const { text, lineStarts } = artifact.decoded;
  const spans: Span[] = [];

  for (const injected of injectedCommands(text, doc.root)) spans.push(injected.span);
  spans.push(...placeholderSpans(text, bodyStart, argumentNames));
  for (const comment of doc.htmlComments) spans.push(comment.span);
  scanHidden(text, (run) => spans.push(run.span));
  for (let i = bodyStart; i < text.length; i++) {
    if (BIDI_MARKS.has(text.charCodeAt(i))) spans.push({ offset: i, length: 1 });
  }
  for (const [index, start] of lineStarts.entries()) {
    if (start < bodyStart) continue;
    const match = findRemoteExecutionInLine(text, start, lineStarts[index + 1] ?? text.length);
    if (match !== undefined) spans.push({ offset: match.offset, length: match.length });
  }

  const headings = new Map<string, number[]>();
  const stack: Nodes[] = [doc.root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const span = nodeSpan(node);
    if (span !== undefined) {
      if (
        node.type === 'linkReference' ||
        node.type === 'imageReference' ||
        node.type === 'definition'
      ) {
        spans.push(span);
      } else if (node.type === 'heading') {
        const key = anchorKey(plainText(node));
        if (key !== '') {
          const offsets = headings.get(key);
          if (offsets === undefined) headings.set(key, [span.offset]);
          else offsets.push(span.offset);
        }
      }
    }
    if ('children' in node) for (const child of node.children) stack.push(child);
  }

  const fileName = artifact.path.slice(artifact.path.lastIndexOf('/') + 1);
  const directory = dirnamePosix(artifact.path);
  const fragments: FragmentPair[] = [];
  for (const link of doc.links) {
    const path = relativeLinkPath(link.url);
    const resolved = path === undefined ? undefined : joinRelative(directory, path);
    const found =
      resolved !== undefined &&
      resolved.startsWith(`${directory}/`) &&
      pathStatus(input.snapshot, resolved) === 'exists';
    if (path !== undefined && !found) spans.push(link.span);
    const fragment = ownFragment(link.url, fileName);
    if (fragment === undefined) continue;
    for (const key of fragmentKeys(fragment)) {
      for (const heading of headings.get(key) ?? []) {
        fragments.push({ link: link.span.offset, heading });
      }
    }
  }
  return { spans, fragments };
}

/** True when `pins` keep the section `[start, end)` in place. */
function pinned(pins: Pins, start: number, end: number): boolean {
  const inside = (offset: number): boolean => offset >= start && offset < end;
  if (pins.spans.some((span) => span.offset < end && span.offset + span.length > start)) {
    return true;
  }
  return pins.fragments.some((pair) => inside(pair.link) !== inside(pair.heading));
}

function topHeadings(doc: MarkdownDocument): TopHeading[] {
  const headings: TopHeading[] = [];
  for (const node of doc.root.children) {
    if (node.type !== 'heading') continue;
    const span = nodeSpan(node);
    if (span === undefined) continue;
    headings.push({ node, depth: node.depth, start: span.offset, end: span.offset + span.length });
  }
  return headings;
}

/** The shallowest heading depth that occurs at least twice, or undefined. */
function splitDepth(headings: readonly TopHeading[]): number | undefined {
  const counts = new Map<number, number>();
  for (const heading of headings) counts.set(heading.depth, (counts.get(heading.depth) ?? 0) + 1);
  const repeated = [...counts].filter(([, count]) => count >= 2).map(([depth]) => depth);
  return repeated.length === 0 ? undefined : Math.min(...repeated);
}

/**
 * The sections at `depth`: each runs from its heading to the next heading of the same or a
 * lower depth, or to the end of the text.
 */
function sectionsAt(
  input: SplitInput,
  headings: readonly TopHeading[],
  depth: number,
): Candidate[] {
  const { text } = input.artifact.decoded;
  const ends = new Map<TopHeading, number>();
  let next = text.length;
  for (let i = headings.length - 1; i >= 0; i--) {
    const heading = headings[i];
    if (heading === undefined || heading.depth > depth) continue;
    ends.set(heading, next);
    next = heading.start;
  }

  const candidates: Candidate[] = [];
  const children = input.doc.root.children;
  let child = 0;
  for (const heading of headings) {
    const end = ends.get(heading);
    if (heading.depth !== depth || end === undefined) continue;
    let contentEnd = heading.end;
    let lastLine = heading.node.position?.end.line ?? 0;
    for (; child < children.length; child++) {
      const node = children[child];
      const span = node === undefined ? undefined : nodeSpan(node);
      if (span === undefined || span.offset < heading.start) continue;
      if (span.offset >= end) break;
      contentEnd = Math.max(contentEnd, span.offset + span.length);
      lastLine = Math.max(lastLine, node?.position?.end.line ?? 0);
    }
    const ordinal = candidates.length + 1;
    const title = plainText(heading.node);
    const slug = hasNonAsciiLetters(title) ? '' : skillSlug(title);
    candidates.push({
      section: { heading: { offset: heading.start, length: heading.end - heading.start }, end },
      ordinal,
      base: slug === '' ? `section-${ordinal}` : slug,
      lines: lastLine - (heading.node.position?.start.line ?? lastLine) + 1,
      tokens: estimateTokens(text.slice(heading.start, contentEnd)),
    });
  }
  return candidates;
}

/** True when a new file named `name` next to SKILL.md is free and no agent reads it. */
function freeName(input: SplitInput, name: string, used: ReadonlySet<string>): boolean {
  if (!isSectionFileName(name) || used.has(foldPath(name))) return false;
  const path = siblingPath(input.artifact.path, name);
  // An all-lowercase `claude.md` in a subdirectory is not classified, but macOS and Windows open
  // it as CLAUDE.md: the upper-case spelling is classified with a letter-case mismatch.
  return (
    !input.takenPaths().has(foldPath(path)) &&
    pathStatus(input.snapshot, path) === 'missing' &&
    classify(path) === undefined &&
    classify(siblingPath(input.artifact.path, name.toUpperCase())) === undefined
  );
}

/**
 * File names for `chosen`, in document order: `<base>.md`, else `<base>-2.md` through
 * `<base>-9.md`. Undefined when a section has no free name.
 */
function nameSections(input: SplitInput, chosen: readonly Candidate[]): string[] | undefined {
  const used = new Set<string>();
  const names: string[] = [];
  for (const candidate of chosen) {
    let found: string | undefined;
    for (let suffix = 1; suffix <= MAX_NAME_SUFFIX && found === undefined; suffix++) {
      const name = suffix === 1 ? `${candidate.base}.md` : `${candidate.base}-${suffix}.md`;
      if (freeName(input, name, used)) found = name;
    }
    if (found === undefined) return undefined;
    used.add(foldPath(found));
    names.push(found);
  }
  return names;
}

function measure(text: string, bodyStart: number): BodySize {
  const body = text.slice(bodyStart);
  return { lines: lineCount(body), tokens: estimateTokens(body) };
}

const fits = (size: BodySize, limits: BodyLimits): boolean =>
  size.lines <= limits.maxLines && size.tokens <= limits.maxTokens;

/** Moves the movable sections at one depth, largest first, until the body fits. */
function splitAt(
  input: SplitInput,
  candidates: readonly Candidate[],
  pins: Pins,
  before: BodySize,
): BodySplit | undefined {
  const { artifact, bodyStart, limits } = input;
  const byLines = before.lines > limits.maxLines;
  const movable = candidates
    .slice(1)
    .filter(
      (candidate) =>
        candidate.lines >= MIN_MOVED_LINES &&
        !pinned(pins, candidate.section.heading.offset, candidate.section.end),
    )
    .sort(
      (a, b) =>
        (byLines ? b.lines - a.lines : b.tokens - a.tokens) ||
        b.section.heading.offset - a.section.heading.offset,
    );

  let chosen: Candidate[] = [];
  for (const candidate of movable) {
    if (chosen.length === MAX_MOVED_SECTIONS) break;
    const tried = [...chosen, candidate].sort(
      (a, b) => a.section.heading.offset - b.section.heading.offset,
    );
    const names = nameSections(input, tried);
    if (names === undefined) continue;
    const changes = moveSections(
      artifact,
      tried.map((item) => item.section),
      names,
    );
    const edit = changes?.[0];
    if (changes === undefined || edit?.kind !== 'edit') continue;
    chosen = tried;
    const after = measure(applyEdits(artifact.decoded.text, edit.edits), bodyStart);
    if (fits(after, limits)) return { changes, names, before, after };
  }
  return undefined;
}

/**
 * Plans moving sections of the body into new Markdown files next to SKILL.md until the body is
 * within `limits`, as skill/body-too-long measures it.
 *
 * - The split level is the shallowest heading level that occurs at least twice among the
 *   top-level headings; when moving sections at that level is not enough, one level deeper.
 * - The text before the first section and the first section always stay: Claude Code re-attaches
 *   the start of the body after compaction.
 * - The largest sections move first (by lines when the body has too many lines, otherwise by
 *   tokens; of two the same size, the later one), at most 8.
 * - A section stays when it has fewer than 10 lines, or holds a command or placeholder Claude
 *   Code replaces while rendering the skill, an HTML comment, hidden or bidirectional
 *   characters, a reference-style link or definition, a command that downloads and runs a
 *   script, a relative link to no file inside the skill directory, or one end of a link to a
 *   heading of this file whose other end is outside it.
 * - Each file is named after the heading's slug (`section-<n>.md`, `n` counting the sections of
 *   its level, when the heading has letters outside ASCII or no letters or digits), with `-2` to
 *   `-9` added when the name is taken in any letter case or names a file an agent reads.
 *
 * Undefined when the Markdown was not analyzed completely or no such split fits.
 */
export function splitBody(input: SplitInput): BodySplit | undefined {
  const { artifact, doc, bodyStart, limits } = input;
  if (!doc.analysis.complete) return undefined;
  const before = measure(artifact.decoded.text, bodyStart);
  if (fits(before, limits)) return undefined;
  const headings = topHeadings(doc);
  const depth = splitDepth(headings);
  if (depth === undefined) return undefined;
  const pins = collectPins(input);
  for (const level of depth < 6 ? [depth, depth + 1] : [depth]) {
    const split = splitAt(input, sectionsAt(input, headings, level), pins, before);
    if (split !== undefined) return split;
  }
  return undefined;
}
