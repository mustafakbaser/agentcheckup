/**
 * The import graph as Claude Code and Gemini CLI see it, built from `findImports`.
 *
 * - Claude Code expands `@path` imports in CLAUDE.md, CLAUDE.local.md and any AGENTS.md it reads,
 *   up to four hops (code.claude.com/docs/en/memory). The same page says it loads the imports of
 *   user-level `~/.claude/rules/` files, but it does not say so for project `.claude/rules/`
 *   files. Those are still followed, and `ParsedFile.documented` tells callers which results rest
 *   only on them, so they can treat those as information.
 * - Gemini CLI expands them in every context file it loads, up to five hops: GEMINI.md, and the
 *   files `context.fileName` names (src/platforms/gemini.ts). A missing file becomes an
 *   "Import failed" comment and imports outside the project root are rejected
 *   (geminicli.com/docs/reference/memport, memoryImportProcessor.ts).
 *
 * Only files that agentcheckup read (artifacts) can be followed. Imports of other files are
 * leaves; when such a file might itself import something, results that depend on it are marked
 * incomplete so callers can stay silent rather than guess.
 *
 * A file can be a root through a symlink: with `CLAUDE.md -> AGENTS.md`, Claude Code reads
 * AGENTS.md as the CLAUDE.md (documented, code.claude.com/docs/en/memory: "Claude reads
 * `CLAUDE.md` through the link") and expands its imports. Imports then resolve from the link's
 * directory (see `ImportGraph.rootPath`). Gemini CLI's source does that: it reads the path it
 * found and passes `path.dirname(filePath)` as the base (memoryDiscovery.ts). Claude Code's
 * documentation says only that relative imports resolve from "the file containing the import";
 * where the link and the file it points to sit in different directories, results that depend on
 * that are marked uncertain (`importsUncertainty`).
 */
import { dirnamePosix, joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, PlatformId, Snapshot } from '../../core/types.js';
import { findImports } from '../../parse/imports.js';
import type { ImportDialect, ImportReference, MarkdownDocument } from '../../parse/types.js';
import { classify } from '../classify.js';
import { geminiNamesFile } from '../gemini.js';
import { MARKDOWN_KINDS } from '../kinds.js';
import { skillDirectoryOf } from '../location.js';
import { basename, inPayloadFolder, joinPath, nearestGitRoot, selfAndAncestors } from '../paths.js';
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

/**
 * Extensions (lower case, without the dot; `''` for none) of files that may contain further
 * imports. Other files are leaves. The walker reads import targets with these extensions only.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'mdc', 'markdown', 'txt', '']);

/**
 * The parts of a `LoadView` the graph reads. Without `json`, the graph cannot read Gemini CLI's
 * `context.fileName`, and only GEMINI.md files are Gemini CLI roots.
 */
export type ImportView = Pick<LoadView, 'snapshot' | 'index' | 'markdown'> &
  Partial<Pick<LoadView, 'json'>>;

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

/** What a graph computes from its view alone, so every graph over one view can share it. */
interface ViewCaches {
  readonly edges: Map<string, readonly ImportEdge[]>;
  readonly rootPaths: Record<ImportDialect, Map<Artifact, string | undefined>>;
}

const VIEW_CACHES = new WeakMap<ImportView, ViewCaches>();

/**
 * The edges and root paths of the graphs over `view`. Loaders build a graph per plan, and the
 * matrix and `--by-directory` plan every agent in many directories over one view. Each graph
 * keeps its own edge budget; a shared parse is the cached one the view returns anyway.
 */
function viewCaches(view: ImportView): ViewCaches {
  let caches = VIEW_CACHES.get(view);
  if (caches === undefined) {
    caches = { edges: new Map(), rootPaths: { claude: new Map(), gemini: new Map() } };
    VIEW_CACHES.set(view, caches);
  }
  return caches;
}

