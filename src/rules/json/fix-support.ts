/**
 * Helpers for the fixes of the JSON, MCP, hooks, settings and risk rules. Fixes are built with
 * the builders of src/fix/edits.ts; these helpers decide when a rule may offer one at all.
 * See docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 */
import type { Artifact, FileChange, TextEdit } from '../../core/types.js';

/**
 * Whether a rule may attach a fix that edits this artifact's file. Not for a file reached through
 * a symbolic link, which the planner refuses anyway, nor for one that other paths reach through
 * symbolic links: one edit would then change a file that several agents read, each with its own
 * syntax and rules.
 */
export function editable(artifact: Artifact): boolean {
  return artifact.file.symlinkTarget === undefined && artifact.aliases.length === 0;
}

/** The manual step for a finding in a file {@link editable} refuses. */
export function sharedFileGuidance(artifact: Artifact): string {
  return artifact.file.symlinkTarget === undefined
    ? 'other paths link to this file, so edit it by hand for every agent that reads it'
    : 'this file is reached through a symbolic link; edit the file it links to by hand';
}

/**
 * Merges builder changes that each edit the same file's scanned text into one change, so they
 * apply together. Undefined when one is missing, is not an edit of that file, or overlaps another.
 */
export function mergeEdits(
  artifact: Artifact,
  changes: readonly (FileChange | undefined)[],
): FileChange | undefined {
  const edits: TextEdit[] = [];
  for (const change of changes) {
    if (change?.kind !== 'edit' || change.path !== artifact.path) return undefined;
    edits.push(...change.edits);
  }
  edits.sort((a, b) => a.offset - b.offset || a.length - b.length);
  for (let i = 1; i < edits.length; i++) {
    const previous = edits[i - 1];
    const current = edits[i];
    if (previous === undefined || current === undefined) continue;
    if (current.offset < previous.offset + previous.length) return undefined;
    if (current.offset === previous.offset && current.length === 0 && previous.length === 0) {
      return undefined;
    }
  }
  return edits.length === 0 ? undefined : { kind: 'edit', path: artifact.path, edits };
}

/** True for a path that a POSIX shell reads as one word without quoting. */
export function shellSafePath(path: string): boolean {
  return /^[\w./-]+$/.test(path) && !path.startsWith('-');
}
