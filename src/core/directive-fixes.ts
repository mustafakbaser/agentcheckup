/**
 * Fixes and manual steps for the engine's own directive findings (src/core/directive-rules.ts):
 * removing a directive that suppresses nothing, correcting a misspelled rule id, and showing how
 * a directive without a reason should look. Pure.
 *
 * Fixes edit through the builders of src/fix/edits.ts and are planned like any rule's fix. See
 * docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 */
import { replaceSpan } from '../fix/edits.js';
import { lineEndAfter, lineStartBefore, roundTrips } from '../fix/text.js';
import { DIRECTIVE_UNKNOWN_RULE, DIRECTIVE_UNUSED } from './directive-rules.js';
import { positionAt } from './text.js';
import { type Directive, FILE_KEYWORD, NEXT_LINE_KEYWORD } from './suppress.js';
import type { Artifact, Fix, Span } from './types.js';

/**
 * Most findings one rule reports per file in the rule families that cap them (see
 * MAX_FINDINGS_PER_FILE in src/rules/instructions/helpers.ts). A rule that reported this many
 * may have dropped the finding a directive was written for.
 */
export const CAPPED_FINDINGS = 100;

/** Unknown ids per file the engine looks for a similar rule id for; the rest get no fix. */
export const MAX_SUGGESTED_IDS = 100;

/** Longest edit distance at which a known rule id counts as the misspelled one. */
const MAX_DISTANCE = 2;

/** Rule ids longer than this are not compared: no rule id is close to them. */
const MAX_COMPARED_LENGTH = 128;

/**
 * True when a fix may edit the artifact's file: it is not reached through a symbolic link, no
 * other path links to it, and its bytes decode and encode back unchanged.
 */
export function editableFile(artifact: Artifact): boolean {
  return (
    artifact.file.symlinkTarget === undefined &&
    artifact.aliases.length === 0 &&
    roundTrips(artifact.file.bytes, artifact.decoded)
  );
}

function isBlank(text: string, start: number, end: number): boolean {
  return text.slice(start, end).trim() === '';
}

/** Offset after the line terminator at `lineEnd` (from lineEndAfter), or the end of the text. */
function nextLineStart(text: string, lineEnd: number): number {
  if (text.charCodeAt(lineEnd) === 0x0d && text.charCodeAt(lineEnd + 1) === 0x0a) {
    return lineEnd + 2;
  }
  return text.charCodeAt(lineEnd) === 0x0a ? lineEnd + 1 : lineEnd;
}

/**
 * What to delete to remove the comment at `span`: its whole line or lines when nothing else is
 * on them, together with one of the blank lines around it when it stood between two; otherwise
 * the comment and the spaces that separate it from the rest of its line.
 */
export function directiveRemoval(text: string, span: Span): Span {
  const start = span.offset;
  const end = span.offset + span.length;
  const lineStart = lineStartBefore(text, start);
  const lineEnd = lineEndAfter(text, end);
  const textBefore = !isBlank(text, lineStart, start);
  if (textBefore || !isBlank(text, end, lineEnd)) {
    let from = start;
    let to = end;
    const isSpace = (code: number): boolean => code === 0x20 || code === 0x09;
    if (textBefore) {
      while (from > lineStart && isSpace(text.charCodeAt(from - 1))) from--;
    } else {
      while (to < lineEnd && isSpace(text.charCodeAt(to))) to++;
    }
    return { offset: from, length: to - from };
  }

  let from = lineStart;
  let to = nextLineStart(text, lineEnd);
  if (to === lineEnd) {
    // The last line, without a terminator: remove the line break before it instead.
    if (lineStart > 0)
      from = text.charCodeAt(lineStart - 2) === 0x0d ? lineStart - 2 : lineStart - 1;
    return { offset: from, length: to - from };
  }
  const previousBlank =
    lineStart === 0 || isBlank(text, lineStartBefore(text, lineStart - 1), lineStart);
  const followingEnd = lineEndAfter(text, to);
  if (previousBlank && to < text.length && isBlank(text, to, followingEnd)) {
    to = nextLineStart(text, followingEnd);
  }
  return { offset: from, length: to - from };
}

