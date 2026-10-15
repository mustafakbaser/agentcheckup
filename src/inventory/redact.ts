/**
 * Redaction of command lines and arguments for the security inventory. The inventory keeps
 * commands so reviewers can see what runs, but never the credentials people put into them:
 *
 * - the value after a credential-like flag (`--token abc`, `--header "Authorization: …"`,
 *   curl's `-H` and `-u`) and the value of `--token=abc` or `API_KEY=abc`;
 * - the value of an HTTP header whose name looks like a credential (`Authorization: Bearer abc`),
 *   and the word after `Bearer` or `Basic`;
 * - every URL down to its origin: user names, passwords, paths, queries and fragments can all
 *   carry secrets (a Slack webhook URL is a credential in its path), so only `scheme://host:port`
 *   stays, followed by `/…` when anything was cut;
 * - any word that holds a credential with a known vendor prefix (mcp/literal-secret's detector).
 *
 * The redacted form is what the inventory shows and what its digests are built from, so a
 * credential never reaches a report or a baseline (docs/adr/0007, decision 10).
 */
import { findSecret } from '../rules/mcp/secrets.js';

/** Stands in for a removed value. */
export const REDACTED = '…';

/**
 * Names of flags, variables and headers whose value is treated as a credential. The same words
 * as the gate summaries in src/core/baseline.ts use, so both redact the same arguments.
 */
const SECRET_NAME = /token|key|secret|passw|auth|credential|bearer|header|cookie/i;

/** Short flags that take a credential: curl's `-H` (header) and `-u` (user:password). */
const SECRET_SHORT_FLAGS: ReadonlySet<string> = new Set(['-H', '-u']);

/** Words after which an HTTP authorization scheme puts the credential. */
const AUTH_SCHEMES: ReadonlySet<string> = new Set(['bearer', 'basic', 'token']);

const QUOTES = '"\'`';

interface Parts {
  readonly lead: string;
  readonly core: string;
  readonly trail: string;
}

/** Splits surrounding quotes and brackets off a word, so `"--token=x"` reads as `--token=x`. */
function parts(word: string): Parts {
  let start = 0;
  let end = word.length;
  while (start < end && QUOTES.includes(word.charAt(start))) start++;
  while (end > start && (QUOTES + ');,').includes(word.charAt(end - 1))) end--;
  return { lead: word.slice(0, start), core: word.slice(start, end), trail: word.slice(end) };
}

/** True for `--token`, `--api-key`, `-H`: a flag whose next word is a credential. */
export function isSecretFlag(word: string): boolean {
  const { core } = parts(word);
  if (!core.startsWith('-') || core.includes('=')) return false;
  if (SECRET_SHORT_FLAGS.has(core)) return true;
  const name = core.replace(/^-+/, '');
  return name !== '' && SECRET_NAME.test(name);
}

/** `Authorization:` with nothing after the colon: the header value is the next word. */
function isBareSecretHeader(core: string): boolean {
  return core.endsWith(':') && !core.includes('/') && SECRET_NAME.test(core.slice(0, -1));
}

/** True when the word after `word` holds a credential. */
function redactsNext(word: string): boolean {
  const { core } = parts(word);
  return isSecretFlag(word) || AUTH_SCHEMES.has(core.toLowerCase()) || isBareSecretHeader(core);
}

const SCHEME_CHAR = /^[\d+.a-z-]$/i;

/**
 * `scheme://host:port`, plus `/…` when the URL had more (credentials, path, query, fragment).
 * Text that does not parse as a URL keeps only its scheme.
 */
export function urlOrigin(text: string): { readonly origin: string; readonly cut: boolean } {
  const separator = text.indexOf('://');
  const scheme = separator < 0 ? '' : text.slice(0, separator);
  if (separator > 0 && URL.canParse(text)) {
    const url = new URL(text);
    const host = url.host;
    if (host !== '') {
      const origin = url.origin !== 'null' ? url.origin : `${url.protocol}//${host}`;
      const cut =
        url.username !== '' ||
        url.password !== '' ||
        (url.pathname !== '' && url.pathname !== '/') ||
        url.search !== '' ||
        url.hash !== '';
      return { origin, cut };
    }
  }
  return { origin: `${scheme}://`, cut: true };
}

/** A URL inside `text` cut to its origin, with the text before it kept. */
function redactUrlIn(text: string): string | undefined {
  const separator = text.indexOf('://');
  if (separator <= 0) return undefined;
  let start = separator;
  while (start > 0 && SCHEME_CHAR.test(text.charAt(start - 1))) start--;
  if (start === separator) return undefined;
  const { origin, cut } = urlOrigin(text.slice(start));
  return `${text.slice(0, start)}${origin}${cut ? `/${REDACTED}` : ''}`;
}

/** A value in `NAME=value`, `--flag=value` or `Header: value`, redacted on its own. */
function redactValue(value: string): string {
  if (value === '') return value;
  const url = redactUrlIn(value);
  if (url !== undefined) return url;
  return findSecret(value) === undefined ? value : REDACTED;
}

/** One word of a command line, redacted. */
function redactWord(word: string, afterSecret: boolean): string {
  const { lead, core, trail } = parts(word);
  if (core === '') return word;
  if (afterSecret) return `${lead}${REDACTED}${trail}`;

  const equals = core.indexOf('=');
  const url = core.indexOf('://');
  if (equals > 0 && (url < 0 || equals < url)) {
    const name = core.slice(0, equals);
    const bare = name.replace(/^-+/, '');
    const secret = bare !== '' && (SECRET_NAME.test(bare) || SECRET_SHORT_FLAGS.has(name));
    const value = secret ? REDACTED : redactValue(core.slice(equals + 1));
    return `${lead}${name}=${value}${trail}`;
  }

  const colon = core.indexOf(':');
  if (colon > 0 && colon < core.length - 1 && (url < 0 || colon < url)) {
    const name = core.slice(0, colon);
    if (!name.includes('/') && SECRET_NAME.test(name)) return `${lead}${name}:${REDACTED}${trail}`;
  }

  const redactedUrl = redactUrlIn(core);
  if (redactedUrl !== undefined) return `${lead}${redactedUrl}${trail}`;
  return findSecret(core) === undefined ? word : `${lead}${REDACTED}${trail}`;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * A command line with credentials removed. Words are split at whitespace and the whitespace is
 * kept, so the result reads like the original.
 */
export function redactCommand(command: string): string {
  let out = '';
  let previous = '';
  let i = 0;
  while (i < command.length) {
    const start = i;
    while (i < command.length && isSpace(command.charAt(i))) i++;
    out += command.slice(start, i);
    const wordStart = i;
    while (i < command.length && !isSpace(command.charAt(i))) i++;
    if (i === wordStart) break;
    const word = command.slice(wordStart, i);
    out += redactWord(word, previous !== '' && redactsNext(previous));
    previous = word;
  }
  return out;
}

/** Arguments with credentials removed; the value after a credential flag becomes `…`. */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const previous = index > 0 ? (args[index - 1] ?? '') : '';
    if (previous !== '' && redactsNext(lastWord(previous))) return REDACTED;
    return redactCommand(arg);
  });
}

/** The last whitespace-separated word of an argument, `Authorization:` in `-H Authorization:`. */
function lastWord(arg: string): string {
  const trimmed = arg.trimEnd();
  let start = trimmed.length;
  while (start > 0 && !isSpace(trimmed.charAt(start - 1))) start--;
  return trimmed.slice(start);
}
