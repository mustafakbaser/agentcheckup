/**
 * Detects shell lines that download a script and execute it in one step:
 *
 *   curl -fsSL https://x/install.sh | sh        wget -qO- https://x | sudo bash -s -- -y
 *   bash <(curl -s https://x)                   /bin/bash -c "$(curl -fsSL https://x)"
 *   irm https://x/install.ps1 | iex             iex ((New-Object Net.WebClient).DownloadString('https://x'))
 *
 * Plain string scanning, linear in the line length: every inner scan is bounded.
 */
import type { DecodedText } from '../../core/types.js';
import { negatesRunning } from './command-context.js';
import { wordTokens } from './english.js';

export interface RemoteExecution {
  /** Offset in the scanned text where the match starts. */
  readonly offset: number;
  readonly length: number;
  readonly url: string;
  /** Short description of the construct, e.g. `curl … | sh`. */
  readonly form: string;
}

const FETCHERS: ReadonlySet<string> = new Set([
  'curl',
  'curl.exe',
  'wget',
  'wget.exe',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
]);
const INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ash',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'node',
  'php',
  'pwsh',
  'powershell',
  'iex',
  'invoke-expression',
]);
const SOURCERS: ReadonlySet<string> = new Set(['source', '.']);
/** Inner scans of `<(…)` and `$(…)` look at most this far. */
const INNER_LIMIT = 1024;
/** Substitutions examined per line. */
const OCCURRENCE_LIMIT = 64;

interface Token {
  readonly start: number;
  readonly end: number;
  /** Lower-cased, quotes and brackets stripped, path removed: `"/bin/bash` -> `bash`. */
  readonly name: string;
  readonly raw: string;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
}

/** Token separators: whitespace and parentheses, so `iex(irm` splits into `iex` and `irm`. */
function isSeparator(code: number): boolean {
  return isSpace(code) || code === 0x28 || code === 0x29;
}

const STRIP = new Set(['"', "'", '`', '[', ']', '{', '}', ';', ',', '$']);

function tokenize(text: string, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  let i = from;
  while (i < to) {
    while (i < to && isSeparator(text.charCodeAt(i))) i++;
    const start = i;
    while (i < to && !isSeparator(text.charCodeAt(i))) i++;
    if (i === start) break;
    let first = start;
    let last = i;
    while (first < last && STRIP.has(text.charAt(first))) first++;
    while (last > first && STRIP.has(text.charAt(last - 1))) last--;
    const raw = text.slice(first, last);
    const lower = raw.toLowerCase();
    tokens.push({
      start: first === last ? start : first,
      end: first === last ? i : last,
      raw,
      name: lower.slice(lower.lastIndexOf('/') + 1),
    });
  }
  return tokens;
}

/** RFC 2606 / RFC 6761 names and loopback: documentation placeholders, not real downloads. */
function isPlaceholderHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.')) return true;
  for (const name of ['example.com', 'example.net', 'example.org']) {
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return host.endsWith('.example') || host.endsWith('.test') || host.endsWith('.invalid');
}

const URL_END = new Set(['"', "'", '`', ')', ']', '>', '<', '|', ';']);

/** First http(s) URL in `text[from, to)` with a real-looking host, or undefined. */
export function findUrl(text: string, from: number, to: number): string | undefined {
  const slice = text.slice(from, to);
  const lower = slice.toLowerCase();
  for (let at = lower.indexOf('http'); at !== -1; at = lower.indexOf('http', at + 4)) {
    const scheme = lower.startsWith('https://', at) ? 8 : lower.startsWith('http://', at) ? 7 : 0;
    if (scheme === 0) continue;
    let end = at + scheme;
    while (end < slice.length && !isSpace(slice.charCodeAt(end)) && !URL_END.has(slice.charAt(end)))
      end++;
    const url = slice.slice(at, end);
    let hostEnd = scheme;
    while (hostEnd < url.length && !'/:?#'.includes(url.charAt(hostEnd))) hostEnd++;
    const host = url.slice(scheme, hostEnd).toLowerCase();
    let plain = host.length > 0;
    for (let i = 0; i < host.length && plain; i++) {
      const code = host.charCodeAt(i);
      plain =
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2e ||
        code === 0x2d;
    }
    if (plain && host.includes('.') && !isPlaceholderHost(host)) return url;
  }
  return undefined;
}

