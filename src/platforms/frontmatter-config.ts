/**
 * The frontmatter of a Claude Code skill, command or subagent read as configuration: the fields
 * Claude Code may read, as documents the configuration readers accept (`hookHandlers`, the MCP
 * readers, `spanOf`). The security inventory lists the hooks, MCP servers and permissions these
 * fields declare (docs/adr/0012).
 *
 * The documentation describes frontmatter as YAML between `---` lines, and a file whose YAML does
 * not parse as one with no fields. Claude Code's reader does more, none of it documented (read
 * from the 2.1.272 binary and replayed under its Bun version):
 *
 * - it takes the block up to the first `---` anywhere, even inside a line, and accepts any
 *   whitespace after the opening `---` (src/platforms/skill-repair.ts, `claudeCodeBlock`);
 * - it parses with `Bun.YAML.parse`, which keeps the last of repeated keys, applies `<<` merge
 *   keys and accepts implicit keys longer than 1,024 characters;
 * - when that fails, it retries with unquoted values quoted (src/platforms/skill-repair.ts).
 *
 * So every block either reader finds is read, with the retry, and the fields of all of them are
 * listed: listing an item never claims that it runs, and a hook must not hide behind a stray
 * `---` or `: `. A block no parse reads, one past agentcheckup's parser limits, and one with merge
 * keys may declare fields that agentcheckup cannot see, so its file is `unreadable`.
 */
import type { Span } from '../core/types.js';
import { locateFrontmatter, parseFrontmatter } from '../parse/frontmatter.js';
import { isTable, type SpannedDocument } from '../parse/json-access.js';
import type { FrontmatterData, FrontmatterResult, JsonPathSegment } from '../parse/types.js';
import { claudeCodeBlock, claudeCodeRepair } from './skill-repair.js';
import { hitParserLimit } from './yaml.js';

type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;

/** The fields of one block, as one reader reads them. */
export interface FrontmatterReading {
  /** The fields, with spans into the file's own text. */
  readonly doc: SpannedDocument;
  /**
   * The parse the fields come from, for checks of the whole block such as `checkSubagent`. Its
   * spans point into the text that was parsed, which is the file's only for a documented reading;
   * use {@link doc} for spans.
   */
  readonly parse: ValidFrontmatter;
  /**
   * True when the documentation describes this reading: the block between `---` lines, parsed
   * as it is. False for the retry or a block only Claude Code's reader finds.
   */
  readonly documented: boolean;
}

export interface FrontmatterConfig {
  /** One reading per block that parses; two when the readers find different blocks. */
  readonly readings: readonly FrontmatterReading[];
  /** A block may declare fields that agentcheckup cannot read. */
  readonly unreadable: boolean;
}

/** `[start, end)` of a block's YAML in the file's text. */
interface Block {
  readonly start: number;
  readonly end: number;
}

type BlockRead =
  | { readonly kind: 'fields'; readonly reading: FrontmatterReading }
  | { readonly kind: 'limit' }
  | { readonly kind: 'unparsed' };

const OPENING = '---\n';
const CLOSING = '\n---\n';

/** The configuration Claude Code may read from the frontmatter of `text`, parsed as `frontmatter`. */
export function claudeFrontmatterConfig(
  text: string,
  frontmatter: FrontmatterResult,
): FrontmatterConfig {
  const blocks: { readonly block: Block; readonly strict?: ValidFrontmatter }[] = [];
  const location = locateFrontmatter(text);
  const documented =
    location.kind === 'block' ? { start: location.yamlStart, end: location.yamlEnd } : undefined;
  if (documented !== undefined) {
    blocks.push({
      block: documented,
      ...(frontmatter.kind === 'valid' ? { strict: frontmatter } : {}),
    });
  }
  const claude = claudeCodeBlock(text);
  const same = claude?.start === documented?.start && claude?.end === documented?.end;
  if (claude !== undefined && !same) blocks.push({ block: claude });

  const readings: FrontmatterReading[] = [];
  let unreadable = false;
  for (const { block, strict } of blocks) {
    const read =
      strict === undefined
        ? readBlock(text, block)
        : ({
            kind: 'fields',
            reading: { doc: documentOf(strict.data), parse: strict, documented: true },
          } as const);
    if (read.kind === 'fields') {
      readings.push(read.reading);
      // agentcheckup reads `<<` as a key; Claude Code merges it.
      if (hasMergeKey(read.reading.doc.value)) unreadable = true;
    } else if (read.kind === 'limit') {
      unreadable = true;
    }
  }
  // A block that no parse reads may still declare fields for Claude Code's YAML reader.
  if (blocks.length > 0 && readings.length === 0) unreadable = true;
  return { readings, unreadable };
}

