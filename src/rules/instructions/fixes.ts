/**
 * Shared pieces of the instruction rules' fixes (docs/adr/0008-write-fixes-to-the-scanned-
 * repository.md): when a file may be edited, and the manual step when it may not.
 */
import type { Artifact } from '../../core/types.js';
import { roundTrips } from '../../fix/text.js';
import { quotePath } from '../shared/format.js';

/**
 * Why a fix must not edit the artifact's file, or undefined when it may. Never edited: a file
 * reached through a symbolic link, a file that other paths link to (the edit would change them
 * too), and a file whose bytes do not decode and encode back unchanged.
 */
export function editBlocker(artifact: Artifact): string | undefined {
  const target = artifact.file.symlinkTarget;
  if (target !== undefined) {
    return `${quotePath(artifact.path)} is a symbolic link to ${quotePath(target)}`;
  }
  const alias = artifact.aliases[0];
  if (alias !== undefined) return `${quotePath(alias)} is a symbolic link to this file`;
  if (!roundTrips(artifact.file.bytes, artifact.decoded)) {
    return `${quotePath(artifact.path)} does not decode cleanly`;
  }
  return undefined;
}

/** A manual step for an edit a fix may not make: `do this by hand, because`. */
export function byHand(action: string, blocker: string): string {
  return `${action} by hand: ${blocker}`;
}

/**
 * Index (0-based) of the line that starts at `offset`, the number of lines when `offset` is the
 * end of the text, or undefined when no line starts there.
 */
export function lineIndexOfOffset(artifact: Artifact, offset: number): number | undefined {
  const { text, lineStarts } = artifact.decoded;
  const index = lineStarts.indexOf(offset);
  if (index !== -1) return index;
  return offset === text.length ? lineStarts.length : undefined;
}
