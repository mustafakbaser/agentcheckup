/**
 * The import graph as Claude Code and Gemini CLI see it, built from `findImports`.
 *
 * - Claude Code expands `@path` imports in CLAUDE.md, CLAUDE.local.md and any AGENTS.md it reads,
 *   up to four hops (code.claude.com/docs/en/memory). The same page says it loads the imports of
 *   user-level `~/.claude/rules/` files, but it does not say so for project `.claude/rules/`
 *   files. Those are still followed, and `ParsedFile.documented` tells callers which results rest
 *   only on them, so they can treat those as information.
 * - Gemini CLI expands them in GEMINI.md up to five hops; a missing file becomes an
 *   "Import failed" comment and imports outside the project root are rejected
 *   (geminicli.com/docs/reference/memport, memoryImportProcessor.ts).
 *
 * Only files that agentcheckup read (artifacts) can be followed. Imports of other files are
 * leaves; when such a file might itself import something, results that depend on it are marked
 * incomplete so callers can stay silent rather than guess.
 */
import { dirnamePosix, joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, PlatformId, Snapshot } from '../../core/types.js';
import { findImports } from '../../parse/imports.js';
import type { ImportDialect, ImportReference, MarkdownDocument } from '../../parse/types.js';
import { skillDirectoryOf } from '../location.js';
import { basename, inPayloadFolder, joinPath, selfAndAncestors } from '../paths.js';
import type { LoadView } from './view.js';

export const DIALECT_PLATFORM: Readonly<Record<ImportDialect, PlatformId>> = {
  claude: 'claude-code',
  gemini: 'gemini',
};

/** Import hops each agent follows from the file it loads. */
export const MAX_HOPS: Readonly<Record<ImportDialect, number>> = { claude: 4, gemini: 5 };

/** Files whose presence on the path makes Claude Code skip AGENTS.md. */
export const CLAUDE_FILE_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] as const;

/** Bounds the edges one graph visits, so a hostile repository cannot stall a scan for minutes. */
const MAX_EDGE_VISITS = 200_000;

