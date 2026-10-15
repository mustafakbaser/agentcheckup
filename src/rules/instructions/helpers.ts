import type { Artifact, PlatformId, RuleContext } from '../../core/types.js';

export {
  basename,
  fileExists,
  indexArtifacts,
  inPayloadFolder,
  joinPath,
  nearestGitRoot,
  relativePath,
  selfAndAncestors,
} from '../../platforms/paths.js';

/** The artifact's readers that the user targets, in the artifact's order. */
export function targetedReaders(
  context: Pick<RuleContext<unknown>, 'targets'>,
  artifact: Artifact,
): PlatformId[] {
  return artifact.readers.filter((platform) => context.targets.has(platform));
}

/**
 * Findings one rule reports per file at most. A hostile file can hold thousands of matching
 * tokens; past this count more findings add nothing for the reader and cost report time.
 */
export const MAX_FINDINGS_PER_FILE = 100;

/** Counts findings per file; `allow(path)` is false once a file reached the limit. */
export class FindingLimiter {
  readonly #counts = new Map<string, number>();

  allow(path: string): boolean {
    const count = this.#counts.get(path) ?? 0;
    if (count >= MAX_FINDINGS_PER_FILE) return false;
    this.#counts.set(path, count + 1);
    return true;
  }
}