/** The fields of a block: parsed as it is, else as Claude Code's retry repairs it. */
function readBlock(text: string, block: Block): BlockRead {
  const yaml = text.slice(block.start, block.end);
  const parsed = parseFrontmatter(`${OPENING}${yaml}${CLOSING}`);
  if (parsed.kind === 'valid') {
    const map = (span: Span): Span => ({
      offset: Math.max(block.start, span.offset - OPENING.length + block.start),
      length: span.length,
    });
    return {
      kind: 'fields',
      reading: { doc: documentOf(parsed.data, map), parse: parsed, documented: false },
    };
  }
  if (parsed.kind !== 'invalid') return { kind: 'unparsed' };
  if (hitParserLimit(parsed.errors)) return { kind: 'limit' };

  const repaired = claudeCodeRepair(yaml);
  const retried = parseFrontmatter(`${OPENING}${repaired}${CLOSING}`);
  if (retried.kind === 'invalid' && hitParserLimit(retried.errors)) return { kind: 'limit' };
  if (retried.kind !== 'valid') return { kind: 'unparsed' };
  return {
    kind: 'fields',
    reading: {
      doc: documentOf(retried.data, lineMap(yaml, repaired, block.start)),
      parse: retried,
      documented: false,
    },
  };
}

/**
 * Frontmatter that parsed as documented, as a document the configuration readers accept, with
 * spans into the file: for agents other than Claude Code, whose readers are not modeled.
 */
export function frontmatterDocument(data: FrontmatterData): SpannedDocument {
  return documentOf(data);
}

/**
 * Frontmatter as a document. A top-level path uses the spans the parse kept; a deeper one is
 * resolved on demand. `map` moves a span from the text that was parsed into the file's text.
 */
function documentOf(data: FrontmatterData, map?: (span: Span) => Span): SpannedDocument {
  const mapped = (span: Span | undefined): Span | undefined =>
    span === undefined || map === undefined ? span : map(span);
  const topLevel = (path: readonly JsonPathSegment[]): string | undefined => {
    const [first] = path;
    return path.length === 1 && typeof first === 'string' ? first : undefined;
  };
  return {
    value: data.values,
    valueSpan: (path) => {
      const key = topLevel(path);
      return mapped(key === undefined ? data.valueSpanAt(path) : data.valueSpan(key));
    },
    keySpan: (path) => {
      const key = topLevel(path);
      return mapped(key === undefined ? data.keySpanAt(path) : data.keySpan(key));
    },
  };
}

/**
 * Maps a span in the parsed text of a repaired block to the file. The repair rewrites lines in
 * place and never adds or removes one, so a span maps to the same line of the file, at the same
 * column or the end of the line.
 */
function lineMap(yaml: string, repaired: string, yamlStart: number): (span: Span) => Span {
  const from = lineStarts(repaired);
  const to = lineStarts(yaml);
  return (span) => {
    const offset = span.offset - OPENING.length;
    if (from.length !== to.length || offset < 0 || offset > repaired.length) {
      return { offset: 0, length: 3 };
    }
    const line = lineIndex(from, offset);
    const start = to[line] ?? 0;
    const end = line + 1 < to.length ? (to[line + 1] ?? yaml.length) - 1 : yaml.length;
    const column = Math.min(offset - (from[line] ?? 0), end - start);
    const length = Math.min(span.length, end - start - column);
    return { offset: yamlStart + start + column, length: Math.max(0, length) };
  };
}

/** Offsets where each line of `text` starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The index of the line that holds `offset`, by binary search over `starts`. */
function lineIndex(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * True when a mapping anywhere in `value` has the key `<<`. Values are finite trees: aliases were
 * expanded within the parser's budget.
 */
export function hasMergeKey(value: unknown): boolean {
  const stack: unknown[] = [value];
  for (let node = stack.pop(); node !== undefined || stack.length > 0; node = stack.pop()) {
    if (Array.isArray(node)) {
      stack.push(...(node as unknown[]));
    } else if (isTable(node)) {
      if (Object.hasOwn(node, '<<')) return true;
      for (const key of Object.keys(node)) stack.push(node[key]);
    }
  }
  return false;
}