export class ImportGraph {
  readonly index: ReadonlyMap<string, Artifact>;
  readonly snapshot: Snapshot;
  readonly #view: ImportView;
  readonly #edges: Map<string, readonly ImportEdge[]>;
  readonly #rootPaths: Record<ImportDialect, Map<Artifact, string | undefined>>;
  #budget: number;

  constructor(view: ImportView, maxEdgeVisits = MAX_EDGE_VISITS) {
    const caches = viewCaches(view);
    this.#edges = caches.edges;
    this.#rootPaths = caches.rootPaths;
    this.#view = view;
    this.snapshot = view.snapshot;
    this.index = view.index;
    this.#budget = maxEdgeVisits;
  }

  markdown(artifact: Artifact): MarkdownDocument {
    return this.#view.markdown(artifact);
  }

  /**
   * Whether the settings of a working directory at or above `path` name the file there in
   * Gemini CLI's `context.fileName` ({@link geminiNamesFile}). False without `json`.
   */
  geminiNames(path: string): boolean {
    const json = this.#view.json;
    return json !== undefined && geminiNamesFile({ index: this.index, json }, path);
  }

  /**
   * The path through which `dialect`'s agent loads `artifact` by itself, expanding its imports:
   * the artifact's own path, else the first of its aliases (symlinks that reach it, in code-point
   * order) at a location the agent loads. Undefined when the agent reaches the file only through
   * imports, or not at all. With `CLAUDE.md -> AGENTS.md` and no other CLAUDE file, it is
   * `CLAUDE.md` for the AGENTS.md artifact.
   *
   * The file's relative imports resolve from this path's directory. A file loaded through links
   * in several directories resolves them from the first one only.
   */
  rootPath(artifact: Artifact, dialect: ImportDialect): string | undefined {
    const cache = this.#rootPaths[dialect];
    if (cache.has(artifact)) return cache.get(artifact);
    const found = [artifact.path, ...artifact.aliases].find((path) =>
      isRootLocation(this, artifact, path, dialect),
    );
    cache.set(artifact, found);
    return found;
  }

