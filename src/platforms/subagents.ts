/**
 * Whether Claude Code loads a subagent definition from `.claude/agents/`
 * (code.claude.com/docs/en/sub-agents). Shared by instr/subagent-invalid and the Claude Code
 * loader, so the rule reports exactly the files the load plan skips.
 *
 * Claude Code loads a subagent only when YAML frontmatter on the first line has a `name` and a
 * `description`. A file without a `name`, or whose frontmatter does not start on line 1, is
 * documentation. A `name` that starts with `-`, contains `:` or is longer than 256 characters, a
 * missing `description`, and YAML that does not parse make it skip the file.
 */
import { codePointLength } from '../core/measure.js';
import type { Span } from '../core/types.js';
import { parseFrontmatter } from '../parse/frontmatter.js';
import type { FrontmatterData, FrontmatterResult, ParseIssue } from '../parse/types.js';
import { yamlSyntaxError } from './yaml.js';

/** Supported subagent fields other than `name` (code.claude.com/docs/en/sub-agents). */
const AGENT_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'autoCompactWindow',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'omitClaudeMd',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
  'experimental',
]);

/** Longest subagent name Claude Code accepts, in characters. */
export const MAX_SUBAGENT_NAME_LENGTH = 256;

const OPENING_DELIMITER: Span = { offset: 0, length: 3 };

/** Why Claude Code skips a subagent file. Every issue carries the span a finding points at. */
export type SubagentIssue =
  /** Valid frontmatter that starts after blank lines instead of on line 1. */
  | { readonly code: 'misplaced-frontmatter'; readonly span: Span }
  | { readonly code: 'unclosed-frontmatter'; readonly span: Span }
  /** Frontmatter in another format than YAML. */
  | { readonly code: 'unsupported-frontmatter'; readonly span: Span }
  | { readonly code: 'invalid-yaml'; readonly span: Span; readonly error: ParseIssue }
  | { readonly code: 'name-missing' | 'name-empty'; readonly span: Span }
  | {
      readonly code: 'name-leading-dash' | 'name-colon';
      readonly span: Span;
      readonly name: string;
    }
  | { readonly code: 'name-too-long'; readonly span: Span; readonly length: number }
  | { readonly code: 'description-missing' | 'description-empty'; readonly span: Span };

/**
 * - `documentation`: no frontmatter, or frontmatter without any subagent field. Claude Code does
 *   not treat the file as a subagent, and says nothing.
 * - `skipped`: meant as a subagent, but Claude Code skips it for `issues`.
 * - `unknown`: YAML that lenient readers may accept, or that hit agentcheckup's parser limits.
 * - `loads`: Claude Code loads the subagent.
 */
export type SubagentCheck =
  | { readonly status: 'documentation' }
  | { readonly status: 'skipped'; readonly issues: readonly SubagentIssue[] }
  | { readonly status: 'unknown' }
  | {
      readonly status: 'loads';
      readonly name: string;
      readonly description: string;
      /** Offset of the body: the subagent's system prompt. */
      readonly bodyOffset: number;
    };

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * A frontmatter block that starts after leading blank lines instead of on line 1. Claude Code
 * reads such a file as having no frontmatter. Returns the offset of the `---` line when the
 * block parses and declares a name or description, so it was clearly meant for Claude Code.
 */
function misplacedFrontmatter(text: string): number | undefined {
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    if (text.slice(offset, end).trim() !== '') break;
    if (newline === -1) return undefined;
    offset = newline + 1;
  }
  if (offset === 0 || !text.startsWith('---', offset)) return undefined;
  const block = parseFrontmatter(text.slice(offset));
  if (block.kind !== 'valid') return undefined;
  const { values } = block.data;
  return isMissing(values['name']) && isMissing(values['description']) ? undefined : offset;
}

function fieldIssues(data: FrontmatterData): SubagentIssue[] | undefined {
  const { values } = data;
  const name = values['name'];
  if (isMissing(name)) {
    // Frontmatter with no subagent fields at all is documentation, which Claude Code allows.
    if (!data.keys.some((key) => AGENT_FIELDS.has(key))) return undefined;
    return [
      {
        code: Object.hasOwn(values, 'name') ? 'name-empty' : 'name-missing',
        span: data.keySpan('name') ?? OPENING_DELIMITER,
      },
    ];
  }

  const issues: SubagentIssue[] = [];
  if (typeof name === 'string') {
    const span = data.valueSpan('name') ?? OPENING_DELIMITER;
    const length = codePointLength(name);
    if (name.startsWith('-')) {
      issues.push({ code: 'name-leading-dash', span, name });
    } else if (name.includes(':')) {
      issues.push({ code: 'name-colon', span, name });
    } else if (length > MAX_SUBAGENT_NAME_LENGTH) {
      issues.push({ code: 'name-too-long', span, length });
    }
  }

  if (isMissing(values['description'])) {
    const hasKey = Object.hasOwn(values, 'description');
    issues.push({
      code: hasKey ? 'description-empty' : 'description-missing',
      span: (hasKey ? data.keySpan('description') : data.keySpan('name')) ?? OPENING_DELIMITER,
    });
  }
  return issues;
}

/** A name or description that is present: strings as written, other values as JSON. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** What Claude Code does with the subagent file `text`, whose frontmatter is `frontmatter`. */
export function checkSubagent(text: string, frontmatter: FrontmatterResult): SubagentCheck {
  switch (frontmatter.kind) {
    case 'absent': {
      const offset = misplacedFrontmatter(text);
      if (offset === undefined) return { status: 'documentation' };
      return {
        status: 'skipped',
        issues: [{ code: 'misplaced-frontmatter', span: { offset, length: 3 } }],
      };
    }
    case 'unclosed':
      return {
        status: 'skipped',
        issues: [{ code: 'unclosed-frontmatter', span: frontmatter.openSpan }],
      };
    case 'unsupported':
      return {
        status: 'skipped',
        issues: [{ code: 'unsupported-frontmatter', span: frontmatter.span }],
      };
    case 'invalid': {
      const error = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
      if (error === undefined) return { status: 'unknown' };
      return { status: 'skipped', issues: [{ code: 'invalid-yaml', span: error.span, error }] };
    }
    case 'valid': {
      const issues = fieldIssues(frontmatter.data);
      if (issues === undefined) return { status: 'documentation' };
      if (issues.length > 0) return { status: 'skipped', issues };
      const { values } = frontmatter.data;
      return {
        status: 'loads',
        name: asText(values['name']),
        description: asText(values['description']),
        bodyOffset: frontmatter.bodyOffset,
      };
    }
  }
}
