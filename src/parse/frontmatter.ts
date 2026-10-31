/**
 * YAML frontmatter, read the way coding agents read it: strictly, and without executing anything.
 *
 * Platform behavior (verified 2026-10-14):
 * - Claude Code reads SKILL.md frontmatter only when `---` is the very first line. Malformed YAML
 *   loads the body with empty metadata, so the skill never auto-triggers.
 *   https://code.claude.com/docs/en/skills
 * - Codex requires `---` on line 1 and a closing `---` line. https://learn.chatgpt.com/docs/build-skills
 * - The Agent Skills reference validator parses with strictyaml and rejects duplicate keys.
 *   https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py
 * So we parse strict YAML 1.2, report every problem with a precise span, and never throw.
 *
 * Security:
 * - gray-matter evaluates `---js` / `---javascript` blocks, and js-yaml has had prototype
 *   pollution and merge-key DoS issues; both are banned by lint. We only *recognize* other
 *   frontmatter languages and report them as `unsupported`.
 * - eemeli/yaml runs with the core schema, no merge keys, no YAML 1.1 known tags, and unique keys.
 * - We never call `toJS()`. Values are built here into null-prototype objects, so keys like
 *   `__proto__` and `constructor` are ordinary own properties, and alias expansion is capped
 *   (billion-laughs) before any large value is materialized.
 */
import {
  type Document,
  type DocumentOptions,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type ParsedNode,
  parseDocument,
  type ParseOptions,
  type Pair,
  type Scalar,
  type SchemaOptions,
  type YAMLMap,
} from 'yaml';
import type { Span } from '../core/types.js';
import { cleanMessage, spanBetween } from './spans.js';
import type { FrontmatterData, FrontmatterResult, JsonPathSegment, ParseIssue } from './types.js';
import { formatInteger } from '../core/format.js';

/** Raw YAML blocks larger than this are not parsed (frontmatter is metadata, not content). */
export const MAX_FRONTMATTER_LENGTH = 64 * 1024;
/** Same budget as yaml's `maxAliasCount`: alias dereferences allowed, counting nested ones. */
const MAX_ALIAS_COUNT = 100;
/** Nodes that alias expansion may materialize in total. Bounds memory for wide anchors. */
const MAX_ALIAS_NODES = 10_000;
/** Nesting deeper than this is rejected before our recursive value builder could overflow. */
const MAX_DEPTH = 256;
/** Hostile input can produce one error per character; report a bounded number. */
const MAX_ISSUES = 100;

/**
 * How frontmatter YAML is read ({@link parseYaml}); src/fix/yaml-source.ts reads it the same way.
 */
export const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  version: '1.2',
  schema: 'core',
  merge: false,
  uniqueKeys: true,
  resolveKnownTags: false,
  prettyErrors: false,
  strict: true,
  keepSourceTokens: false,
};

/**
 * `parseDocument(yaml, YAML_OPTIONS)`, without yaml's unique-key check where it cannot fire. The
 * check compares each key with every earlier key of its mapping, so its cost grows with the
 * square of the keys: a flow mapping of 16,000 keys, which fits in the length limit, takes 0.9 s
 * instead of 0.03 s (yaml 2.9.1). All the check adds is a DUPLICATE_KEY error, as the pair is kept
 * either way, so the YAML is parsed without it, and again with it only when a mapping repeats a
 * scalar key's value. A Set compares values as SameValueZero, which equates everything the
 * check's `===` does and `NaN` as well: such a key costs a second parse, not a wrong result.
 */
export function parseYaml(yaml: string): Document.Parsed {
  const unchecked = parseDocument(yaml, { ...YAML_OPTIONS, uniqueKeys: false });
  return mayRepeatKeys(unchecked.contents) ? parseDocument(yaml, YAML_OPTIONS) : unchecked;
}

