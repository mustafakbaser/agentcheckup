/**
 * What Claude Code loads for a session started in one directory (docs/platforms.md, "Claude
 * Code"; code.claude.com/docs/en/memory, skills, sub-agents, mcp and hooks):
 *
 * - CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md from the scan root down to the working
 *   directory, root first, CLAUDE.local.md after CLAUDE.md in each directory, each followed by
 *   its imports (up to four hops). The order of CLAUDE.md and .claude/CLAUDE.md in one directory
 *   is not documented. AGENTS.md takes their place only when no CLAUDE file is on the path.
 * - Nested CLAUDE.md files and, when AGENTS.md is read, nested AGENTS.md files load when Claude
 *   works with a file in their directory.
 * - `.claude/rules/` files without `paths` load at launch, with `paths` when Claude works with a
 *   matching file. YAML that does not parse loads the rule as if it had no `paths`.
 * - Skills in `.claude/skills/<name>/SKILL.md` from the working directory up to the repository
 *   root are listed at launch, each listing entry cut at 1,536 characters; nested skills folders
 *   load on demand. Commands load when invoked. Subagents are listed by ./subagents.ts, which
 *   every agent's plan shares.
 * - `.mcp.json` servers load after the user approves them; hooks in `.claude/settings.json` and
 *   `.claude/settings.local.json` run once the workspace is trusted.
 *
 * Every decision a rule also makes goes through the function that rule uses, and a skip carries
 * the rule's id only when that rule reports the same file. Behavior the sources do not state is
 * marked `unverified`. User, managed and plugin scopes are listed in `hidden`, never read.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import {
  codePointLength,
  estimateTokens,
  lineCount,
  tokensOf,
  utf8ByteLength,
  CHARS_PER_TOKEN,
} from '../../core/measure.js';
import { dirnamePosix, pathStatus } from '../../core/paths.js';
import type { Artifact } from '../../core/types.js';
import { issueKind, isTable } from '../../parse/json-access.js';
import type {
  FrontmatterResult,
  ImportReference,
  MarkdownDocument,
  ParseIssue,
} from '../../parse/types.js';
import { classify } from '../classify.js';
import { claudeProjectSettings, settingAt } from '../root-settings.js';
import { HOOK_EVENTS, hookEvents, hookHandlers } from '../hooks.js';
import { hookInventoryIds, mcpInventoryIds } from '../inventory-ids.js';
import { isClaudeMcpConfig, mcpServers, urlWithoutType } from '../mcp.js';
import {
  inClaudeFolder,
  inPayloadFolder,
  joinPath,
  nearestGitRoot,
  selfAndAncestors,
} from '../paths.js';
import {
  CLAUDE_LISTING_MAX_CHARS,
  claudeBoolean,
  claudeSkillListing,
  skillLocation,
} from '../skills.js';
import type { SOURCES } from '../sources.js';
import { yamlSyntaxError } from '../yaml.js';
import { agentsMdShadowedByClaude, rulesByOwner } from './agents-md-shadow.js';
import {
  agentsMdDirectory,
  CLAUDE_FILE_NAMES,
  type ClaudeFileOnPath,
  claudeFilesOnPath,
  claudeImportOutsideRoot,
  claudeImportsUncertainty,
  filesWithFollowedImports,
  type ImportEdge,
  ImportGraph,
  importRoots,
  importsPastLimit,
  inHtmlComment,
  isClaudeAgentsMdLocation,
  looksLikeFilePath,
  MAX_HOPS,
  scanRootIsRepository,
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
  LoadRole,
  OutOfScope,
  Size,
  SkippedLoad,
} from './types.js';
import { TRIGGER_RANK } from './types.js';
import type { LoadView } from './view.js';

export interface ClaudeCodeLoadOptions {
  /** Working directory, root-relative POSIX without a trailing slash; `''` is the scan root. */
  readonly cwd: string;
  /** Rule settings and options: limits and assumptions follow the rules' options. */
  readonly config: ResolvedConfig;
  /** The model's context window in tokens, from `--context-window`. */
  readonly contextWindow?: number;
}

/** Claude Code loads a CLAUDE.md of up to 4 MiB in full and skips a larger one. */
export const CLAUDE_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Lines per CLAUDE.md that Claude Code's documentation recommends staying under. */
export const CLAUDE_ADVISED_LINES = 200;

/** Share of the context window the skill listing may use (`skillListingBudgetFraction`). */
const LISTING_BUDGET_FRACTION = 0.01;

const LINES_RULE = 'instr/claude-md-too-long';
const SHADOW_RULE = 'instr/agents-md-ignored-by-claude';
const CASE_RULE = 'instr/filename-case';

/** Instruction files Claude Code finds by exact name. */
const CASE_CHECKED_KINDS: ReadonlySet<Artifact['kind']> = new Set([
  'agents-md',
  'claude-md',
  'claude-local-md',
]);

type Evidence = readonly (keyof typeof SOURCES)[];
const MEMORY: Evidence = ['claudeMemory'];
const SKILLS: Evidence = ['claudeSkills'];
const SKILL_OVERRIDES: Evidence = ['claudeSkills', 'claudeSettings'];
const MCP: Evidence = ['claudeMcp'];
const HOOKS: Evidence = ['claudeHooks', 'claudeSettings'];

/** Scopes outside the repository that add to what Claude Code loads. Listed, never read. */
const HIDDEN: readonly HiddenScope[] = [
  { scope: 'account', locations: ['claude.ai connectors'], roles: ['mcp-server'] },
  {
    scope: 'managed',
    locations: [
      '/Library/Application Support/ClaudeCode/CLAUDE.md',
      '/Library/Application Support/ClaudeCode/managed-settings.json',
      '/etc/claude-code/CLAUDE.md',
      '/etc/claude-code/managed-settings.json',
      'C:\\Program Files\\ClaudeCode\\CLAUDE.md',
      'C:\\Program Files\\ClaudeCode\\managed-settings.json',
    ],
    roles: ['hook', 'instructions', 'mcp-server', 'skill', 'subagent'],
  },
  {
    scope: 'plugin',
    locations: ['installed plugins'],
    roles: ['command', 'hook', 'mcp-server', 'skill', 'subagent'],
  },
  {
    scope: 'user',
    locations: [
      '~/.claude.json',
      '~/.claude/CLAUDE.md',
      '~/.claude/agents/',
      '~/.claude/commands/',
      '~/.claude/rules/',
      '~/.claude/settings.json',
      '~/.claude/skills/',
    ],
    roles: ['command', 'hook', 'instructions', 'mcp-server', 'rule', 'skill', 'subagent'],
  },
];

