/**
 * Glob patterns from a scanned repository, matched against the absolute path a file has on the
 * machine where an agent runs. agentcheckup knows only the path below the scan root, so a match
 * can be certain (`match`: whatever directory the repository is checked out in), possible
 * (`maybe`: it depends on that directory, or on syntax this module does not evaluate) or
 * excluded (`no`).
 *
 * Patterns come from a repository that may be hostile (docs/adr/0003): no RegExp is built from
 * them. Matching works on segments, with `*`, `?`, `[...]`, `\` escapes, `**` segments and
 * `{a,b}` braces; it is O(pattern × path) per expanded pattern, and both the expansion and the
 * pattern length are bounded. Extglobs and negation are not evaluated (`maybe`). Whether `*` and
 * `**` match names that start with a dot differs between glob libraries, so a result that
 * depends on it is `maybe` too. Pure.
 */

export type GlobMatch = 'match' | 'maybe' | 'no';

/** Longest pattern evaluated, in UTF-16 code units. */
const MAX_PATTERN_LENGTH = 1024;

/** Most alternatives the braces of one pattern expand to. */
const MAX_EXPANSIONS = 64;

/** One part of a segment pattern. */
type Token =
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | {
      readonly kind: 'class';
      readonly negated: boolean;
      readonly items: readonly (readonly [string, string])[];
    };

/** A path segment pattern; `globstar` is a whole `**` segment. */
type Segment = { readonly globstar: true } | { readonly globstar: false; tokens: Token[] };

/**
 * The alternatives of a pattern's `{a,b}` groups, innermost and leftmost first; a brace without
 * its partner stays literal. Undefined past {@link MAX_EXPANSIONS}.
 */
export function expandBraces(pattern: string): string[] | undefined {
  const results: string[] = [];
  const queue = [pattern];
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    const group = firstGroup(item);
    if (group === undefined) {
      results.push(item);
      if (results.length > MAX_EXPANSIONS) return undefined;
      continue;
    }
    const head = item.slice(0, group.open);
    const tail = item.slice(group.close + 1);
    for (const option of group.options) queue.push(head + option + tail);
    if (queue.length + results.length > MAX_EXPANSIONS) return undefined;
  }
  return results;
}

/** The first `{...}` group with a top-level comma whose braces are balanced. */
function firstGroup(
  text: string,
): { readonly open: number; readonly close: number; readonly options: string[] } | undefined {
  for (let open = 0; open < text.length; open++) {
    const char = text.charAt(open);
    if (char === '\\') {
      open++;
      continue;
    }
    if (char !== '{') continue;
    let depth = 0;
    let start = open + 1;
    const options: string[] = [];
    for (let i = open + 1; i < text.length; i++) {
      const inner = text.charAt(i);
      if (inner === '\\') {
        i++;
        continue;
      }
      if (inner === '{') depth++;
      else if (inner === '}' && depth > 0) depth--;
      else if (inner === ',' && depth === 0) {
        options.push(text.slice(start, i));
        start = i + 1;
      } else if (inner === '}') {
        if (options.length === 0) break;
        options.push(text.slice(start, i));
        return { open, close: i, options };
      }
    }
  }
  return undefined;
}

/** True for syntax this module does not evaluate: extglobs and a leading `!`. */
function unsupported(pattern: string): boolean {
  if (pattern.startsWith('!')) return true;
  for (let i = 0; i + 1 < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === '\\') {
      i++;
      continue;
    }
    if ('@!+*?'.includes(char) && pattern.charAt(i + 1) === '(') return true;
  }
  return false;
}

/** The tokens of one segment pattern. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '\\' && i + 1 < text.length) {
      i++;
      tokens.push({ kind: 'char', value: text.charAt(i) });
    } else if (char === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (char === '?') {
      tokens.push({ kind: 'any' });
    } else if (char === '[') {
      const parsed = parseClass(text, i);
      if (parsed === undefined) tokens.push({ kind: 'char', value: char });
      else {
        tokens.push(parsed.token);
        i = parsed.end;
      }
    } else {
      tokens.push({ kind: 'char', value: char });
    }
  }
  return tokens;
}

/** A `[...]` class starting at `start`, or undefined when it is not closed. */
function parseClass(
  text: string,
  start: number,
): { readonly token: Token; readonly end: number } | undefined {
  let i = start + 1;
  const negated = text.charAt(i) === '!' || text.charAt(i) === '^';
  if (negated) i++;
  const items: [string, string][] = [];
  let first = true;
  for (; i < text.length; i++) {
    let char = text.charAt(i);
    if (char === ']' && !first) return { token: { kind: 'class', negated, items }, end: i };
    first = false;
    if (char === '\\' && i + 1 < text.length) {
      i++;
      char = text.charAt(i);
    }
    if (text.charAt(i + 1) === '-' && i + 2 < text.length && text.charAt(i + 2) !== ']') {
      items.push([char, text.charAt(i + 2)]);
      i += 2;
    } else {
      items.push([char, char]);
    }
  }
  return undefined;
}

