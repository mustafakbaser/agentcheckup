import type { Nodes } from 'mdast';
import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Span } from '../../core/types.js';
import type { MarkdownDocument } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quote } from '../shared/format.js';
import { MAX_FINDINGS_PER_FILE, targetedReaders } from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

/**
 * Whole-sentence generic directives, normalized (lower case, single spaces, no emphasis markers,
 * no trailing punctuation). Taken from the examples the cited sources call out, plus close
 * variants. Only an exact match is reported, never a sentence that merely contains one.
 */
const VAGUE_DIRECTIVES: ReadonlySet<string> = new Set([
  'follow best practices',
  'follow the best practices',
  'always follow best practices',
  'follow industry best practices',
  'follow coding best practices',
  'follow general best practices',
  'follow standard best practices',
  'follow modern best practices',
  'follow software engineering best practices',
  'use best practices',
  'apply best practices',
  'adhere to best practices',
  'write clean code',
  'always write clean code',
  'write good code',
  'write better code',
  'write quality code',
  'write high-quality code',
  'write high quality code',
  'write readable code',
  'write maintainable code',
  'write efficient code',
  'write bug-free code',
  'write clean, maintainable code',
  'write clean and maintainable code',
  'write clean, readable code',
  'write clean and readable code',
  'write clean, efficient code',
  'write clean, readable, maintainable code',
  'write clean, readable and maintainable code',
  'write clean, readable, and maintainable code',
  'use meaningful variable names',
  'use meaningful names',
  'use descriptive variable names',
  'use clear variable names',
  'test your changes',
  'test your changes carefully',
  'test your code',
  'make sure everything works',
  'make sure the code works',
  'make sure your code works',
  'ensure everything works',
  'ensure the code works',
  'format code properly',
  'format your code properly',
  'keep files organized',
  'keep the code organized',
  'keep code clean',
  'keep the code clean',
  'keep the codebase clean',
  'follow the existing architecture',
  'be careful',
  'be thorough',
  'be careful with changes',
  'be careful when making changes',
  'use common sense',
  'do your best',
  'avoid bugs',
  "don't introduce bugs",
  'do not introduce bugs',
]);

/** Sentences longer than this cannot be one of the directives; skip normalizing them. */
const MAX_SENTENCE_LENGTH = 80;
/** Above this share of non-ASCII letters the text is not treated as English. */
const MAX_NON_ASCII_LETTER_RATIO = 0.05;
const LETTER = /\p{L}/u;
const SPACES = /\s+/g;

function normalize(sentence: string): string {
  let out = '';
  for (const char of sentence) {
    if (char === '*' || char === '_' || char === '`') continue;
    out += char === '\u2019' ? "'" : char;
  }
  out = out.replace(SPACES, ' ').trim().toLowerCase();
  while (out.length > 0 && '.!;:'.includes(out.charAt(out.length - 1))) {
    out = out.slice(0, -1).trimEnd();
  }
  return out;
}

function paragraphSpans(doc: MarkdownDocument): Span[] {
  const spans: Span[] = [];
  const stack: Nodes[] = [doc.root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'paragraph') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        spans.push({ offset: start, length: end - start });
      continue;
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
  return spans;
}

/** True when the prose is predominantly ASCII letters, a cheap proxy for English text. */
function isEnglishProse(text: string, paragraphs: readonly Span[]): boolean {
  let ascii = 0;
  let other = 0;
  for (const span of paragraphs) {
    for (const char of text.slice(span.offset, span.offset + span.length)) {
      const code = char.codePointAt(0) ?? 0;
      if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) ascii++;
      else if (code > 0x7f && LETTER.test(char)) other++;
    }
  }
  return ascii > 0 && other <= (ascii + other) * MAX_NON_ASCII_LETTER_RATIO;
}

