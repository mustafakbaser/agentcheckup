/**
 * How agents recover from SKILL.md frontmatter that is not valid YAML.
 *
 * - Codex (`repair_frontmatter_scalar_fields` in codex-rs/skills/src/parser.rs): when serde_yaml
 *   fails, each `key: value` line outside a block scalar, at any indentation, whose value contains
 *   `: ` or starts with `[`, `{`, `@` or a backtick and does not parse, is wrapped in single
 *   quotes, and the YAML is parsed again. Codex reads lines with `str::lines()`, which drops a
 *   trailing `\r`.
 * - Claude Code documents only the outcome: YAML that does not parse leaves the skill with no
 *   fields. The 2.1.300 binary retries before giving up: it wraps top-level `key: value` lines
 *   whose unquoted value contains `: ` or one of `{}[]*&#!|>%@` and a backtick (unless the value
 *   is a valid flow list) in double quotes and turns leading tabs into two spaces each. The line
 *   pattern cannot match a line ending in `\r`. This retry is undocumented, so rules never cite
 *   it: they replay it only to stay silent about Claude Code where the shipped parser recovers,
 *   and claim the documented outcome where it does not.
 *
 * Both repairs are replayed and the result is parsed with the same hardened parser that
 * produced the original error. A repair that parses means that agent loads the skill normally.
 */
import { parseFrontmatter } from '../../parse/frontmatter.js';

/** True when `yaml`, placed between frontmatter delimiters, is a valid mapping. */
export function parsesAsFrontmatter(yaml: string): boolean {
  return parseFrontmatter(`---\n${yaml}\n---\n`).kind === 'valid';
}

/** Parses one scalar as a mapping value. `undefined` when it is not valid YAML. */
function parseValue(scalar: string): { readonly value: unknown } | undefined {
  const result = parseFrontmatter(`---\nv: ${scalar}\n---\n`);
  return result.kind === 'valid' ? { value: result.data.values['v'] } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

/** Claude Code's line pattern. Without the `m` flag, `$` cannot follow a trailing `\r`. */
const CLAUDE_KEY_LINE = /^([a-z_-]+):\s+(\S.*)$/i;
/** Characters that make Claude Code quote a value. */
const CLAUDE_NEEDS_QUOTES = /[{}[\]*&#!|>%@`]|: /;
const LEADING_TABS = /^\t+/gm;

function claudeCodeRepairLine(line: string): string {
  const match = CLAUDE_KEY_LINE.exec(line);
  if (match === null) return line;
  const key = match[1] ?? '';
  const value = match[2] ?? '';
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return line;
  }
  if (value.startsWith('[') && value.endsWith(']') && Array.isArray(parseValue(value)?.value)) {
    return line;
  }
  if (!CLAUDE_NEEDS_QUOTES.test(value)) return line;
  return `${key}: "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** The YAML Claude Code 2.1.300 parses on its second attempt (undocumented, see above). */
export function claudeCodeRepair(yaml: string): string {
  return yaml
    .split('\n')
    .map(claudeCodeRepairLine)
    .join('\n')
    .replace(LEADING_TABS, (tabs) => '  '.repeat(tabs.length));
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

/** Rust `char::is_whitespace`: the Unicode White_Space property. */
function isWhitespace(char: string): boolean {
  const code = char.codePointAt(0) ?? -1;
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Rust `str::trim()`: removes White_Space from both ends. Unlike JavaScript, it keeps U+FEFF. */
export function rustTrim(value: string): string {
  return trimEnd(trimStart(value));
}

function trimStart(value: string): string {
  let start = 0;
  while (start < value.length && isWhitespace(value.charAt(start))) start++;
  return value.slice(start);
}

function trimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && isWhitespace(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

/** Rust `str::lines()`: splits on `\n` and drops one trailing `\r` from each line. */
function rustLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line.charAt(count) === ' ') count++;
  return count;
}

/** `scalar` with a trailing ` # comment` removed, and that comment. */
function splitComment(value: string): { readonly scalar: string; readonly comment: string } {
  for (let i = 0; i < value.length; i++) {
    if (value.charAt(i) !== '#') continue;
    if (i > 0 && !isWhitespace(value.charAt(i - 1))) continue;
    const commentStart = trimEnd(value.slice(0, i)).length;
    return { scalar: value.slice(0, commentStart), comment: value.slice(commentStart) };
  }
  return { scalar: value, comment: '' };
}

function hasColonSeparator(scalar: string): boolean {
  for (let i = 0; i < scalar.length - 1; i++) {
    if (scalar.charAt(i) === ':' && isWhitespace(scalar.charAt(i + 1))) return true;
  }
  return false;
}

/** The YAML Codex parses on its second attempt, or undefined when it changes nothing. */
export function codexRepair(yaml: string): string | undefined {
  let changed = false;
  let blockScalarIndent: number | undefined;
  const repaired: string[] = [];
  for (const line of rustLines(yaml)) {
    const indent = leadingSpaces(line);
    if (blockScalarIndent !== undefined) {
      if (line.trim() === '' || indent > blockScalarIndent) {
        repaired.push(line);
        continue;
      }
      blockScalarIndent = undefined;
    }
    const colon = line.indexOf(':');
    const key = colon === -1 ? '' : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);
    if (key.trim() === '' || (value !== '' && !isWhitespace(value.charAt(0)))) {
      repaired.push(line);
      continue;
    }
    const valueStart = trimStart(value);
    const leading = value.slice(0, value.length - valueStart.length);
    const { scalar: withSpace, comment } = splitComment(valueStart);
    const scalar = trimEnd(withSpace);
    const first = scalar.charAt(0);
    if (first === '' || first === "'" || first === '"') {
      repaired.push(line);
      continue;
    }
    if (first === '|' || first === '>') {
      blockScalarIndent = indent;
      repaired.push(line);
      continue;
    }
    const flowLike =
      (first === '[' || first === '{' || first === '@' || first === '`') &&
      parseValue(scalar) === undefined;
    if (!hasColonSeparator(scalar) && !flowLike) {
      repaired.push(line);
      continue;
    }
    repaired.push(`${key}:${leading}'${scalar.replaceAll("'", "''")}'${comment}`);
    changed = true;
  }
  return changed ? repaired.join('\n') : undefined;
}
