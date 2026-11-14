/**
 * Redaction of command lines and arguments for the security inventory. The inventory keeps
 * commands so reviewers can see what runs, but never the credentials people put into them:
 *
 * - the value after a credential-like flag (`--token abc`, `--pat abc`, `--header "Authorization:
 *   …"`, curl's `-H` and `-u`) and the value of `--token=abc`, `--pwd=abc` or `API_KEY=abc`
 *   ({@link isSecretName});
 * - the password option of the programs in {@link PASSWORD_PROGRAMS}, where the same letter means
 *   something else in other programs: `sshpass -p pw`, `mysql -ppw`, `redis-cli -a pw`;
 * - the value of an HTTP header whose name looks like a credential (`Authorization: Bearer abc`),
 *   and the word after `Bearer` or `Basic`;
 * - the password of a data source name without a scheme (`root:pw@tcp(db:3306)/x`,
 *   `user:pw@host`) and the credential fields of a connection string
 *   (`Server=db;User Id=sa;Password=pw;`);
 * - every URL down to its origin: user names, passwords, paths, queries and fragments can all
 *   carry secrets (a Slack webhook URL is a credential in its path), so only `scheme://host:port`
 *   stays, followed by `/…` when anything was cut;
 * - any word that holds a credential with a known vendor prefix (mcp/literal-secret's detector).
 *
 * The redacted form is what the inventory shows, so a credential never reaches a report or a
 * baseline (docs/adr/0007, decision 10). Digests cover more than reports show: the
 * credential-free form ({@link withoutCredentials}), which keeps every URL whole but for its
 * user name, password and credential-like query values (docs/adr/0017).
 *
 * Permission values ({@link redactPermission}) are patterns that tell rules apart by their URLs,
 * so a URL there keeps its path and loses only its user name, password and the values of
 * credential-like query parameters.
 *
 * Every test here walks the text once, word by word: no regular expression runs over a whole
 * command line, so a crafted value costs time in proportion to its length.
 */
import { findSecret } from '../rules/mcp/secrets.js';

/** Stands in for a removed value. */
export const REDACTED = '…';

/**
 * Parts of names of flags, variables, headers and query parameters whose value is treated as a
 * credential. The gate summaries in src/core/baseline.ts use {@link isSecretFlag} too, so both
 * redact the same arguments.
 */
const SECRET_NAME = /token|key|secret|passw|auth|credential|bearer|header|cookie|signature/i;

/**
 * Whole words of a name, split at `-`, `_` and `.`, that mark a credential but are too short to
 * look for inside other words: `--pat`, `--pwd`, `DB_PASS`, `--pw`, the `sig` of a shared access
 * signature URL.
 */
const SECRET_WORDS: ReadonlySet<string> = new Set(['pat', 'pass', 'pw', 'pwd', 'sig']);

/** Short flags that take a credential: curl's `-H` (header) and `-u` (user:password). */
const SECRET_SHORT_FLAGS: ReadonlySet<string> = new Set(['-H', '-u']);

/** Words after which an HTTP authorization scheme puts the credential. */
const AUTH_SCHEMES: ReadonlySet<string> = new Set(['bearer', 'basic', 'token']);

/**
 * True when a name of a flag, variable, header or query parameter, leading dashes aside, names a
 * credential: `--token`, `API_KEY`, `Authorization`, `--pwd`, `sig`. `PWD` alone is the shell's
 * working directory, not a password.
 */
export function isSecretName(name: string): boolean {
  const bare = name.replace(/^-+/, '');
  if (bare === '') return false;
  if (SECRET_NAME.test(bare)) return true;
  if (bare === 'PWD') return false;
  return bare
    .toLowerCase()
    .split(/[-._]/)
    .some((word) => SECRET_WORDS.has(word));
}

/**
 * How a program takes its password on the command line, for the programs whose short password
 * option is a port or a path in other programs, so only theirs is read this way.
 */