/**
 * Where a directory sits relative to the working directory.
 * - `path`: the working directory or one above it.
 * - `below`: inside the working directory.
 * - `elsewhere`: in another branch of the tree.
 */
type Scope = 'path' | 'below' | 'elsewhere';

function scopeOf(directory: string, cwd: string): Scope {
  if (directory === '' || directory === cwd || cwd.startsWith(`${directory}/`)) return 'path';
  if (cwd === '' || directory.startsWith(`${cwd}/`)) return 'below';
  return 'elsewhere';
}

/**
 * Loading on demand is documented for directories below the working directory. Whether Claude
 * Code also loads files from other branches when it reads a file there is not.
 */
function onDemandCertainty(scope: Scope): Certainty {
  return scope === 'elsewhere' ? 'unverified' : 'documented';
}

function size(text: string, bytes: number = utf8ByteLength(text)): Size {
  return { bytes, chars: codePointLength(text), tokens: estimateTokens(text) };
}

/**
 * What Claude Code would receive from a file it skips: the whole decoded file. Comments are not
 * stripped, so a skip never parses Markdown and the scan's Markdown budget is spent as before.
 */
function skippedSize(artifact: Artifact): Size {
  return size(artifact.decoded.text, artifact.file.bytes.length);
}

/** The text Claude Code receives: block HTML comments removed (see `inHtmlComment`). */
function withoutComments(text: string, doc: MarkdownDocument): string {
  if (doc.htmlComments.length === 0) return text;
  let kept = '';
  let from = 0;
  for (const comment of doc.htmlComments) {
    if (comment.span.offset < from) continue;
    kept += text.slice(from, comment.span.offset);
    from = comment.span.offset + comment.span.length;
  }
  return kept + text.slice(from);
}

/**
 * A skill's state in `skillOverrides`: listed with its description (`on`), with its name only,
 * hidden from the model but run with /name, or off (SOURCES.claudeSkills).
 */
type SkillOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off';

const SKILL_OVERRIDE_VALUES: ReadonlySet<string> = new Set<SkillOverride>([
  'on',
  'name-only',
  'user-invocable-only',
  'off',
]);

function isSkillOverride(value: string): value is SkillOverride {
  return SKILL_OVERRIDE_VALUES.has(value);
}

/**
 * `disable-model-invocation: true`: the description is not in context, and the skill loads only
 * when the user runs it (SOURCES.claudeSkills, "Control who invokes a skill").
 */
function modelCannotInvoke(frontmatter: FrontmatterResult): boolean {
  return (
    frontmatter.kind === 'valid' &&
    claudeBoolean(frontmatter.data.values['disable-model-invocation']) === true
  );
}

function bodyOffset(frontmatter: FrontmatterResult): number {
  return frontmatter.kind === 'valid' || frontmatter.kind === 'invalid'
    ? frontmatter.bodyOffset
    : 0;
}

/** Splits a comma-separated `paths` string, keeping commas inside `{...}` braces. */
function splitPatterns(value: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const char = value.charAt(i);
    if (char === '{') depth++;
    else if (char === '}' && depth > 0) depth--;
    else if (i === value.length || (char === ',' && depth === 0)) {
      const pattern = value.slice(start, i).trim();
      if (pattern !== '') patterns.push(pattern);
      start = i + 1;
    }
  }
  return patterns;
}

/**
 * When a `.claude/rules/` file loads, from its frontmatter: no `paths` loads it at launch, and
 * so does YAML that does not parse (code.claude.com/docs/en/memory). What Claude Code does with
 * an empty or mistyped `paths`, or with YAML that lenient readers accept, is not documented.
 */
function rulePatterns(frontmatter: FrontmatterResult): {
  readonly patterns: readonly string[] | undefined;
  readonly certainty: Certainty;
} {
  switch (frontmatter.kind) {
    case 'absent':
      return { patterns: undefined, certainty: 'documented' };
    case 'unclosed':
    case 'unsupported':
      return { patterns: undefined, certainty: 'unverified' };
    case 'invalid': {
      const error = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
      return { patterns: undefined, certainty: error === undefined ? 'unverified' : 'documented' };
    }
    case 'valid': {
      const { data } = frontmatter;
      if (!data.keys.includes('paths')) return { patterns: undefined, certainty: 'documented' };
      const value = data.values['paths'];
      let patterns: string[] = [];
      if (typeof value === 'string') patterns = splitPatterns(value);
      else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        patterns = value.filter((item: string) => item.trim() !== '');
      }
      return patterns.length === 0
        ? { patterns: undefined, certainty: 'unverified' }
        : { patterns, certainty: 'documented' };
    }
  }
}

/** A file Claude Code loads by itself, whose imports it expands. */
interface Root {
  readonly path: string;
  readonly artifact: Artifact;
  readonly role: 'instructions' | 'rule';
  readonly trigger: 'startup' | 'on-path';
  readonly patterns?: readonly string[];
  readonly certainty: Certainty;
}

interface Frame {
  readonly artifact: Artifact;
  /** The path Claude Code reaches the file by. */
  readonly path: string;
  /** Files that led here, root first. */
  readonly via: readonly string[];
  readonly edges: readonly ImportEdge[];
  readonly doc: MarkdownDocument;
  next: number;
}

/** How much of a limit one file uses. */
interface Measured {
  readonly path: string;
  readonly value: number;
}

