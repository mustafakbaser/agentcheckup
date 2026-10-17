/**
 * What loading code reads: the scan, its artifacts and their parsed views. The engine's analysis
 * of a snapshot satisfies `LoadView` as it is, and a rule builds one from its context with
 * `viewOf`, so a rule and a loader run the same implementation of a loading behavior over the
 * same memoized parses.
 */
import type {
  Artifact,
  ParseServices,
  PlatformId,
  RuleContext,
  Snapshot,
} from '../../core/types.js';
import { indexArtifacts } from '../paths.js';

export interface LoadView extends ParseServices {
  readonly snapshot: Snapshot;
  /** Every artifact in the scan, sorted by path. */
  readonly artifacts: readonly Artifact[];
  /** Artifact by every path that reaches it: its own path, then each symlink alias. */
  readonly index: ReadonlyMap<string, Artifact>;
  /** Platforms the user targets. */
  readonly targets: ReadonlySet<PlatformId>;
  // Properties, as in the engine's Analysis: the parsers are safe to pass around without `this`.
  readonly frontmatter: ParseServices['frontmatter'];
  readonly markdown: ParseServices['markdown'];
  readonly json: ParseServices['json'];
  readonly toml: ParseServices['toml'];
}

/** The parts of a rule context that `viewOf` reads. */
export type ViewSource = Pick<
  RuleContext<unknown>,
  'snapshot' | 'allArtifacts' | 'targets' | 'frontmatter' | 'markdown' | 'json' | 'toml'
>;

const indexes = new WeakMap<readonly Artifact[], ReadonlyMap<string, Artifact>>();

/**
 * `indexArtifacts(artifacts)`, built once per artifact list. Every rule of a scan receives the
 * same list, so they share one index.
 */
export function artifactIndex(artifacts: readonly Artifact[]): ReadonlyMap<string, Artifact> {
  let index = indexes.get(artifacts);
  if (index === undefined) {
    index = indexArtifacts(artifacts);
    indexes.set(artifacts, index);
  }
  return index;
}

/**
 * The view of a rule context. Parses go through the context, so they share its cache and its
 * Markdown budget.
 */
export function viewOf(context: ViewSource): LoadView {
  return {
    snapshot: context.snapshot,
    artifacts: context.allArtifacts,
    index: artifactIndex(context.allArtifacts),
    targets: context.targets,
    frontmatter: (artifact) => context.frontmatter(artifact),
    markdown: (artifact) => context.markdown(artifact),
    json: (artifact) => context.json(artifact),
    toml: (artifact) => context.toml(artifact),
  };
}
