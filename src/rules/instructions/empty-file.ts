import { compareStrings } from '../../core/compare.js';
import { RULESET_VERSION } from '../../core/meta.js';
import type {
  Artifact,
  ArtifactKind,
  ParseServices,
  PlatformId,
  RuleContext,
} from '../../core/types.js';
import { clinePlace, isClineRuleOrWorkflow } from '../../platforms/cline-rules.js';
import { clineBodyBlank } from '../../platforms/cline-skills.js';
import { EMPTY_FILE_KINDS } from '../../platforms/kinds.js';
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
      'Cline reads every Markdown file in `.clinerules/`, `.cline/rules/` and their `workflows/` folders as a rule or workflow, whatever its name, and drops one that is blank after its frontmatter. It removes the frontmatter of an `AGENTS.md` too, so an `AGENTS.md` with only frontmatter is empty for Cline.',
      'An empty file still has effects: an empty `CLAUDE.md` stops Claude Code from reading `AGENTS.md`. An empty `AGENTS.override.md` next to an `AGENTS.md` is reported by `instr/override-shadows-agents-md` instead.',
      'Add the instructions or delete the file.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: [...EMPTY_FILE_KINDS],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [
      SOURCES.codexAgentsMd,
      SOURCES.codexAgentsMdSource,
      SOURCES.claudeMemory,
      SOURCES.clineRules,
      SOURCES.clineInstructionLoaderSource,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      // Cline reads a file in its rules or workflows folders as a rule or workflow.
      const clineRule = [artifact.path, ...artifact.aliases].some(isClineRuleOrWorkflow);
      let platforms = readersOf(context, artifact, clineRule);
      // instr/override-shadows-agents-md reports an empty override next to AGENTS.md; Cline
      // reads one in its rules folder as a rule of its own.
      if (
        artifact.kind === 'agents-override-md' &&
        agentsMdBeside(context.snapshot, artifact.path) !== undefined
      ) {
        platforms = clineRule ? platforms.filter((platform) => platform === 'cline') : [];
      }
      if (platforms.length === 0) continue;
      const empty = emptiness(context, artifact);
      if (empty !== undefined) {
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
        continue;
      }
      // Cline removes the frontmatter of a rule, a workflow or an AGENTS.md before loading it.
      if (
        platforms.includes('cline') &&
        (clineRule || artifact.kind === 'agents-md') &&
        clineBodyBlank(artifact.decoded.text, context.frontmatter(artifact))
      ) {
        context.report({
          artifact,
          platforms: ['cline'],
          message:
            'This file has frontmatter but no body. Cline removes the frontmatter before loading it, so it gets no instructions from it.',
          guidance: 'add the instructions after the frontmatter, or delete the file',
        });
      }
    }
  },
});

/**
 * The targeted platforms that read the file, with Cline as Cline sees it: a reader of every file
 * in its rules or workflows folders, and of no AGENTS.md or other instruction file in its skills,
 * hooks, agents or plugins folders.
 */
function readersOf(
  context: Pick<RuleContext<unknown>, 'targets' | 'allArtifacts' | 'json'>,
  artifact: Artifact,
  clineRule: boolean,
): PlatformId[] {
  const readers = targetedReaders(context, artifact);
  if (!context.targets.has('cline')) return readers;
  if (clineRule) {
    return readers.includes('cline')
      ? readers
      : [...readers, 'cline' as const].sort(compareStrings);
  }
  if (clinePlace(artifact.path) === undefined) return readers;
  return readers.filter((platform) => platform !== 'cline');
}

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
