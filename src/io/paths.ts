import path, { type PlatformPath } from 'node:path';

/** POSIX path of `name` inside the root-relative directory `parent` (`''` is the root). */
export function joinRelative(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * Root-relative POSIX path of `absolutePath`, or undefined when it is not inside `realRoot`.
 *
 * `path.relative` is used instead of a string prefix test, which would treat `/repo-evil` as
 * inside `/repo`. On Windows a path on another drive or share has no relative form and comes back
 * absolute, which is also outside.
 */
export function relativeInsideRoot(
  realRoot: string,
  absolutePath: string,
  api: PlatformPath = path,
): string | undefined {
  const relative = api.relative(realRoot, absolutePath);
  if (relative === '') return '';
  if (api.isAbsolute(relative)) return undefined;
  if (relative === '..' || relative.startsWith(`..${api.sep}`)) return undefined;
  return api.sep === '/' ? relative : relative.split(api.sep).join('/');
}

/** Splits a path into components without normalizing it: `..` must be resolved physically. */
export function splitComponents(text: string, api: PlatformPath = path): string[] {
  // On POSIX a backslash is an ordinary file name character.
  return api.sep === '/' ? text.split('/') : text.split(/[/\\]/);
}

/**
 * For an absolute `target` that names `rootPath` or something below it, returns the components
 * after the root (unnormalized, possibly containing `..`). Returns undefined for anything else.
 *
 * Purely lexical, component by component: `/repo-evil` does not match `/repo`, and a `..` before
 * the root is fully matched is a mismatch. Empty and `.` components up to the first component
 * after the root are no-ops and dropped; later ones are kept (a trailing slash means "directory").
 * Comparison is case-sensitive on POSIX (including macOS), case-insensitive on Windows.
 */
export function stripRootPrefix(
  rootPath: string,
  target: string,
  api: PlatformPath = path,
): string[] | undefined {
  if (!sameComponent(api.parse(target).root, api.parse(rootPath).root, api)) return undefined;
  const rootParts = splitComponents(rootPath, api).filter(isNamedComponent);
  const targetParts = splitComponents(target, api);
  let matched = 0;
  for (const [index, part] of targetParts.entries()) {
    if (!isNamedComponent(part)) continue;
    if (matched === rootParts.length) return targetParts.slice(index);
    const expected = rootParts[matched];
    if (expected === undefined || !sameComponent(part, expected, api)) return undefined;
    matched += 1;
  }
  return matched === rootParts.length ? [] : undefined;
}

function isNamedComponent(part: string): boolean {
  return part !== '' && part !== '.';
}

function sameComponent(a: string, b: string, api: PlatformPath): boolean {
  if (api.sep === '/') return a === b;
  return a.replaceAll('/', '\\').toLowerCase() === b.replaceAll('/', '\\').toLowerCase();
}

const REPLACEMENT_CHARACTER = '�';

/**
 * Replaces control characters in text read from the scanned tree (symlink targets). That text is
 * attacker-controlled and ends up in terminal, SARIF and HTML output: C0/C1 controls could inject
 * ANSI escape sequences or forge extra output lines, and bidi controls could visually reorder it
 * ("Trojan Source"). Implemented as a code-unit scan: linear time, no control-character regex.
 */
export function sanitizeLinkText(text: string): string {
  let result = '';
  let clean = 0;
  for (let index = 0; index < text.length; index++) {
    if (!isUnsafeCodeUnit(text.charCodeAt(index))) continue;
    result += text.slice(clean, index) + REPLACEMENT_CHARACTER;
    clean = index + 1;
  }
  return clean === 0 ? text : result + text.slice(clean);
}

function isUnsafeCodeUnit(code: number): boolean {
  return (
    code <= 0x1f || // C0 controls, including ESC, CR and LF
    (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls (0x9b is a one-byte CSI)
    code === 0x061c || // Arabic letter mark
    code === 0x200e || // left-to-right mark
    code === 0x200f || // right-to-left mark
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings and overrides
    (code >= 0x2066 && code <= 0x2069) // bidi isolates
  );
}

/** The `code` of a Node.js system error (`ENOENT`, `EACCES`, ...), if any. */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
