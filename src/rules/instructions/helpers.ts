import type { Artifact, PlatformId, RuleContext } from '../../core/types.js';
import { artifactIndex } from '../../platforms/load/view.js';
import { effectiveReaders } from '../../platforms/readers.js';

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

/**
 * The platforms that read the artifact in this repository and that the user targets, sorted by
 * platform id: its default readers with the repository's own settings applied, Gemini CLI's
 * `context.fileName` and Devin Local's `read_config_from` (src/platforms/readers.ts).
 */
export function targetedReaders(
  context: Pick<RuleContext<unknown>, 'targets' | 'allArtifacts' | 'json'>,
  artifact: Artifact,
): PlatformId[] {
  const view = {
    artifacts: context.allArtifacts,
    index: artifactIndex(context.allArtifacts),
    json: (target: Artifact) => context.json(target),
  };
  return effectiveReaders(view, artifact).filter((platform) => context.targets.has(platform));
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