/** The file that uses the most of a limit; the first by path among equals. */
function largest(items: readonly Measured[]): Measured | undefined {
  let best: Measured | undefined;
  for (const item of items) {
    if (
      best === undefined ||
      item.value > best.value ||
      (item.value === best.value && compareStrings(item.path, best.path) < 0)
    ) {
      best = item;
    }
  }
  return best;
}

class ClaudeLoader {
  readonly #view: LoadView;
  readonly #cwd: string;
  readonly #config: ResolvedConfig;
  readonly #contextWindow: number | undefined;
  readonly #graph: ImportGraph;
  readonly #repository: boolean;
  /** Sizes of files the walker did not read because they are too large. */
  readonly #tooLarge = new Map<string, number>();

  readonly #entries = new Map<string, LoadEntry>();
  readonly #skipped = new Map<string, SkippedLoad>();
  readonly #outOfScope = new Map<string, OutOfScope>();
  readonly #incomplete = new Set<string>();
  /** Artifacts with an instructions, import or rule entry, so each file loads once. */
  readonly #loaded = new Set<Artifact>();
  /** Imported files that were not read, listed once. */
  readonly #unreadImports = new Set<string>();
  #position = 0;
  /** Whether AGENTS.md replaces CLAUDE.md here; `unknown` when only unread CLAUDE files exist. */
  #mode: 'claude' | 'agents' | 'unknown' = 'agents';

  // Usage of each limit, for `limits`.
  readonly #bytes: Measured[] = [];
  readonly #lines: Measured[] = [];
  readonly #hops: Measured[] = [];
  /** Uncut listing text of every skill. */
  readonly #listing: Measured[] = [];
  /** Skills in the listing at launch, and its characters after each entry's cut. */
  #listedSkills = 0;
  #listed = 0;

  /** `skillOverrides` of the working directory's settings, on first use. */
  #overrides: ReadonlyMap<string, SkillOverride> | undefined;

  // What the rules report, computed the way they compute it, on first use.
  #followed: ReadonlySet<Artifact> | undefined;
  #tooDeep: ReadonlySet<string> | undefined;
  #shadowed: ReadonlySet<Artifact> | undefined;

  constructor(view: LoadView, options: ClaudeCodeLoadOptions) {
    this.#view = view;
    this.#cwd = options.cwd;
    this.#config = options.config;
    this.#contextWindow = options.contextWindow;
    this.#graph = new ImportGraph(view);
    this.#repository = scanRootIsRepository(view.snapshot);
    for (const entry of view.snapshot.skipped) {
      if (entry.reason === 'too-large' && entry.size !== undefined) {
        this.#tooLarge.set(entry.path, entry.size);
      }
    }
  }

  build(): LoadPlan {
    this.#instructions();
    this.#agentsMdSkips();
    this.#caseMismatches();
    this.#skills();
    this.#commands();
    this.#mcpServers();
    this.#hooks();
    return this.#plan();
  }

  // -------------------------------------------------------------------------------------------
  // Instructions, rules and imports
  // -------------------------------------------------------------------------------------------

