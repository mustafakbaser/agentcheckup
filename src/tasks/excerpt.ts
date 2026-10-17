/**
 * Excerpts for tasks: the least of the file an agent needs to see in the prompt. Two kinds:
 *
 * - A frontmatter value (`description`, `allowed-tools`), cut to {@link MAX_VALUE_LINES} lines
 *   and {@link MAX_VALUE_CHARS} code points.
 * - The body's heading outline with line counts, for skill/body-too-long: headings only, never
 *   the text under them.
 *
 * Never anything from JSON files: settings, MCP and hooks configuration stay out of prompts.
 * Credentials are redacted before cutting, so a cut never leaves part of one behind, and control,
 * bidirectional and tag characters are rendered as `<U+XXXX>`. The agent opens the file itself
 * for the rest; the excerpt saves it a read and shows what the task is about.
 */
import type { Heading, Nodes } from 'mdast';
import { lineCount } from '../core/measure.js';
import { positionAt } from '../core/text.js';
import type { Artifact, ParseServices } from '../core/types.js';
import type { FrontmatterResult } from '../parse/types.js';
import { JSON_KINDS, TOML_KINDS } from '../platforms/kinds.js';
import { forTerminal } from '../report/sanitize.js';
import { plural, truncate } from '../report/text.js';
import { redactSecrets } from './redact.js';
import type { ExcerptSpec } from './templates.js';
import type { TaskExcerpt } from './types.js';

export const MAX_VALUE_LINES = 20;
export const MAX_VALUE_CHARS = 1024;
/** Text redacted before cutting: far more than the cut keeps, far less than a file can hold. */
const MAX_SCANNED_CHARS = 16 * 1024;
/** Headings deeper than this are left out of the outline. */
const MAX_OUTLINE_DEPTH = 3;
export const MAX_OUTLINE_HEADINGS = 40;
const MAX_HEADING_CHARS = 100;

const LINE_BREAK = /\r\n|[\n\r]/;

export function excerptOf(
  artifact: Artifact,
  spec: ExcerptSpec,
  parse: ParseServices,
): TaskExcerpt | undefined {
  if (JSON_KINDS.has(artifact.kind) || TOML_KINDS.has(artifact.kind)) return undefined;
  const frontmatter = parse.frontmatter(artifact);
  switch (spec.kind) {
    case 'value':
      return valueExcerpt(artifact, frontmatter, spec.key);
    case 'outline':
      return outlineExcerpt(artifact, frontmatter, parse);
  }
}

function valueExcerpt(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  key: string,
): TaskExcerpt | undefined {
  if (frontmatter.kind !== 'valid' || !frontmatter.data.keys.includes(key)) return undefined;
  const value = frontmatter.data.values[key];
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    // A list or another type: the value as written, so the agent sees its YAML form.
    const span = frontmatter.data.valueSpan(key);
    if (span === undefined) return undefined;
    raw = artifact.decoded.text.slice(span.offset, span.offset + span.length);
  }
  const { text, redacted } = redactSecrets(truncate(raw, MAX_SCANNED_CHARS, ''));
  const lines = text.split(LINE_BREAK);
  const kept = lines.slice(0, MAX_VALUE_LINES).join('\n');
  const cut = truncate(kept, MAX_VALUE_CHARS, '');
  return {
    kind: 'value',
    text: forTerminal(cut, { multiline: true }),
    truncated: raw.length > MAX_SCANNED_CHARS || lines.length > MAX_VALUE_LINES || cut !== kept,
    redacted,
  };
}

/** The text of a heading: its text and code, without Markdown syntax. */
function headingText(heading: Heading): string {
  let out = '';
  const stack: Nodes[] = [...heading.children].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if ('value' in node && (node.type === 'text' || node.type === 'inlineCode')) out += node.value;
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
  return out.trim();
}

interface Section {
  readonly depth: number;
  readonly title: string;
  readonly line: number;
}

function outlineExcerpt(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  parse: ParseServices,
): TaskExcerpt | undefined {
  const document = parse.markdown(artifact);
  const sections: Section[] = [];
  for (const node of document.root.children) {
    const line = node.position?.start.line;
    if (node.type !== 'heading' || node.depth > MAX_OUTLINE_DEPTH || line === undefined) continue;
    sections.push({ depth: node.depth, title: headingText(node), line });
  }
  if (sections.length === 0) return undefined;

  const bodyOffset =
    frontmatter.kind === 'valid' || frontmatter.kind === 'invalid' ? frontmatter.bodyOffset : 0;
  const bodyLine = positionAt(artifact.decoded, bodyOffset).line;
  const lastLine = lineCount(artifact.decoded.text);
  const out: string[] = [];
  let redacted = false;
  const firstLine = sections[0]?.line ?? bodyLine;
  if (firstLine > bodyLine) {
    out.push(`(before the first heading: ${plural(firstLine - bodyLine, 'line')})`);
  }
  for (const [index, section] of sections.slice(0, MAX_OUTLINE_HEADINGS).entries()) {
    const next = sections.slice(index + 1).find((later) => later.depth <= section.depth);
    const end = next === undefined ? lastLine : next.line - 1;
    const title = redactSecrets(truncate(section.title, MAX_HEADING_CHARS));
    redacted ||= title.redacted;
    const size = plural(Math.max(1, end - section.line + 1), 'line');
    out.push(
      `${'#'.repeat(section.depth)} ${forTerminal(title.text)} (${size}, from line ${section.line})`,
    );
  }
  return {
    kind: 'outline',
    text: out.join('\n'),
    truncated: sections.length > MAX_OUTLINE_HEADINGS || !document.analysis.complete,
    redacted,
  };
}