  /**
   * Imports in `artifact` as `dialect` reads them, in source order. Relative ones resolve from
   * the directory of its `rootPath`, or of its own path when it is not a root.
   */
  edges(artifact: Artifact, dialect: ImportDialect): readonly ImportEdge[] {
    const key = `${dialect}\u0000${artifact.path}`;
    let edges = this.#edges.get(key);
    if (edges === undefined) {
      const references = findImports(artifact.decoded.text, this.markdown(artifact), dialect);
      const directory = dirnamePosix(this.rootPath(artifact, dialect) ?? artifact.path);
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
 * True when `path` is named exactly AGENTS.md, is not under `.agents/` and is not inside a skill:
 * a place where Claude Code may read an AGENTS.md as a directory's instructions.
 */
function isClaudeAgentsMdPath(snapshot: Snapshot, path: string): boolean {
  return (
    basename(path) === 'AGENTS.md' &&
    !underAgentsDirectory(path) &&
    skillDirectoryOf(snapshot, path) === undefined
  );
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
  return artifact.kind === 'agents-md' && isClaudeAgentsMdPath(snapshot, path);
}

/** An AGENTS.md that Claude Code reads directly: no CLAUDE file on its path. */
export function isAgentsMdReadByClaude(graph: ImportGraph, artifact: Artifact): boolean {
  return (
    isClaudeAgentsMdLocation(graph.snapshot, artifact) &&
    claudeFilesOnPath(graph, agentsMdDirectory(artifact.path)).length === 0
  );
}

/** The classification of `path`, one of the paths that reach `artifact`. */
function kindAt(
  artifact: Artifact,
  path: string,
): Pick<Artifact, 'kind' | 'caseMismatch'> | undefined {
  // An imported file's own path classifies as nothing; its artifact knows it was imported.
  return path === artifact.path ? artifact : classify(path);
}

/**
 * True when `dialect`'s agent loads the file at `path`, which reaches `artifact`, by itself and
 * expands its imports: for Gemini CLI a GEMINI.md, or a Markdown file that `context.fileName`
 * names in the settings of its directory or one above it; for Claude Code a CLAUDE.md,
 * CLAUDE.local.md, `.claude/rules/` file, or an AGENTS.md without a CLAUDE file on its path.
 */
function isRootLocation(
  graph: ImportGraph,
  artifact: Artifact,
  path: string,
  dialect: ImportDialect,
): boolean {
  // Case variants (docs/claude.md) are reported by instr/filename-case and may be documents.
  // Files in template and example folders resolve their imports in the projects they are
  // copied into, not where they sit.
  const classification = kindAt(artifact, path);
  if (classification === undefined || classification.caseMismatch !== undefined) return false;
  if (inPayloadFolder(path)) return false;
  const { kind } = classification;
  if (dialect === 'gemini') {
    return kind === 'gemini-md' || (MARKDOWN_KINDS.has(kind) && graph.geminiNames(path));
  }
  if (kind === 'claude-md' || kind === 'claude-local-md' || kind === 'claude-rule') return true;
  return (
    kind === 'agents-md' &&
    isClaudeAgentsMdPath(graph.snapshot, path) &&
    claudeFilesOnPath(graph, agentsMdDirectory(path)).length === 0
  );
}

/**
 * Files each agent loads by itself and expands imports in, by their own path or through a
 * symlink (see `ImportGraph.rootPath`). Sorted by path.
 */
export function importRoots(graph: ImportGraph, dialect: ImportDialect): Artifact[] {
  const roots: Artifact[] = [];
  for (const artifact of new Set(graph.index.values())) {
    if (graph.rootPath(artifact, dialect) !== undefined) roots.push(artifact);
  }
  return roots.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Why the agent's handling of the imports reached from a root is not documented:
 * - `project-rule`: the root is a project `.claude/rules/` file, and Claude Code's documentation
 *   does not say it expands imports there.
 * - `link`: Claude Code reads the root through a symlink in another directory than the file it
 *   points to. Its documentation says relative imports resolve from "the file containing the
 *   import", not whether that is the link or its target; agentcheckup resolves them from the link.
 */
export type ImportsUncertainty = 'project-rule' | 'link';

/**
 * Why Claude Code's handling of the imports of `artifact`, loaded at `path` (its own path or a
 * symlink to it), is not documented; undefined when it is.
 */
export function claudeImportsUncertainty(
  artifact: Artifact,
  path: string,
): ImportsUncertainty | undefined {
  if (kindAt(artifact, path)?.kind === 'claude-rule') return 'project-rule';
  // Through a link in its target's own directory, both readings name the same files.
  if (dirnamePosix(path) !== dirnamePosix(artifact.realPath)) return 'link';
  return undefined;
}

/**
 * Why `dialect`'s handling of the imports reached from `root` is not documented; undefined when
 * it is. Always undefined for Gemini CLI: its source resolves imports from the path it found.
 */
export function importsUncertainty(
  graph: ImportGraph,
  root: Artifact,
  dialect: ImportDialect,
): ImportsUncertainty | undefined {
  if (dialect !== 'claude') return undefined;
  return claudeImportsUncertainty(root, graph.rootPath(root, dialect) ?? root.path);
}

export interface ParsedFile {
  readonly artifact: Artifact;
  readonly hop: number;
  /**
   * False when the agent reaches this file only through roots whose import handling is not
   * documented (see `ImportsUncertainty`).
   */
  readonly documented: boolean;
  /** Why, when `documented` is false: `link` when a symlinked root reaches the file. */
  readonly uncertainty?: ImportsUncertainty;
}

/**
 * Files whose imports `dialect` processes: roots and the artifacts they import, at a hop where
 * the agent still follows imports. Sorted by path.
 */
export function filesWithFollowedImports(graph: ImportGraph, dialect: ImportDialect): ParsedFile[] {
  const maxHops = MAX_HOPS[dialect];
  const roots = importRoots(graph, dialect);
  const { hops } = graph.reach(roots, dialect, maxHops);
  const uncertainty = new Map(
    roots.map((root) => [root, importsUncertainty(graph, root, dialect)]),
  );
  const documentedRoots = roots.filter((root) => uncertainty.get(root) === undefined);
  const linkRoots = roots.filter((root) => uncertainty.get(root) === 'link');
  const documented =
    documentedRoots.length === roots.length
      ? hops
      : graph.reach(documentedRoots, dialect, maxHops).hops;
  const viaLinks =
    linkRoots.length === 0
      ? undefined
      : graph.reach([...documentedRoots, ...linkRoots], dialect, maxHops).hops;
  const within = (reached: ReadonlyMap<Artifact, number> | undefined, artifact: Artifact) => {
    const hop = reached?.get(artifact);
    return hop !== undefined && hop < maxHops;
  };
  const files: ParsedFile[] = [];
  for (const [artifact, hop] of hops) {
    if (hop >= maxHops) continue;
    if (within(documented, artifact)) {
      files.push({ artifact, hop, documented: true });
      continue;
    }
    files.push({
      artifact,
      hop,
      documented: false,
      uncertainty: within(viaLinks, artifact) ? 'link' : 'project-rule',
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
  graph: ImportGraph,
  importer: Artifact,
  edge: ImportEdge,
  dialect: ImportDialect,
): UnresolvedImport | undefined {
  const { snapshot } = graph;
  const { reference, target } = edge;
  if (reference.kind !== 'relative' || target === undefined) return undefined;
  const trimmed = withoutTrailingPunctuation(reference.path);
  if (dialect === 'claude' && !looksLikeFilePath(trimmed)) return undefined;
  if (pathStatus(snapshot, target) !== 'missing') return undefined;

  let path = reference.path;
  let withoutPunctuation: string | undefined;
  if (trimmed !== reference.path && trimmed !== '') {
    // Resolved like the edge itself (see `ImportGraph.edges`).
    const from = graph.rootPath(importer, dialect) ?? importer.path;
    const trimmedTarget = joinRelative(dirnamePosix(from), trimmed);
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
  const undocumented = (root: Artifact): number =>
    Number(importsUncertainty(graph, root, dialect) !== undefined);
  const ordered = [...roots].sort((a, b) => undocumented(a) - undocumented(b));
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

function within(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

/**
 * How a Gemini CLI import in `file` leaves the project root, as instr/import-outside-root reports
 * it. Gemini CLI replaces such an import with an "Import failed ... Path traversal attempt"
 * comment (memoryImportProcessor.ts, `validateImportPath`):
 * - `absolute`: an absolute path, which resolves outside the project.
 * - `relative`: a relative path that resolves outside the project root, the nearest directory
 *   with `.git` at or above the directory the import resolves from. Undefined when the scan shows
 *   no `.git` there: the root may lie above the scan root.
 * Undefined for `~/` paths, which Gemini CLI does not read as imports, and for imports inside the
 * project root.
 */
export function geminiImportOutsideRoot(
  graph: ImportGraph,
  file: Artifact,
  edge: ImportEdge,
): 'absolute' | 'relative' | undefined {
  const { reference, target } = edge;
  switch (reference.kind) {
    case 'home':
      return undefined;
    case 'absolute':
      return 'absolute';
    case 'relative': {
      // From where the import resolves: the link's directory for a GEMINI.md symlink.
      const from = graph.rootPath(file, 'gemini') ?? file.path;
      const projectRoot = nearestGitRoot(graph.snapshot, dirnamePosix(from));
      if (projectRoot === undefined) return undefined;
      if (target !== undefined && within(target, projectRoot)) return undefined;
      return 'relative';
    }
  }
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
