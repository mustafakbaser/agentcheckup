/**
 * Credential redaction for task output, with mcp/literal-secret's detector, in the form the fix
 * diff uses: the first four characters and the length, `ghp_…(40 chars)`. Applied to every
 * string from a rule or the repository (paths, messages, hints, excerpts) before it reaches a
 * prompt, so a task never hands a credential to an agent.
 */
import { formatInteger } from '../core/format.js';
import { findSecret } from '../rules/mcp/secrets.js';

/** Characters of a credential kept in front of the ellipsis, for credentials of 16 or more. */
const SECRET_PREFIX = 4;
const MIN_PREFIXED_SECRET = 16;
/** Matches redacted per string. */
const MAX_DETECTED = 1000;

export interface Redacted {
  readonly text: string;
  /** True when at least one credential was replaced. */
  readonly redacted: boolean;
}

function placeholder(token: string): string {
  const prefix = token.length >= MIN_PREFIXED_SECRET ? token.slice(0, SECRET_PREFIX) : '';
  return `${prefix}…(${formatInteger(token.length)} chars)`;
}

export function redactSecrets(text: string): Redacted {
  let rest = text;
  let out = '';
  let found = 0;
  for (; found < MAX_DETECTED; found++) {
    const match = findSecret(rest);
    if (match === undefined) break;
    const end = match.start + match.length;
    out += `${rest.slice(0, match.start)}${placeholder(rest.slice(match.start, end))}`;
    rest = rest.slice(end);
  }
  return { text: out + rest, redacted: found > 0 };
}

/** {@link redactSecrets}, text only. */
export function redacted(text: string): string {
  return redactSecrets(text).text;
}
