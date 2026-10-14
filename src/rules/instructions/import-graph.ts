/**
 * The import graph as Claude Code and Gemini CLI see it, built from `findImports`.
 *
 * - Claude Code expands `@path` imports in CLAUDE.md, CLAUDE.local.md and any AGENTS.md it reads,
 *   up to four hops (code.claude.com/docs/en/memory). The same page says it loads the imports of
 *   user-level `~/.claude/rules/` files, but it does not say so for project `.claude/rules/`
 *   files. Those are still followed, and `ParsedFile.documented` tells rules which findings rest
 *   only on them, so they can report those as information.
 * - Gemini CLI expands them in GEMINI.md up to five hops; a missing file becomes an
 *   "Import failed" comment and imports outside the project root are rejected
 *   (geminicli.com/docs/reference/memport, memoryImportProcessor.ts).
 *
 * Only files that agentcheck read (artifacts) can be followed. Imports of other files are
 * leaves; when such a file might itself import something, results that depend on it are marked
 * incomplete so rules can stay silent rather than guess.
 */
import { dirnamePosix, joinRelative, pathStatus } from '../../core/paths.js';
import { skillDirectoryOf } from '../../platforms/location.js';
import type { Artifact, PlatformId, RuleContext, Snapshot } from '../../core/types.js';
import { findImports } from '../../parse/imports.js';
import type { ImportDialect, ImportReference, MarkdownDocument } from '../../parse/types.js';
import {
  basename,
  indexArtifacts,
  inPayloadFolder,
  joinPath,
  selfAndAncestors,
} from './helpers.js';

export const DIALECT_PLATFORM: Readonly<Record<ImportDialect, PlatformId>> = {
  claude: 'claude-code',
  gemini: 'gemini',
};

export const DIALECT_AGENT: Readonly<Record<ImportDialect, string>> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
};

/** Import hops each agent follows from the file it loads. */
export const MAX_HOPS: Readonly<Record<ImportDialect, number>> = { claude: 4, gemini: 5 };

/** Files whose presence on the path makes Claude Code skip AGENTS.md. */
export const CLAUDE_FILE_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] as const;

/** Bounds the edges one rule visits, so a hostile repository cannot make a rule run for minutes. */
const MAX_EDGE_VISITS = 200_000;

/** Extensions of files that may contain further imports. Other files are leaves. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'mdc', 'markdown', 'txt', '']);

export type GraphContext = Pick<
  RuleContext<unknown>,
  'markdown' | 'snapshot' | 'allArtifacts' | 'targets'
>;

export interface ImportEdge {
  readonly reference: ImportReference;
  /**
   * Root-relative target of a relative import. Undefined for absolute and home imports and for
   * relative imports that climb above the scan root.
   */
  readonly target: string | undefined;
}

export interface Reach {
  /** Minimum hop of every artifact reached; roots are hop 0. */
  readonly hops: Map<Artifact, number>;
  /** Minimum hop of every relative import target, read or not. */
  readonly targets: Map<string, number>;
  /**
   * True when a file that was not read, or whose existence is unknown, sits where its own
   * imports would be followed, or when the work budget ran out. Absence results are then unsafe.
   */
  readonly incomplete: boolean;
}

export class ImportGraph {
  readonly index: ReadonlyMap<string, Artifact>;
  readonly snapshot: Snapshot;
  readonly #context: GraphContext;
  readonly #edges = new Map<string, readonly ImportEdge[]>();
  #budget: number;

  constructor(context: GraphContext, maxEdgeVisits = MAX_EDGE_VISITS) {
    this.#context = context;
    this.snapshot = context.snapshot;
    this.index = indexArtifacts(context.allArtifacts);
    this.#budget = maxEdgeVisits;
  }

  markdown(artifact: Artifact): MarkdownDocument {
    return this.#context.markdown(artifact);
  }

  /** Imports in `artifact` as `dialect` reads them, in source order. */
  edges(artifact: Artifact, dialect: ImportDialect): readonly ImportEdge[] {
    const key = `${dialect}\u0000${artifact.path}`;
    let edges = this.#edges.get(key);
    if (edges === undefined) {
      const references = findImports(artifact.decoded.text, this.markdown(artifact), dialect);
      const directory = dirnamePosix(artifact.path);
      edges = references.map((reference) => ({
        reference,
        target: reference.kind === 'relative' ? joinRelative(directory, reference.path) : undefined,
      }));
      this.#edges.set(key, edges);
    }
    return edges;
  }