function compile(pattern: string): Segment[] {
  return pattern
    .split('/')
    .map((part) =>
      part === '**' ? { globstar: true } : { globstar: false, tokens: tokenize(part) },
    );
}

function tokenMatches(token: Token, char: string): boolean {
  switch (token.kind) {
    case 'char':
      return token.value === char;
    case 'any':
      return true;
    case 'class': {
      const inside = token.items.some(([low, high]) => char >= low && char <= high);
      return inside !== token.negated;
    }
    case 'star':
      return false;
  }
}

/**
 * One segment against one name: `*` runs within the name, the others take one character. With
 * `dot` false, a name that starts with `.` needs a literal `.` first.
 */
function segmentMatches(tokens: readonly Token[], name: string, dot: boolean): boolean {
  if (!dot && name.startsWith('.') && tokens[0]?.kind !== 'char') return false;
  // Code points: a glob `?` takes one character, as path names count them.
  const chars = Array.from(name);
  let t = 0;
  let c = 0;
  let starT = -1;
  let starC = 0;
  while (c < chars.length) {
    const token = tokens[t];
    if (token?.kind === 'star') {
      starT = t++;
      starC = c;
    } else if (token !== undefined && tokenMatches(token, chars[c] ?? '')) {
      t++;
      c++;
    } else if (starT >= 0) {
      t = starT + 1;
      c = ++starC;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === 'star') t++;
  return t === tokens.length;
}

/** Segments against names: `**` takes any run of names, none starting with `.` unless `dot`. */
function pathMatches(
  segments: readonly Segment[],
  names: readonly string[],
  dot: boolean,
): boolean {
  let s = 0;
  let n = 0;
  let starS = -1;
  let starN = 0;
  while (n < names.length) {
    const segment = segments[s];
    const name = names[n] ?? '';
    if (segment?.globstar === true) {
      starS = s++;
      starN = n;
    } else if (segment !== undefined && segmentMatches(segment.tokens, name, dot)) {
      s++;
      n++;
    } else if (starS >= 0 && (dot || !(names[starN] ?? '').startsWith('.'))) {
      s = starS + 1;
      n = ++starN;
    } else {
      return false;
    }
  }
  while (segments[s]?.globstar === true) s++;
  return s === segments.length;
}

/** Whether `segments` match `names` whatever the dot setting, under one of them, or not at all. */
function matchBoth(segments: readonly Segment[], names: readonly string[]): GlobMatch {
  const withDot = pathMatches(segments, names, true);
  const withoutDot = pathMatches(segments, names, false);
  return withDot && withoutDot ? 'match' : withDot || withoutDot ? 'maybe' : 'no';
}

const GLOBSTAR: Segment = { globstar: true };

/**
 * One brace-free pattern against `/<unknown directories>/<path>`:
 * - one that starts with `**` (or `/**`) takes the unknown directories with that `**`, so it
 *   matches when the rest matches the end of `path`. agentcheckup assumes the names of the
 *   directories above the scan root do not complete such a pattern: `**\/vendor/**\/CLAUDE.md`
 *   does not exclude every CLAUDE.md of a repository checked out under a `vendor` directory.
 * - any other absolute pattern (`/`, `~`, a drive letter) names those directories, so it may match
 *   when some tail of it matches `path`, with any `**` before that tail free to take the first
 *   names of `path`.
 * - a relative pattern without a leading `**`: whether Claude Code matches one against an
 *   absolute path at all is not documented, so at best it may, read the same way.
 */
function matchOne(pattern: string, names: readonly string[]): GlobMatch {
  const segments = compile(pattern);
  const start = pattern.startsWith('/') ? 1 : 0;
  if (segments[start]?.globstar === true) {
    return matchBoth([GLOBSTAR, ...segments.slice(start + 1)], names);
  }
  let globstarSeen = false;
  for (let k = start; k < segments.length; k++) {
    const rest = segments.slice(k);
    if (matchBoth(globstarSeen ? [GLOBSTAR, ...rest] : rest, names) !== 'no') return 'maybe';
    if (segments[k]?.globstar === true) globstarSeen = true;
  }
  return 'no';
}

/**
 * How `pattern` matches the file at `path` (POSIX, relative to the scan root), whose absolute
 * path is not known: see the module comment. A pattern too long, with too many alternatives or
 * with syntax this module does not evaluate is `maybe`.
 */
export function matchAbsoluteGlob(pattern: string, path: string): GlobMatch {
  if (pattern.length > MAX_PATTERN_LENGTH || unsupported(pattern)) return 'maybe';
  const expanded = expandBraces(pattern);
  if (expanded === undefined) return 'maybe';
  const names = path.split('/');
  let result: GlobMatch = 'no';
  for (const alternative of expanded) {
    const one = matchOne(alternative, names);
    if (one === 'match') return 'match';
    if (one === 'maybe') result = 'maybe';
  }
  return result;
}
