/**
 * Credentials in the lines a fix shows, masked as the inventory masks them (src/inventory): the
 * dry-run diff of `agentcheckup fix`, its JSON hunks, and the check that keeps credentials out of
 * the review comments of `fix --format suggestions`. Display only: fixes are planned, applied
 * and verified on the real text.
 *
 * - In a JSON or TOML configuration file: every value of an `env`, `headers` or `http_headers`
 *   table, and of Codex's `shell_environment_policy.set`, keeps only what the inventory would
 *   show of it: a reference such as `${GITHUB_TOKEN}`, an on/off switch, the origin of a URL;
 *   anything else becomes `…`. Every other string loses its credentials as a permission value
 *   does (`withoutCredentials`): the value after a credential flag, the password of
 *   `sshpass -p`, `mysql -p`, a DSN or a connection string, a URL's user name and password and
 *   its credential-like query values. Repeated keys are masked too.
 * - In every line of every file: the user name and password of each URL and its credential-like
 *   query values.
 *
 * A value that is wholly a credential of a known vendor format is left for the caller's detector
 * (src/report/fix-diff.ts), which shows it as `ghp_…(40 chars)`.
 */
import type { Node as JsonNode } from 'jsonc-parser';
import {
  argsWithoutCredentials,
  maskUrlCredentials,
  urlOrigin,
  REDACTED,
  withoutCredentials,
} from '../inventory/redact.js';
import { collectStrings, isTable, own } from '../parse/json-access.js';
import { lenientJsonTree } from '../parse/json.js';
import { parseToml } from '../parse/toml.js';
import type { JsonPathSegment } from '../parse/types.js';
import { findSecret } from '../rules/mcp/secrets.js';

