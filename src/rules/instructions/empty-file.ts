import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ArtifactKind, ParseServices } from '../../core/types.js';
import { agentsMdBeside } from '../../platforms/load/codex-chain.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { isBlank } from './codex.js';
import { basename, targetedReaders } from './helpers.js';

/** Kinds whose frontmatter is metadata that the agent removes before loading the body. */
const FRONTMATTER_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'claude-rule',
  'windsurf-rule',
  'cline-rule',
]);

/** Kinds whose block-level HTML comments Claude Code strips before loading. */
const COMMENT_STRIPPED_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'claude-md',
  'claude-local-md',
]);

export const emptyFileRule = defineRule({
  meta: {
    id: 'instr/empty-file',
    title: 'Instruction file is empty',
    rationale: [
      'An instruction file with no content gives agents nothing to follow. Codex skips an empty or whitespace-only `AGENTS.md`. Claude Code strips block-level HTML comments from `CLAUDE.md` before loading it, so a `CLAUDE.md` with only comments is empty for Claude Code. A rule with frontmatter and no body adds no instructions.',
      'An empty file still has effects: an empty `CLAUDE.md` stops Claude Code from reading `AGENTS.md`. An empty `AGENTS.override.md` next to an `AGENTS.md` is reported by `instr/override-shadows-agents-md` instead.',
      'Add the instructions or delete the file.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: [
      'agents-md',
      'agents-override-md',
      'claude-md',
      'claude-local-md',
      'claude-rule',
      'gemini-md',
      'windsurf-rule',
      'windsurf-legacy-rules',
      'cline-rule',
      'cursor-legacy-rules',
      'copilot-instructions',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [SOURCES.codexAgentsMd, SOURCES.codexAgentsMdSource, SOURCES.claudeMemory],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platforms = targetedReaders(context, artifact);
      if (platforms.length === 0) continue;
      // instr/override-shadows-agents-md reports an empty override next to AGENTS.md.
      if (
        artifact.kind === 'agents-override-md' &&
        agentsMdBeside(context.snapshot, artifact.path) !== undefined
      ) {
        continue;
      }
      const empty = emptiness(context, artifact);
      if (empty === undefined) continue;
      // Only Claude Code is documented to strip the comments; other readers get them.
      const reported = empty.claudeOnly
        ? platforms.filter((platform) => platform === 'claude-code')
        : platforms;
      if (reported.length > 0) {
        context.report({
          artifact,
          platforms: reported,
          message: empty.message,
          guidance: guidanceFor(artifact),
        });
      }
    }
  },
});

/** The manual step: only the author knows what the file should say, and fixes never delete. */
function guidanceFor(artifact: Artifact): string {
  if (COMMENT_STRIPPED_KINDS.has(artifact.kind)) {
    return 'add instructions or delete the file; even an empty CLAUDE file stops Claude Code from reading AGENTS.md';
  }
  if (FRONTMATTER_KINDS.has(artifact.kind)) return 'add the rule text, or delete the file';
  return 'add instructions or delete the file';
}

interface Emptiness {
  readonly message: string;
  /** Empty only after Claude Code strips block HTML comments. */
  readonly claudeOnly: boolean;
}

function emptiness(context: ParseServices, artifact: Artifact): Emptiness | undefined {
  const { text } = artifact.decoded;
  const all = (message: string): Emptiness => ({ message, claudeOnly: false });
  if (text.length === 0) return all('This file is empty, so agents get no instructions from it.');
  if (isBlank(text)) {
    return all('This file contains only whitespace, so agents get no instructions from it.');
  }

  if (FRONTMATTER_KINDS.has(artifact.kind)) {
    const frontmatter = context.frontmatter(artifact);
    if (frontmatter.kind === 'valid' && isBlank(text.slice(frontmatter.bodyOffset))) {
      return all(
        'This rule has frontmatter but no body, so it adds no instructions when it loads.',
      );
    }
  }

  if (COMMENT_STRIPPED_KINDS.has(artifact.kind)) {
    const comments = context.markdown(artifact).htmlComments;
    if (comments.length > 0) {
      let rest = '';
      let cursor = 0;
      for (const comment of comments) {
        rest += text.slice(cursor, comment.span.offset);
        cursor = Math.max(cursor, comment.span.offset + comment.span.length);
      }
      rest += text.slice(cursor);
      if (isBlank(rest)) {
        return {
          message: `This ${basename(artifact.path)} contains only HTML comments, which Claude Code strips before loading, so Claude Code gets no instructions from it.`,
          claudeOnly: true,
        };
      }
    }
  }
  return undefined;
}
