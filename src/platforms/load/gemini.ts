/**
 * What Gemini CLI loads for a session started in one directory (docs/platforms.md, "Gemini CLI",
 * and the sources it cites; source code read at google-gemini/gemini-cli ed96fae):
 *
 * - Context file names: `context.fileName` from `<cwd>/.gemini/settings.json`, then GEMINI.md
 *   (src/platforms/gemini.ts). `setGeminiMdFilename` adds the configured names in front of the
 *   ones it already holds, which at startup is GEMINI.md, so GEMINI.md is always read
 *   (packages/core/src/tools/memoryTool.ts lines 22-48, `setGeminiMdFilename`;
 *   packages/cli/src/config/config.ts lines 620-628, where `settings.context?.fileName` is the
 *   only key read). The configuration reference and the trusted folders page disagree on the
 *   default of folder trust, and the source merges the schema's default (on); the plan follows
 *   the trusted folders page, which says it is off.
 * - At startup: every name in every directory from the project root (the nearest directory with
 *   `.git`) down to the working directory. The source sorts the paths it found
 *   (`getEnvironmentMemoryPaths` in memoryDiscovery.ts), which puts the root first unless a
 *   directory name sorts before the file name; positions follow that sort. A file that is blank
 *   once trimmed adds nothing (`concatenateInstructions`).
 * - Imports: `@path` in each context file, up to five hops, through the shared import graph
 *   (./imports.ts). An import outside the project root, or of a file that does not exist, becomes
 *   an "Import failed" comment (memoryImportProcessor.ts).
 * - Just in time: the same names in directories below the working directory, when a tool
 *   accesses a path there (`loadJitSubdirectoryMemory`).
 * - Skills: `SKILL.md` and `<name>/SKILL.md` in the working directory's `.gemini/skills` and
 *   `.agents/skills`; `.agents/skills` wins on a name. The listing is in the prompt at startup;
 *   the body loads when the model activates the skill and the user consents. Whether a skill is
 *   listed is decided by src/platforms/gemini-skills.ts, which the skill rules share.
 * - MCP servers in the working directory's settings connect at startup: folder trust is off by
 *   default, so no trust prompt comes first. `mcp.excluded` and `mcp.allowed` turn servers off.
 * - Hooks in the same settings run after the user accepts them: Gemini CLI fingerprints project
 *   hooks and warns before a new or changed one runs. `hooksConfig.enabled: false` and
 *   `hooksConfig.disabled` turn them off.
 *
 * Every decision a rule also makes goes through the function that rule uses, and a skip carries
 * the rule's id only when that rule reports the same file. User, system and extension scopes are
 * listed in `hidden`, never read.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { codePointLength, estimateTokens, tokensOf, utf8ByteLength } from '../../core/measure.js';
import { dirnamePosix, pathStatus } from '../../core/paths.js';
import type { Artifact } from '../../core/types.js';
import { isObject, issueKind, own, ownObject } from '../../parse/json-access.js';
import type { ImportReference, JsonDocument, MarkdownDocument } from '../../parse/types.js';
import { classify } from '../classify.js';
import {
  GEMINI_SETTINGS_FILE,
  type GeminiContextFiles,
  geminiContextFileNames,
  geminiNamingDirectories,
  isNamed,
} from '../gemini.js';
import { type GeminiSkipReason, geminiSkillVerdict } from '../gemini-skills.js';
import { HOOK_EVENTS, hookEvents, hookHandlers } from '../hooks.js';
import { hookInventoryIds, mcpInventoryIds } from '../inventory-ids.js';
import { MARKDOWN_OR_IMPORTED_KINDS } from '../kinds.js';
import { isBundledSkill, skillDirectoryOf } from '../location.js';
import { mcpServers } from '../mcp.js';
import { basename, inPayloadFolder, joinPath, nearestGitRoot, selfAndAncestors } from '../paths.js';
import { effectiveReaders } from '../readers.js';
import { bodyOffset, GEMINI_SKILL_ROOTS, skillLocation } from '../skills.js';
import { isBlank } from './codex-text.js';
import {
  filesWithFollowedImports,
  geminiImportOutsideRoot,
  type ImportEdge,
  ImportGraph,
  importRoots,
  importsPastLimit,
  looksLikeFilePath,
  MAX_HOPS,
  tooDeepImports,
  unresolvedImport,
  withoutTrailingPunctuation,
} from './imports.js';
import type {
  Assumption,
  Certainty,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  OutOfScope,
  Size,
  SkipCode,
  SkippedLoad,
  SourceKey,
} from './types.js';
import { TRIGGER_RANK } from './types.js';
import type { LoadView } from './view.js';

export interface GeminiLoadOptions {
  /** Working directory, root-relative POSIX without a trailing slash; `''` is the scan root. */
  readonly cwd: string;
  readonly config: ResolvedConfig;
  /** Not used: Gemini CLI documents no limit that depends on the context window. */
  readonly contextWindow?: number;
}