/** A replacement within one line: columns `start` to `end` show `text`. */
export interface LineMask {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Masks by 0-based line index, each line's sorted and without overlaps. */
export type LineMasks = ReadonlyMap<number, readonly LineMask[]>;

/** Keys whose object holds environment variables or HTTP headers: values only by name. */
const SECRET_TABLES: ReadonlySet<string> = new Set(['env', 'headers', 'http_headers']);

/** Values the inventory shows of a `tls` switch; they are never a secret. */
const SWITCHES: ReadonlySet<string> = new Set(['0', '1', 'true', 'false', 'yes', 'no']);

/** Words of a header value that name an authorization scheme. */
const SCHEMES: ReadonlySet<string> = new Set(['bearer', 'basic', 'token']);

/** At most this many strings of one file are masked; the rest of a hostile file shows as is. */
const MAX_NODES = 20_000;

/** `${NAME}`, `${env:NAME}`, `$NAME`: a reference to a variable set elsewhere. */
function isReference(word: string): boolean {
  return /^\$(?:\{[\w.:-]{1,200}\}|\w{1,200})$/.test(word);
}

/**
 * What a fix diff shows of an env or header value: the value itself when it is a switch or only
 * references and scheme words (`Bearer ${TOKEN}`), the URL origin of an endpoint, else `…`.
 * Undefined to leave it as written, for a switch, references, or a vendor credential that the
 * caller's detector shows as `ghp_…(40 chars)`.
 */
function tableValue(value: string): string | undefined {
  const text = value.trim();
  if (text === '' || SWITCHES.has(text.toLowerCase())) return undefined;
  const words = text.split(/\s+/);
  if (words.every((word) => isReference(word) || SCHEMES.has(word.toLowerCase()))) {
    return undefined;
  }
  const secret = findSecret(text);
  if (secret?.start === 0 && secret.length === text.length) return undefined;
  if (/^[a-z][\d+.a-z-]*:\/\/[^\s/?#@]/i.test(text) && URL.canParse(text)) {
    const { origin, cut } = urlOrigin(text);
    return `${origin}${cut ? `/${REDACTED}` : ''}`;
  }
  return REDACTED;
}

/** A span of the text, replaced by `text`. */
interface Replacement {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** The line of `offset`: the last start at or before it. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Replacements split into masks by line; a span over several lines masks each part. */
function byLine(text: string, replacements: readonly Replacement[]): LineMasks {
  const starts = lineStartsOf(text);
  const out = new Map<number, LineMask[]>();
  const sorted = [...replacements].sort((a, b) => a.offset - b.offset);
  let covered = 0;
  for (const { offset, length, text: shown } of sorted) {
    if (offset < covered || length <= 0) continue;
    covered = offset + length;
    const first = lineAt(starts, offset);
    const last = lineAt(starts, offset + length - 1);
    for (let line = first; line <= last; line++) {
      const lineStart = starts[line] ?? 0;
      const nextStart = starts[line + 1] ?? text.length + 1;
      const start = Math.max(offset, lineStart) - lineStart;
      const end = Math.min(offset + length, nextStart - 1) - lineStart;
      const masks = out.get(line) ?? [];
      masks.push({ start, end, text: line === first ? shown : REDACTED });
      out.set(line, masks);
    }
  }
  return out;
}

/** A JSON string literal for `value`, as a replacement of the node, when it differs. */
function stringReplacement(node: JsonNode, value: string): Replacement | undefined {
  if (value === node.value) return undefined;
  return { offset: node.offset, length: node.length, text: JSON.stringify(value) };
}

function jsonReplacements(text: string): Replacement[] {
  const root = lenientJsonTree(text);
  if (root === undefined) return [];
  const out: Replacement[] = [];
  const stack: { node: JsonNode; table: boolean }[] = [{ node: root, table: false }];
  let visited = 0;
  while (stack.length > 0 && visited++ < MAX_NODES) {
    const item = stack.pop();
    if (item === undefined) break;
    const { node, table } = item;
    if (node.type === 'string' && typeof node.value === 'string') {
      const shown = table ? tableValue(node.value) : withoutCredentials(node.value);
      const replacement = shown === undefined ? undefined : stringReplacement(node, shown);
      if (replacement !== undefined) out.push(replacement);
      continue;
    }
    if (node.type === 'object') {
      const command = commandOf(node);
      for (const property of node.children ?? []) {
        const [key, value] = property.children ?? [];
        if (key === undefined || value === undefined) continue;
        const name = typeof key.value === 'string' ? key.value : '';
        if (name === 'args' && value.type === 'array') {
          out.push(...argsReplacements(value, command));
          continue;
        }
        if (value.type === 'object' && SECRET_TABLES.has(name)) {
          for (const member of value.children ?? []) {
            const memberValue = member.children?.[1];
            if (memberValue !== undefined) stack.push({ node: memberValue, table: true });
          }
        } else stack.push({ node: value, table: false });
      }
      continue;
    }
    for (const child of node.children ?? []) stack.push({ node: child, table });
  }
  return out;
}

/** The `command` string of an object node, the program its `args` go to. */
function commandOf(node: JsonNode): string | undefined {
  for (const property of node.children ?? []) {
    const [key, value] = property.children ?? [];
    const command: unknown = value?.value;
    if (key?.value === 'command' && typeof command === 'string') return command;
  }
  return undefined;
}

/** `args` without credentials, element by element, read together for `sshpass -p pw`. */
function argsReplacements(array: JsonNode, command: string | undefined): Replacement[] {
  const strings = (array.children ?? []).flatMap((node) => {
    const value: unknown = node.value;
    return node.type === 'string' && typeof value === 'string' ? [{ node, value }] : [];
  });
  const shown = argsWithoutCredentials(
    strings.map(({ value }) => value),
    command,
  );
  return strings.flatMap(({ node, value }, index) => {
    const replacement = stringReplacement(node, shown[index] ?? value);
    return replacement === undefined ? [] : [replacement];
  });
}

/** Under `env`, `headers` or `http_headers`, or Codex's `shell_environment_policy.set`. */
function inSecretTable(path: readonly JsonPathSegment[]): boolean {
  const parent = path[path.length - 2];
  if (typeof parent !== 'string') return false;
  if (SECRET_TABLES.has(parent)) return true;
  return parent === 'set' && path[path.length - 3] === 'shell_environment_policy';
}

function tomlReplacements(text: string): Replacement[] {
  const doc = parseToml(text);
  if (!doc.ok) return [];
  const out: Replacement[] = [];
  for (const { path, value } of collectStrings(doc.value)) {
    const span = doc.valueSpan(path);
    if (span === undefined) continue;
    let shown: string | undefined;
    if (inSecretTable(path)) shown = tableValue(value);
    else if (path[path.length - 2] === 'args' && typeof path[path.length - 1] === 'number') {
      const index = path[path.length - 1] as number;
      const owner = valueAt(doc.value, path.slice(0, -2));
      const command = isTable(owner) ? own(owner, 'command') : undefined;
      const args = valueAt(doc.value, path.slice(0, -1));
      const strings = Array.isArray(args)
        ? args.map((arg: unknown) => (typeof arg === 'string' ? arg : ''))
        : [];
      const masked = argsWithoutCredentials(
        strings,
        typeof command === 'string' ? command : undefined,
      )[index];
      shown = masked === value ? undefined : masked;
    } else {
      const masked = withoutCredentials(value);
      shown = masked === value ? undefined : masked;
    }
    if (shown !== undefined) {
      out.push({ offset: span.offset, length: span.length, text: JSON.stringify(shown) });
    }
  }
  return out;
}

function valueAt(root: unknown, path: readonly JsonPathSegment[]): unknown {
  let value = root;
  for (const segment of path) {
    if (typeof segment === 'number') value = Array.isArray(value) ? value[segment] : undefined;
    else value = isTable(value) ? own(value, segment) : undefined;
  }
  return value;
}

/**
 * The masks of a file's text, by line, from what the file is: JSON for `.json` and `.jsonc`
 * files, TOML for `.toml` files. Other files get only the line-wise URL masking of
 * {@link maskLine}.
 */
export function credentialMasks(path: string, text: string): LineMasks {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
    return byLine(text, jsonReplacements(text));
  }
  if (lower.endsWith('.toml')) return byLine(text, tomlReplacements(text));
  return new Map();
}

/**
 * One line with its masks applied, then the user name, password and credential-like query
 * values of each URL in it removed. `ellipsis` stands in for `…` in ASCII output.
 */
export function maskLine(
  line: string,
  masks: readonly LineMask[] | undefined,
  ellipsis = REDACTED,
): string {
  let out = line;
  if (masks !== undefined) {
    let next = '';
    let at = 0;
    for (const mask of masks) {
      if (mask.start < at || mask.end > line.length) continue;
      next += line.slice(at, mask.start) + mask.text;
      at = mask.end;
    }
    out = next + line.slice(at);
  }
  const masked = maskUrlCredentials(out);
  return ellipsis === REDACTED ? masked : masked.replaceAll(REDACTED, ellipsis);
}

/** True when masking changes the line: it holds a credential a review comment must not carry. */
export function holdsCredential(line: string, masks: readonly LineMask[] | undefined): boolean {
  return maskLine(line, masks) !== line;
}
