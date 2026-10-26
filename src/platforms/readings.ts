/**
 * What an artifact is at each path that reaches it. The engine folds a file reached through a
 * symlink into the artifact of its real file, so it is linted and scored once
 * (src/core/engine.ts, buildArtifacts). An agent that follows the symlink sees the file at the
 * alias's path, though, so the alias's own name decides its role there:
 * `.claude/agents -> ../.github/agents` makes each Copilot agent file a Claude Code subagent too.
 */
import type { Artifact, ArtifactKind } from '../core/types.js';
import { classify } from './classify.js';

export interface Reading {
  readonly kind: ArtifactKind;
  /** The artifact's own path, or the symlink alias that makes it this kind. */
  readonly path: string;
}

/**
 * One reading per kind: the artifact's own kind at its own path first, then the kind of each
 * symlink alias that classifies, at the first alias in code-point order that gives it.
 */
export function readingsOf(artifact: Artifact): Reading[] {
  const out: Reading[] = [{ kind: artifact.kind, path: artifact.path }];
  for (const alias of artifact.aliases) {
    const kind = classify(alias)?.kind;
    if (kind !== undefined && !out.some((reading) => reading.kind === kind)) {
      out.push({ kind, path: alias });
    }
  }
  return out;
}

/** The path at which `artifact` is a `kind`, or undefined when no path that reaches it is one. */
export function pathAs(artifact: Artifact, kind: ArtifactKind): string | undefined {
  return readingsOf(artifact).find((reading) => reading.kind === kind)?.path;
}
