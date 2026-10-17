import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG } from '../../../src/core/config.js';
import { buildArtifacts } from '../../../src/core/engine.js';
import type { Artifact } from '../../../src/core/types.js';
import type {
  FrontmatterResult,
  JsonDocument,
  MarkdownDocument,
  TomlDocument,
} from '../../../src/parse/types.js';
import { artifactIndex, viewOf } from '../../../src/platforms/load/view.js';
import { snapshotFrom } from '../../helpers/lint.js';

function contextFor() {
  const snapshot = snapshotFrom(
    { 'AGENTS.md': 'Use pnpm.\n', 'CLAUDE.md': 'Use pnpm.\n' },
    { symlinks: { 'CLAUDE.md': 'AGENTS.md' } },
  );
  const allArtifacts = buildArtifacts(snapshot, EMPTY_CONFIG);
  const calls: string[] = [];
  const record = (kind: string, artifact: Artifact): void => {
    calls.push(`${kind} ${artifact.path}`);
  };
  return {
    calls,
    context: {
      snapshot,
      allArtifacts,
      targets: new Set(['codex'] as const),
      frontmatter: (artifact: Artifact) => {
        record('frontmatter', artifact);
        return {} as FrontmatterResult;
      },
      markdown: (artifact: Artifact) => {
        record('markdown', artifact);
        return {} as MarkdownDocument;
      },
      json: (artifact: Artifact) => {
        record('json', artifact);
        return {} as JsonDocument;
      },
      toml: (artifact: Artifact) => {
        record('toml', artifact);
        return {} as TomlDocument;
      },
    },
  };
}

describe('viewOf', () => {
  it('exposes the context and indexes artifacts by path and by alias', () => {
    const { context } = contextFor();
    const view = viewOf(context);
    expect(view.snapshot).toBe(context.snapshot);
    expect(view.artifacts).toBe(context.allArtifacts);
    expect(view.targets).toBe(context.targets);
    expect([...view.index.keys()]).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(view.index.get('CLAUDE.md')?.path).toBe('AGENTS.md');
  });

  it('parses through the context, so rules and loaders share its cache and budget', () => {
    const { context, calls } = contextFor();
    const view = viewOf(context);
    const artifact = view.index.get('AGENTS.md')!;
    view.frontmatter(artifact);
    view.markdown(artifact);
    view.json(artifact);
    view.toml(artifact);
    expect(calls).toEqual([
      'frontmatter AGENTS.md',
      'markdown AGENTS.md',
      'json AGENTS.md',
      'toml AGENTS.md',
    ]);
  });

  it('builds the index once per artifact list and never parses while building it', () => {
    const { context, calls } = contextFor();
    expect(viewOf(context).index).toBe(viewOf(context).index);
    expect(artifactIndex(context.allArtifacts)).toBe(viewOf(context).index);
    expect(artifactIndex([...context.allArtifacts])).not.toBe(viewOf(context).index);
    expect(calls).toEqual([]);
  });
});
