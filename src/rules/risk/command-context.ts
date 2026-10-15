/**
 * What the prose around a command says about it, for risk/remote-script-execution. English-only
 * word matching that can only suppress findings, never create them. Linear: every block and
 * heading is tokenized once and its result cached.
 */
import type { Nodes } from 'mdast';
import type { Span } from '../../core/types.js';
import type { MarkdownDocument } from '../../parse/types.js';
import { type WordToken, wordTokens } from './english.js';

const NEGATORS: ReadonlySet<string> = new Set(['never', "don't", 'dont', "mustn't", "shouldn't"]);
const NOT_LEADS: ReadonlySet<string> = new Set(['do', 'must', 'should']);
const RUN_VERBS: ReadonlySet<string> = new Set(['run', 'execute', 'pipe', 'invoke']);
const ADDRESS_VERBS: ReadonlySet<string> = new Set([
  'ask',
  'tell',
  'instruct',
  'have',
  'give',
  'prompt',
  'direct',
  'let',
  'get',
  'remind',
  'advise',
]);
const PEOPLE: ReadonlySet<string> = new Set(['user', 'users', 'human', 'developer', 'developers']);
const PEOPLE_MODALS: ReadonlySet<string> = new Set([
  'should',
  'can',
  'must',
  'may',
  'needs',
  'need',
  'will',
]);

/** "never run", "do not execute", "don't pipe", "must not invoke" (verb within three words). */
export function negatesRunning(tokens: readonly WordToken[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]?.word ?? '';
    const negated =
      NEGATORS.has(word) || (word === 'not' && NOT_LEADS.has(tokens[i - 1]?.word ?? ''));
    if (!negated) continue;
    for (let j = i + 1; j < Math.min(tokens.length, i + 4); j++) {
      if (RUN_VERBS.has(tokens[j]?.word ?? '')) return true;
    }
  }
  return false;
}

/**
 * Offset of the first phrase that hands a command to a person ("tell the user to", "give the
 * user these steps", "the user can"), or -1.
 */
export function firstUserDirection(tokens: readonly WordToken[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) break;
    if (ADDRESS_VERBS.has(token.word)) {
      let j = i + 1;
      if (tokens[j]?.word === 'the' || tokens[j]?.word === 'your') j++;
      if (PEOPLE.has(tokens[j]?.word ?? '')) return token.offset;
    }
    if (PEOPLE.has(token.word) && PEOPLE_MODALS.has(tokens[i + 1]?.word ?? '')) return token.offset;
  }
  return -1;
}

interface Unit {
  readonly start: number;
  end: number;
  readonly block: number;
  /** Starts with a list item marker. */
  readonly list: boolean;
}

interface Block {
  readonly start: number;
  end: number;
  readonly firstUnit: number;
  /**
   * The block before introduces this one: it starts with a list item, a code fence, a blockquote
   * or indented code, or the block before ends with a colon ("tell the user:").
   */
  readonly continues: boolean;
}

interface Facts {
  readonly negated: boolean;
  /** Offset of the first user-directed phrase, or -1. */
  readonly userDirection: number;
}

function isBlank(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) return false;
  }
  return true;
}

function firstNonBlank(text: string, start: number, end: number): number {
  let i = start;
  while (i < end && (text.charAt(i) === ' ' || text.charAt(i) === '\t')) i++;
  return i;
}

/** A list item marker (-, *, +, 1. or 1)) after indentation. */
function startsListItem(text: string, start: number, end: number): boolean {
  const i = firstNonBlank(text, start, end);
  const char = text.charAt(i);
  if ((char === '-' || char === '*' || char === '+') && text.charAt(i + 1) === ' ') return true;
  let j = i;
  while (j < end && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x39) j++;
  return j > i && (text.charAt(j) === '.' || text.charAt(j) === ')') && text.charAt(j + 1) === ' ';
}

/** A code fence, a blockquote or an indented code block. */
function startsQuotedOrCode(text: string, start: number, end: number): boolean {
  const i = firstNonBlank(text, start, end);
  if (text.startsWith('```', i) || text.startsWith('~~~', i) || text.charAt(i) === '>') return true;
  return text.charAt(start) === '\t' || text.startsWith('    ', start);
}

/** Whether the text before `end` ends with a colon, ignoring trailing whitespace. */
function endsWithColon(text: string, start: number, end: number): boolean {
  let i = end - 1;
  while (i >= start && isBlank(text, i, i + 1)) i--;
  return i >= start && text.charAt(i) === ':';
}