/** Index after the last `;` or `&&` in `text[from, to)`: the start of the last command there. */
function lastCommandStart(text: string, from: number, to: number): number {
  let start = from;
  for (let i = from; i < to; i++) {
    const char = text.charAt(i);
    if (char === ';') start = i + 1;
    else if (char === '&' && text.charAt(i + 1) === '&') start = i + 2;
  }
  return start;
}

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);

function isRedirection(raw: string): boolean {
  const first = raw.charAt(0);
  const second = raw.charAt(1);
  return (
    first === '>' ||
    first === '<' ||
    (first >= '0' && first <= '9' && (second === '>' || second === '<'))
  );
}

/**
 * Whether `interpreter` with these arguments runs its program from standard input, which is the
 * downloaded script. `sh`, `bash -s`, `python3 -` and `iex` do; `bash -c '…'`, `python3 -m
 * json.tool`, `node -e …` and `python3 parse.py` read the download as data.
 */
function executesStdin(interpreter: string, args: readonly Token[]): boolean {
  if (interpreter === 'iex' || interpreter === 'invoke-expression') return true;
  const shell = SHELLS.has(interpreter);
  const powershell = interpreter === 'pwsh' || interpreter === 'powershell';
  for (let index = 0; index < args.length; index++) {
    const raw = args[index]?.raw ?? '';
    if (raw === '') continue;
    if (isRedirection(raw)) {
      // `> file` names its target in the next word; `>/dev/null` and `2>&1` carry it.
      const operator = raw.replace(/^\d/, '');
      if (operator === '>' || operator === '>>' || operator === '<' || operator === '&>') index++;
      continue;
    }
    if (raw === '-') return true;
    if (raw === '--') {
      if (shell) return true;
      continue;
    }
    if (powershell) return false;
    if (!raw.startsWith('-')) return false;
    if (raw.startsWith('--')) {
      if (raw === '--eval' || raw === '--print' || raw === '--command' || raw === '--require')
        return false;
      continue;
    }
    const letters = raw.slice(1);
    if (shell) {
      if (letters.includes('c')) return false;
      if (letters.includes('s')) return true;
      continue;
    }
    for (const letter of 'cemEpnr') if (letters.includes(letter)) return false;
  }
  return true;
}

/** The interpreter a pipeline stage starts with, skipping `sudo [flags]` and `env [VAR=x]`. */
function stageInterpreter(tokens: readonly Token[]): Token | undefined {
  let i = 0;
  if (tokens[i]?.name === 'sudo') {
    i++;
    while (tokens[i]?.raw.startsWith('-')) {
      const flag = tokens[i]?.raw ?? '';
      i += flag === '-u' || flag === '-g' || flag === '--user' || flag === '--group' ? 2 : 1;
    }
  }
  if (tokens[i]?.name === 'env') {
    i++;
    while (tokens[i]?.raw.includes('=') === true) i++;
  }
  const token = tokens[i];
  if (token === undefined || !INTERPRETERS.has(token.name)) return undefined;
  return executesStdin(token.name, tokens.slice(i + 1)) ? token : undefined;
}

/** End of the first command in `text[from, to)`: a separator, comment, quote or code-span end. */
function firstCommandEnd(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const char = text.charAt(i);
    if (char === '&') {
      const before = text.charAt(i - 1);
      const after = text.charAt(i + 1);
      if (before !== '>' && before !== '<' && after !== '>') return i;
      continue;
    }
    if (char === ';' || char === '`' || char === '"' || char === "'" || char === ')') return i;
    if (char === '#' && (i === from || isSpace(text.charCodeAt(i - 1)))) return i;
  }
  return to;
}

