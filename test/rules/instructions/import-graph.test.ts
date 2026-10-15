import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG } from '../../../src/core/config.js';
import { buildArtifacts } from '../../../src/core/engine.js';
import type { Artifact } from '../../../src/core/types.js';
import { parseFrontmatter } from '../../../src/parse/frontmatter.js';
import { parseMarkdown } from '../../../src/parse/markdown.js';
import {
  claudeFilesOnPath,
  ImportGraph,
  importRoots,
  isAgentsMdReadByClaude,
} from '../../../src/rules/instructions/import-graph.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

function graphFor(files: FileMap, extras: SnapshotExtras = {}, budget?: number) {
  const snapshot = snapshotFrom(files, extras);
  const artifacts = buildArtifacts(snapshot, EMPTY_CONFIG);
  const context = {
    snapshot,
    allArtifacts: artifacts,
    targets: new Set(['claude-code', 'gemini'] as const),
    markdown: (artifact: Artifact) =>
      parseMarkdown(artifact.decoded.text, parseFrontmatter(artifact.decoded.text)),
  };
  const graph = budget === undefined ? new ImportGraph(context) : new ImportGraph(context, budget);
  const byPath = (path: string): Artifact => {
    const artifact = graph.index.get(path);
    if (artifact === undefined) throw new Error(`no artifact ${path}`);
    return artifact;
  };
  return { graph, byPath };
}

describe('ImportGraph', () => {
  it('records minimum hops and stops following at the hop limit', () => {
    const { graph, byPath } = graphFor({
      'CLAUDE.md': '@AGENTS.md\n@GEMINI.md\n',
      'AGENTS.md': '@GEMINI.md\n',
      'GEMINI.md': '@./.cursorrules\n',
      '.cursorrules': 'x',
    });
    const reach = graph.reach([byPath('CLAUDE.md')], 'claude', 1);
    expect([...reach.hops].map(([artifact, hop]) => [artifact.path, hop])).toEqual([
      ['CLAUDE.md', 0],
      ['AGENTS.md', 1],
      ['GEMINI.md', 1],
    ]);
    expect(reach.incomplete).toBe(false);
  });

  it('marks results incomplete when an unread Markdown file could import more', () => {
    const { graph, byPath } = graphFor(
      { 'CLAUDE.md': '@docs/index.md\n@package.json\n@docs\n' },
      { paths: ['docs/index.md', 'package.json', 'docs/other.md'] },
    );
    expect(graph.reach([byPath('CLAUDE.md')], 'claude', 4).incomplete).toBe(true);
    // At the last hop the unread file's own imports would not be followed anyway.
    expect(graph.reach([byPath('CLAUDE.md')], 'claude', 1).incomplete).toBe(false);
  });

  it('does not treat JSON files, directories or missing files as possible importers', () => {
    const { graph, byPath } = graphFor(
      { 'CLAUDE.md': '@package.json\n@./docs\n@missing.md\n' },
      { paths: ['package.json', 'docs/a.md'] },
    );
    expect(graph.reach([byPath('CLAUDE.md')], 'claude', 4).incomplete).toBe(false);
  });

  it('marks results incomplete when the edge budget runs out', () => {
    const { graph, byPath } = graphFor(
      { 'CLAUDE.md': '@AGENTS.md\n@GEMINI.md\n', 'AGENTS.md': 'x', 'GEMINI.md': 'y' },
      {},
      1,
    );
    expect(graph.reach([byPath('CLAUDE.md')], 'claude', 4).incomplete).toBe(true);
  });

  it('caches parsed imports per dialect', () => {
    const { graph, byPath } = graphFor({ 'GEMINI.md': 'See @./notes.md.\n' });
    const gemini = graph.edges(byPath('GEMINI.md'), 'gemini');
    expect(graph.edges(byPath('GEMINI.md'), 'gemini')).toBe(gemini);
    expect(gemini.map((edge) => edge.target)).toEqual(['notes.md.']);
    expect(graph.edges(byPath('GEMINI.md'), 'claude').map((edge) => edge.target)).toEqual([
      'notes.md',
    ]);
  });

  it('follows symlink aliases to the real file', () => {
    const { graph } = graphFor(
      { 'AGENTS.md': 'x', 'docs/AGENTS.md': 'x' },
      { symlinks: { 'docs/AGENTS.md': 'AGENTS.md' } },
    );
    expect(graph.index.get('docs/AGENTS.md')?.path).toBe('AGENTS.md');
  });
});

describe('Claude Code roots', () => {
  it('lists CLAUDE files and rules, and AGENTS.md only without a CLAUDE file on its path', () => {
    const { graph } = graphFor({
      'CLAUDE.md': 'x',
      'docs/CLAUDE.local.md': 'x',
      '.claude/rules/a.md': 'x',
      'AGENTS.md': 'x',
      'other/AGENTS.md': 'x',
      'other/.agents/AGENTS.md': 'x',
      'GEMINI.md': 'x',
    });
    expect(importRoots(graph, 'claude').map((artifact) => artifact.path)).toEqual([
      '.claude/rules/a.md',
      'CLAUDE.md',
      'docs/CLAUDE.local.md',
    ]);
    expect(importRoots(graph, 'gemini').map((artifact) => artifact.path)).toEqual(['GEMINI.md']);
  });

  it('reads AGENTS.md directly when no CLAUDE file exists on the path', () => {
    const { graph, byPath } = graphFor({ 'pkg/AGENTS.md': 'x', 'other/CLAUDE.md': 'x' });
    expect(isAgentsMdReadByClaude(graph, byPath('pkg/AGENTS.md'))).toBe(true);
    expect(importRoots(graph, 'claude').map((artifact) => artifact.path)).toEqual([
      'other/CLAUDE.md',
      'pkg/AGENTS.md',
    ]);
  });

  it('does not treat a skill reference AGENTS.md as an AGENTS.md Claude Code reads', () => {
    const { graph, byPath } = graphFor({
      'skills/x/SKILL.md': '---\nname: x\ndescription: d\n---\n',
      'skills/x/AGENTS.md': 'x',
    });
    expect(isAgentsMdReadByClaude(graph, byPath('skills/x/AGENTS.md'))).toBe(false);
  });

  it('finds CLAUDE files on the path, read or not, but not directories', () => {
    const { graph } = graphFor(
      { 'a/b/AGENTS.md': 'x', 'CLAUDE.md': 'x' },
      { ignoredFiles: ['a/CLAUDE.local.md'], paths: ['a/b/CLAUDE.md/notes.txt'] },
    );
    expect(
      claudeFilesOnPath(graph, 'a/b').map((file) => [file.path, file.artifact !== undefined]),
    ).toEqual([
      ['a/CLAUDE.local.md', false],
      ['CLAUDE.md', true],
    ]);
  });
});
