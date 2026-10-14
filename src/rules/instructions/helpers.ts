import { dirnamePosix, pathStatus } from '../../core/paths.js';
import type { Artifact, PlatformId, RuleContext, Snapshot } from '../../core/types.js';

/** Last path segment. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Joins a root-relative directory ('' for the scan root) and a relative name. */
export function joinPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

/** `directory` itself, then each ancestor up to and including the scan root (''). */
export function selfAndAncestors(directory: string): string[] {
  const result = [directory];
  let current = directory;
  while (current !== '') {
    current = dirnamePosix(current);
    result.push(current);
  }
  return result;
}

/**
 * True only when `path` is known to exist as a file. A directory with that name, or a path whose
 * existence is unknown (inside an unlisted directory), is not a file here.
 */
export function fileExists(snapshot: Snapshot, path: string): boolean {
  return pathStatus(snapshot, path) === 'exists' && !snapshot.paths.has(`${path}/`);
}

/**
 * The nearest directory at or above `directory` that contains a `.git` entry (a directory in a
 * normal clone, a file in submodules and worktrees), or undefined when none is in the scan.
 */
export function nearestGitRoot(snapshot: Snapshot, directory: string): string | undefined {
  for (const candidate of selfAndAncestors(directory)) {
    if (pathStatus(snapshot, joinPath(candidate, '.git')) === 'exists') return candidate;
  }
  return undefined;
}

/** Every path that reaches an artifact: its own path and its symlink aliases. */
export function indexArtifacts(artifacts: readonly Artifact[]): Map<string, Artifact> {
  const index = new Map<string, Artifact>();
  for (const artifact of artifacts) index.set(artifact.path, artifact);
  for (const artifact of artifacts) {
    for (const alias of artifact.aliases) if (!index.has(alias)) index.set(alias, artifact);
  }
  return index;
}

/** Relative POSIX path from directory `from` to the file `to`, both relative to the scan root. */
export function relativePath(from: string, to: string): string {
  const fromParts = from === '' ? [] : from.split('/');
  const toParts = to.split('/');
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const up: string[] = [];
  for (let i = common; i < fromParts.length; i++) up.push('..');
  return [...up, ...toParts.slice(common)].join('/');
}

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

/** Folder names whose contents are payload for other projects, not this repository's own files. */
const PAYLOAD_FOLDERS: ReadonlySet<string> = new Set([
  'assets',
  'example',
  'examples',
  'sample',
  'samples',
  'fixture',
  'fixtures',
  '__fixtures__',
  'testdata',
  'scaffold',
  'scaffolds',
]);

/**
 * True when a directory on `path` (not the file name) is a template, example, sample, fixture or
 * assets folder. Instruction files there are copied into generated projects or used as test input, so
 * judging them where they sit (their chain, their imports, the files next to them) is wrong.
 */
export function inPayloadFolder(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  segments.pop();
  return segments.some((segment) => segment.includes('template') || PAYLOAD_FOLDERS.has(segment));
}
