/**
 * Text helpers shared by the task builder and the Markdown formatter: code spans that untrusted
 * text cannot break out of, and the agentcheckup commands a task names.
 */
import { TOOL_NAME } from '../core/meta.js';
import { forTerminal } from '../report/sanitize.js';

function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === char ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * `text` as a Markdown code span on one line: control, bidirectional and tag characters
 * rendered as `<U+XXXX>`, line breaks as `⏎`, delimited by more backticks than any run inside
 * (CommonMark 6.1), with a space inside the delimiters when the text starts or ends with one.
 */
export function codeSpan(text: string): string {
  const neutral = forTerminal(text);
  const fence = '`'.repeat(longestRun(neutral, '`') + 1);
  const pad = neutral.startsWith('`') || neutral.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${neutral}${pad}${fence}`;
}

/** A fence of tildes longer than any tilde run in `text`, and at least four. */
export function tildeFence(text: string): string {
  return '~'.repeat(Math.max(4, longestRun(text, '~') + 1));
}

/** Characters a path argument may hold without quoting. */
const PLAIN_ARGUMENT = /^[\w%+,./:=@~-]+$/;

/**
 * A directory as one shell word for a command line: as it is when it holds only plain
 * characters and does not start with `-`, otherwise in single quotes. `''` stays empty.
 */
export function shellWord(path: string): string {
  if (path === '') return '';
  if (PLAIN_ARGUMENT.test(path) && !path.startsWith('-') && !path.startsWith('~')) return path;
  const quoted = `'${path.replaceAll("'", "'\\''")}'`;
  return path.startsWith('-') ? `'./${quoted.slice(1)}` : quoted;
}

/**
 * `npx agentcheckup@<version> <command> [path] <args…>`: every command a task names is pinned to
 * the version that wrote it, so the agent runs the same rules.
 */
export function agentcheckupCommand(
  version: string,
  command: string,
  path: string,
  args: readonly string[] = [],
): string {
  return ['npx', `${TOOL_NAME}@${version}`, command, ...(path === '' ? [] : [path]), ...args].join(
    ' ',
  );
}
