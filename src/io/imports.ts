/**
 * The walker's import pass: which imported files to read after the walk. No I/O here; the walker
 * reads what the planner asks for (Walker.readImports in walk.ts), and scripts/corpus replays the
 * same plan from a git tree.
 *
 * Claude Code expands `@path` imports in the instruction files it loads, Gemini CLI in
 * GEMINI.md, and Copilot CLI `@path` references in its instruction files, so an imported
 * README.md or docs/guide.md is part of what the agent loads although it is not agent
 * configuration. The walk reads only configuration; without this pass the import rules and the
 * load plans could not size such a file or follow the imports inside it.
 *
 * The plan uses the import rules' and loaders' own code (src/platforms/load/imports.ts and
 * copilot.ts): the same roots (importRoots, which include a file that a symlinked CLAUDE.md or
 * GEMINI.md points to, and copilotCliImportRoots), the same extraction (ImportGraph.edges over the
 * engine's Markdown parser, with a budget of its own; Copilot CLI's references as Claude Code's),
 * the same resolution relative to the importing file (or to the symlink it was loaded through),
 * imports inside HTML comments skipped for Claude Code, and the same hop limits (MAX_HOPS: 4 for
 * Claude Code, 5 for Gemini CLI; Copilot CLI documents none, so only the caps below stop it).
 * Copilot CLI does not expand references in GEMINI.md or `*.instructions.md` files it reached
 * through one. It is a breadth-first search, one hop per round, so when a cap stops the pass the
 * files closest to the instruction files are the ones that were read. Within a round targets are
 * sorted, so the result does not depend on timing.
 *
 * A target is read only when the walk listed it as a file (inside the root, not ignored, not
 * below an opaque directory, not a link whose target was not looked at), it is text by its name
 * (isTextImportTarget), and nothing tried to read it before. Everything else stays as the walk
 * left it: an existing file that was not read, which the loaders report as such.
 */
import { compareStrings } from '../core/compare.js';
import { EMPTY_CONFIG } from '../core/config.js';
import { analyze, buildArtifacts } from '../core/engine.js';
import type { ParseCache } from '../core/parse-cache.js';
import type { Artifact, Snapshot, SourceFile } from '../core/types.js';
import type { ImportDialect } from '../parse/types.js';
import {
  COPILOT_CLI_IMPORT_DIALECT,
  copilotCliExpandsImported,
  copilotCliImportRoots,
} from '../platforms/load/copilot.js';
import { ImportGraph, importRoots, inHtmlComment, MAX_HOPS } from '../platforms/load/imports.js';
import { isTextImportTarget } from './filters.js';

/** At most this many files are added by the import pass. Past it, targets are `import-limit`. */
export const MAX_IMPORTED_FILES = 200;

/**
 * At most this many bytes are read by the import pass, on top of the walk's own reads (and within
 * its maxTotalBytes). Past it, targets are `import-limit`. Each file is also held to the walk's
 * per-file cap, maxFileBytes.
 */
export const MAX_IMPORTED_BYTES = 8 * 1024 * 1024;

/**
 * Markdown the planner may parse to find imports, in characters and lines: a quarter of the
 * scan's own budget (SCAN_MARKDOWN_BUDGET, docs/adr/0003), on top of it, because the engine parses
 * the same files again unless it shares the planner's `parseCache`. The largest corpus repository
 * needs about 190 KB for its instruction files. Past it, imports in further files are not
 * followed, and their targets stay unread.
 */
export const IMPORT_MARKDOWN_BUDGET = 4 * 1024 * 1024;
export const IMPORT_MARKDOWN_LINE_BUDGET = 150_000;

/** One agent's way of following imports: the import rules' dialects, and Copilot CLI's. */
type Search = ImportDialect | 'copilot-cli';

const SEARCHES: readonly Search[] = ['claude', 'gemini', 'copilot-cli'];

/** How each search finds and resolves the imports in a file. */
const SEARCH_DIALECT: Readonly<Record<Search, ImportDialect>> = {
  claude: 'claude',
  gemini: 'gemini',
  'copilot-cli': COPILOT_CLI_IMPORT_DIALECT,
};

/** Hops each search follows. Copilot CLI documents no limit; the pass's caps bound it. */
const SEARCH_MAX_HOPS: Readonly<Record<Search, number>> = {
  ...MAX_HOPS,
  'copilot-cli': Number.POSITIVE_INFINITY,
};

function perSearch<T>(value: () => T): Record<Search, T> {
  return { claude: value(), gemini: value(), 'copilot-cli': value() };
}

interface Waiting {
  readonly search: Search;
  readonly hop: number;
}

export interface ImportPlannerOptions {
  /**
   * Import references the planner may visit, across all files and rounds, so a hostile
   * repository cannot stall the walk. Past it, the pass ends after the targets already found.
   * Default: the import graph's own cap, the one the import rules use.
   */
  readonly maxEdgeVisits?: number;
  /**
   * Decoded texts and parses to share with the scan of the finished snapshot. A parse the scan's
   * own budget would analyze differently is not reused (see ParseCache), so the plan and the scan
   * are what they are without it.
   */
  readonly parseCache?: ParseCache;
}

/**
 * Plans the import pass over the snapshot of a finished walk. Call `next()` for the targets to
 * read, report each with `done()`, and repeat until `next()` returns nothing.
 */
export class ImportPlanner {
  readonly #snapshot: Snapshot;
  readonly #graph: ImportGraph;
  /** Artifact by every path that reaches it, growing as imported files are read. */
  readonly #index: Map<string, Artifact>;
  /** Paths that need no read: files of the walk, targets it skipped, targets asked for. */
  readonly #settled: Set<string>;
  readonly #hops: Record<Search, Map<Artifact, number>>;
  /** Relative targets each search has met, at any hop. */
  readonly #met: Record<Search, Set<string>>;
  /** Files to expand in the next round, per search. */
  #frontier: Record<Search, Artifact[]>;
  /** Targets handed out by the last `next()`, and the searches waiting for each. */
  readonly #pending = new Map<string, Waiting[]>();