/**
 * Reads the prose around commands in one Markdown file. The text is split into blocks (runs of
 * non-blank lines) and blocks into units: each list item is a unit, and so is the text before
 * the first item. A command is judged by its unit, the unit's introduction (the lead-in text of
 * its list, or the paragraph before a code block or list) and the nearest heading before it.
 */
export class CommandContext {
  readonly #text: string;
  readonly #unitOfLine: number[] = [];
  readonly #units: Unit[] = [];
  readonly #blocks: Block[] = [];
  readonly #facts = new Map<string, Facts>();
  readonly #headings: Span[] = [];
  readonly #headingNegated = new Map<number, boolean>();

  constructor(text: string, lineStarts: readonly number[], doc: MarkdownDocument) {
    this.#text = text;
    let block: Block | undefined;
    for (let line = 0; line < lineStarts.length; line++) {
      const start = lineStarts[line] ?? 0;
      const end = lineStarts[line + 1] ?? text.length;
      if (isBlank(text, start, end)) {
        block = undefined;
        this.#unitOfLine.push(-1);
        continue;
      }
      const list = startsListItem(text, start, end);
      if (block === undefined) {
        const previous = this.#blocks[this.#blocks.length - 1];
        block = {
          start,
          end,
          firstUnit: this.#units.length,
          continues:
            list ||
            startsQuotedOrCode(text, start, end) ||
            (previous !== undefined && endsWithColon(text, previous.start, previous.end)),
        };
        this.#blocks.push(block);
        this.#units.push({ start, end, block: this.#blocks.length - 1, list });
      } else if (list) {
        this.#units.push({ start, end, block: this.#blocks.length - 1, list });
      }
      block.end = end;
      const unit = this.#units[this.#units.length - 1];
      if (unit !== undefined) unit.end = end;
      this.#unitOfLine.push(this.#units.length - 1);
    }
    const stack: Nodes[] = [doc.root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type === 'heading' && start !== undefined && end !== undefined) {
        this.#headings.push({ offset: start, length: end - start });
      }
      if ('children' in node) for (const child of node.children) stack.push(child);
    }
    this.#headings.sort((a, b) => a.offset - b.offset);
  }

  #factsOf(start: number, end: number): Facts {
    const key = `${String(start)}:${String(end)}`;
    const cached = this.#facts.get(key);
    if (cached !== undefined) return cached;
    const tokens = wordTokens(this.#text, start, end);
    const facts = { negated: negatesRunning(tokens), userDirection: firstUserDirection(tokens) };
    this.#facts.set(key, facts);
    return facts;
  }

  /** The text that introduces a unit, if any. */
  #introduction(index: number): { start: number; end: number } | undefined {
    const unit = this.#units[index];
    const block = unit === undefined ? undefined : this.#blocks[unit.block];
    if (unit === undefined || block === undefined) return undefined;
    const first = this.#units[block.firstUnit];
    if (unit.list && index !== block.firstUnit && first !== undefined && !first.list) return first;
    if ((unit.list || index === block.firstUnit) && block.continues)
      return this.#blocks[unit.block - 1];
    return undefined;
  }

  /** The nearest heading that starts before `offset`, as an index into the sorted headings. */
  #headingBefore(offset: number): number {
    let low = 0;
    let high = this.#headings.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if ((this.#headings[mid]?.offset ?? 0) <= offset) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /**
   * Why a command at `offset` on `line` (0-based) should not be reported, or undefined: its unit,
   * the unit's introduction or the section heading says not to run it, or the unit or its
   * introduction hands it to a person to run.
   */
  suppression(line: number, offset: number): 'negated' | 'user' | undefined {
    const index = this.#unitOfLine[line] ?? -1;
    const unit = this.#units[index];
    if (unit !== undefined) {
      const facts = this.#factsOf(unit.start, unit.end);
      if (facts.negated) return 'negated';
      if (facts.userDirection !== -1 && facts.userDirection < offset) return 'user';
      const introduction = this.#introduction(index);
      if (introduction !== undefined) {
        const intro = this.#factsOf(introduction.start, introduction.end);
        if (intro.negated) return 'negated';
        if (intro.userDirection !== -1) return 'user';
      }
    }
    const heading = this.#headingBefore(offset);
    if (heading !== -1) {
      let negated = this.#headingNegated.get(heading);
      if (negated === undefined) {
        const span = this.#headings[heading];
        negated =
          span !== undefined &&
          negatesRunning(wordTokens(this.#text, span.offset, span.offset + span.length));
        this.#headingNegated.set(heading, negated);
      }
      if (negated) return 'negated';
    }
    return undefined;
  }
}