  /** Charges `count` edge visits; false once the budget is spent. */
  spend(count: number): boolean {
    this.#budget -= count;
    return this.#budget >= 0;
  }

  /**
   * Breadth-first search from `roots`. Imports of a file at hop `maxHops` are not followed,
   * because the agent does not follow them either.
   */
  reach(roots: readonly Artifact[], dialect: ImportDialect, maxHops: number): Reach {
    const hops = new Map<Artifact, number>();
    const targets = new Map<string, number>();
    let incomplete = false;
    const queue: Artifact[] = [];
    for (const root of roots) {
      if (hops.has(root)) continue;
      hops.set(root, 0);
      queue.push(root);
    }
    // The array iterator also visits entries pushed during the loop.
    for (const file of queue) {
      const hop = hops.get(file) ?? 0;
      if (hop >= maxHops) continue;
      const edges = this.edges(file, dialect);
      if (!this.spend(edges.length)) return { hops, targets, incomplete: true };
      for (const { reference, target } of edges) {
        if (target === undefined) continue;
        if (dialect === 'claude' && inHtmlComment(this.markdown(file), reference)) continue;
        const next = hop + 1;
        if (!targets.has(target)) targets.set(target, next);
        const artifact = this.index.get(target);
        if (artifact === undefined) {
          if (next < maxHops && mayImport(this.snapshot, target)) incomplete = true;
          continue;
        }
        if (hops.has(artifact)) continue;
        hops.set(artifact, next);
        queue.push(artifact);
      }
    }
    return { hops, targets, incomplete };
  }
}