/** `curl … | sh` and `curl … | tee x | sh`. */
function findPipe(text: string, from: number, to: number): RemoteExecution | undefined {
  const stages: [number, number][] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (text.charAt(i) !== '|') continue;
    if (text.charAt(i + 1) === '|') {
      i++;
      continue;
    }
    stages.push([start, i]);
    start = i + 1;
  }
  stages.push([start, to]);
  for (let k = 0; k + 1 < stages.length; k++) {
    const [stageStart, stageEnd] = stages[k] ?? [0, 0];
    const commandStart = lastCommandStart(text, stageStart, stageEnd);
    const fetcher = tokenize(text, commandStart, stageEnd).find((token) =>
      FETCHERS.has(token.name),
    );
    if (fetcher === undefined) continue;
    const url = findUrl(text, fetcher.end, stageEnd);
    if (url === undefined) continue;
    const stageTokens = (index: number): Token[] => {
      const [from, to] = stages[index] ?? [0, 0];
      return tokenize(text, from, firstCommandEnd(text, from, to));
    };
    let next = k + 1;
    let tokens = stageTokens(next);
    if (tokens[0]?.name === 'tee' && next + 1 < stages.length) {
      next++;
      tokens = stageTokens(next);
    }
    const interpreter = stageInterpreter(tokens);
    if (interpreter === undefined) continue;
    return {
      offset: fetcher.start,
      length: interpreter.end - fetcher.start,
      url,
      form: `${fetcher.name} … | ${interpreter.name}`,
    };
  }
  return undefined;
}

/** `bash <(curl …)`, `source <(curl …)`, `bash -c "$(curl …)"`, `eval "$(curl …)"`. */
function findSubstitution(text: string, from: number, to: number): RemoteExecution | undefined {
  for (const opener of ['<(', '$(']) {
    let seen = 0;
    for (
      let at = text.indexOf(opener, from);
      at !== -1 && at < to;
      at = text.indexOf(opener, at + 2)
    ) {
      if (++seen > OCCURRENCE_LIMIT) break;
      const innerEnd = Math.min(to, at + 2 + INNER_LIMIT);
      const close = text.indexOf(')', at + 2);
      const end = close === -1 || close > innerEnd ? innerEnd : close;
      const fetcher = tokenize(text, at + 2, end)[0];
      if (fetcher === undefined || !FETCHERS.has(fetcher.name)) continue;
      const url = findUrl(text, fetcher.end, end);
      if (url === undefined) continue;
      const before = tokenize(text, Math.max(from, at - 64), at).filter(
        (token) => token.raw !== '',
      );
      const last = before[before.length - 1];
      let runner: Token | undefined;
      if (opener === '<(') {
        if (last !== undefined && (INTERPRETERS.has(last.name) || SOURCERS.has(last.name)))
          runner = last;
      } else if (last?.name === 'eval') {
        runner = last;
      } else if (last?.raw === '-c' && INTERPRETERS.has(before[before.length - 2]?.name ?? '')) {
        runner = before[before.length - 2];
      }
      if (runner === undefined) continue;
      const shown =
        opener === '<('
          ? `${runner.name} <(${fetcher.name} …)`
          : runner.name === 'eval'
            ? `eval "$(${fetcher.name} …)"`
            : `${runner.name} -c "$(${fetcher.name} …)"`;
      return { offset: runner.start, length: end + 1 - runner.start, url, form: shown };
    }
  }
  return undefined;
}

/** PowerShell `iex (irm …)` and `iex ((New-Object Net.WebClient).DownloadString('…'))`. */
function findPowerShell(text: string, from: number, to: number): RemoteExecution | undefined {
  const lower = text.slice(from, to).toLowerCase();
  if (!lower.includes('iex') && !lower.includes('invoke-expression')) return undefined;
  const tokens = tokenize(text, from, to);
  const runner = tokens.find((token) => token.name === 'iex' || token.name === 'invoke-expression');
  if (runner === undefined) return undefined;
  const download = tokens.some(
    (token) => FETCHERS.has(token.name) || token.name.includes('downloadstring'),
  );
  if (!download) return undefined;
  const url = findUrl(text, from, to);
  if (url === undefined) return undefined;
  return {
    offset: runner.start,
    length: runner.end - runner.start,
    url,
    form: `${runner.name} (… download …)`,
  };
}

