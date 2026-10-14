import { pathStatus } from '../../core/paths.js';
import type { Artifact, ParseServices, Snapshot } from '../../core/types.js';
import { inPayloadFolder, joinPath } from '../instructions/helpers.js';

/** Where a path sits relative to the `.github/<subdirectory>` folder Copilot reads. */
export type Placement =
  /** Exactly where Copilot looks. */
  | { readonly kind: 'expected' }
  /** The right place when ignoring letter case. */
  | { readonly kind: 'case' }
  /** Inside `<root>/.github/...` of a subdirectory that is not a repository root. */
  | { readonly kind: 'nested'; readonly root: string }
  | { readonly kind: 'elsewhere' };

/**
 * Classifies `path` against `.github/<inside>` at the repository root. A `.github` folder in a
 * subdirectory that has its own `.git` (a nested repository or submodule) counts as a root.
 */
export function placement(snapshot: Snapshot, path: string, inside: string): Placement {
  const segments = path.split('/');
  const lower = segments.map((segment) => segment.toLowerCase());
  const insideSegments = inside.split('/');
  for (let start = 0; start + insideSegments.length < segments.length + 1; start++) {
    if (lower[start] !== '.github') continue;
    const matches = insideSegments.every(
      (segment, index) => lower[start + 1 + index] === segment.toLowerCase(),
    );
    if (!matches) continue;
    const exact =
      segments[start] === '.github' &&
      insideSegments.every((segment, index) => segments[start + 1 + index] === segment);
    if (!exact) return { kind: 'case' };
    if (start === 0) return { kind: 'expected' };
    const root = segments.slice(0, start).join('/');
    if (pathStatus(snapshot, joinPath(root, '.git')) === 'exists') return { kind: 'expected' };
    return { kind: 'nested', root };
  }
  return { kind: 'elsewhere' };
}

/**
 * Whether Copilot could plausibly be meant to read `path` from where it is: inside a `.github`
 * tree, but not in `.github/workflows` (agentic workflow imports use the same suffix), and not
 * inside a template, example or fixture project whose `.github` folder is copied elsewhere.
 * Files outside any `.github` folder are often copy-paste collections or shared sources.
 */
export function inPlausibleGithubTree(path: string): boolean {
  const lower = path.toLowerCase().split('/');
  const index = lower.indexOf('.github');
  if (index === -1) return false;
  if (lower[index + 1] === 'workflows') return false;
  return !inPayloadFolder(lower.slice(0, index + 1).join('/'));
}

/** Frontmatter keys that only Copilot instruction files use. */
const COPILOT_KEYS = ['applyTo', 'excludeAgent', 'description'] as const;

/**
 * Whether a `*.instructions.md` file is meant for Copilot: it lives under a `.github` folder
 * (except `.github/workflows`, where agentic workflows keep imports with the same suffix) or its
 * frontmatter uses Copilot's fields. Other files with that suffix may be ordinary docs.
 */
export function meantForCopilot(parse: ParseServices, artifact: Artifact): boolean {
  const segments = artifact.path.toLowerCase().split('/');
  const github = segments.indexOf('.github');
  if (github !== -1) return segments[github + 1] !== 'workflows';
  const frontmatter = parse.frontmatter(artifact);
  return (
    frontmatter.kind === 'valid' &&
    COPILOT_KEYS.some((key) => Object.hasOwn(frontmatter.data.values, key))
  );
}