/** The fix that removes an unused directive. Undefined when its file may not be edited. */
export function unusedDirectiveFix(artifact: Artifact, directive: Directive): Fix | undefined {
  if (!editableFile(artifact)) return undefined;
  const line = positionAt(artifact.decoded, directive.span.offset).line;
  return {
    id: `${DIRECTIVE_UNUSED.id}#remove`,
    class: 'safe',
    title: `Remove the unused directive on line ${line} of ${artifact.path}`,
    changes: [replaceSpan(artifact, directiveRemoval(artifact.decoded.text, directive.span), '')],
  };
}

/**
 * Levenshtein distance between `a` and `b` when it is at most `max`, otherwise `max + 1`. Stops
 * as soon as a row exceeds `max`, so the cost is bounded by the shorter string's length times
 * the longer one's, and the strings are short.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return Math.min(previous[b.length] ?? max + 1, max + 1);
}

/**
 * Rule ids within edit distance 2 of `id`, compared in lower case, sorted. Directive ids are
 * never candidates: a directive cannot suppress them.
 */
export function similarRuleIds(id: string, known: Iterable<string>): string[] {
  if (id.length > MAX_COMPARED_LENGTH) return [];
  const lower = id.toLowerCase();
  const found: string[] = [];
  for (const candidate of known) {
    if (candidate.startsWith('directive/') || candidate === id) continue;
    if (boundedDistance(lower, candidate, MAX_DISTANCE) <= MAX_DISTANCE) found.push(candidate);
  }
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The fix that replaces the misspelled id at `index` of the directive with `replacement`. */
export function unknownRuleFix(
  artifact: Artifact,
  directive: Directive,
  index: number,
  replacement: string,
): Fix | undefined {
  const id = directive.ruleIds[index];
  const span = directive.ruleIdSpans[index];
  if (id === undefined || span === undefined || !editableFile(artifact)) return undefined;
  if (artifact.decoded.text.slice(span.offset, span.offset + span.length) !== id) return undefined;
  const line = positionAt(artifact.decoded, span.offset).line;
  const where = directive.scope === 'file' ? 'anywhere in this file' : 'on the line after it';
  return {
    id: `${DIRECTIVE_UNKNOWN_RULE.id}#rename`,
    class: 'review',
    title: `Replace "${id}" with "${replacement}" in the directive on line ${line}`,
    changes: [replaceSpan(artifact, span, replacement)],
    notes: [`The directive then suppresses ${replacement} findings ${where}.`],
  };
}

/** The manual step for an unknown rule id without a unique similar id. */
export function unknownRuleGuidance(similar: readonly string[]): string {
  if (similar.length > 1) {
    return `replace it with the rule you meant (${similar.slice(0, 3).join(', ')}${similar.length > 3 ? ', …' : ''}) or remove it`;
  }
  return 'correct the id or remove it from the directive; every rule id is listed in the rule docs';
}

/** Rule ids longer than this, together, are shown as a placeholder in guidance. */
const MAX_SHOWN_IDS = 120;

/** The manual step for a directive without rule ids or without a reason: its complete form. */
export function missingReasonGuidance(directive: Directive, yamlComment: boolean): string {
  const keyword = directive.scope === 'file' ? FILE_KEYWORD : NEXT_LINE_KEYWORD;
  const joined = directive.ruleIds.join(', ');
  const ids = joined.length === 0 || joined.length > MAX_SHOWN_IDS ? '<rule-id>' : joined;
  const body = `${keyword} ${ids} -- <reason>`;
  return `write it as ${yamlComment ? `# ${body}` : `<!-- ${body} -->`}`;
}