/** Words that reject the command they precede on the same line: "avoid", "instead of". */
const LINE_NEGATIONS: ReadonlySet<string> = new Set([
  'avoid',
  'forbidden',
  'prohibited',
  'disallowed',
]);
const LINE_NEGATION_PAIRS: ReadonlySet<string> = new Set([
  'instead of',
  'rather than',
  'not allowed',
]);

/**
 * True when English text before the match on its line says not to run it: "Never run curl … |
 * sh", "do not pipe …", "use brew instead of …". A negation of another verb ("Never guess
 * versions.") does not count.
 */
function isNegated(prefix: string): boolean {
  const tokens = wordTokens(prefix);
  if (negatesRunning(tokens)) return true;
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]?.word ?? '';
    if (LINE_NEGATIONS.has(word)) return true;
    if (LINE_NEGATION_PAIRS.has(`${word} ${tokens[i + 1]?.word ?? ''}`)) return true;
  }
  return false;
}

function cheapReject(lower: string): boolean {
  if (!lower.includes('http')) return true;
  return !(
    lower.includes('curl') ||
    lower.includes('wget') ||
    lower.includes('iwr') ||
    lower.includes('irm') ||
    lower.includes('invoke-') ||
    lower.includes('downloadstring')
  );
}

/** Finds a download-and-execute construct in `text[from, to)` (one line). */
export function findRemoteExecution(
  text: string,
  from: number,
  to: number,
): RemoteExecution | undefined {
  if (cheapReject(text.slice(from, to).toLowerCase())) return undefined;
  const match =
    findPipe(text, from, to) ?? findSubstitution(text, from, to) ?? findPowerShell(text, from, to);
  if (match === undefined || isNegated(text.slice(from, match.offset))) return undefined;
  return match;
}

/**
 * Scans a Markdown line. Table rows use `|` as the cell separator, so only their inline code
 * (`…`) is scanned there; any other line is scanned whole.
 */
export function findRemoteExecutionInLine(
  text: string,
  from: number,
  to: number,
): RemoteExecution | undefined {
  let first = from;
  while (first < to && isSpace(text.charCodeAt(first))) first++;
  if (text.charAt(first) !== '|') return findRemoteExecution(text, from, to);
  let open = -1;
  for (let i = first; i < to; i++) {
    if (text.charAt(i) !== '`') continue;
    if (open === -1) {
      open = i + 1;
      continue;
    }
    const match = findRemoteExecution(text, open, i);
    if (match !== undefined) return match;
    open = -1;
  }
  return undefined;
}

/** Most matches kept per file: a hostile file can hold one on every line. */
const MAX_KEPT_LINES = 1024;
const BY_LINE = new WeakMap<DecodedText, ReadonlyMap<number, RemoteExecution>>();

/**
 * {@link findRemoteExecutionInLine} for every line of a decoded file, by line index, for the lines
 * with a match. Kept per decoding, unless there are more than {@link MAX_KEPT_LINES}: two rules
 * ask, in every scan that `fix` runs to verify its fixes, and a file the fixes leave alone keeps
 * its decoding.
 */
export function remoteExecutionsByLine(decoded: DecodedText): ReadonlyMap<number, RemoteExecution> {
  const kept = BY_LINE.get(decoded);
  if (kept !== undefined) return kept;
  const { text, lineStarts } = decoded;
  const matches = new Map<number, RemoteExecution>();
  for (let line = 0; line < lineStarts.length; line++) {
    const start = lineStarts[line] ?? 0;
    const end = lineStarts[line + 1] ?? text.length;
    const match = findRemoteExecutionInLine(text, start, end);
    if (match !== undefined) matches.set(line, match);
  }
  if (matches.size <= MAX_KEPT_LINES) BY_LINE.set(decoded, matches);
  return matches;
}
