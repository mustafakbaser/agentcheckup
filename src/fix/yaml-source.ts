/**
 * What the parsed frontmatter does not keep, and the YAML builders in edits.ts need: where the
 * comments are, whether an entry carries an anchor, an alias or a tag, and the text of scalar
 * values before YAML resolves them to numbers or booleans (`1.10`, not `1.1`).
 *
 * Runs only on YAML that src/parse/frontmatter.ts already parsed as valid, which bounds its size
 * and nesting. Builds no JavaScript values (no `toJS()`), and never follows an alias. Pure.
 */
import { CST, isAlias, isMap, isScalar, isSeq, Lexer, type ParsedNode, parseDocument } from 'yaml';

import { YAML_OPTIONS } from '../parse/frontmatter.js';

/**
 * Offsets, relative to the start of `yaml`, of the `#` that starts each comment. Text inside
 * scalars, such as `#` in a block scalar or a quoted string, is not a comment.
 */
export function commentOffsets(yaml: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  let scalarNext = false;
  // The lexer yields consecutive slices of the source, and three control tokens that take no
  // source text: one starts a document, one ends a broken flow collection, and one comes before
  // the source of every scalar.
  for (const token of new Lexer().lex(yaml)) {
    if (token === CST.SCALAR) {
      scalarNext = true;
      continue;
    }
    if (token === CST.DOCUMENT || token === CST.FLOW_END) continue;
    if (!scalarNext && token.startsWith('#')) offsets.push(offset);
    scalarNext = false;
    offset += token.length;
  }
  return offsets;
}

/** One top-level entry, as the YAML builders need it. */
export interface EntrySource {
  /** True when the key or the value carries an anchor, an alias or a tag, at any depth. */
  readonly sharesNodes: boolean;
  /**
   * The value as text: a scalar's text before YAML resolves it, or that of each item of a list
   * of scalars. Undefined for an empty or null value, an empty list, a mapping, an alias, or a
   * list with a null item or a nested collection.
   */
  readonly text: string | readonly string[] | undefined;
}

/** True when an anchor, an alias or a tag is on `root` or below it. Iterative. */
function hasSharedNodes(root: ParsedNode): boolean {
  const stack: ParsedNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (isAlias(node) || node.anchor !== undefined || node.tag !== undefined) return true;
    if (isMap(node)) {
      for (const pair of node.items) {
        stack.push(pair.key);
        if (pair.value !== null) stack.push(pair.value);
      }
    } else if (isSeq(node)) {
      stack.push(...node.items);
    }
  }
  return false;
}

/** A scalar's text before resolution, or undefined for anything else and for null. */
function scalarText(node: ParsedNode): string | undefined {
  if (!isScalar(node) || node.value === null) return undefined;
  return node.source;
}

function valueText(node: ParsedNode | null): string | readonly string[] | undefined {
  if (node === null) return undefined;
  if (!isSeq(node)) return scalarText(node);
  const items: string[] = [];
  for (const item of node.items) {
    const text = scalarText(item);
    if (text === undefined) return undefined;
    items.push(text);
  }
  return items.length === 0 ? undefined : items;
}

/**
 * The top-level entries of `yaml` by the offset of their key, relative to the start of `yaml`
 * (the offset of `keySpan` minus that of the YAML). Empty when `yaml` is not a valid mapping.
 */
export function entrySources(yaml: string): ReadonlyMap<number, EntrySource> {
  const entries = new Map<number, EntrySource>();
  const doc = parseDocument(yaml, YAML_OPTIONS);
  const root = doc.contents;
  if (doc.errors.length > 0 || !isMap(root)) return entries;
  for (const pair of root.items) {
    entries.set(pair.key.range[0], {
      sharesNodes: hasSharedNodes(pair.key) || (pair.value !== null && hasSharedNodes(pair.value)),
      text: valueText(pair.value),
    });
  }
  return entries;
}