/** Characters that may close a sentence after its terminator: emphasis, code, quotes, brackets. */
function isClosingMark(code: number): boolean {
  return (
    code === 0x2a ||
    code === 0x5f ||
    code === 0x60 ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x29
  );
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Splits a paragraph into sentences: after `.`, `!` or `?` (and any closing emphasis or quote
 * marks) followed by whitespace, and at line breaks. Linear in the paragraph length.
 */
function sentences(text: string, paragraph: Span): Span[] {
  const result: Span[] = [];
  const end = paragraph.offset + paragraph.length;
  const push = (from: number, to: number): void => {
    while (from < to && isSpace(text.charCodeAt(from))) from++;
    while (to > from && isSpace(text.charCodeAt(to - 1))) to--;
    if (to > from) result.push({ offset: from, length: to - from });
  };
  let start = paragraph.offset;
  for (let i = paragraph.offset; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (code !== 0x2e && code !== 0x21 && code !== 0x3f) continue;
    let after = i + 1;
    while (after < end && isClosingMark(text.charCodeAt(after))) after++;
    if (after < end && !isSpace(text.charCodeAt(after))) continue;
    push(start, after);
    start = after;
    i = after - 1;
  }
  push(start, end);
  return result;
}

/** True when `span` overlaps any code span. `codeSpans` is sorted and non-overlapping. */
function overlapsCode(doc: MarkdownDocument, span: Span): boolean {
  const spans = doc.codeSpans;
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const code = spans[mid];
    if (code !== undefined && code.offset + code.length <= span.offset) low = mid + 1;
    else high = mid;
  }
  const candidate = spans[low];
  return candidate !== undefined && candidate.offset < span.offset + span.length;
}

function findVague(artifact: Artifact, doc: MarkdownDocument): Span[] {
  const { text } = artifact.decoded;
  const paragraphs = paragraphSpans(doc);
  if (!isEnglishProse(text, paragraphs)) return [];
  const found: Span[] = [];
  for (const paragraph of paragraphs) {
    for (const sentence of sentences(text, paragraph)) {
      if (sentence.length > MAX_SENTENCE_LENGTH || overlapsCode(doc, sentence)) continue;
      const raw = text.slice(sentence.offset, sentence.offset + sentence.length);
      if (VAGUE_DIRECTIVES.has(normalize(raw))) found.push(sentence);
    }
  }
  return found;
}

export const vagueDirectiveRule = defineRule({
  meta: {
    id: 'instr/vague-directive',
    title: 'Instruction is generic advice that says nothing about the project',
    rationale: [
      'Sentences such as "Follow best practices" or "Write clean code" tell an agent nothing about this project. Claude Code\'s documentation asks for instructions concrete enough to verify ("Use 2-space indentation" instead of "Format code properly"). Windsurf\'s says generic rules like "write good code" are already in Cascade\'s training data, and Cursor\'s says to avoid vague guidance. Gloaguen et al. (2026) found that context files are useful mainly for non-standard practices, and that they raise inference cost by over 20% on average.',
      'agentcheckup reports a sentence only when the whole sentence is one of a fixed list of generic directives, and only in English text.',
      'Replace it with the specific command, convention or path you mean, or delete it.',
    ].join('\n\n'),
    category: 'clarity',
    severity: 'info',
    appliesTo: [
      'agents-md',
      'claude-md',
      'claude-local-md',
      'claude-rule',
      'gemini-md',
      'windsurf-rule',
      'windsurf-legacy-rules',
      'cline-rule',
      'cursor-rule',
      'cursor-legacy-rules',
      'copilot-instructions',
      'copilot-path-instructions',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [
      SOURCES.claudeMemory,
      SOURCES.windsurfRules,
      SOURCES.cursorRules,
      INSTRUCTION_SOURCES.aaifEffectiveAgentsMd,
      INSTRUCTION_SOURCES.evaluatingAgentsMd,
      INSTRUCTION_SOURCES.augmentAgentsMd,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platforms = targetedReaders(context, artifact);
      if (platforms.length === 0) continue;
      for (const span of findVague(artifact, context.markdown(artifact)).slice(
        0,
        MAX_FINDINGS_PER_FILE,
      )) {
        const sentence = artifact.decoded.text.slice(span.offset, span.offset + span.length);
        context.report({
          artifact,
          span,
          platforms,
          message: `${quote(sentence)} is generic advice that tells the agent nothing about this project. Replace it with the specific command, convention or path you mean.`,
          guidance:
            'name what you mean, such as the exact test command or a naming rule, or delete the sentence',
        });
      }
    }
  },
});