  #instructions(): void {
    const cwd = this.#cwd;
    const onPath = claudeFilesOnPath(this.#graph, cwd);
    const claudeFiles = new Map<string, ClaudeFileOnPath>(onPath.map((file) => [file.path, file]));
    for (const file of onPath)
      if (file.artifact === undefined) this.#unread(file.path, 'instructions');
    this.#mode = onPath.some((file) => file.artifact !== undefined)
      ? 'claude'
      : onPath.length > 0
        ? 'unknown'
        : 'agents';

    const rules = rulesByOwner(this.#graph);
    const startup: Root[] = [];
    const later: Root[] = [];
    for (const directory of selfAndAncestors(cwd).reverse()) {
      const leads: Root[] = [];
      const names =
        this.#mode === 'agents'
          ? ['AGENTS.md', '.claude/AGENTS.md']
          : ['CLAUDE.md', '.claude/CLAUDE.md'];
      for (const name of names) {
        const path = joinPath(directory, name);
        const artifact =
          this.#mode === 'agents' ? this.#agentsMdAt(path) : claudeFiles.get(path)?.artifact;
        if (artifact === undefined) continue;
        leads.push({
          path,
          artifact,
          role: 'instructions',
          trigger: 'startup',
          certainty: 'documented',
        });
      }
      const ruleRoots: Root[] = [];
      for (const artifact of rules.get(directory) ?? []) {
        const { patterns, certainty } = rulePatterns(this.#view.frontmatter(artifact));
        const base = { path: artifact.path, artifact, role: 'rule', certainty } as const;
        if (patterns === undefined) ruleRoots.push({ ...base, trigger: 'startup' });
        else later.push({ ...base, trigger: 'on-path', patterns });
      }
      const local =
        this.#mode === 'agents'
          ? undefined
          : claudeFiles.get(joinPath(directory, 'CLAUDE.local.md'))?.artifact;
      // Documented: root first, CLAUDE.local.md after CLAUDE.md. Not documented: CLAUDE.md
      // against .claude/CLAUDE.md (or AGENTS.md against .claude/AGENTS.md), and where rules go
      // among the files of their directory ("the same priority as .claude/CLAUDE.md").
      const unorderedLeads = leads.length > 1;
      const unorderedRules = ruleRoots.length + leads.length + (local === undefined ? 0 : 1) > 1;
      for (const lead of leads) {
        startup.push(unorderedLeads ? { ...lead, certainty: 'unverified' } : lead);
      }
      for (const rule of ruleRoots) {
        startup.push(unorderedRules ? { ...rule, certainty: 'unverified' } : rule);
      }
      if (local !== undefined) {
        const path = joinPath(directory, 'CLAUDE.local.md');
        startup.push({
          path,
          artifact: local,
          role: 'instructions',
          trigger: 'startup',
          certainty: 'documented',
        });
      }
    }
    for (const root of startup) this.#loadRoot(root);

    later.push(...this.#nestedRoots(rules));
    later.sort((a, b) => compareStrings(a.path, b.path));
    for (const root of later) this.#loadRoot(root);
  }

  /** The AGENTS.md at `path` when Claude Code may read it there, flagging one it cannot see. */
  #agentsMdAt(path: string): Artifact | undefined {
    const artifact = this.#view.index.get(path);
    if (artifact !== undefined) {
      return isClaudeAgentsMdLocation(this.#view.snapshot, artifact, path) ? artifact : undefined;
    }
    if (this.#mayExist(path)) this.#unread(path, 'instructions');
    return undefined;
  }

  /** True when a file exists at `path` or might: not missing and not a directory. */
  #mayExist(path: string): boolean {
    const status = pathStatus(this.#view.snapshot, path);
    if (status === 'missing') return false;
    return status === 'unknown' || !this.#view.snapshot.paths.has(`${path}/`);
  }

  /** Files that load when Claude Code works in their directory: nested CLAUDE.md, AGENTS.md, rules. */
  #nestedRoots(rules: ReadonlyMap<string, readonly Artifact[]>): Root[] {
    const cwd = this.#cwd;
    const roots: Root[] = [];
    for (const [path, artifact] of this.#view.index) {
      const classification = classify(path);
      if (classification === undefined || classification.caseMismatch !== undefined) continue;
      const { kind } = classification;
      const claude = kind === 'claude-md' || kind === 'claude-local-md';
      if (!claude && !(kind === 'agents-md' && this.#mode === 'agents')) continue;
      // `X/AGENTS.md` and `X/.claude/AGENTS.md` belong to X, and so do the CLAUDE files that
      // Claude Code looks for: X/CLAUDE.md, X/.claude/CLAUDE.md and X/CLAUDE.local.md.
      const directory = agentsMdDirectory(path);
      if (claude && !CLAUDE_FILE_NAMES.some((name) => joinPath(directory, name) === path)) continue;
      const scope = scopeOf(directory, cwd);
      if (scope === 'path') continue;
      if (!claude) {
        if (!isClaudeAgentsMdLocation(this.#view.snapshot, artifact, path)) continue;
        if (inPayloadFolder(path)) {
          this.#out(path, 'payload-folder');
          continue;
        }
        // A CLAUDE file on its path makes Claude Code skip it (see #agentsMdSkips).
        const above = claudeFilesOnPath(this.#graph, directory);
        for (const file of above)
          if (file.artifact === undefined) this.#unread(file.path, 'instructions');
        if (above.length > 0) continue;
      } else if (inPayloadFolder(path)) {
        this.#out(path, 'payload-folder');
        continue;
      }
      roots.push({
        path,
        artifact,
        role: 'instructions',
        trigger: 'on-path',
        patterns: [`${directory}/**`],
        certainty: onDemandCertainty(scope),
      });
    }
    for (const [owner, list] of rules) {
      const scope = scopeOf(owner, cwd);
      if (scope === 'path') continue;
      for (const artifact of list) {
        if (inPayloadFolder(artifact.path)) {
          this.#out(artifact.path, 'payload-folder');
          continue;
        }
        // Rules of another directory's .claude folder: when they load is not documented.
        const { patterns } = rulePatterns(this.#view.frontmatter(artifact));
        roots.push({
          path: artifact.path,
          artifact,
          role: 'rule',
          trigger: 'on-path',
          patterns: patterns ?? [`${owner}/**`],
          certainty: 'unverified',
        });
      }
    }
    return roots;
  }

  #loadRoot(root: Root): void {
    if (this.#loaded.has(root.artifact)) return;
    if (this.#oversize(root.artifact, root.path, root.role)) return;
    this.#addMemoryEntry(root.role, root.path, root.artifact, root, undefined, 0);
    this.#expand(root);
  }

  /** A file over Claude Code's 4 MiB limit, which it skips. */
  #oversize(artifact: Artifact, path: string, role: LoadRole): boolean {
    return this.#overLimit(path, role, artifact.file.bytes.length, artifact);
  }

  /**
   * Skips a file of `bytes` bytes when it is over Claude Code's 4 MiB limit, with its size when
   * the scan read it.
   */
  #overLimit(path: string, role: LoadRole, bytes: number, artifact?: Artifact): boolean {
    if (bytes <= CLAUDE_MAX_FILE_BYTES) return false;
    this.#skip({
      role,
      path,
      code: 'over-byte-budget',
      ...(artifact === undefined ? {} : { size: skippedSize(artifact) }),
      certainty: 'documented',
      evidence: MEMORY,
    });
    this.#bytes.push({ path, value: bytes });
    return true;
  }

  /**
   * A file that exists or may exist but was not read. True when the walker saw that it is over
   * Claude Code's 4 MiB limit, so Claude Code skips it; otherwise the plan is incomplete.
   */
  #unread(path: string, role: LoadRole): boolean {
    if (this.#overLimit(path, role, this.#tooLarge.get(path) ?? 0)) return true;
    this.#incomplete.add(`unread:${path}`);
    return false;
  }

  #markdown(artifact: Artifact): MarkdownDocument {
    const doc = this.#view.markdown(artifact);
    if (!doc.analysis.complete) this.#incomplete.add(`markdown-budget:${artifact.path}`);
    return doc;
  }

  #addMemoryEntry(
    role: 'instructions' | 'import' | 'rule',
    path: string,
    artifact: Artifact,
    root: Root,
    via: readonly string[] | undefined,
    hop: number,
  ): void {
    const text = withoutComments(artifact.decoded.text, this.#markdown(artifact));
    const entry: LoadEntry = {
      id: `${role}:${path}`,
      role,
      trigger: root.trigger,
      ...(root.trigger === 'startup' ? { position: ++this.#position } : {}),
      path,
      realPath: artifact.realPath,
      ...(via === undefined ? {} : { via }),
      ...(root.patterns === undefined ? {} : { patterns: root.patterns }),
      size: size(text, artifact.file.bytes.length),
      certainty: root.certainty,
      evidence: MEMORY,
    };
    this.#loaded.add(artifact);
    this.#entries.set(entry.id, entry);
    this.#bytes.push({ path, value: artifact.file.bytes.length });
    if (
      role === 'instructions' &&
      (artifact.kind === 'claude-md' || artifact.kind === 'claude-local-md')
    ) {
      this.#lines.push({ path, value: lineCount(artifact.decoded.text) });
    }
    if (role === 'import') this.#hops.push({ path, value: hop });
  }

  #frame(artifact: Artifact, path: string, via: readonly string[]): Frame {
    return {
      artifact,
      path,
      via,
      edges: this.#graph.edges(artifact, 'claude'),
      doc: this.#markdown(artifact),
      next: 0,
    };
  }

  /**
   * Imports of `root` in the order Claude Code inlines them: depth first, in source order, each
   * file once. A file's imports are followed while it is less than four hops from the root by
   * its shortest chain, as instr/import-depth counts them.
   */
  #expand(root: Root): void {
    const maxHops = MAX_HOPS.claude;
    const reach = this.#graph.reach([root.artifact], 'claude', maxHops);
    if (!this.#graph.hasBudget()) this.#incomplete.add(`import-budget:${root.path}`);
    // Claude Code's documentation does not say it expands imports in project rules, nor whether
    // imports in a file read through a symlink in another directory resolve from the link.
    const uncertainty = claudeImportsUncertainty(root.artifact, root.path);
    const certainty = uncertainty === undefined ? root.certainty : 'unverified';
    // Where the link sits does not change the absolute and home imports of the file itself.
    const ownCertainty = uncertainty === 'link' ? root.certainty : certainty;
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
      if (inHtmlComment(frame.doc, edge.reference)) continue;
      const own = frame.artifact === root.artifact && edge.reference.kind !== 'relative';
      this.#checkImport(frame.artifact, edge, own ? ownCertainty : certainty);
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
        if (this.#oversize(artifact, target, 'import')) continue;
        this.#addMemoryEntry('import', target, artifact, child, via, hop);
      }
      if (hop < maxHops) stack.push(this.#frame(artifact, target, via));
    }

    for (const item of importsPastLimit(this.#graph, root.artifact, reach, 'claude')) {
      const key = `${item.file.path}\u0000${String(item.reference.span.offset)}`;
      const reported = this.#tooDeepKeys().has(key);
      this.#skip({
        role: 'import',
        path: item.file.path,
        name: item.target,
        code: 'import-too-deep',
        ...(reported ? { ruleId: 'instr/import-depth' } : {}),
        certainty,
        evidence: MEMORY,
      });
      this.#hops.push({ path: item.file.path, value: maxHops + 1 });
    }
  }

  /** Skips and unread files for one import in a file whose imports Claude Code follows. */
  #checkImport(file: Artifact, edge: ImportEdge, certainty: Certainty): void {
    const { reference, target } = edge;
    // The import rules judge every file whose imports Claude Code follows from any root.
    const ruleId = (id: string): { readonly ruleId?: string } =>
      this.#followedFiles().has(file) ? { ruleId: id } : {};
    if (target === undefined) {
      // Imports in CLAUDE.local.md are personal: instr/import-outside-root does not judge them.
      if (file.kind === 'claude-local-md') return;
      if (claudeImportOutsideRoot(edge, this.#repository) === undefined) return;
      this.#skip({
        role: 'import',
        path: file.path,
        name: reference.path,
        code: 'import-outside-root',
        ...ruleId('instr/import-outside-root'),
        certainty,
        evidence: MEMORY,
      });
      return;
    }
    const unresolved = unresolvedImport(this.#graph, file, edge, 'claude');
    if (unresolved !== undefined) {
      this.#skip({
        role: 'import',
        path: file.path,
        name: unresolved.path,
        code: 'import-unresolved',
        ...ruleId('instr/import-unresolved'),
        certainty,
        evidence: MEMORY,
      });
    }
  }

  /**
   * An import of a file agentcheckup did not read, such as a README or a document that is not
   * agent configuration. A file that exists is listed without a size, and its own imports cannot
   * be followed, so the plan is incomplete. A path that may exist claims nothing.
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
        this.#unread(target, 'import');
      }
      return;
    }
    if (this.#unread(target, 'import') || this.#unreadImports.has(target)) return;
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
      evidence: MEMORY,
    });
    this.#hops.push({ path: target, value: hop });
  }

  /** AGENTS.md files Claude Code skips because a CLAUDE file is on the path. */
  #agentsMdSkips(): void {
    const cwd = this.#cwd;
    for (const [path, artifact] of this.#view.index) {
      if (this.#loaded.has(artifact)) continue;
      if (!isClaudeAgentsMdLocation(this.#view.snapshot, artifact, path)) continue;
      // `X/AGENTS.md` or `X/.claude/AGENTS.md`.
      const directory = agentsMdDirectory(path);
      const scope = scopeOf(directory, cwd);
      if (scope !== 'path' && inPayloadFolder(path)) {
        this.#out(path, 'payload-folder');
        continue;
      }
      // With a CLAUDE file at or above the working directory, Claude Code reads no AGENTS.md. With
      // none, it reads the ones on the path, and a nested one unless a CLAUDE file is on its path.
      const shadowed =
        this.#mode === 'claude' ||
        (scope !== 'path' &&
          claudeFilesOnPath(this.#graph, directory).some((file) => file.artifact !== undefined));
      if (!shadowed) continue;
      this.#skip({
        role: 'instructions',
        path: artifact.path,
        code: 'shadowed-by-claude-md',
        ...(this.#shadowedFiles().has(artifact) ? { ruleId: SHADOW_RULE } : {}),
        size: skippedSize(artifact),
        certainty: 'documented',
        evidence: MEMORY,
      });
    }
  }

  /**
   * Instruction files whose names match CLAUDE.md, CLAUDE.local.md or AGENTS.md only when case is
   * ignored. Claude Code looks for the exact names, so on a case-sensitive file system it never
   * finds them (instr/filename-case reports each one).
   */
  #caseMismatches(): void {
    for (const artifact of this.#view.artifacts) {
      if (artifact.caseMismatch === undefined || !CASE_CHECKED_KINDS.has(artifact.kind)) continue;
      this.#skip({
        role: 'instructions',
        path: artifact.path,
        code: 'case-mismatch',
        ruleId: CASE_RULE,
        size: skippedSize(artifact),
        certainty: 'documented',
        evidence: MEMORY,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Skills and commands (subagents: ./subagents.ts)
  // -------------------------------------------------------------------------------------------

  #skills(): void {
    const cwd = this.#cwd;
    const repositoryRoot = nearestGitRoot(this.#view.snapshot, cwd) ?? '';
    const insideRepository = (directory: string): boolean =>
      repositoryRoot === '' ||
      directory === repositoryRoot ||
      directory.startsWith(`${repositoryRoot}/`);
    const listed: { path: string; build: (position: number | undefined) => LoadEntry }[] = [];
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'skill' || artifact.caseMismatch !== undefined) continue;
      // The best path to the skill: listed at launch, then below the working directory.
      let best: { path: string; owner: string; scope: Scope } | undefined;
      const rank = (scope: Scope): number => (scope === 'path' ? 0 : scope === 'below' ? 1 : 2);
      for (const path of [artifact.path, ...artifact.aliases]) {
        const location = skillLocation(path);
        if (location?.platforms.has('claude-code') !== true) continue;
        const { root } = location;
        if (root !== '.claude/skills' && !root.endsWith('/.claude/skills')) continue;
        const owner = root === '.claude/skills' ? '' : root.slice(0, -'/.claude/skills'.length);
        const scope = scopeOf(owner, cwd);
        // Project skills load from the working directory up to the repository root only.
        if (scope === 'path' && !insideRepository(owner)) continue;
        if (
          best === undefined ||
          rank(scope) < rank(best.scope) ||
          (rank(scope) === rank(best.scope) && compareStrings(path, best.path) < 0)
        ) {
          best = { path, owner, scope };
        }
      }
      if (best === undefined) continue;
      const { path, owner, scope } = best;
      if (scope !== 'path' && inPayloadFolder(path)) {
        this.#out(path, 'payload-folder');
        continue;
      }
      const frontmatter = this.#view.frontmatter(artifact);
      const listing = claudeSkillListing(path, artifact.decoded.text, frontmatter);
      // A block Claude Code may not read as frontmatter: how it lists the skill is not documented.
      const bodyOnly = frontmatter.kind === 'unclosed' || frontmatter.kind === 'unsupported';
      const body = size(artifact.decoded.text.slice(listing.bodyOffset));
      const certainty = bodyOnly ? 'unverified' : onDemandCertainty(scope);
      const override = this.#skillOverrides().get(listing.name);
      const evidence = override === undefined ? SKILLS : SKILL_OVERRIDES;
      if (override === 'off') {
        this.#skip({
          role: 'skill',
          path,
          name: listing.name,
          code: 'disabled',
          certainty,
          evidence,
        });
        continue;
      }
      if (override === 'user-invocable-only' || modelCannotInvoke(frontmatter)) {
        // Not in the listing: the skill loads only when the user runs /name.
        this.#add({
          id: `skill:${path}`,
          role: 'skill',
          trigger: 'manual',
          path,
          realPath: artifact.realPath,
          name: listing.name,
          size: body,
          certainty,
          evidence,
        });
        continue;
      }
      // The listing always holds the name; `name-only` leaves the description out.
      const nameOnly = override === 'name-only';
      const shown = nameOnly ? listing.name : `${listing.name}${listing.shown}`;
      const build = (position: number | undefined): LoadEntry => {
        const entry: LoadEntry = {
          id: `skill:${path}`,
          role: 'skill',
          trigger: scope === 'path' ? 'startup' : 'on-path',
          ...(position === undefined ? {} : { position }),
          path,
          realPath: artifact.realPath,
          name: listing.name,
          ...(scope === 'path' ? {} : { patterns: [`${owner}/**`] }),
          size: size(shown),
          deferred: body,
          certainty,
          evidence,
        };
        // The description limits measure the descriptions in the listing.
        if (!nameOnly) {
          this.#listing.push({ path, value: listing.length });
          if (scope === 'path') this.#listed += codePointLength(listing.shown);
        }
        if (scope === 'path') this.#listedSkills++;
        return entry;
      };
      if (scope === 'path') listed.push({ path, build });
      else this.#add(build(undefined));
    }
    // The order of the listing is not documented; positions follow the path.
    listed.sort((a, b) => compareStrings(a.path, b.path));
    for (const { build } of listed) this.#add(build(++this.#position));
  }

  /**
   * `skillOverrides` from the working directory's `.claude/settings.json` and
   * `.claude/settings.local.json`, the local file winning per skill (SOURCES.claudeSkills,
   * "Override skill visibility from settings"). Only the four documented values count. User and
   * managed settings can set it too; they are not visible.
   */
  #skillOverrides(): ReadonlyMap<string, SkillOverride> {
    if (this.#overrides !== undefined) return this.#overrides;
    const overrides = new Map<string, SkillOverride>();
    for (const doc of claudeProjectSettings(this.#view, this.#cwd)) {
      const value = settingAt(doc, ['skillOverrides']);
      if (!isTable(value)) continue;
      for (const skill of Object.keys(value)) {
        const state = value[skill];
        if (typeof state === 'string' && isSkillOverride(state)) overrides.set(skill, state);
      }
    }
    this.#overrides = overrides;
    return overrides;
  }

  #commands(): void {
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'claude-command') continue;
      const folder = inClaudeFolder(artifact.path, 'commands');
      if (folder === undefined) continue;
      const scope = scopeOf(folder.owner, this.#cwd);
      if (scope !== 'path' && inPayloadFolder(artifact.path)) {
        this.#out(artifact.path, 'payload-folder');
        continue;
      }
      const offset = bodyOffset(this.#view.frontmatter(artifact));
      this.#add({
        id: `command:${artifact.path}`,
        role: 'command',
        trigger: 'manual',
        path: artifact.path,
        realPath: artifact.realPath,
        name: folder.relative.slice(0, -'.md'.length),
        size: size(artifact.decoded.text.slice(offset)),
        // Commands in another directory's .claude folder: not documented.
        certainty: scope === 'path' ? 'documented' : 'unverified',
        evidence: SKILLS,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // MCP servers and hooks
  // -------------------------------------------------------------------------------------------

  /**
   * Project servers live in `.mcp.json` at the project root. That Claude Code also reads one in a
   * directory above the working directory is not documented.
   */
  #mcpServers(): void {
    const cwd = this.#cwd;
    for (const directory of selfAndAncestors(cwd).reverse()) {
      const path = joinPath(directory, '.mcp.json');
      const artifact = this.#configAt(path, 'mcp-json');
      if (artifact === undefined) continue;
      if (!isClaudeMcpConfig(this.#view.snapshot, artifact)) {
        this.#out(path, 'other-agent-plugin');
        continue;
      }
      const certainty = directory === cwd ? 'documented' : 'unverified';
      const doc = this.#view.json(artifact);
      if (!doc.ok) {
        this.#invalidJson(artifact, doc.errors, 'mcp-server', false, MCP);
        continue;
      }
      const servers = mcpServers(artifact, doc);
      const inventoryIds = mcpInventoryIds(artifact.path, servers);
      servers.forEach(({ name, config }, index) => {
        if (urlWithoutType(config)) {
          this.#skip({
            role: 'mcp-server',
            path: artifact.path,
            name,
            code: 'url-without-type',
            ruleId: 'mcp/url-without-type',
            certainty,
            evidence: MCP,
          });
          return;
        }
        this.#add({
          id: `mcp-server:${path}#${name}`,
          role: 'mcp-server',
          trigger: 'on-approval',
          path,
          realPath: artifact.realPath,
          name,
          inventoryId: inventoryIds[index] ?? '',
          certainty,
          evidence: MCP,
        });
      });
    }
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'mcp-json') continue;
      if (scopeOf(dirnamePosix(artifact.path), cwd) !== 'below') continue;
      const plugin = !isClaudeMcpConfig(this.#view.snapshot, artifact);
      this.#out(artifact.path, plugin ? 'other-agent-plugin' : 'below-start-dir');
    }
  }

  /**
   * Hooks from the project's `.claude/settings.json` and `.claude/settings.local.json`. That
   * Claude Code also reads settings in a directory above the working directory is not documented.
   */
  #hooks(): void {
    const cwd = this.#cwd;
    const known: ReadonlySet<string> = new Set(HOOK_EVENTS['claude-code']);
    for (const directory of selfAndAncestors(cwd).reverse()) {
      for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
        const path = joinPath(directory, name);
        const artifact = this.#configAt(path, 'claude-settings');
        if (artifact === undefined) continue;
        const certainty = directory === cwd ? 'documented' : 'unverified';
        const doc = this.#view.json(artifact);
        if (!doc.ok) {
          this.#invalidJson(artifact, doc.errors, 'hook', true, HOOKS);
          continue;
        }
        for (const event of hookEvents(doc, 'claude-code')) {
          if (known.has(event.name)) continue;
          this.#skip({
            role: 'hook',
            path: artifact.path,
            name: event.name,
            code: 'unknown-event',
            ruleId: 'hooks/unknown-event',
            certainty,
            evidence: HOOKS,
          });
        }
        // Ids over every handler, as the inventory numbers them; unknown events are skipped above.
        const handlers = hookHandlers(doc, 'claude-code', { includeUnknown: true });
        const ids = hookInventoryIds(path, handlers);
        const inventoryIds = hookInventoryIds(artifact.path, handlers);
        handlers.forEach((handler, index) => {
          if (!handler.known) return;
          this.#add({
            id: ids[index] ?? '',
            role: 'hook',
            trigger: 'on-approval',
            path,
            realPath: artifact.realPath,
            name: handler.event,
            inventoryId: inventoryIds[index] ?? '',
            certainty,
            evidence: HOOKS,
          });
        });
      }
    }
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'claude-settings') continue;
      // `<owner>/.claude/settings.json`
      const owner = dirnamePosix(dirnamePosix(artifact.path));
      if (scopeOf(owner, cwd) === 'below') this.#out(artifact.path, 'below-start-dir');
    }
  }

  /** The config artifact at `path`, flagging a file that exists but was not read. */
  #configAt(path: string, kind: Artifact['kind']): Artifact | undefined {
    const artifact = this.#view.index.get(path);
    if (artifact !== undefined) return artifact.kind === kind ? artifact : undefined;
    if (this.#mayExist(path)) this.#incomplete.add(`unread:${path}`);
    return undefined;
  }

  /** A config file that does not parse; json/invalid-syntax reports all but parser limits. */
  #invalidJson(
    artifact: Artifact,
    errors: readonly ParseIssue[],
    role: LoadRole,
    strict: boolean,
    evidence: Evidence,
  ): void {
    const issue = errors[0];
    if (issue === undefined) return;
    const kind = issueKind(issue);
    if (kind === 'limit') {
      this.#incomplete.add(`unparsed:${artifact.path}`);
      return;
    }
    this.#skip({
      role,
      path: artifact.path,
      code: 'invalid-json',
      ruleId: 'json/invalid-syntax',
      // Whether Claude Code accepts comments and trailing commas in .mcp.json is not documented.
      certainty: kind === 'other' || strict ? 'documented' : 'unverified',
      evidence,
    });
  }

  // -------------------------------------------------------------------------------------------
  // What the rules report, computed on the same analysis
  // -------------------------------------------------------------------------------------------

  /** Files whose imports instr/import-unresolved and instr/import-outside-root judge. */
  #followedFiles(): ReadonlySet<Artifact> {
    this.#followed ??= new Set(
      filesWithFollowedImports(new ImportGraph(this.#view), 'claude').map((file) => file.artifact),
    );
    return this.#followed;
  }

  /** `<file>\0<offset>` of every import instr/import-depth reports as too deep. */
  #tooDeepKeys(): ReadonlySet<string> {
    if (this.#tooDeep === undefined) {
      const graph = new ImportGraph(this.#view);
      this.#tooDeep = new Set(
        tooDeepImports(graph, importRoots(graph, 'claude'), 'claude').map(
          (item) => `${item.file.path}\u0000${String(item.reference.span.offset)}`,
        ),
      );
    }
    return this.#tooDeep;
  }

  /** AGENTS.md files instr/agents-md-ignored-by-claude reports. */
  #shadowedFiles(): ReadonlySet<Artifact> {
    if (this.#shadowed === undefined) {
      // The files the engine gives the rule: AGENTS.md artifacts where it is not turned off.
      const judged = this.#view.artifacts.filter(
        (artifact) =>
          artifact.kind === 'agents-md' &&
          this.#config.ruleSetting(SHADOW_RULE, artifact.path)?.severity !== 'off',
      );
      this.#shadowed = new Set(
        agentsMdShadowedByClaude(new ImportGraph(this.#view), judged).map((item) => item.artifact),
      );
    }
    return this.#shadowed;
  }

  // -------------------------------------------------------------------------------------------
  // The plan
  // -------------------------------------------------------------------------------------------

  #add(entry: LoadEntry): void {
    if (!this.#entries.has(entry.id)) this.#entries.set(entry.id, entry);
  }

  #skip(skip: Omit<SkippedLoad, 'id'>): void {
    const id =
      skip.name === undefined
        ? `${skip.role}:${skip.path}`
        : `${skip.role}:${skip.path}#${skip.name}`;
    if (!this.#skipped.has(id)) this.#skipped.set(id, { id, ...skip });
  }

  #out(path: string, because: OutOfScope['because']): void {
    this.#outOfScope.set(`${path}\u0000${because}`, { path, because });
  }

  /**
   * One usage per limit: the file that uses the most of it. The skill listing budget is 1% of
   * the context window; it is measured in characters, at the estimate's four per token. The
   * listing is computed for the working directory, so that is its subject.
   */
  #limits(): LimitUsage[] {
    const limits: LimitUsage[] = [];
    const add = (
      measured: Measured | undefined,
      usage: Omit<LimitUsage, 'used' | 'subject'>,
    ): void => {
      if (measured !== undefined) {
        limits.push({ ...usage, used: measured.value, subject: measured.path });
      }
    };
    add(largest(this.#bytes), {
      key: 'claude-code.memory_file_max_bytes',
      unit: 'bytes',
      limit: CLAUDE_MAX_FILE_BYTES,
      effect: 'skips',
      evidence: MEMORY,
    });
    add(largest(this.#lines), {
      key: 'claude-code.memory_file_lines',
      unit: 'lines',
      limit: this.#advisedLines().value,
      effect: 'advice',
      evidence: MEMORY,
    });
    add(largest(this.#hops), {
      key: 'claude-code.import_max_hops',
      unit: 'hops',
      limit: MAX_HOPS.claude,
      effect: 'skips',
      evidence: MEMORY,
    });
    add(largest(this.#listing), {
      key: 'claude-code.skill_listing_max_desc_chars',
      unit: 'chars',
      limit: CLAUDE_LISTING_MAX_CHARS,
      effect: 'shortens',
      evidence: SKILLS,
    });
    const window = this.#contextWindow;
    add(this.#listedSkills === 0 ? undefined : { path: this.#cwd, value: this.#listed }, {
      key: 'claude-code.skill_listing_budget',
      label: 'skills listing',
      unit: 'chars',
      limit:
        window === undefined
          ? null
          : Math.floor(window * LISTING_BUDGET_FRACTION * CHARS_PER_TOKEN),
      effect: 'shortens',
      evidence: SKILLS,
    });
    return limits.sort((a, b) => compareStrings(a.key, b.key));
  }

  #advisedLines(): { readonly value: number; readonly configured: boolean } {
    const value = this.#config.ruleSetting(LINES_RULE, '')?.options?.['maxLines'];
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? { value, configured: true }
      : { value: CLAUDE_ADVISED_LINES, configured: false };
  }

  #assumptions(): Assumption[] {
    const assumptions: Assumption[] = [
      {
        key: 'claude-code.instructions_mode',
        value: 'claude-md-or-agents-md',
        origin: 'default',
        evidence: MEMORY,
      },
      { key: 'claude-code.min_version', value: '2.1.277', origin: 'default', evidence: MEMORY },
      {
        key: 'claude-code.session',
        value: 'interactive',
        origin: 'default',
        evidence: ['claudeHooks', 'claudeMcp'],
      },
      {
        key: 'claude-code.workspace_trusted',
        value: true,
        origin: 'default',
        evidence: ['claudeHooks', 'claudeMcp'],
      },
    ];
    if (this.#contextWindow !== undefined) {
      assumptions.push({
        key: 'claude-code.context_window',
        value: this.#contextWindow,
        origin: 'flag',
        evidence: SKILLS,
      });
    }
    const lines = this.#advisedLines();
    if (lines.configured) {
      assumptions.push({
        key: 'claude-code.memory_file_lines',
        value: lines.value,
        origin: 'rule-option',
        evidence: MEMORY,
      });
    }
    return assumptions.sort((a, b) => compareStrings(a.key, b.key));
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
      agent: 'claude-code',
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
 * The load plan of Claude Code for a session started in `options.cwd`. Run it on the analysis the
 * rules ran on, after them: it reads the same cached parses, so the scan's Markdown budget is
 * spent in the same order, and a file the budget cut short is listed in `incomplete`.
 */
export function loadClaudeCode(view: LoadView, options: ClaudeCodeLoadOptions): LoadPlan {
  return new ClaudeLoader(view, options).build();
}