interface PasswordOptions {
  /** Options whose next word is the password. */
  readonly separate: ReadonlySet<string>;
  /** Options with the password attached to them, `-ppw`. */
  readonly attached: ReadonlySet<string>;
  /** Other options that take the next word as their value. */
  readonly withValue: ReadonlySet<string>;
  /** True when the first operand ends the program's options: sshpass runs the rest. */
  readonly optionsEndAtOperand: boolean;
}

/** sshpass(1): `-p password` or `-ppassword`; `-f file`, `-d fd` and `-P prompt` take values. */
const SSHPASS: PasswordOptions = {
  separate: new Set(['-p']),
  attached: new Set(['-p']),
  withValue: new Set(['-f', '-d', '-P']),
  optionsEndAtOperand: true,
};

/**
 * The MySQL and MariaDB clients: `-ppassword`, attached, "you cannot have a space between the
 * option and the password"; `-p` alone prompts, and the next word is the database.
 */
const MYSQL: PasswordOptions = {
  separate: new Set(),
  attached: new Set(['-p']),
  withValue: new Set(),
  optionsEndAtOperand: false,
};

/** redis-cli: `-a password`. */
const REDIS_CLI: PasswordOptions = {
  separate: new Set(['-a']),
  attached: new Set(),
  withValue: new Set(),
  optionsEndAtOperand: false,
};

/** Programs, by file name without `.exe`, whose short password option {@link PasswordOptions} reads. */
const PASSWORD_PROGRAMS: ReadonlyMap<string, PasswordOptions> = new Map([
  ['sshpass', SSHPASS],
  ['redis-cli', REDIS_CLI],
  ...[
    'mysql',
    'mysqladmin',
    'mysqlcheck',
    'mysqldump',
    'mysqlimport',
    'mysqlpump',
    'mysqlshow',
    'mysqlslap',
    'mariadb',
    'mariadb-admin',
    'mariadb-check',
    'mariadb-dump',
    'mariadb-import',
    'mariadb-show',
    'mariadb-slap',
  ].map((name) => [name, MYSQL] as const),
]);

/** Words that end a simple command in a shell command line. */
const SEPARATORS: ReadonlySet<string> = new Set([';', '&&', '||', '|', '&', '(', ')', '|&']);

/**
 * Words before `:` in `user:password@…` that are not a user name: package specifiers such as
 * `npm:lodash@4` and `mailto:` addresses.
 */
const NOT_A_USER: ReadonlySet<string> = new Set([
  'npm',
  'jsr',
  'docker',
  'oci',
  'github',
  'gitlab',
  'bitbucket',
  'git',
  'file',
  'link',
  'workspace',
  'patch',
  'catalog',
  'portal',
  'mailto',
]);

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

/** True for `--token`, `--api-key`, `--pat`, `-H`: a flag whose next word is a credential. */
export function isSecretFlag(word: string): boolean {
  const { core } = parts(word);
  if (!core.startsWith('-') || core.includes('=')) return false;
  if (SECRET_SHORT_FLAGS.has(core)) return true;
  return isSecretName(core);
}