/** True when a mapping in the tree has two scalar keys with the same value. */
function mayRepeatKeys(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isMap(node)) {
      const keys = new Set<unknown>();
      for (const pair of node.items) {
        if (isScalar(pair.key)) {
          if (keys.has(pair.key.value)) return true;
          keys.add(pair.key.value);
        }
        stack.push(pair.key, pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push(item);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------------------------

interface Line {
  /** Offset of the first character. */
  readonly start: number;
  /** End of the content, excluding `\n` or `\r\n`. */
  readonly end: number;
  /** Start of the next line (`text.length` for the last line). */
  readonly next: number;
}

function lineAt(text: string, start: number): Line {
  const newline = text.indexOf('\n', start);
  const next = newline === -1 ? text.length : newline + 1;
  let end = newline === -1 ? text.length : newline;
  if (end > start && text.charCodeAt(end - 1) === 0x0d) end--;
  return { start, end, next };
}

function isBlankFrom(text: string, from: number, end: number): boolean {
  for (let i = from; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}

/** A line that is exactly `marker`, optionally followed by spaces or tabs. */
function isDelimiterLine(text: string, line: Line, marker: string): boolean {
  return (
    line.end - line.start >= marker.length &&
    text.startsWith(marker, line.start) &&
    isBlankFrom(text, line.start + marker.length, line.end)
  );
}

/** `---js`, `---javascript`, `---json`, `---coffee`, `---yaml`: gray-matter's language syntax. */
const LANGUAGE_FENCE = /^---([a-z][\w+-]*)[\t ]*$/i;

/** Where the frontmatter block is, found without parsing YAML. */
export type FrontmatterLocation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unclosed'; readonly openSpan: Span }
  | { readonly kind: 'unsupported'; readonly syntax: string; readonly span: Span }
  | {
      readonly kind: 'block';
      /** Whole block, from offset 0 through the closing `---` (without its line terminator). */
      readonly span: Span;
      readonly bodyOffset: number;
      /** The YAML between the delimiter lines. */
      readonly yamlStart: number;
      readonly yamlEnd: number;
    };

/**
 * Finds the frontmatter delimiters. The opening delimiter must start at offset 0 (the BOM is
 * already removed); the closing one is the first later line that is exactly `---`.
 */
export function locateFrontmatter(text: string): FrontmatterLocation {
  if (!text.startsWith('---') && !text.startsWith('+++')) return { kind: 'absent' };
  const open = lineAt(text, 0);
  const openSpan = spanBetween(0, open.end, text.length);

  if (isDelimiterLine(text, open, '+++'))
    return { kind: 'unsupported', syntax: 'toml', span: openSpan };
  if (!isDelimiterLine(text, open, '---')) {
    const language = LANGUAGE_FENCE.exec(text.slice(0, open.end))?.[1];
    return language === undefined
      ? { kind: 'absent' }
      : { kind: 'unsupported', syntax: language.toLowerCase(), span: openSpan };
  }
  if (open.next === open.end) return { kind: 'unclosed', openSpan };

  for (let start = open.next; start < text.length;) {
    const line = lineAt(text, start);
    if (isDelimiterLine(text, line, '---')) {
      return {
        kind: 'block',
        span: spanBetween(0, line.end, text.length),
        bodyOffset: line.next,
        yamlStart: open.next,
        yamlEnd: line.start,
      };
    }
    start = line.next;
  }
  return { kind: 'unclosed', openSpan };
}

// ---------------------------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------------------------

/** Thrown inside the value builder when a resource limit or semantic error is hit. */
class FrontmatterLimit extends Error {
  readonly code: string;
  /** `[start, end)` in the YAML text. */
  readonly range: readonly [number, number];

  constructor(code: string, message: string, range: readonly [number, number]) {
    super(message);
    this.code = code;
    this.range = range;
  }
}

interface BuildContext {
  /** The YAML text and its offset in the full text. */
  readonly yaml: string;
  readonly base: number;
  /** Each alias node's anchor target, resolved in document order. */
  readonly aliasTargets: ReadonlyMap<ParsedNode, ParsedNode | undefined>;
  aliasCount: number;
  aliasNodes: number;
  /** > 0 while expanding an alias. */
  aliasDepth: number;
}

function toSpan(context: Pick<BuildContext, 'yaml' | 'base'>, start: number, end: number): Span {
  const { yaml, base } = context;
  const from = Math.min(Math.max(0, start), yaml.length);
  const to = Math.min(Math.max(from, end), yaml.length);
  return { offset: base + from, length: to - from };
}

/** Span of a node's value, without trailing whitespace or line breaks (block collections). */
function nodeSpan(context: Pick<BuildContext, 'yaml' | 'base'>, node: ParsedNode): Span {
  const [start, valueEnd] = node.range;
  let end = valueEnd;
  while (end > start) {
    const code = context.yaml.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    end--;
  }
  return toSpan(context, start, end);
}

function issue(code: string, message: string, span: Span): ParseIssue {
  return { code, message: cleanMessage(message), span };
}

/** `DUPLICATE_KEY` -> `duplicate-key`; yaml's `MULTIPLE_DOCS` uses our documented name. */
function issueCode(yamlCode: string): string {
  return yamlCode === 'MULTIPLE_DOCS'
    ? 'multiple-documents'
    : yamlCode.toLowerCase().replaceAll('_', '-');
}

/**
 * Walks every node in document order (pre-order, keys before values) without recursion, so
 * hostile nesting cannot overflow the stack here.
 */
function walk(root: ParsedNode, visit: (node: ParsedNode) => void): void {
  const stack: ParsedNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    visit(node);
    const children: ParsedNode[] = [];
    if (isMap(node)) {
      for (const pair of node.items) {
        children.push(pair.key);
        if (pair.value) children.push(pair.value);
      }
    } else if (isSeq(node)) {
      children.push(...node.items);
    }
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
}

/** Scalar nodes by start offset (the first one wins), to locate keys named by an error. */
function scalarsByStart(root: ParsedNode | null): Map<number, ParsedNode> {
  const scalars = new Map<number, ParsedNode>();
  if (root === null) return scalars;
  walk(root, (node) => {
    if (isScalar(node) && !scalars.has(node.range[0])) scalars.set(node.range[0], node);
  });
  return scalars;
}

/**
 * Resolves aliases the way YAML defines them: to the most recent anchor with that name that
 * precedes the alias in document order. One pass, so it is linear even with many aliases
 * (yaml's `Alias.resolve` rescans the document per alias).
 */
function resolveAliases(root: ParsedNode): Map<ParsedNode, ParsedNode | undefined> {
  const anchors = new Map<string, ParsedNode>();
  const targets = new Map<ParsedNode, ParsedNode | undefined>();
  walk(root, (node) => {
    if (isAlias(node)) {
      targets.set(node, anchors.get(node.source));
    } else if (node.anchor !== undefined) {
      anchors.set(node.anchor, node);
    }
  });
  return targets;
}

type ScalarValue = string | number | boolean | null;

function scalarValue(node: Scalar.Parsed): ScalarValue {
  const { value } = node;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  // Unreachable with the core schema, no custom tags and `resolveKnownTags: false`; keep the
  // source text rather than leaking a non-JSON object (Buffer, Set, Date) to rules.
  return node.source;
}

/** The tag of a merge key, whether written `<<`, `!!merge` or `!<tag:yaml.org,2002:merge>`. */
const MERGE_TAG = 'tag:yaml.org,2002:merge';

/**
 * The JavaScript key a JS-based agent would see, mirroring yaml's `toJS()` stringification. A key
 * tagged as a merge key is `<<` whatever its text: readers that merge, such as js-yaml, merge it,
 * so it stays visible to the checks that flag merge keys (agentcheckup merges none, ADR 0003).
 */
function keyString(context: BuildContext, key: ParsedNode, depth: number): string {
  if (key.tag === MERGE_TAG) return '<<';
  const value = buildValue(context, key, depth);
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Collection keys (`? [a, b]`): use the source text. yaml's toJS() would print YAML instead.
  const span = nodeSpan(context, key);
  return context.yaml.slice(span.offset - context.base, span.offset - context.base + span.length);
}

/** Charges one node against the alias budget; throws once the budget is exhausted. */
function chargeAliasBudget(context: BuildContext, node: ParsedNode): void {
  if (context.aliasDepth > 0) context.aliasNodes++;
  if (context.aliasCount > MAX_ALIAS_COUNT || context.aliasNodes > MAX_ALIAS_NODES) {
    throw new FrontmatterLimit(
      'excessive-aliases',
      'Too many alias expansions; this looks like an alias bomb (billion laughs).',
      [node.range[0], node.range[1]],
    );
  }
}

function buildAlias(context: BuildContext, node: ParsedNode, depth: number): unknown {
  const target = context.aliasTargets.get(node);
  if (target === undefined) {
    throw new FrontmatterLimit('unresolved-alias', 'Alias refers to an undefined anchor.', [
      node.range[0],
      node.range[1],
    ]);
  }
  context.aliasCount++;
  chargeAliasBudget(context, node);
  context.aliasDepth++;
  try {
    return buildValue(context, target, depth + 1);
  } finally {
    context.aliasDepth--;
  }
}

/** Called for each entry of the root mapping, in source order, with its stringified key. */
type EntryCallback = (key: string, pair: Pair<ParsedNode, ParsedNode | null>) => void;

function buildMap(
  context: BuildContext,
  map: YAMLMap.Parsed,
  depth: number,
  onEntry?: EntryCallback,
): Readonly<Record<string, unknown>> {
  const object = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const pair of map.items) {
    const key = keyString(context, pair.key, depth);
    if (seen.has(key)) {
      // Different YAML keys (`1` and `"1"`, `~` and `""`) that collapse to one JavaScript key.
      throw new FrontmatterLimit('duplicate-key', `Map keys must be unique ("${key}").`, [
        pair.key.range[0],
        pair.key.range[1],
      ]);
    }
    seen.add(key);
    onEntry?.(key, pair);
    // Assignment on a null-prototype object creates an own property even for `__proto__`.
    object[key] = pair.value === null ? null : buildValue(context, pair.value, depth);
  }
  return Object.freeze(object);
}

function buildValue(context: BuildContext, node: ParsedNode, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new FrontmatterLimit('too-deep', `Nesting is deeper than ${MAX_DEPTH} levels.`, [
      node.range[0],
      node.range[1],
    ]);
  }
  chargeAliasBudget(context, node);
  if (isScalar(node)) return scalarValue(node);
  if (isAlias(node)) return buildAlias(context, node, depth);
  if (isMap(node)) return buildMap(context, node, depth + 1);
  return Object.freeze(node.items.map((item) => buildValue(context, item, depth + 1)));
}

// ---------------------------------------------------------------------------------------------
// Warnings: constructs that parse, but differently across YAML implementations
// ---------------------------------------------------------------------------------------------

/** YAML 1.1 booleans that YAML 1.2 (and therefore we) read as strings. */
const YAML11_BOOLEAN = /^(?:y|yes|n|no|on|off)$/i;

function scalarWarnings(context: BuildContext, node: Scalar.Parsed, out: ParseIssue[]): void {
  if (node.type !== 'PLAIN') return;
  const span = nodeSpan(context, node);
  const source = node.source;
  if (typeof node.value === 'string' && YAML11_BOOLEAN.test(source)) {
    const yaml11 = ['y', 'yes', 'on'].includes(source.toLowerCase());
    out.push(
      issue(
        'yaml11-boolean',
        `"${source}" is a string in YAML 1.2 but the boolean ${String(yaml11)} in YAML 1.1 parsers. Quote it.`,
        span,
      ),
    );
  }
  if (typeof node.value === 'number' && String(node.value) !== source) {
    out.push(
      issue(
        'number-coercion',
        `"${source}" is read as the number ${String(node.value)}. Quote it to keep the text.`,
        span,
      ),
    );
  }
}

function nullValueWarnings(context: BuildContext, map: YAMLMap.Parsed, out: ParseIssue[]): void {
  for (const pair of map.items) {
    const value = pair.value;
    if (value !== null && !(isScalar(value) && value.value === null)) continue;
    const valueSpan = value === null ? undefined : nodeSpan(context, value);
    const span =
      valueSpan === undefined || valueSpan.length === 0 ? nodeSpan(context, pair.key) : valueSpan;
    out.push(issue('null-value', 'The value is null (empty, `~` or `null`).', span));
  }
}

function collectWarnings(context: BuildContext, root: ParsedNode): ParseIssue[] {
  const warnings: ParseIssue[] = [];
  walk(root, (node) => {
    if (isAlias(node)) {
      warnings.push(
        issue(
          'alias',
          `Alias *${node.source}: not every agent's YAML parser resolves aliases.`,
          nodeSpan(context, node),
        ),
      );
      return;
    }
    if (node.anchor !== undefined) {
      warnings.push(
        issue(
          'alias',
          `Anchor &${node.anchor}: not every agent's YAML parser supports anchors.`,
          nodeSpan(context, node),
        ),
      );
    }
    if (node.tag !== undefined) {
      warnings.push(
        issue(
          'tag',
          `Explicit tag ${node.tag}: YAML implementations resolve tags differently.`,
          nodeSpan(context, node),
        ),
      );
    }
    if (isScalar(node)) scalarWarnings(context, node, warnings);
    else if (isMap(node)) nullValueWarnings(context, node, warnings);
  });
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

interface KeySpans {
  readonly key: Span;
  readonly value: Span | undefined;
}

/** The spans of the key and the value at the end of a path. */
interface PathSpans {
  /** Undefined when the last segment is a sequence index, or for the root. */
  readonly key: Span | undefined;
  /** Undefined for a key without a value node (`? key`). */
  readonly value: Span | undefined;
}

/**
 * The JavaScript key of a mapping key node, as {@link keyString} gives it, without charging the
 * alias budget: the block already passed it once.
 */
function plainKey(
  located: Pick<BuildContext, 'yaml' | 'base'>,
  targets: ReadonlyMap<ParsedNode, ParsedNode | undefined>,
  key: ParsedNode,
): string {
  const node = isAlias(key) ? (targets.get(key) ?? key) : key;
  if (isScalar(node)) {
    const value = scalarValue(node);
    return value === null ? '' : String(value);
  }
  const span = nodeSpan(located, node);
  return located.yaml.slice(span.offset - located.base, span.offset - located.base + span.length);
}

/**
 * Resolves nested paths for {@link FrontmatterData.valueSpanAt} and `keySpanAt`. The block is
 * parsed again on the first call, so frontmatter read only at the top level, as most is, keeps
 * no syntax tree in memory. The block parsed before, so the second parse succeeds the same way.
 */
function nestedSpans(
  yaml: string,
  base: number,
): (path: readonly JsonPathSegment[]) => PathSpans | undefined {
  const located = { yaml, base };
  let parsed:
    | {
        readonly root: ParsedNode | null;
        readonly targets: ReadonlyMap<ParsedNode, ParsedNode | undefined>;
      }
    | undefined;
  // Pairs of each mapping by key, built on the first lookup in that mapping, so resolving many
  // paths costs one pass over each mapping they cross rather than one per path.
  const pairsOf = new Map<YAMLMap.Parsed, Map<string, Pair<ParsedNode, ParsedNode | null>>>();
  const pairAt = (
    map: YAMLMap.Parsed,
    key: string,
    targets: ReadonlyMap<ParsedNode, ParsedNode | undefined>,
  ): Pair<ParsedNode, ParsedNode | null> | undefined => {
    let pairs = pairsOf.get(map);
    if (pairs === undefined) {
      pairs = new Map();
      for (const pair of map.items) {
        const name = plainKey(located, targets, pair.key);
        // Keys are unique: the first parse rejected repeated ones.
        if (!pairs.has(name)) pairs.set(name, pair);
      }
      pairsOf.set(map, pairs);
    }
    return pairs.get(key);
  };
  return (path) => {
    if (parsed === undefined) {
      // The block passed the unique-key check once; yaml's check is quadratic in the keys of a
      // mapping, so the second parse leaves it out.
      const doc = parseDocument(yaml, { ...YAML_OPTIONS, uniqueKeys: false });
      const root = doc.errors.length === 0 ? doc.contents : null;
      parsed = { root, targets: root === null ? new Map() : resolveAliases(root) };
    }
    const { targets } = parsed;
    let key: ParsedNode | undefined;
    let value: ParsedNode | null = parsed.root;
    for (const segment of path) {
      // An anchor is never an alias itself, so one step reaches the value.
      const node: ParsedNode | null | undefined =
        value !== null && isAlias(value) ? targets.get(value) : value;
      if (node === null || node === undefined) return undefined;
      if (typeof segment === 'string') {
        if (!isMap(node)) return undefined;
        const pair = pairAt(node, segment, targets);
        if (pair === undefined) return undefined;
        key = pair.key;
        value = pair.value;
      } else {
        if (!isSeq(node)) return undefined;
        const item = node.items[segment];
        if (item === undefined) return undefined;
        key = undefined;
        value = item;
      }
    }
    if (value === null && key === undefined) return undefined;
    return {
      key: key === undefined ? undefined : nodeSpan(located, key),
      value: value === null ? undefined : nodeSpan(located, value),
    };
  };
}

function frontmatterData(
  values: Readonly<Record<string, unknown>>,
  spans: ReadonlyMap<string, KeySpans>,
  nested?: { readonly yaml: string; readonly base: number },
): FrontmatterData {
  const resolve = nested === undefined ? undefined : nestedSpans(nested.yaml, nested.base);
  return {
    values,
    keys: Object.freeze([...spans.keys()]),
    keySpan: (key) => spans.get(key)?.key,
    valueSpan: (key) => spans.get(key)?.value,
    valueSpanAt: (path) => resolve?.(path)?.value,
    keySpanAt: (path) =>
      typeof path[path.length - 1] === 'string' ? resolve?.(path)?.key : undefined,
  };
}

const EMPTY_DATA = frontmatterData(
  Object.freeze(Object.create(null) as Record<string, unknown>),
  new Map(),
);

type BlockLocation = Extract<FrontmatterLocation, { kind: 'block' }>;

function invalid(location: BlockLocation, errors: ParseIssue[]): FrontmatterResult {
  return {
    kind: 'invalid',
    span: location.span,
    bodyOffset: location.bodyOffset,
    errors: errors.slice(0, MAX_ISSUES),
  };
}

function parseBlock(text: string, location: BlockLocation): FrontmatterResult {
  const yaml = text.slice(location.yamlStart, location.yamlEnd);
  const base = location.yamlStart;
  if (yaml.length > MAX_FRONTMATTER_LENGTH) {
    return invalid(location, [
      issue(
        'too-large',
        `Frontmatter is ${formatInteger(yaml.length)} characters; the limit is ${formatInteger(MAX_FRONTMATTER_LENGTH)}.`,
        location.span,
      ),
    ]);
  }

  const doc = parseYaml(yaml);
  const located = { yaml, base };
  if (doc.errors.length > 0) {
    const keys = doc.errors.some((error) => error.code === 'DUPLICATE_KEY')
      ? scalarsByStart(doc.contents)
      : undefined;
    return invalid(
      location,
      doc.errors.slice(0, MAX_ISSUES).map((error) => {
        // yaml points duplicate keys at their first character; report the whole key.
        const key = error.code === 'DUPLICATE_KEY' ? keys?.get(error.pos[0]) : undefined;
        return issue(
          issueCode(error.code),
          error.code === 'MULTIPLE_DOCS'
            ? 'Frontmatter must contain a single YAML document.'
            : error.message,
          key ? nodeSpan(located, key) : toSpan(located, error.pos[0], error.pos[1]),
        );
      }),
    );
  }

  const root = doc.contents;
  if (root === null) {
    return {
      kind: 'valid',
      span: location.span,
      bodyOffset: location.bodyOffset,
      data: EMPTY_DATA,
      warnings: [],
    };
  }
  if (!isMap(root)) {
    return invalid(location, [
      issue(
        'not-a-mapping',
        'Frontmatter must be a mapping of keys to values.',
        nodeSpan(located, root),
      ),
    ]);
  }

  const context: BuildContext = {
    yaml,
    base,
    aliasTargets: resolveAliases(root),
    aliasCount: 0,
    aliasNodes: 0,
    aliasDepth: 0,
  };
  const spans = new Map<string, KeySpans>();
  let values: Readonly<Record<string, unknown>>;
  try {
    values = buildMap(context, root, 1, (key, pair) => {
      spans.set(key, {
        key: nodeSpan(context, pair.key),
        value: pair.value === null ? undefined : nodeSpan(context, pair.value),
      });
    });
  } catch (error) {
    if (!(error instanceof FrontmatterLimit)) throw error;
    return invalid(location, [issue(error.code, error.message, toSpan(context, ...error.range))]);
  }

  const warnings = [
    ...doc.warnings.map((warning) =>
      issue(
        issueCode(warning.code),
        warning.message,
        toSpan(context, warning.pos[0], warning.pos[1]),
      ),
    ),
    ...collectWarnings(context, root),
  ].sort(
    (a, b) => a.span.offset - b.span.offset || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );

  return {
    kind: 'valid',
    span: location.span,
    bodyOffset: location.bodyOffset,
    data: frontmatterData(values, spans, { yaml, base }),
    warnings: warnings.slice(0, MAX_ISSUES),
  };
}

/** Parses the frontmatter at the start of `text`. Never throws on any input. */
export function parseFrontmatter(text: string): FrontmatterResult {
  const location = locateFrontmatter(text);
  if (location.kind !== 'block') return location;
  try {
    return parseBlock(text, location);
  } catch (error) {
    // Backstop: a stack overflow or an unexpected library failure must not crash the scan.
    const message = error instanceof Error ? error.message : 'unknown error';
    return invalid(location, [
      issue('parse-failed', `YAML parser failed: ${message}`, location.span),
    ]);
  }
}
