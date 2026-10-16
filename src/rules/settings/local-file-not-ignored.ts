import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact } from '../../core/types.js';
import { defineRule } from '../define.js';
import { shellSafePath } from '../json/fix-support.js';
import { SOURCES } from '../sources.js';

interface InstructionDirectories {
  /** Directories that hold an AGENTS.md. */
  readonly agentsMd: ReadonlySet<string>;
  /** Directories whose CLAUDE.md or .claude/CLAUDE.md applies to them and everything below. */
  readonly claudeMd: ReadonlySet<string>;
}

/** One pass over the artifacts, so the rule stays linear in their number. */
function instructionDirectories(all: readonly Artifact[]): InstructionDirectories {
  const agentsMd = new Set<string>();
  const claudeMd = new Set<string>();
  for (const artifact of all) {
    if (artifact.kind === 'agents-md') agentsMd.add(dirnamePosix(artifact.path));
    if (artifact.kind !== 'claude-md') continue;
    let owner = dirnamePosix(artifact.path);
    if (owner === '.claude' || owner.endsWith('/.claude')) owner = dirnamePosix(owner);
    claudeMd.add(owner);
  }
  return { agentsMd, claudeMd };
}

/** Whether Claude Code would read AGENTS.md in `directory` if CLAUDE.local.md were not there. */
function agentsMdDependsOnIt(directory: string, index: InstructionDirectories): boolean {
  if (!index.agentsMd.has(directory)) return false;
  // Any CLAUDE.md or .claude/CLAUDE.md in this directory or above already makes Claude Code skip it.
  for (let current = directory; ; current = dirnamePosix(current)) {
    if (index.claudeMd.has(current)) return false;
    if (current === '') return true;
  }
}

/**
 * The manual step. There is no fix: the walk does not read `.gitignore` files as text a fix
 * could edit, and a scan of the fixed copy in memory does not apply them, so a fix could never be
 * verified. agentcheckup never runs git, so the `git rm --cached` step is printed for the user;
 * only for a path a shell reads as one word, so the printed command cannot run anything else.
 */
function guidanceFor(path: string): string {
  const untrack = shellSafePath(path)
    ? `git rm --cached ${path}`
    : 'git rm --cached on the file (quote its path)';
  return `add the line "CLAUDE.local.md" to the root .gitignore (it matches the file in every directory); if git already tracks the file, also run ${untrack}`;
}

export const localFileNotIgnoredRule = defineRule({
  meta: {
    id: 'settings/local-file-not-ignored',
    title: 'CLAUDE.local.md is not gitignored',
    rationale: [
      "`CLAUDE.local.md` holds personal instructions for one project, such as sandbox URLs and test data, and Claude Code's documentation says to add it to `.gitignore`. Once committed, it loads for everyone who works in the project. In a directory that relies on `AGENTS.md`, it also stops Claude Code from reading `AGENTS.md` for everyone: by default Claude Code reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above.",
      'agentcheckup skips files that a `.gitignore` in the repository excludes, so a reported `CLAUDE.local.md` is not covered by one. It does not read `.git/info/exclude` or your global excludes file: those keep the file out of your clone only, while a `.gitignore` entry covers every clone. `.claude/settings.local.json` is not reported, because Claude Code adds it to your global git excludes when it creates the file.',
      'Add `CLAUDE.local.md` to `.gitignore`. If it is already committed, also run `git rm --cached CLAUDE.local.md`.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: ['claude-local-md'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeMemory, SOURCES.claudeSettings],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    // Presence only proves "not gitignored" when the walk applied .gitignore files.
    if (!context.snapshot.gitignoreApplied) return;
    const index = instructionDirectories(context.allArtifacts);
    for (const artifact of context.artifacts) {
      // Read although a .gitignore matches it: an untrusted scan does not let .gitignore hide
      // agent configuration.
      if (context.snapshot.gitignoredConfig?.has(artifact.path) === true) continue;
      const directory = dirnamePosix(artifact.path);
      const agents = agentsMdDependsOnIt(directory, index)
        ? ' and stops reading the AGENTS.md next to it'
        : '';
      context.report({
        artifact,
        message: `CLAUDE.local.md is not covered by any .gitignore in this repository. Once it is committed, Claude Code loads these personal instructions for everyone in the project${agents}; add it to .gitignore.`,
        guidance: guidanceFor(artifact.path),
      });
    }
  },
});