/** `Authorization:` with nothing after the colon: the header value is the next word. */
function isBareSecretHeader(core: string): boolean {
  return core.endsWith(':') && !core.includes('/') && isSecretName(core.slice(0, -1));
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

/** How a redaction treats URLs: cut to the origin, or with only their credentials removed. */
type UrlMode = 'origin' | 'credentials';

/**
 * A URL inside `text` with its credentials removed: the user name and password, and the value of
 * every query parameter whose name looks like a credential. Undefined when there is no URL or
 * nothing to remove.
 */
function redactUrlCredentialsIn(text: string): string | undefined {
  const separator = text.indexOf('://');
  if (separator <= 0) return undefined;
  const authorityStart = separator + 3;
  let authorityEnd = authorityStart;
  while (authorityEnd < text.length && !'/?#'.includes(text.charAt(authorityEnd))) authorityEnd++;
  const at = text.lastIndexOf('@', authorityEnd - 1);
  let out =
    at >= authorityStart ? `${text.slice(0, authorityStart)}${REDACTED}${text.slice(at)}` : text;
  const query = out.indexOf('?', authorityStart);
  if (query !== -1) {
    const fragment = out.indexOf('#', query);
    const end = fragment === -1 ? out.length : fragment;
    const params = out
      .slice(query + 1, end)
      .split('&')
      .map((param) => {
        const equals = param.indexOf('=');
        if (equals <= 0 || !isSecretName(param.slice(0, equals))) return param;
        return `${param.slice(0, equals + 1)}${REDACTED}`;
      });
    out = `${out.slice(0, query + 1)}${params.join('&')}${out.slice(end)}`;
  }
  return out === text ? undefined : out;
}

/** A URL inside `text` redacted as `mode` says. */
function redactUrl(text: string, mode: UrlMode): string | undefined {
  return mode === 'origin' ? redactUrlIn(text) : redactUrlCredentialsIn(text);
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

/**
 * The password of a data source name without a scheme removed: `root:pw@tcp(db:3306)/x` (Go's
 * MySQL driver) and `user:pw@host`. The password runs from the first `:` to the last `@` before
 * the host part, which ends at the first `/` or `(`. Not a password: a container image digest
 * (`image:tag@sha256:…`) and package specifiers such as `npm:lodash@4`. Undefined when there is
 * none.
 */
function redactDsn(core: string): string | undefined {
  if (core.includes('://')) return undefined;
  const colon = core.indexOf(':');
  if (colon <= 0) return undefined;
  let hostEnd = colon + 1;
  while (hostEnd < core.length && !'/('.includes(core.charAt(hostEnd))) hostEnd++;
  const at = core.lastIndexOf('@', hostEnd - 1);
  if (at <= colon + 1 || at === core.length - 1) return undefined;
  const user = core.slice(0, colon);
  if (user.includes('/') || user.includes('@') || NOT_A_USER.has(user.toLowerCase())) {
    return undefined;
  }
  if (isDigest(core.slice(at + 1))) return undefined;
  return `${user}:${REDACTED}${core.slice(at)}`;
}

/** `sha256:…`, `sha512:…`: an OCI content digest. */
function isDigest(text: string): boolean {
  const colon = text.indexOf(':');
  return (
    colon > 3 && text.slice(0, 3).toLowerCase() === 'sha' && /^\d+$/.test(text.slice(3, colon))
  );
}

/** A value in `NAME=value`, `--flag=value` or `Header: value`, redacted on its own. */
function redactValue(value: string, mode: UrlMode): string {
  if (value === '') return value;
  const url = redactUrl(value, mode);
  if (url !== undefined) return findSecret(url) === undefined ? url : REDACTED;
  const dsn = redactDsn(value);
  if (dsn !== undefined) return findSecret(dsn) === undefined ? dsn : REDACTED;
  return findSecret(value) === undefined ? value : REDACTED;
}

/** One word of a command line, redacted. */
function redactWord(word: string, afterSecret: boolean, mode: UrlMode): string {
  const { lead, core, trail } = parts(word);
  if (core === '') return word;
  if (afterSecret) return `${lead}${REDACTED}${trail}`;
  // A connection string, `Server=db;User Id=sa;Password=pw`, or commands joined by `;`: each
  // segment on its own.
  if (core.includes(';') && core.includes('=')) {
    const segments = core.split(';').map((segment) => redactSegment(segment, mode));
    return `${lead}${segments.join(';')}${trail}`;
  }
  return `${lead}${redactSegment(core, mode)}${trail}`;
}

/** A word, or a segment of one between `;`, without surrounding quotes, redacted. */
function redactSegment(core: string, mode: UrlMode): string {
  if (core === '') return core;
  const equals = core.indexOf('=');
  const url = core.indexOf('://');
  if (equals > 0 && (url < 0 || equals < url)) {
    const name = core.slice(0, equals);
    const secret = isSecretName(name.trim()) || SECRET_SHORT_FLAGS.has(name);
    const value = secret ? REDACTED : redactValue(core.slice(equals + 1), mode);
    return `${name}=${value}`;
  }

  const colon = core.indexOf(':');
  if (colon > 0 && colon < core.length - 1 && (url < 0 || colon < url)) {
    const name = core.slice(0, colon);
    if (!name.includes('/') && isSecretName(name)) return `${name}:${REDACTED}`;
  }

  const redactedUrl = redactUrl(core, mode);
  if (redactedUrl !== undefined && findSecret(redactedUrl) === undefined) return redactedUrl;
  const dsn = redactDsn(core);
  if (dsn !== undefined && findSecret(dsn) === undefined) return dsn;
  return findSecret(core) === undefined ? core : REDACTED;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * The program a word starts, when it is one of {@link PASSWORD_PROGRAMS}: its file name, without
 * a directory, `.exe` or the `Bash(` of a permission rule.
 */
function passwordProgram(core: string): PasswordOptions | undefined {
  let name = core;
  const paren = name.indexOf('(');
  if (paren >= 0) name = name.slice(paren + 1);
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  return PASSWORD_PROGRAMS.get(name);
}

/**
 * Where a command is in the options of a password-taking program ({@link PASSWORD_PROGRAMS}):
 * which program, and whether the next word is its password or another option's value.
 */
interface ProgramState {
  options: PasswordOptions | undefined;
  next: 'password' | 'value' | undefined;
}

/**
 * What `core`, one word or argument, shows as in the options of the program `state` tracks:
 * `…` for a password, `-p…` for an option with a password attached, undefined for anything
 * else. Moves the state on.
 */
function programWord(core: string, state: ProgramState): string | undefined {
  const { options, next } = state;
  state.next = undefined;
  if (options === undefined) {
    state.options = passwordProgram(core);
    return undefined;
  }
  if (next === 'password') return REDACTED;
  if (next === 'value') return undefined;
  if (core.startsWith('-') && core.length > 1) {
    if (options.separate.has(core)) {
      state.next = 'password';
      return undefined;
    }
    if (options.withValue.has(core)) {
      state.next = 'value';
      return undefined;
    }
    for (const option of options.attached) {
      if (core.length > option.length && core.startsWith(option)) return `${option}${REDACTED}`;
    }
    return undefined;
  }
  // sshpass runs the rest as a command, which may take a password of its own; another password
  // program named as an operand, as in `docker exec db mysql`, takes over too.
  const program = passwordProgram(core);
  if (options.optionsEndAtOperand || program !== undefined) state.options = program;
  return undefined;
}

/**
 * True when a new simple command starts after `word`: after `;`, `&&`, `|` and the like, and
 * after the `)` or `,` that ends a tool rule in `Bash(mysql -ppw *), Bash(ssh -p 22 *)`.
 */
function endsCommand(word: string): boolean {
  return SEPARATORS.has(word) || /[&),;|]$/.test(word);
}

function redactWords(command: string, mode: UrlMode): string {
  let out = '';
  let previous = '';
  const state: ProgramState = { options: undefined, next: undefined };
  let i = 0;
  while (i < command.length) {
    const start = i;
    while (i < command.length && isSpace(command.charAt(i))) i++;
    out += command.slice(start, i);
    const wordStart = i;
    while (i < command.length && !isSpace(command.charAt(i))) i++;
    if (i === wordStart) break;
    const word = command.slice(wordStart, i);
    const { lead, core, trail } = parts(word);
    const password = programWord(core, state);
    if (password !== undefined) out += `${lead}${password}${trail}`;
    else out += redactWord(word, previous !== '' && redactsNext(previous), mode);
    if (endsCommand(word)) {
      state.options = undefined;
      state.next = undefined;
    }
    previous = word;
  }
  return out;
}

/**
 * A command line with credentials removed. Words are split at whitespace and the whitespace is
 * kept, so the result reads like the original.
 */
export function redactCommand(command: string): string {
  return redactWords(command, 'origin');
}

/**
 * A permission value, such as `Bash(curl -H "Authorization: Bearer abc" *)`, with credentials
 * removed as from a command line, except that a URL keeps its path and query and loses only its
 * user name, password and credential-like query values: two rules for two paths stay two rules.
 */
export function redactPermission(value: string): string {
  return redactWords(value, 'credentials');
}

/**
 * A command line, URL or other value with only its credentials removed, as from a permission
 * value ({@link redactPermission}): everything else, URL paths and the words around a
 * credential included, stays as written. Digests are built from this form, so they change with
 * anything but a credential (docs/adr/0017).
 */
export function withoutCredentials(text: string): string {
  return redactWords(text, 'credentials');
}

/** At most this many vendor tokens are masked in one value. */
const MAX_MASKED = 64;

/**
 * A value with credentials of a known vendor format masked where they stand, so the words around
 * them stay readable, then redacted as a permission value ({@link redactPermission}): a value
 * agentcheckup shows as written, such as a permission or a model setting, never carries one.
 */
export function redactShown(text: string): string {
  let out = text;
  for (let round = 0; round < MAX_MASKED; round++) {
    const secret = findSecret(out);
    if (secret === undefined) break;
    out = `${out.slice(0, secret.start)}${REDACTED}${out.slice(secret.start + secret.length)}`;
  }
  return redactPermission(out);
}

/**
 * A line of any file with the user name and password of each URL in it removed, and the values
 * of its credential-like query parameters: what a fix diff masks in every line it shows.
 */
export function maskUrlCredentials(line: string): string {
  if (!line.includes('://')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const start = i;
    while (i < line.length && isSpace(line.charAt(i))) i++;
    out += line.slice(start, i);
    const wordStart = i;
    while (i < line.length && !isSpace(line.charAt(i))) i++;
    const word = line.slice(wordStart, i);
    const { lead, core, trail } = parts(word);
    const masked = core.includes('://') ? redactUrlCredentialsIn(core) : undefined;
    out += masked === undefined ? word : `${lead}${masked}${trail}`;
  }
  return out;
}

function redactArgList(
  args: readonly string[],
  mode: UrlMode,
  program: string | undefined,
): string[] {
  const state: ProgramState = {
    options: program === undefined ? undefined : passwordProgram(parts(program.trim()).core),
    next: undefined,
  };
  return args.map((arg, index) => {
    const previous = index > 0 ? (args[index - 1] ?? '') : '';
    const password = programWord(arg.trim(), state);
    if (password !== undefined) return password;
    if (previous !== '' && redactsNext(lastWord(previous))) return REDACTED;
    return redactWords(arg, mode);
  });
}

/**
 * Arguments with credentials removed; the value after a credential flag becomes `…`. `program`,
 * the command the arguments are passed to, tells the password options of {@link
 * PASSWORD_PROGRAMS} apart: `-p` is sshpass's password and ssh's port.
 */
export function redactArgs(args: readonly string[], program?: string): string[] {
  return redactArgList(args, 'origin', program);
}

/** Arguments with only their credentials removed, as {@link withoutCredentials} does it. */
export function argsWithoutCredentials(args: readonly string[], program?: string): string[] {
  return redactArgList(args, 'credentials', program);
}

/** The last whitespace-separated word of an argument, `Authorization:` in `-H Authorization:`. */
function lastWord(arg: string): string {
  const trimmed = arg.trimEnd();
  let start = trimmed.length;
  while (start > 0 && !isSpace(trimmed.charAt(start - 1))) start--;
  return trimmed.slice(start);
}