  constructor(snapshot: Snapshot, options: ImportPlannerOptions = {}) {
    this.#snapshot = snapshot;
    // The engine's own classification, aliasing and Markdown parser, so the plan sees the files
    // as the rules will; only the parse budget is the planner's own.
    const analysis = analyze(snapshot, {
      markdownBudget: IMPORT_MARKDOWN_BUDGET,
      markdownLineBudget: IMPORT_MARKDOWN_LINE_BUDGET,
      ...(options.parseCache === undefined ? {} : { parseCache: options.parseCache }),
    });
    this.#index = new Map(analysis.index);
    this.#graph = new ImportGraph(
      { snapshot, index: this.#index, markdown: analysis.markdown, json: analysis.json },
      options.maxEdgeVisits,
    );
    this.#settled = new Set([
      ...snapshot.files.map((file) => file.path),
      ...snapshot.skipped.map((entry) => entry.path),
    ]);
    this.#hops = perSearch(() => new Map<Artifact, number>());
    this.#met = perSearch(() => new Set<string>());
    this.#frontier = perSearch((): Artifact[] => []);
    for (const search of SEARCHES) {
      const roots =
        search === 'copilot-cli'
          ? copilotCliImportRoots(analysis.artifacts)
          : importRoots(this.#graph, search);
      for (const root of roots) {
        if (this.#hops[search].has(root)) continue;
        this.#hops[search].set(root, 0);
        this.#frontier[search].push(root);
      }
    }
  }

  /**
   * The targets to read next, sorted by code point: the unread files that the files of the
   * nearest hop still to expand import. Empty when the pass is complete. Every target of the
   * previous call must have been reported with `done` first.
   */
  next(): string[] {
    while (SEARCHES.some((search) => this.#frontier[search].length > 0)) {
      if (!this.#graph.hasBudget()) return [];
      const wanted = this.#expand();
      if (wanted.size > 0) {
        for (const [path, waiting] of wanted) this.#pending.set(path, waiting);
        return [...wanted.keys()].sort(compareStrings);
      }
    }
    return [];
  }

  /** Reports what reading `path` gave: the file added to the snapshot, or undefined. */
  done(path: string, file: SourceFile | undefined): void {
    const waiting = this.#pending.get(path) ?? [];
    this.#pending.delete(path);
    if (file === undefined) return;
    const artifact = this.#artifactOf(file);
    if (artifact === undefined) return;
    this.#index.set(path, artifact);
    for (const { search, hop } of waiting) this.#reach(search, artifact, hop);
  }

  /** Whether `search` follows the imports in `file`, reached at `hop`. */
  #expands(search: Search, file: Artifact, hop: number): boolean {
    // The agent does not follow the imports of a file at its hop limit. Without an `@` there is
    // no import, and no need to parse the file.
    if (hop >= SEARCH_MAX_HOPS[search] || !file.decoded.text.includes('@')) return false;
    return search !== 'copilot-cli' || hop === 0 || copilotCliExpandsImported(file.kind);
  }

  /** One round: expands every frontier file and returns the unread targets it imports. */
  #expand(): Map<string, Waiting[]> {
    const wanted = new Map<string, Waiting[]>();
    for (const search of SEARCHES) {
      const frontier = this.#frontier[search];
      this.#frontier[search] = [];
      for (const file of frontier) {
        const hop = this.#hops[search].get(file) ?? 0;
        if (!this.#expands(search, file, hop)) continue;
        const edges = this.#graph.edges(file, SEARCH_DIALECT[search]);
        if (!this.#graph.spend(edges.length)) return wanted;
        for (const { reference, target } of edges) {
          if (target === undefined || this.#met[search].has(target)) continue;
          if (search === 'claude' && inHtmlComment(this.#graph.markdown(file), reference)) {
            continue;
          }
          this.#met[search].add(target);
          const known = this.#index.get(target);
          if (known !== undefined) {
            this.#reach(search, known, hop + 1);
            continue;
          }
          if (!this.#readable(target)) continue;
          const list = wanted.get(target) ?? [];
          list.push({ search, hop: hop + 1 });
          wanted.set(target, list);
        }
      }
    }
    for (const path of wanted.keys()) this.#settled.add(path);
    return wanted;
  }

  #reach(search: Search, artifact: Artifact, hop: number): void {
    if (this.#hops[search].has(artifact)) return;
    this.#hops[search].set(artifact, hop);
    this.#frontier[search].push(artifact);
  }

  /** A listed text file, not read and not tried yet. */
  #readable(path: string): boolean {
    const { paths, opaqueDirectories } = this.#snapshot;
    return (
      !this.#settled.has(path) &&
      paths.has(path) &&
      // A directory, or a symlink whose target was not looked at (outside the root, broken).
      !paths.has(`${path}/`) &&
      !opaqueDirectories.has(`${path}/`) &&
      isTextImportTarget(path)
    );
  }

  /**
   * The artifact the engine will make of `file`: the real file's artifact when `file` reaches,
   * through a symlink, a file that is in the snapshot itself, else its own.
   */
  #artifactOf(file: SourceFile): Artifact | undefined {
    const real = file.symlinkTarget === undefined ? undefined : this.#index.get(file.symlinkTarget);
    if (real !== undefined && real.path === file.symlinkTarget) return real;
    return buildArtifacts({ ...this.#snapshot, files: [file] }, EMPTY_CONFIG)[0];
  }
}
