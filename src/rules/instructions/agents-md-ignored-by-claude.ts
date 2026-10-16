import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, pathStatus } from '../../core/paths.js';
import type { ReportDescriptor, RuleContext } from '../../core/types.js';
import { createFile, insertLine } from '../../fix/edits.js';
import { pathProblem } from '../../fix/paths.js';
import {
  agentsMdShadowedByClaude,
  type ShadowedAgentsMd,
} from '../../platforms/load/agents-md-shadow.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { byHand, editBlocker, lineIndexOfOffset } from './fixes.js';
import { basename, joinPath, relativePath } from './helpers.js';
import { ImportGraph } from './import-graph.js';
import { materialized } from './symlink-materialized.js';

const RULE_ID = 'instr/agents-md-ignored-by-claude';

/** Unverified: GitHub Copilot CLI reads both files, so it may see AGENTS.md twice. */
const COPILOT_NOTE =
  'GitHub Copilot CLI also reads CLAUDE.md, so it may load AGENTS.md twice after this change (not verified).';

type Context = Pick<RuleContext<undefined>, 'frontmatter' | 'snapshot' | 'targets'>;
type Repair = Pick<ReportDescriptor, 'fix' | 'guidance'>;

function notes(context: Context, ...first: string[]): string[] {
  return context.targets.has('copilot') ? [...first, COPILOT_NOTE] : first;
}

/**
 * The CLAUDE.md or .claude/CLAUDE.md in the AGENTS.md's own directory gets the import as its
 * first line, after frontmatter if it has any, as in the example of Claude Code's memory
 * documentation: "@AGENTS.md", an empty line, then the Claude-specific instructions. Imports
 * resolve from the importing file, so .claude/CLAUDE.md imports "@../AGENTS.md".
 */
function importIntoClaudeFile(context: Context, shadowed: ShadowedAgentsMd): Repair {
  const { artifact, nearest } = shadowed;
  const claude = nearest.artifact;
  const line = `@${relativePath(dirnamePosix(nearest.path), artifact.path)}`;
  const action = `add the line "${line}" at the top of ${quotePath(nearest.path)}`;
  const blocker =
    claude.path === nearest.path
      ? editBlocker(claude)
      : `${quotePath(nearest.path)} is a symbolic link to ${quotePath(claude.path)}`;
  if (blocker !== undefined) return { guidance: byHand(action, blocker) };
  if (materialized(context.snapshot, claude) !== undefined) {
    // instr/symlink-materialized replaces the path with the import; adding one would repeat it.
    return {
      guidance: `replace the path in ${quotePath(nearest.path)} with the line "${line}" (see instr/symlink-materialized)`,
    };
  }
  const frontmatter = context.frontmatter(claude);
  let index: number | undefined = 0;
  if (frontmatter.kind === 'valid' || frontmatter.kind === 'invalid') {
    index = lineIndexOfOffset(claude, frontmatter.bodyOffset);
  } else if (frontmatter.kind !== 'absent') {
    index = undefined;
  }
  if (index === undefined) return { guidance: action };
  return {
    fix: {
      id: `${RULE_ID}#import`,
      class: 'safe',
      title: `Add "${line}" as line ${index + 1} of ${claude.path}`,
      changes: [insertLine(claude, index, line, { blankAfter: true })],
      notes: notes(context),
    },
  };
}

/**
 * A new CLAUDE.md in the AGENTS.md's directory that imports it: when the CLAUDE file Claude
 * Code reads instead is in a parent directory, or is a CLAUDE.local.md, which is personal and
 * never edited.
 */
