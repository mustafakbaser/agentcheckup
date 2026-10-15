import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import { agentsMdShadowedByClaude } from '../../platforms/load/agents-md-shadow.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { joinPath, relativePath } from './helpers.js';
import { ImportGraph } from './import-graph.js';

export const agentsMdIgnoredByClaudeRule = defineRule({
  meta: {
    id: 'instr/agents-md-ignored-by-claude',
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
  },
  defaultOptions: undefined,
  check(context) {
    const graph = new ImportGraph(context);
    for (const { artifact, directory, nearest } of agentsMdShadowedByClaude(
      graph,
      context.artifacts,
    )) {
      const nearestDirectory = dirnamePosix(nearest.path);
      const sameDirectory =
        nearestDirectory === directory || nearestDirectory === joinPath(directory, '.claude');
      const message = sameDirectory
        ? `Claude Code reads ${quotePath(relativePath(directory, nearest.path))} in this directory and skips this AGENTS.md. Add the line ${quotePath(`@${relativePath(nearestDirectory, artifact.path)}`)} to that file so Claude Code reads both.`
        : `Claude Code reads ${quotePath(nearest.path)} from a parent directory and skips this AGENTS.md. To have Claude Code read it, add a CLAUDE.md in this directory with the line ${quotePath(`@${relativePath(directory, artifact.path)}`)}.`;
      context.report({
        artifact,
        message,
        related: [
          { path: nearest.path, message: 'Claude Code reads this file instead of AGENTS.md.' },
        ],
      });
    }
  },
});