type Evidence = readonly SourceKey[];
/** Which files Gemini CLI reads, and in what order. */
const MEMORY: Evidence = ['geminiMd', 'geminiDiscoverySource'];
/** `context.fileName` and the default name. */
const NAMES: Evidence = ['geminiMd', 'geminiCliConfigSource', 'geminiMemoryToolSource'];
const IMPORTS: Evidence = ['geminiImports', 'geminiImportSource'];
const SKILLS: Evidence = ['geminiSkills', 'geminiSkillLoaderSource'];
/** The workspace settings are those of the working directory. */
const SETTINGS: Evidence = ['geminiSettingsSource'];
const MCP: Evidence = ['geminiMcp', 'geminiTrustedFolders'];
const HOOKS: Evidence = ['geminiHooks'];
const CONFIGURATION: Evidence = ['geminiConfiguration'];

/** Scopes outside the repository that add to what Gemini CLI loads. Listed, never read. */
const HIDDEN: readonly HiddenScope[] = [
  {
    scope: 'managed',
    locations: [
      '/Library/Application Support/GeminiCli/settings.json',
      '/etc/gemini-cli/settings.json',
      '/etc/gemini-cli/system-defaults.json',
      'C:\\ProgramData\\gemini-cli\\settings.json',
    ],
    roles: ['hook', 'instructions', 'mcp-server'],
  },
  {
    scope: 'plugin',
    locations: ['Gemini CLI extensions'],
    roles: ['hook', 'instructions', 'mcp-server', 'skill'],
  },
  {
    scope: 'user',
    locations: [
      '~/.agents/skills/',
      '~/.gemini/GEMINI.md',
      '~/.gemini/mcp-server-enablement.json',
      '~/.gemini/settings.json',
      '~/.gemini/skills/',
      '~/.gemini/tmp/<project>/memory/',
    ],
    roles: ['hook', 'instructions', 'mcp-server', 'skill'],
  },
];

/** The skip code and reporting rule of each reason Gemini CLI skips a skill for. */
const SKILL_SKIPS: Readonly<
  Record<
    GeminiSkipReason | 'no-fields',
    { readonly code: SkipCode; readonly ruleId?: string; readonly certainty: Certainty }
  >
> = {
  'no-frontmatter': {
    code: 'no-frontmatter',
    ruleId: 'skill/frontmatter-missing',
    certainty: 'source-code',
  },
  unsupported: {
    code: 'invalid-frontmatter',
    ruleId: 'skill/frontmatter-invalid',
    certainty: 'source-code',
  },
  // The loader at ed96fae accepts a byte order mark before `---`; the rule follows an older one.
  bom: { code: 'bom', ruleId: 'skill/frontmatter-bom', certainty: 'unverified' },
  'not-a-mapping': {
    code: 'invalid-frontmatter',
    ruleId: 'skill/frontmatter-invalid',
    certainty: 'source-code',
  },
  'no-description': {
    code: 'no-description',
    ruleId: 'skill/description-missing',
    certainty: 'source-code',
  },
  'no-name': {
    code: 'invalid-frontmatter',
    ruleId: 'skill/name-missing',
    certainty: 'source-code',
  },
  // YAML that does not parse, read line by line without a `name:` or `description:` line.
  'no-fields': { code: 'invalid-frontmatter', certainty: 'source-code' },
};

function size(text: string, bytes: number = utf8ByteLength(text)): Size {
  return { bytes, chars: codePointLength(text), tokens: estimateTokens(text) };
}

function fileSize(artifact: Artifact): Size {
  return size(artifact.decoded.text, artifact.file.bytes.length);
}

function within(path: string, directory: string): boolean {
  return directory === '' || path === directory || path.startsWith(`${directory}/`);
}

/** Strictly below `directory`. */
function below(path: string, directory: string): boolean {
  return path !== directory && within(path, directory);
}

