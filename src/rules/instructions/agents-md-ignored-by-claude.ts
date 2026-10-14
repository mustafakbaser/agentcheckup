import { RULESET_VERSION } from '../../core/meta.js';
import { skillDirectoryOf } from '../../platforms/location.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { basename, inPayloadFolder, joinPath, relativePath, selfAndAncestors } from './helpers.js';
import { agentsMdDirectory, claudeFilesOnPath, ImportGraph, MAX_HOPS } from './import-graph.js';

/** The same file on disk, or a copy whose text differs at most in line endings and trailing space. */
function sameInstructions(a: Artifact, b: Artifact): boolean {
  if (a.realPath === b.realPath) return true;
  const normalize = (artifact: Artifact): string =>
    artifact.decoded.text.replaceAll('\r\n', '\n').trimEnd();
  return normalize(a) === normalize(b);
}

/** The directory that owns a rule's `.claude` folder: `pkg` for `pkg/.claude/rules/x.md`. */
function ruleOwner(path: string): string | undefined {
  if (path.startsWith('.claude/rules/')) return '';
  const index = path.indexOf('/.claude/rules/');
  return index === -1 ? undefined : path.slice(0, index);
}

/** `.claude/rules/` files grouped by the directory that owns the `.claude` folder. */
function rulesByOwner(graph: ImportGraph): Map<string, Artifact[]> {
  const owners = new Map<string, Artifact[]>();
  for (const artifact of new Set(graph.index.values())) {
    if (artifact.kind !== 'claude-rule') continue;
    const owner = ruleOwner(artifact.path);
    if (owner === undefined) continue;
    const list = owners.get(owner) ?? [];
    list.push(artifact);
    owners.set(owner, list);
  }
  return owners;
}

export const agentsMdIgnoredByClaudeRule = defineRule({
  meta: {
    id: 'instr/agents-md-ignored-by-claude',
    title: 'Claude Code skips AGENTS.md because a CLAUDE.md exists',
    rationale: [
      'By default, Claude Code (v2.1.277 and later) reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or any directory above it. Otherwise it reads only the `CLAUDE.md` files, so the instructions that Codex, Cursor and GitHub Copilot get from `AGENTS.md` never reach Claude Code.',
      'agentcheck assumes the default **Project instructions** setting, `claude-md-or-agents-md`. It does not report an `AGENTS.md` that a `CLAUDE.md` or `.claude/rules/` file imports, symlinks or copies; one inside a skill, a template, example or fixture directory, or a directory whose name starts with a dot, such as `.github/`; or one whose status depends on a file agentcheck did not read, such as a gitignored `CLAUDE.local.md`.',
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
    const rules = rulesByOwner(graph);
    for (const artifact of context.artifacts) {
      // Case variants are reported by instr/filename-case. An AGENTS.md inside a configuration
      // folder (.agents/, .codex/, .github/ ...) is not a directory's instructions; Claude Code
      // never reads .agents/ at all.
      if (basename(artifact.path) !== 'AGENTS.md') continue;
      const directory = agentsMdDirectory(artifact.path);
      if (directory.split('/').some((segment) => segment.startsWith('.'))) continue;
      // An AGENTS.md inside a skill is the skill's reference material, and one in a template or
      // example folder is copied into other projects; neither is this directory's rules.
      if (skillDirectoryOf(context.snapshot, artifact.path) !== undefined) continue;
      if (inPayloadFolder(artifact.path)) continue;

      const claudeFiles = claudeFilesOnPath(graph, directory);
      const importers: Artifact[] = [];
      for (const file of claudeFiles)
        if (file.artifact !== undefined) importers.push(file.artifact);
      const nearest = claudeFiles.find((file) => file.artifact !== undefined);
      if (nearest === undefined) continue;
      // A CLAUDE file that is this file (a symlink) or an identical copy: Claude Code already
      // reads the same instructions.
      if (importers.some((claude) => sameInstructions(claude, artifact))) continue;

      // Rules in .claude/rules load with the CLAUDE.md files on the path and can import AGENTS.md.
      for (const ancestor of selfAndAncestors(directory))
        importers.push(...(rules.get(ancestor) ?? []));
      const reach = graph.reach(importers, 'claude', MAX_HOPS.claude);
      if (reach.hops.has(artifact) || reach.incomplete) continue;

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