/** True when an unread target exists or might exist and could contain imports of its own. */
function mayImport(snapshot: Snapshot, target: string): boolean {
  const status = pathStatus(snapshot, target);
  if (status === 'missing') return false;
  if (status === 'exists' && snapshot.paths.has(`${target}/`)) return false;
  const name = basename(target);
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

/**
 * Claude Code strips block-level HTML comments before it loads a file, so an import inside one is
 * not followed. Gemini CLI does not strip comments.
 */
export function inHtmlComment(doc: MarkdownDocument, reference: ImportReference): boolean {
  const offset = reference.span.offset;
  return doc.htmlComments.some(
    (comment) =>
      offset >= comment.span.offset && offset < comment.span.offset + comment.span.length,
  );
}

/** The directory an AGENTS.md belongs to: `X` for both `X/AGENTS.md` and `X/.claude/AGENTS.md`. */
export function agentsMdDirectory(path: string): string {
  const directory = dirnamePosix(path);
  if (directory === '.claude') return '';
  if (directory.endsWith('/.claude')) return directory.slice(0, -'/.claude'.length);
  return directory;
}

/** Claude Code never reads AGENTS.md under a `.agents/` directory. */
function underAgentsDirectory(path: string): boolean {
  return path.startsWith('.agents/') || path.includes('/.agents/');
}

export interface ClaudeFileOnPath {
  readonly path: string;
  /** The file's artifact; undefined when it exists but was not read, or might exist. */
  readonly artifact: Artifact | undefined;
}

/**
 * CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md files in `directory` and its ancestors that
 * exist or might exist, nearest first.
 */
export function claudeFilesOnPath(graph: ImportGraph, directory: string): ClaudeFileOnPath[] {
  const found: ClaudeFileOnPath[] = [];
  for (const ancestor of selfAndAncestors(directory)) {
    for (const name of CLAUDE_FILE_NAMES) {
      const path = joinPath(ancestor, name);
      const artifact = graph.index.get(path);
      if (artifact !== undefined) {
        found.push({ path, artifact });
        continue;
      }
      const status = pathStatus(graph.snapshot, path);
      if (status === 'missing') continue;
      if (status === 'exists' && graph.snapshot.paths.has(`${path}/`)) continue;
      found.push({ path, artifact: undefined });
    }
  }
  return found;
}

/** An AGENTS.md that Claude Code reads directly: no CLAUDE file on its path. */
export function isAgentsMdReadByClaude(graph: ImportGraph, artifact: Artifact): boolean {
  return (
    artifact.kind === 'agents-md' &&
    basename(artifact.path) === 'AGENTS.md' &&
    !underAgentsDirectory(artifact.path) &&
    skillDirectoryOf(graph.snapshot, artifact.path) === undefined &&
    claudeFilesOnPath(graph, agentsMdDirectory(artifact.path)).length === 0
  );
}

/** Files each agent loads by itself and expands imports in. */
export function importRoots(graph: ImportGraph, dialect: ImportDialect): Artifact[] {
  const roots: Artifact[] = [];
  for (const artifact of new Set(graph.index.values())) {
    // Case variants (docs/claude.md) are reported by instr/filename-case and may be documents.
    // Files in template and example folders resolve their imports in the projects they are
    // copied into, not where they sit.
    if (artifact.caseMismatch !== undefined || inPayloadFolder(artifact.path)) continue;
    if (dialect === 'gemini') {
      if (artifact.kind === 'gemini-md') roots.push(artifact);
      continue;
    }
    if (
      artifact.kind === 'claude-md' ||
      artifact.kind === 'claude-local-md' ||
      artifact.kind === 'claude-rule' ||
      isAgentsMdReadByClaude(graph, artifact)
    ) {
      roots.push(artifact);
    }
  }
  return roots.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ParsedFile {
  readonly artifact: Artifact;
  readonly hop: number;
  /**
   * False when the agent reaches this file only through a project `.claude/rules/` file, whose
   * import expansion is not documented.
   */
  readonly documented: boolean;
}

/** A root whose import expansion is not documented: a project `.claude/rules/` file. */
export function isUndocumentedRoot(artifact: Artifact): boolean {
  return artifact.kind === 'claude-rule';
}

/**
 * Files whose imports `dialect` processes: roots and the artifacts they import, at a hop where
 * the agent still follows imports. Sorted by path.
 */
export function filesWithFollowedImports(graph: ImportGraph, dialect: ImportDialect): ParsedFile[] {
  const maxHops = MAX_HOPS[dialect];
  const roots = importRoots(graph, dialect);
  const { hops } = graph.reach(roots, dialect, maxHops);
  const documentedRoots = roots.filter((root) => !isUndocumentedRoot(root));
  const documented =
    documentedRoots.length === roots.length
      ? hops
      : graph.reach(documentedRoots, dialect, maxHops).hops;
  const files: ParsedFile[] = [];
  for (const [artifact, hop] of hops) {
    if (hop >= maxHops) continue;
    const documentedHop = documented.get(artifact);
    files.push({
      artifact,
      hop,
      documented: documentedHop !== undefined && documentedHop < maxHops,
    });
  }
  return files.sort((a, b) =>
    a.artifact.path < b.artifact.path ? -1 : a.artifact.path > b.artifact.path ? 1 : 0,
  );
}

/** Dialects whose platform the user targets. */
export function targetedDialects(context: Pick<RuleContext<unknown>, 'targets'>): ImportDialect[] {
  return (['claude', 'gemini'] as const).filter((dialect) =>
    context.targets.has(DIALECT_PLATFORM[dialect]),
  );
}

const TRAILING_PUNCTUATION = '.,;:!?)]}\'"';

/** `docs/guide.md.` -> `docs/guide.md`. */
export function withoutTrailingPunctuation(path: string): string {
  let end = path.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(path.charAt(end - 1))) end--;
  return path.slice(0, end);
}

/**
 * Whether a Claude Code import was meant as a file: it starts with `./` or `../`, or its last
 * segment has a file extension. Claude Code also parses mentions such as `@tanstack/react-query`
 * or `@octocat` as imports; those are not reported.
 */
export function looksLikeFilePath(path: string): boolean {
  if (path.includes(':')) return false;
  if (path.startsWith('./') || path.startsWith('../')) return true;
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  const extension = name.slice(dot + 1);
  if (extension.length > 10) return false;
  const first = extension.charCodeAt(0);
  const isLetter = (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
  if (!isLetter) return false;
  for (let i = 1; i < extension.length; i++) {
    const code = extension.charCodeAt(i);
    const alnum =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    if (!alnum) return false;
  }
  return true;
}