function weakest(a: Certainty, b: Certainty): Certainty {
  const rank: Readonly<Record<Certainty, number>> = {
    documented: 0,
    'source-code': 1,
    unverified: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

/** The directory a context file name is resolved in: `a/b/X.md` named `b/X.md` -> `a`. */
function nameDirectory(path: string, name: string): string {
  return path === name ? '' : path.slice(0, path.length - name.length - 1);
}

/** A context file Gemini CLI loads by itself and expands the imports of. */
interface Root {
  readonly path: string;
  readonly artifact: Artifact;
  readonly trigger: 'startup' | 'on-path';
  readonly patterns?: readonly string[];
  readonly certainty: Certainty;
}

interface Frame {
  readonly artifact: Artifact;
  readonly path: string;
  readonly via: readonly string[];
  readonly edges: readonly ImportEdge[];
  next: number;
}

interface ListedSkill {
  readonly path: string;
  readonly artifact: Artifact;
  /** Index into GEMINI_SKILL_ROOTS. */
  readonly root: number;
  readonly name: string;
  readonly description: string;
  readonly certainty: Certainty;
}

class GeminiLoader {
  readonly #view: LoadView;
  readonly #cwd: string;
  readonly #graph: ImportGraph;
  readonly #names: GeminiContextFiles;
  /** Directories Gemini CLI looks in at startup, the project root first. */
  readonly #chain: readonly string[];
  readonly #gitRoot: string | undefined;

  readonly #entries = new Map<string, LoadEntry>();
  readonly #skipped = new Map<string, SkippedLoad>();
  readonly #outOfScope = new Map<string, OutOfScope>();
  readonly #incomplete = new Set<string>();
  /** Artifacts with an instructions or import entry, so each file loads once. */
  readonly #loaded = new Set<Artifact>();
  readonly #unreadImports = new Set<string>();
  #position = 0;
  /** Hops of each import, for the hop limit. */
  readonly #hops: { readonly path: string; readonly value: number }[] = [];

  #followed: ReadonlySet<Artifact> | undefined;
  #tooDeep: ReadonlySet<string> | undefined;

  constructor(view: LoadView, options: GeminiLoadOptions) {
    this.#view = view;
    this.#cwd = options.cwd;
    this.#graph = new ImportGraph(view);
    this.#names = geminiContextFileNames(view, options.cwd);
    this.#gitRoot = nearestGitRoot(view.snapshot, options.cwd);
    const upward = selfAndAncestors(options.cwd);
    const top = this.#gitRoot === undefined ? upward.length : upward.indexOf(this.#gitRoot) + 1;
    this.#chain = upward.slice(0, top).reverse();
  }

  build(): LoadPlan {
    this.#settings();
    this.#instructions();
    this.#skills();
    return this.#plan();
  }

  // -------------------------------------------------------------------------------------------
  // Context files and imports
  // -------------------------------------------------------------------------------------------

  /**
   * Directories above the working directory count only when the scan shows the project root:
   * without a `.git`, Gemini CLI stops at the working directory, unless one lies above the scan
   * root.
   */
  #chainCertainty(directory: string): Certainty {
    return this.#gitRoot === undefined && directory !== this.#cwd ? 'unverified' : 'documented';
  }

  /** Where a directory sits: on the startup chain, below the working directory, or neither. */
  #place(directory: string): 'chain' | 'below' | undefined {
    if (this.#chain.includes(directory)) return 'chain';
    return below(directory, this.#cwd) ? 'below' : undefined;
  }

  /** The context file name `path` matches, and the directory Gemini CLI finds it from. */
  #nameOf(path: string): { readonly name: string; readonly directory: string } | undefined {
    for (const name of this.#names.names) {
      if (isNamed(path, name)) return { name, directory: nameDirectory(path, name) };
    }
    return undefined;
  }

  #instructions(): void {
    const { index, snapshot } = this.#view;
    const startup: Root[] = [];
    for (const directory of this.#chain) {
      for (const name of this.#names.names) {
        const path = joinPath(directory, name);
        const artifact = index.get(path);
        if (artifact === undefined) {
          if (this.#mayExist(path)) this.#incomplete.add(`unread:${path}`);
          continue;
        }
        if (!MARKDOWN_OR_IMPORTED_KINDS.has(artifact.kind)) continue;
        startup.push({
          path,
          artifact,
          trigger: 'startup',
          certainty: this.#chainCertainty(directory),
        });
      }
    }
    // Gemini CLI sorts the paths it found, and reads a file reached twice once.
    startup.sort((a, b) => compareStrings(a.path, b.path));
    const seen = new Set<Artifact>();
    for (const root of startup) {
      if (seen.has(root.artifact)) continue;
      seen.add(root.artifact);
      this.#loadRoot(root);
    }

    const later: Root[] = [];
    for (const [path, artifact] of index) {
      const named = this.#nameOf(path);
      if (named === undefined || this.#place(named.directory) !== 'below') continue;
      if (!MARKDOWN_OR_IMPORTED_KINDS.has(artifact.kind)) continue;
      if (inPayloadFolder(path)) {
        this.#out(path, 'payload-folder');
        continue;
      }
      later.push({
        path,
        artifact,
        trigger: 'on-path',
        patterns: [`${named.directory}/**`],
        certainty: 'documented',
      });
    }
    later.sort((a, b) => compareStrings(a.path, b.path));
    for (const root of later) this.#loadRoot(root);

    // Named files below the working directory that the walk did not read.
    const unread = new Set<string>([
      ...snapshot.ignoredFiles,
      ...snapshot.skipped.map((s) => s.path),
    ]);
    for (const path of snapshot.paths) if (!path.endsWith('/')) unread.add(path);
    for (const path of unread) {
      if (index.has(path)) continue;
      const named = this.#nameOf(path);
      if (named !== undefined && this.#place(named.directory) === 'below') {
        this.#incomplete.add(`unread:${path}`);
      }
    }

    this.#unnamedFiles();
    this.#caseMismatches();
  }

  #loadRoot(root: Root): void {
    if (this.#loaded.has(root.artifact)) return;
    if (isBlank(root.artifact.decoded.text)) {
      // Gemini CLI trims each file and drops the empty ones (`concatenateInstructions`).
      this.#skip({
        role: 'instructions',
        path: root.path,
        code: 'blank-file',
        ...(this.#readersInclude(root.artifact) ? { ruleId: 'instr/empty-file' } : {}),
        size: fileSize(root.artifact),
        certainty: weakest(root.certainty, 'source-code'),
        evidence: MEMORY,
      });
      return;
    }
    this.#addEntry('instructions', root.path, root.artifact, root, undefined);
    this.#expand(root);
  }

  /** Whether the rules count Gemini CLI among the readers of `artifact` (targetedReaders). */
  #readersInclude(artifact: Artifact): boolean {
    return effectiveReaders(this.#view, artifact).includes('gemini');
  }

  #markdown(artifact: Artifact): MarkdownDocument {
    const doc = this.#view.markdown(artifact);
    if (!doc.analysis.complete) this.#incomplete.add(`markdown-budget:${artifact.path}`);
    return doc;
  }

  #addEntry(
    role: 'instructions' | 'import',
    path: string,
    artifact: Artifact,
    root: Root,
    via: readonly string[] | undefined,
  ): void {
    this.#markdown(artifact);
    this.#loaded.add(artifact);
    this.#add({
      id: `${role}:${path}`,
      role,
      trigger: root.trigger,
      ...(root.trigger === 'startup' ? { position: ++this.#position } : {}),
      path,
      realPath: artifact.realPath,
      ...(via === undefined ? {} : { via }),
      ...(root.patterns === undefined ? {} : { patterns: root.patterns }),
      size: fileSize(artifact),
      certainty: root.certainty,
      evidence: role === 'import' ? IMPORTS : MEMORY,
    });
  }

  #frame(artifact: Artifact, path: string, via: readonly string[]): Frame {
    return { artifact, path, via, edges: this.#graph.edges(artifact, 'gemini'), next: 0 };
  }

  /**
   * Imports of `root` in the order Gemini CLI inlines them: depth first, in source order. A file's
   * imports are followed while it is less than five hops from the root by its shortest chain, as
   * instr/import-depth counts them. Gemini CLI inlines a file once per import chain; the plan lists
   * each file once.
   */
  #expand(root: Root): void {
    const maxHops = MAX_HOPS.gemini;
    const reach = this.#graph.reach([root.artifact], 'gemini', maxHops);
    if (!this.#graph.hasBudget()) this.#incomplete.add(`import-budget:${root.path}`);
    // Without a `.git` at or above the file, Gemini CLI rejects every import as outside the
    // project, unless a `.git` lies above the scan root.
    const projectRoot = nearestGitRoot(this.#view.snapshot, dirnamePosix(root.path));
    const certainty = projectRoot === undefined ? 'unverified' : root.certainty;
    const child: Root = { ...root, certainty };
    const visited = new Set<Artifact>([root.artifact]);
    const stack: Frame[] = [this.#frame(root.artifact, root.path, [])];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const edge = frame.edges[frame.next];
      if (edge === undefined) {
        stack.pop();
        continue;
      }
      frame.next++;
      if (this.#checkImport(frame.artifact, edge, certainty)) continue;
      const { target } = edge;
      if (target === undefined) continue;
      const artifact = this.#view.index.get(target);
      const via = [...frame.via, frame.path];
      if (artifact === undefined) {
        this.#unreadImport(edge.reference, target, child, via, reach.targets.get(target) ?? 1);
        continue;
      }
      const hop = reach.hops.get(artifact);
      if (hop === undefined || visited.has(artifact)) continue;
      visited.add(artifact);
      if (!this.#loaded.has(artifact)) {
        this.#addEntry('import', target, artifact, child, via);
        this.#hops.push({ path: target, value: hop });
      }
      if (hop < maxHops) stack.push(this.#frame(artifact, target, via));
    }

    for (const item of importsPastLimit(this.#graph, root.artifact, reach, 'gemini')) {
      const key = `${item.file.path}\u0000${String(item.reference.span.offset)}`;
      this.#skip({
        role: 'import',
        path: item.file.path,
        name: item.target,
        code: 'import-too-deep',
        ...(this.#tooDeepKeys().has(key) ? { ruleId: 'instr/import-depth' } : {}),
        certainty,
        evidence: IMPORTS,
      });
      this.#hops.push({ path: item.file.path, value: maxHops + 1 });
    }
  }

  /**
   * Skips for one import, in the order Gemini CLI checks it: outside the project root, then
   * missing. True when Gemini CLI does not load the import.
   */
  #checkImport(file: Artifact, edge: ImportEdge, certainty: Certainty): boolean {
    const { reference } = edge;
    // The import rules judge every file whose imports Gemini CLI follows from any root.
    const ruleId = (id: string): { readonly ruleId?: string } =>
      this.#followedFiles().has(file) ? { ruleId: id } : {};
    if (geminiImportOutsideRoot(this.#graph, file, edge) !== undefined) {
      this.#skip({
        role: 'import',
        path: file.path,
        name: reference.path,
        code: 'import-outside-root',
        ...ruleId('instr/import-outside-root'),
        certainty: weakest(certainty, 'source-code'),
        evidence: IMPORTS,
      });
      return true;
    }
    const unresolved = unresolvedImport(this.#graph, file, edge, 'gemini');
    if (unresolved === undefined) return false;
    this.#skip({
      role: 'import',
      path: file.path,
      name: unresolved.path,
      code: 'import-unresolved',
      ...ruleId('instr/import-unresolved'),
      certainty,
      evidence: IMPORTS,
    });
    return true;
  }

  /**
   * An import of a file agentcheckup did not read, such as a README. A file that exists is listed
   * without a size, and its own imports cannot be followed, so the plan is incomplete.
   */
  #unreadImport(
    reference: ImportReference,
    target: string,
    root: Root,
    via: readonly string[],
    hop: number,
  ): void {
    if (!this.#mayExist(target)) return;
    if (pathStatus(this.#view.snapshot, target) === 'unknown') {
      if (looksLikeFilePath(withoutTrailingPunctuation(reference.path))) {
        this.#incomplete.add(`unread:${target}`);
      }
      return;
    }
    this.#incomplete.add(`unread:${target}`);
    if (this.#unreadImports.has(target)) return;
    this.#unreadImports.add(target);
    this.#add({
      id: `import:${target}`,
      role: 'import',
      trigger: root.trigger,
      ...(root.trigger === 'startup' ? { position: ++this.#position } : {}),
      path: target,
      realPath: target,
      via,
      ...(root.patterns === undefined ? {} : { patterns: root.patterns }),
      certainty: root.certainty,
      evidence: IMPORTS,
    });
    this.#hops.push({ path: target, value: hop });
  }

  /**
   * Files a session started elsewhere reads, but this one does not: an AGENTS.md that
   * `context.fileName` does not name (Gemini CLI reads only GEMINI.md without it), and files that
   * the settings of a directory below the working directory name, which a session started there
   * reads.
   */
  #unnamedFiles(): void {
    const { index, snapshot } = this.#view;
    for (const [path, artifact] of index) {
      if (this.#loaded.has(artifact) || this.#nameOf(path) !== undefined) continue;
      const place = this.#place(dirnamePosix(path));
      if (place === undefined || !MARKDOWN_OR_IMPORTED_KINDS.has(artifact.kind)) continue;
      const deeper = geminiNamingDirectories(this.#view, path).some((cwd) => below(cwd, this.#cwd));
      if (deeper) {
        this.#out(path, 'below-start-dir');
        continue;
      }
      if (basename(path) !== 'AGENTS.md' || classify(path)?.kind !== 'agents-md') continue;
      if (inPayloadFolder(path) || skillDirectoryOf(snapshot, path) !== undefined) continue;
      this.#skip({
        role: 'instructions',
        path,
        code: 'not-read',
        size: fileSize(artifact),
        certainty: 'documented',
        evidence: NAMES,
      });
    }
  }

  /**
   * GEMINI.md files whose names match only when case is ignored. Gemini CLI looks for the exact
   * name, so on a case-sensitive file system it does not find them (instr/filename-case).
   */
  #caseMismatches(): void {
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'gemini-md' || artifact.caseMismatch === undefined) continue;
      if (this.#place(dirnamePosix(artifact.path)) === undefined) continue;
      this.#skip({
        role: 'instructions',
        path: artifact.path,
        code: 'case-mismatch',
        ...(this.#readersInclude(artifact) ? { ruleId: 'instr/filename-case' } : {}),
        size: fileSize(artifact),
        certainty: 'source-code',
        evidence: MEMORY,
      });
    }
  }

  /** True when a file exists at `path` or might: not missing and not a directory. */
  #mayExist(path: string): boolean {
    const status = pathStatus(this.#view.snapshot, path);
    if (status === 'missing') return false;
    return status === 'unknown' || !this.#view.snapshot.paths.has(`${path}/`);
  }

  // -------------------------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------------------------

  #skills(): void {
    const { index, snapshot } = this.#view;
    const roots = GEMINI_SKILL_ROOTS.map((segment) => joinPath(this.#cwd, segment));
    const listed: ListedSkill[] = [];
    for (const [path, artifact] of index) {
      if (artifact.kind !== 'skill') continue;
      const caseMismatch =
        path === artifact.path
          ? artifact.caseMismatch !== undefined
          : classify(path)?.caseMismatch !== undefined;
      const location = skillLocation(path, caseMismatch);
      if (location === undefined) continue;
      const root = roots.indexOf(location.root);
      const base = { id: `skill:${path}`, role: 'skill', path } as const;
      if (root === -1) {
        // Another directory's skills folders: a session started there reads them.
        const owner = dirnamePosix(dirnamePosix(location.root));
        const ours = GEMINI_SKILL_ROOTS.some((segment) => isNamed(location.root, segment));
        if (!ours || !location.platforms.has('gemini')) continue;
        if (below(owner, this.#cwd)) this.#out(path, 'below-start-dir');
        else if (within(this.#cwd, owner)) {
          this.#skip({ ...base, code: 'not-read', certainty: 'source-code', evidence: SKILLS });
        }
        continue;
      }
      // The rules judge neither skills bundled in another skill nor skills in template, example
      // or fixture folders, so the plan leaves them out too.
      if (isBundledSkill(snapshot, artifact.path) || inPayloadFolder(artifact.path)) {
        this.#out(path, 'payload-folder');
        continue;
      }
      if (!location.platforms.has('gemini')) {
        // A skill in a category folder: Gemini CLI looks only one level deep.
        this.#skip({ ...base, code: 'not-read', certainty: 'source-code', evidence: SKILLS });
        continue;
      }
      const frontmatter = this.#view.frontmatter(artifact);
      const verdict = geminiSkillVerdict(frontmatter, artifact.decoded);
      if (verdict.kind === 'unchecked') {
        this.#incomplete.add(`unparsed:${path}`);
        continue;
      }
      if (verdict.kind === 'skipped') {
        const skip = SKILL_SKIPS[verdict.reason];
        this.#skip({
          ...base,
          code: skip.code,
          ...(skip.ruleId === undefined ? {} : { ruleId: skip.ruleId }),
          // The skill file: its body never reaches the model.
          size: fileSize(artifact),
          certainty: skip.certainty,
          evidence: SKILLS,
        });
        continue;
      }
      const name = verdict.name.trim() === '' ? basename(dirnamePosix(path)) : verdict.name;
      // Found on case-insensitive file systems only; the listing order within a folder is the
      // order of a file search.
      let certainty: Certainty = verdict.fields === 'yaml' ? 'documented' : 'source-code';
      if (verdict.fields === 'unknown' || caseMismatch) certainty = 'unverified';
      listed.push({
        path,
        artifact,
        root,
        name,
        description: verdict.description.trim(),
        certainty,
      });
    }

    // A skill in a later folder overrides one with the same name in an earlier folder.
    const winner = new Map<string, number>();
    for (const skill of listed) {
      winner.set(skill.name, Math.max(winner.get(skill.name) ?? -1, skill.root));
    }
    listed.sort((a, b) => a.root - b.root || compareStrings(a.path, b.path));
    for (const skill of listed) {
      const { path, artifact } = skill;
      if ((winner.get(skill.name) ?? skill.root) > skill.root) {
        this.#skip({
          id: `skill:${path}`,
          role: 'skill',
          path,
          name: skill.name,
          code: 'shadowed-by-preferred',
          certainty: 'documented',
          evidence: ['geminiSkills'],
        });
        continue;
      }
      const offset = bodyOffset(this.#view.frontmatter(artifact));
      const listing = skill.description === '' ? skill.name : `${skill.name}\n${skill.description}`;
      this.#add({
        id: `skill:${path}`,
        role: 'skill',
        trigger: 'startup',
        position: ++this.#position,
        path,
        realPath: artifact.realPath,
        name: skill.name,
        size: size(listing),
        deferred: size(artifact.decoded.text.slice(offset)),
        certainty: skill.certainty,
        evidence: SKILLS,
      });
    }

    // Skill files Gemini CLI would read that the walk did not.
    const unread = new Set<string>([
      ...snapshot.ignoredFiles,
      ...snapshot.skipped.map((s) => s.path),
    ]);
    for (const path of snapshot.paths) if (!path.endsWith('/')) unread.add(path);
    for (const path of unread) {
      if (index.has(path) || basename(path).toLowerCase() !== 'skill.md') continue;
      const location = skillLocation(path);
      if (location !== undefined && roots.includes(location.root)) {
        this.#incomplete.add(`unread:${path}`);
      }
    }
    for (const directory of snapshot.opaqueDirectories) {
      if (roots.some((root) => within(directory.slice(0, -1), root))) {
        this.#incomplete.add(`unread:${directory}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Settings: MCP servers and hooks
  // -------------------------------------------------------------------------------------------

  #settings(): void {
    const cwd = this.#cwd;
    const { index } = this.#view;
    // Settings of other directories: Gemini CLI reads only the working directory's.
    for (const [path, artifact] of index) {
      if (artifact.kind !== 'gemini-settings' || !isNamed(path, GEMINI_SETTINGS_FILE)) continue;
      const owner = nameDirectory(path, GEMINI_SETTINGS_FILE);
      if (owner === cwd) continue;
      if (below(owner, cwd)) this.#out(path, 'below-start-dir');
      else if (within(cwd, owner)) {
        this.#skip({
          role: 'mcp-server',
          path,
          code: 'not-read',
          certainty: 'source-code',
          evidence: SETTINGS,
        });
      }
    }

    const path = joinPath(cwd, GEMINI_SETTINGS_FILE);
    const artifact = index.get(path);
    if (artifact === undefined) {
      if (this.#mayExist(path)) this.#incomplete.add(`unread:${path}`);
      return;
    }
    if (artifact.kind !== 'gemini-settings') return;
    const doc = this.#view.json(artifact);
    if (!doc.ok) {
      this.#invalidSettings(artifact, path, doc);
      return;
    }
    this.#mcpServers(artifact, path, doc);
    this.#hooks(artifact, path, doc);
  }

  /** Settings that do not parse; json/invalid-syntax reports all but parser limits. */
  #invalidSettings(
    artifact: Artifact,
    path: string,
    doc: Extract<JsonDocument, { ok: false }>,
  ): void {
    const issue = doc.errors[0];
    if (issue === undefined || issueKind(issue) === 'limit') {
      this.#incomplete.add(`unparsed:${artifact.path}`);
      return;
    }
    // Comments are allowed: the parse already removed them, as Gemini CLI does.
    this.#skip({
      role: 'mcp-server',
      path,
      code: 'invalid-json',
      ruleId: 'json/invalid-syntax',
      certainty: 'source-code',
      evidence: [...SETTINGS, ...CONFIGURATION],
    });
  }

  #mcpServers(artifact: Artifact, path: string, doc: Extract<JsonDocument, { ok: true }>): void {
    const root = doc.value;
    const mcp = isObject(root) ? ownObject(root, 'mcp') : undefined;
    const list = (key: string): readonly unknown[] | undefined => {
      const value = mcp === undefined ? undefined : own(mcp, key);
      return Array.isArray(value) ? value : undefined;
    };
    const allowed = list('allowed');
    const excluded = list('excluded');
    const servers = mcpServers(artifact, doc);
    const inventoryIds = mcpInventoryIds(artifact.path, servers);
    servers.forEach(({ name }, index) => {
      if (excluded?.includes(name) === true || (allowed !== undefined && !allowed.includes(name))) {
        this.#skip({
          role: 'mcp-server',
          path,
          name,
          code: 'disabled',
          certainty: 'documented',
          evidence: ['geminiMcp', ...CONFIGURATION],
        });
        return;
      }
      this.#add({
        id: `mcp-server:${path}#${name}`,
        role: 'mcp-server',
        trigger: 'startup',
        path,
        realPath: artifact.realPath,
        name,
        inventoryId: inventoryIds[index] ?? '',
        certainty: 'documented',
        evidence: MCP,
      });
    });
  }

  #hooks(artifact: Artifact, path: string, doc: Extract<JsonDocument, { ok: true }>): void {
    const known: readonly string[] = HOOK_EVENTS.gemini;
    for (const event of hookEvents(doc, 'gemini')) {
      if (known.includes(event.name)) continue;
      this.#skip({
        role: 'hook',
        path,
        name: event.name,
        code: 'unknown-event',
        ruleId: 'hooks/unknown-event',
        certainty: 'documented',
        evidence: HOOKS,
      });
    }
    const root = doc.value;
    const config = isObject(root) ? ownObject(root, 'hooksConfig') : undefined;
    const off = config !== undefined && own(config, 'enabled') === false;
    const disabledValue = config === undefined ? undefined : own(config, 'disabled');
    const disabled = Array.isArray(disabledValue) ? disabledValue : [];
    // Ids over every handler, as the inventory numbers them; unknown events are skipped above.
    const handlers = hookHandlers(doc, 'gemini', { includeUnknown: true });
    const ids = hookInventoryIds(path, handlers, 'gemini');
    const inventoryIds = hookInventoryIds(artifact.path, handlers, 'gemini');
    handlers.forEach((handler, index) => {
      if (!handler.known) return;
      const id = ids[index] ?? '';
      const named = [own(handler.handler, 'name'), own(handler.handler, 'command')];
      const listedOff = named.some(
        (value) => typeof value === 'string' && disabled.includes(value),
      );
      if (off || listedOff) {
        this.#skip({
          id,
          role: 'hook',
          path,
          name: handler.event,
          code: 'disabled',
          // How `hooksConfig.disabled` matches a hook is not documented beyond "names (commands)".
          certainty: off ? 'documented' : 'unverified',
          evidence: CONFIGURATION,
        });
        return;
      }
      this.#add({
        id,
        role: 'hook',
        trigger: 'on-approval',
        path,
        realPath: artifact.realPath,
        name: handler.event,
        inventoryId: inventoryIds[index] ?? '',
        certainty: 'documented',
        evidence: HOOKS,
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // What the rules report, computed on the same analysis
  // -------------------------------------------------------------------------------------------

  /** Files whose imports instr/import-unresolved and instr/import-outside-root judge. */
  #followedFiles(): ReadonlySet<Artifact> {
    this.#followed ??= new Set(
      filesWithFollowedImports(new ImportGraph(this.#view), 'gemini').map((file) => file.artifact),
    );
    return this.#followed;
  }

  /** `<file>\0<offset>` of every import instr/import-depth reports as too deep. */
  #tooDeepKeys(): ReadonlySet<string> {
    if (this.#tooDeep === undefined) {
      const graph = new ImportGraph(this.#view);
      this.#tooDeep = new Set(
        tooDeepImports(graph, importRoots(graph, 'gemini'), 'gemini').map(
          (item) => `${item.file.path}\u0000${String(item.reference.span.offset)}`,
        ),
      );
    }
    return this.#tooDeep;
  }

  // -------------------------------------------------------------------------------------------
  // The plan
  // -------------------------------------------------------------------------------------------

  #add(entry: LoadEntry): void {
    if (!this.#entries.has(entry.id)) this.#entries.set(entry.id, entry);
  }

  #skip(skip: Omit<SkippedLoad, 'id'> & { readonly id?: string }): void {
    const id =
      skip.id ??
      (skip.name === undefined
        ? `${skip.role}:${skip.path}`
        : `${skip.role}:${skip.path}#${skip.name}`);
    const { id: _id, ...rest } = skip;
    if (!this.#skipped.has(id)) this.#skipped.set(id, { id, ...rest });
  }

  #out(path: string, because: OutOfScope['because']): void {
    this.#outOfScope.set(`${path}\u0000${because}`, { path, because });
  }

  #assumptions(): Assumption[] {
    return [
      {
        key: 'gemini.access',
        value: 'paid API key or Gemini Code Assist license',
        origin: 'default',
        evidence: ['geminiAntigravity'],
      },
      {
        key: 'gemini.context.fileName',
        value: this.#names.names.join(', '),
        origin: this.#names.origin,
        evidence: NAMES,
      },
      {
        key: 'gemini.folder_trust',
        value: false,
        origin: 'default',
        evidence: ['geminiTrustedFolders'],
      },
    ];
  }

  #limits(): LimitUsage[] {
    let largest: { readonly path: string; readonly value: number } | undefined;
    for (const item of this.#hops) {
      if (
        largest === undefined ||
        item.value > largest.value ||
        (item.value === largest.value && compareStrings(item.path, largest.path) < 0)
      ) {
        largest = item;
      }
    }
    if (largest === undefined) return [];
    return [
      {
        key: 'gemini.import_max_hops',
        unit: 'hops',
        limit: MAX_HOPS.gemini,
        used: largest.value,
        subject: largest.path,
        effect: 'skips',
        evidence: IMPORTS,
      },
    ];
  }

  #plan(): LoadPlan {
    const entries = [...this.#entries.values()].sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.id, b.id),
    );
    const startup = { bytes: 0, chars: 0 };
    const onDemand = { bytes: 0, chars: 0 };
    for (const entry of entries) {
      const total = entry.trigger === 'startup' ? startup : onDemand;
      total.bytes += entry.size?.bytes ?? 0;
      total.chars += entry.size?.chars ?? 0;
      onDemand.bytes += entry.deferred?.bytes ?? 0;
      onDemand.chars += entry.deferred?.chars ?? 0;
    }
    const totalSize = (total: { bytes: number; chars: number }): Size => ({
      ...total,
      tokens: tokensOf(total.chars),
    });
    return {
      agent: 'gemini',
      cwd: this.#cwd,
      entries,
      skipped: [...this.#skipped.values()].sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id),
      ),
      outOfScope: [...this.#outOfScope.values()].sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
      ),
      assumptions: this.#assumptions(),
      hidden: HIDDEN,
      limits: this.#limits(),
      totals: { startup: totalSize(startup), onDemand: totalSize(onDemand) },
      incomplete: [...this.#incomplete].sort(compareStrings),
    };
  }
}

/**
 * The load plan of Gemini CLI for a session started in `options.cwd`. Run it on the analysis the
 * rules ran on, after them: it reads the same cached parses.
 */
export function loadGemini(view: LoadView, options: GeminiLoadOptions): LoadPlan {
  return new GeminiLoader(view, options).build();
}
