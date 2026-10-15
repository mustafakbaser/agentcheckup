import type { Nodes } from 'mdast';
import { DIRECTIVE_PREFIX, RULESET_VERSION } from '../../core/meta.js';
import { type ArtifactKind, PLATFORM_IDS, type PlatformId, type Span } from '../../core/types.js';
import { MARKDOWN_OR_IMPORTED_KINDS } from '../../platforms/kinds.js';
import type { MarkdownDocument } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { joinNames, platformName, quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isEnglishProse } from './english.js';
import { looksLikeAgentInstruction } from './instruction-signals.js';
import { RISK_SOURCES } from './sources.js';

/** Comments shorter than this (after collapsing whitespace) are maintainer notes, not instructions. */
export const MIN_COMMENT_LENGTH = 40;
/** Only the start of a very long comment is analyzed. */
const ANALYZED_LENGTH = 4000;

/** Kinds whose block-level HTML comments Claude Code documents as stripped. */
const CLAUDE_STRIPS: ReadonlySet<ArtifactKind> = new Set(['claude-md', 'claude-local-md']);

/** Parents whose `html` children are block-level (flow) rather than inline (phrasing). */
const FLOW_PARENTS: ReadonlySet<string> = new Set([
  'root',
  'blockquote',
  'listItem',
  'footnoteDefinition',
]);

/** Spans of block-level HTML nodes, in document order. Iterative, so deep trees are safe. */
function blockHtmlSpans(doc: MarkdownDocument): Span[] {
  const spans: Span[] = [];
  const stack: Nodes[] = [doc.root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (!('children' in node)) continue;
    const flow = FLOW_PARENTS.has(node.type);
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child === undefined) continue;
      if (child.type === 'html' && flow) {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start !== undefined && end !== undefined)
          spans.push({ offset: start, length: end - start });
      }
      stack.push(child);
    }
  }
  return spans.sort((a, b) => a.offset - b.offset);
}

function isInside(spans: readonly Span[], offset: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const span = spans[mid];
    if (span === undefined) return false;
    if (offset < span.offset) high = mid - 1;
    else if (offset >= span.offset + span.length) low = mid + 1;
    else return true;
  }
  return false;
}

function collapse(text: string): string {
  let out = '';
  let space = false;
  for (const char of text) {
    const blank = char === ' ' || char === '\t' || char === '\n' || char === '\r';
    if (blank) {
      space = out !== '';
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += char;
  }
  return out;
}

export const hiddenCommentRule = defineRule({
  meta: {
    id: 'risk/hidden-comment',
    title: 'HTML comment hides instructions for the agent from human readers',
    rationale: [
      'An HTML comment does not show in rendered Markdown, on GitHub or in most editors, but it is still part of the file. Codex passes `AGENTS.md` to the model as written, comments included, and the other agents do not document removing comments; only Claude Code documents removing block-level HTML comments, from `CLAUDE.md`. Instructions in a comment therefore reach the agent while a reviewer of the rendered file never sees them.',
      'This rule reports comments that read as instructions for an AI agent: they address the agent ("Note for AI agents: …"), try to override its instructions ("ignore all previous instructions"), or ask it to hide something from the user. Short comments, agentcheckup directives and text that is not English prose are not reported. Files that an instruction file imports with `@path` are checked too, because the agent loads them with the file that imports them.',
      'Move instructions you intend into visible text, or delete them.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'info',
    appliesTo: [...MARKDOWN_OR_IMPORTED_KINDS],
    platforms: PLATFORM_IDS,
    sources: [
      SOURCES.claudeMemory,
      SOURCES.codexAgentsMdSource,
      SOURCES.agentsMd,
      RISK_SOURCES.cursorRulesComments,
      RISK_SOURCES.copilotInstructionsComments,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    const directive = `${DIRECTIVE_PREFIX}-`;
    for (const artifact of context.artifacts) {
      const doc = context.markdown(artifact);
      if (doc.htmlComments.length === 0) continue;
      let blocks: Span[] | undefined;

      for (const comment of doc.htmlComments) {
        const body = collapse(comment.value.slice(0, ANALYZED_LENGTH));
        if (body.length < MIN_COMMENT_LENGTH || body.startsWith(directive)) continue;
        if (!isEnglishProse(body) || !looksLikeAgentInstruction(body)) continue;

        blocks ??= blockHtmlSpans(doc);
        const block = isInside(blocks, comment.span.offset);
        // Claude Code documents stripping block-level comments from CLAUDE.md files only.
        const strips = block && CLAUDE_STRIPS.has(artifact.kind);
        const readers = artifact.readers.filter(
          (platform: PlatformId) =>
            context.targets.has(platform) && !(platform === 'claude-code' && strips),
        );
        if (readers.length === 0) continue;

        const names = joinNames(readers.map(platformName));
        const verb = readers.length === 1 ? 'reads' : 'read';
        const who =
          strips && artifact.readers.includes('claude-code')
            ? `Claude Code removes it, but ${names} ${verb} this file, comment included.`
            : `${names} ${verb} this file, comment included.`;
        context.report({
          artifact,
          span: comment.span,
          message: `HTML comment hides instructions for the agent from rendered Markdown: ${quote(body)}. ${who}`,
          platforms: readers,
        });
      }
    }
  },
});