/** Extensions of files that may contain further imports. Other files are leaves. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'mdc', 'markdown', 'txt', '']);

/** The parts of a `LoadView` the graph reads. */
export type ImportView = Pick<LoadView, 'snapshot' | 'index' | 'markdown'>;

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
  readonly #view: ImportView;
  readonly #edges = new Map<string, readonly ImportEdge[]>();
  #budget: number;

  constructor(view: ImportView, maxEdgeVisits = MAX_EDGE_VISITS) {
    this.#view = view;
    this.snapshot = view.snapshot;
    this.index = view.index;
    this.#budget = maxEdgeVisits;
  }

  markdown(artifact: Artifact): MarkdownDocument {
    return this.#view.markdown(artifact);
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

  /** False once the edge budget is spent: results computed after that are incomplete. */
  hasBudget(): boolean {
    return this.#budget >= 0;
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

/**
 * True when `path`, which reaches `artifact`, is an AGENTS.md that Claude Code may read as a
 * directory's instructions: named exactly AGENTS.md, not under `.agents/` and not inside a skill.
 */
export function isClaudeAgentsMdLocation(
  snapshot: Snapshot,
  artifact: Artifact,
  path: string = artifact.path,
): boolean {
  return (
    artifact.kind === 'agents-md' &&
    basename(path) === 'AGENTS.md' &&
    !underAgentsDirectory(path) &&
    skillDirectoryOf(snapshot, path) === undefined
  );
}

/** An AGENTS.md that Claude Code reads directly: no CLAUDE file on its path. */
export function isAgentsMdReadByClaude(graph: ImportGraph, artifact: Artifact): boolean {
  return (
    isClaudeAgentsMdLocation(graph.snapshot, artifact) &&
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
export function targetedDialects(view: Pick<LoadView, 'targets'>): ImportDialect[] {
  return (['claude', 'gemini'] as const).filter((dialect) =>
    view.targets.has(DIALECT_PLATFORM[dialect]),
  );
}

// ---------------------------------------------------------------------------------------------
// Imports the agent cannot load: shared by the import rules and the loaders
// ---------------------------------------------------------------------------------------------

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

/** A relative import whose file does not exist, as instr/import-unresolved reports it. */
export interface UnresolvedImport {
  /** The path as shown in the message. */
  readonly path: string;
  /** Gemini only: the existing file the path names without its trailing punctuation. */
  readonly withoutPunctuation?: string;
}

/**
 * The import `edge` in `importer` names a file that does not exist, so `dialect`'s agent cannot
 * load it. Undefined for imports that resolve, that leave the scan root, whose existence is
 * unknown, and, for Claude Code, mentions that do not look like file paths. Callers skip imports
 * inside HTML comments for Claude Code first (see `inHtmlComment`).
 */
export function unresolvedImport(
  snapshot: Snapshot,
  importer: Artifact,
  edge: ImportEdge,
  dialect: ImportDialect,
): UnresolvedImport | undefined {
  const { reference, target } = edge;
  if (reference.kind !== 'relative' || target === undefined) return undefined;
  const trimmed = withoutTrailingPunctuation(reference.path);
  if (dialect === 'claude' && !looksLikeFilePath(trimmed)) return undefined;
  if (pathStatus(snapshot, target) !== 'missing') return undefined;

  let path = reference.path;
  let withoutPunctuation: string | undefined;
  if (trimmed !== reference.path && trimmed !== '') {
    const trimmedTarget = joinRelative(dirnamePosix(importer.path), trimmed);
    if (trimmedTarget !== undefined && pathStatus(snapshot, trimmedTarget) !== 'missing') {
      // Whether Claude Code keeps trailing punctuation in an import path is not documented;
      // Gemini CLI's parser keeps it (it reads up to the next whitespace).
      if (dialect === 'claude') return undefined;
      withoutPunctuation = trimmed;
    } else if (dialect === 'claude') {
      path = trimmed;
    }
  }
  return { path, ...(withoutPunctuation === undefined ? {} : { withoutPunctuation }) };
}

/** An import in a file at the hop limit, which the agent does not follow. */
export interface TooDeepImport {
  /** The import root whose chain reaches `file` at the hop limit. */
  readonly root: Artifact;
  /** The file at the hop limit that holds the import. */
  readonly file: Artifact;
  readonly reference: ImportReference;
  /** The root-relative path of the existing file that is not loaded. */
  readonly target: string;
}

/**
 * Imports in a file `maxHops` hops from the root of `reach` that name an existing file the chain
 * does not load within the limit. In order of `reach.hops`, then source order.
 */
export function importsPastLimit(
  graph: ImportGraph,
  root: Artifact,
  reach: Reach,
  dialect: ImportDialect,
): TooDeepImport[] {
  const maxHops = MAX_HOPS[dialect];
  const found: TooDeepImport[] = [];
  for (const [file, hop] of reach.hops) {
    if (hop !== maxHops) continue;
    const doc = graph.markdown(file);
    for (const { reference, target } of graph.edges(file, dialect)) {
      if (target === undefined) continue;
      if (dialect === 'claude' && inHtmlComment(doc, reference)) continue;
      const loadedAt = reach.targets.get(target);
      if (loadedAt !== undefined && loadedAt <= maxHops) continue;
      if (pathStatus(graph.snapshot, target) !== 'exists') continue;
      found.push({ root, file, reference, target });
    }
  }
  return found;
}

/**
 * Imports past the hop limit from each of `roots`, as instr/import-depth reports them: documented
 * roots first, one search per root, and nothing from a root whose search is incomplete. A file
 * may appear once per root that reaches it at the limit.
 */
export function tooDeepImports(
  graph: ImportGraph,
  roots: readonly Artifact[],
  dialect: ImportDialect,
): TooDeepImport[] {
  // Documented roots first, so a finding they share with a project rule keeps its severity.
  const ordered = [...roots].sort(
    (a, b) => Number(isUndocumentedRoot(a)) - Number(isUndocumentedRoot(b)),
  );
  const found: TooDeepImport[] = [];
  for (const root of ordered) {
    const reach = graph.reach([root], dialect, MAX_HOPS[dialect]);
    if (reach.incomplete) continue;
    found.push(...importsPastLimit(graph, root, reach, dialect));
  }
  return found;
}

/**
 * First segments of absolute paths that are clearly file-system locations. Claude Code also
 * parses `@/components/Button` (a TypeScript path alias in prose) as an absolute import; such
 * mentions are not reported for Claude Code.
 */
const SYSTEM_DIRECTORIES: ReadonlySet<string> = new Set([
  'Users',
  'home',
  'etc',
  'opt',
  'var',
  'tmp',
  'usr',
  'root',
  'mnt',
  'media',
  'Volumes',
  'private',
  'srv',
  'Library',
  'nix',
]);

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

export function isFileSystemPath(path: string): boolean {
  if (WINDOWS_DRIVE.test(path)) return true;
  const first = path.split('/').find((segment) => segment !== '');
  return first !== undefined && SYSTEM_DIRECTORIES.has(first);
}

/**
 * True when a `.git` entry at the scan root shows that the scan covers the whole repository, so
 * a relative import that climbs above the root leaves the repository.
 */
export function scanRootIsRepository(snapshot: Snapshot): boolean {
  return pathStatus(snapshot, '.git') === 'exists';
}

/**
 * How a Claude Code import leaves the repository, as instr/import-outside-root reports it:
 * - `home`: a `~/` path, which each user's machine resolves differently.
 * - `absolute`: an absolute file-system path.
 * - `relative`: a relative path that climbs above the repository root (`repository` is true when
 *   the scan root is the repository root, see {@link scanRootIsRepository}).
 * Undefined for imports inside the repository and for absolute mentions such as
 * `@/components/Button` that are not file-system paths.
 */
export function claudeImportOutsideRoot(
  edge: ImportEdge,
  repository: boolean,
): 'home' | 'absolute' | 'relative' | undefined {
  const { reference, target } = edge;
  switch (reference.kind) {
    case 'home':
      return 'home';
    case 'absolute':
      return isFileSystemPath(reference.path) ? 'absolute' : undefined;
    case 'relative':
      return target !== undefined || !repository ? undefined : 'relative';
  }
}