function createClaudeFile(
  context: Context,
  shadowed: ShadowedAgentsMd,
  folded: () => ReadonlySet<string>,
): Repair {
  const { artifact, directory, nearest } = shadowed;
  const target = joinPath(directory, 'CLAUDE.md');
  const line = `@${relativePath(directory, artifact.path)}`;
  const action = `create ${quotePath(target)} with the line "${line}"`;
  if (pathProblem(target) !== undefined) return { guidance: action };
  if (pathStatus(context.snapshot, target) !== 'missing' || folded().has(target.toLowerCase())) {
    return { guidance: `add the line "${line}" to ${quotePath(target)}` };
  }
  const effects =
    basename(nearest.path) !== 'CLAUDE.local.md'
      ? [
          `Claude Code loads the new file, and AGENTS.md through it, when it works with files in ${directory}.`,
        ]
      : [
          `${nearest.path} stays as it is. Commit the new file, so that Claude Code reads AGENTS.md through the import for everyone.`,
          // Once a CLAUDE.md is on the path, Claude Code no longer reads AGENTS.md files directly.
          ...(directory === ''
            ? []
            : [
                `In sessions started in ${directory}, an AGENTS.md in a parent directory then loads only if a CLAUDE.md imports it.`,
              ]),
        ];
  return {
    fix: {
      id: `${RULE_ID}#create`,
      class: 'review',
      title: `Create ${target} with the line "${line}"`,
      changes: [createFile(target, `${line}\n`)],
      notes: notes(context, ...effects),
    },
  };
}

export const agentsMdIgnoredByClaudeRule = defineRule({
  meta: {
    id: RULE_ID,
    title: 'Claude Code skips AGENTS.md because a CLAUDE.md exists',
    rationale: [
      'By default, Claude Code (v2.1.277 and later) reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or any directory above it. Otherwise it reads only the `CLAUDE.md` files, so the instructions that Codex, Cursor and GitHub Copilot get from `AGENTS.md` never reach Claude Code.',
      'agentcheckup assumes the default **Project instructions** setting, `claude-md-or-agents-md`. It does not report an `AGENTS.md` that a `CLAUDE.md` or `.claude/rules/` file imports, symlinks or copies; one inside a skill, a template, example or fixture directory, or a directory whose name starts with a dot, such as `.github/`; or one whose status depends on a file agentcheckup did not read, such as a gitignored `CLAUDE.local.md`.',
      'Add the line `@AGENTS.md` to the `CLAUDE.md`; Claude Code never reads an imported `AGENTS.md` twice. If you keep separate files on purpose, suppress the finding with a reason.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['agents-md'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeMemory],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe', 'review'],
      summary:
        'Adds "@AGENTS.md" as the first line of the CLAUDE.md in the same directory (safe), or creates a CLAUDE.md with that line when the CLAUDE file Claude Code reads instead is in a parent directory or is a CLAUDE.local.md (review).',
    },
  },
  defaultOptions: undefined,
  check(context) {
    const graph = new ImportGraph(context);
    let folded: Set<string> | undefined;
    const foldedPaths = (): ReadonlySet<string> => {
      folded ??= new Set(
        [...context.snapshot.paths, ...context.snapshot.ignoredFiles].map((path) =>
          path.toLowerCase(),
        ),
      );
      return folded;
    };
    for (const shadowed of agentsMdShadowedByClaude(graph, context.artifacts)) {
      const { artifact, directory, nearest } = shadowed;
      const nearestDirectory = dirnamePosix(nearest.path);
      const sameDirectory =
        nearestDirectory === directory || nearestDirectory === joinPath(directory, '.claude');
      const message = sameDirectory
        ? `Claude Code reads ${quotePath(relativePath(directory, nearest.path))} in this directory and skips this AGENTS.md. Add the line ${quotePath(`@${relativePath(nearestDirectory, artifact.path)}`)} to that file so Claude Code reads both.`
        : `Claude Code reads ${quotePath(nearest.path)} from a parent directory and skips this AGENTS.md. To have Claude Code read it, add a CLAUDE.md in this directory with the line ${quotePath(`@${relativePath(directory, artifact.path)}`)}.`;
      const repair =
        sameDirectory && basename(nearest.path) !== 'CLAUDE.local.md'
          ? importIntoClaudeFile(context, shadowed)
          : createClaudeFile(context, shadowed, foldedPaths);
      context.report({
        artifact,
        message,
        related: [
          { path: nearest.path, message: 'Claude Code reads this file instead of AGENTS.md.' },
        ],
        ...repair,
      });
    }
  },
});
