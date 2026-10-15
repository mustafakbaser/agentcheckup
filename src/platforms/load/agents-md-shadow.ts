/**
 * AGENTS.md files that Claude Code skips because a CLAUDE file is on their path. Shared by
 * instr/agents-md-ignored-by-claude and the Claude Code loader, so the loader's skips carry that
 * rule's id exactly when the rule reports them.
 *
 * In its default `claude-md-or-agents-md` mode, Claude Code (v2.1.277 and later) reads AGENTS.md
 * only when no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md exists in the working directory or
 * above it (code.claude.com/docs/en/memory). This module judges each AGENTS.md from its own
 * directory, as if the session started there.
 */
import type { Artifact } from '../../core/types.js';
import { skillDirectoryOf } from '../location.js';
import { basename, inPayloadFolder, selfAndAncestors } from '../paths.js';
import {
  agentsMdDirectory,
  type ClaudeFileOnPath,
  claudeFilesOnPath,
  type ImportGraph,
  MAX_HOPS,
} from './imports.js';

/** The same file on disk, or a copy whose text differs at most in line endings and trailing space. */
export function sameInstructions(a: Artifact, b: Artifact): boolean {
  if (a.realPath === b.realPath) return true;
  const normalize = (artifact: Artifact): string =>
    artifact.decoded.text.replaceAll('\r\n', '\n').trimEnd();
  return normalize(a) === normalize(b);
}

/** The directory that owns a rule's `.claude` folder: `pkg` for `pkg/.claude/rules/x.md`. */
export function ruleOwner(path: string): string | undefined {
  if (path.startsWith('.claude/rules/')) return '';
  const index = path.indexOf('/.claude/rules/');
  return index === -1 ? undefined : path.slice(0, index);
}

/** `.claude/rules/` files grouped by the directory that owns the `.claude` folder. */
export function rulesByOwner(graph: Pick<ImportGraph, 'index'>): Map<string, Artifact[]> {
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

export interface ShadowedAgentsMd {
  readonly artifact: Artifact;
  /** The directory the AGENTS.md belongs to (see `agentsMdDirectory`). */
  readonly directory: string;
  /** The nearest CLAUDE file on its path, which Claude Code reads instead. */
  readonly nearest: ClaudeFileOnPath & { readonly artifact: Artifact };
}

/**
 * The AGENTS.md files among `artifacts` that instr/agents-md-ignored-by-claude reports, in the
 * order of `artifacts`. Not reported: an AGENTS.md inside a configuration folder (a directory
 * whose name starts with a dot), a skill, or a template, example or fixture folder; one that a
 * CLAUDE file or a rule on its path imports, symlinks or copies; and one whose status depends on
 * a file agentcheckup did not read.
 */
export function agentsMdShadowedByClaude(
  graph: ImportGraph,
  artifacts: readonly Artifact[],
): ShadowedAgentsMd[] {
  const rules = rulesByOwner(graph);
  const shadowed: ShadowedAgentsMd[] = [];
  for (const artifact of artifacts) {
    // Case variants are reported by instr/filename-case. An AGENTS.md inside a configuration
    // folder (.agents/, .codex/, .github/ ...) is not a directory's instructions; Claude Code
    // never reads .agents/ at all.
    if (basename(artifact.path) !== 'AGENTS.md') continue;
    const directory = agentsMdDirectory(artifact.path);
    if (directory.split('/').some((segment) => segment.startsWith('.'))) continue;
    // An AGENTS.md inside a skill is the skill's reference material, and one in a template or
    // example folder is copied into other projects; neither is this directory's rules.
    if (skillDirectoryOf(graph.snapshot, artifact.path) !== undefined) continue;
    if (inPayloadFolder(artifact.path)) continue;

    const claudeFiles = claudeFilesOnPath(graph, directory);
    const importers: Artifact[] = [];
    for (const file of claudeFiles) if (file.artifact !== undefined) importers.push(file.artifact);
    const nearest = claudeFiles.find(
      (file): file is ClaudeFileOnPath & { readonly artifact: Artifact } =>
        file.artifact !== undefined,
    );
    if (nearest === undefined) continue;
    // A CLAUDE file that is this file (a symlink) or an identical copy: Claude Code already
    // reads the same instructions.
    if (importers.some((claude) => sameInstructions(claude, artifact))) continue;

    // Rules in .claude/rules load with the CLAUDE.md files on the path and can import AGENTS.md.
    for (const ancestor of selfAndAncestors(directory))
      importers.push(...(rules.get(ancestor) ?? []));
    const reach = graph.reach(importers, 'claude', MAX_HOPS.claude);
    if (reach.hops.has(artifact) || reach.incomplete) continue;
    shadowed.push({ artifact, directory, nearest });
  }
  return shadowed;
}
