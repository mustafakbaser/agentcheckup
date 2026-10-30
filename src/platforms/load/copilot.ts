/**
 * What GitHub Copilot loads on its three surfaces, from docs/platforms.md ("GitHub Copilot") and
 * the sources it cites. Each surface is an agent of its own: `copilot-cli` (Copilot CLI),
 * `copilot-vscode` (the Local harness of Copilot in VS Code) and `copilot-cloud` (Copilot cloud
 * agent on GitHub.com).
 *
 * - Repository instructions. The CLI reads `.github/copilot-instructions.md`, AGENTS.md,
 *   CLAUDE.md, `.claude/CLAUDE.md` and GEMINI.md in its "standard locations": the repository root,
 *   the working directory and the directories between them at startup, and the directories in
 *   the path of a file it works on when it works on it. It inlines `@path` references in all but
 *   GEMINI.md, nested, inside the repository only, and drops identical copies of a file (such an
 *   entry adds no characters). VS Code reads `.github/copilot-instructions.md`,
 *   AGENTS.md, CLAUDE.md, `.claude/CLAUDE.md` and CLAUDE.local.md at the workspace root; nested
 *   AGENTS.md files only with a setting that is off by default. The cloud agent reads
 *   `.github/copilot-instructions.md`, CLAUDE.md and GEMINI.md at the repository root, and the
 *   AGENTS.md nearest to the files it works on.
 * - Path-specific `.github/instructions/**\/*.instructions.md` files: the CLI (at the repository
 *   root and the working directory) and the cloud agent apply them through `applyTo`; VS Code
 *   through `applyTo`, else when the model picks their `description`, else when attached
 *   (`copilotActivation`, shared with copilot/apply-to). The cloud agent never applies one without
 *   a valid `applyTo`, nor one whose `excludeAgent` is `cloud-agent`. The CLI (at the repository
 *   root and the working directory) and VS Code also read `.claude/rules/**\/*.md` files, scoped
 *   by `paths` (the CLI also takes `applyTo`). A file elsewhere is skipped where
 *   copilot/instructions-misplaced reports it (`copilotMisplacement`).
 * - Skills: SKILL.md one level below `.github/skills`, `.claude/skills` and `.agents/skills` at the
 *   repository root (VS Code: the workspace root). The CLI keeps the first skill of a name in that
 *   order, then a parent directory's `.github/skills`, and lists `.claude/commands/*.md` as skills
 *   that a skill of the same name wins over. VS Code does not load a skill whose `name` has
 *   invalid characters, is too long or differs from its directory.
 * - MCP servers: the CLI reads `.mcp.json` and `.github/mcp.json` in each directory from the
 *   working directory up to the repository root, closer files winning on a name conflict, in
 *   trusted folders only. VS Code reads `.vscode/mcp.json` and `.mcp.json` at the workspace root.
 *   The cloud agent's servers are configured in the repository settings on GitHub.com. The CLI's
 *   repository settings, `.github/copilot/settings(.local).json`, turn skills and servers off by
 *   name (`disabledSkills`, `disabledMcpServers`).
 * - Hooks in `.github/hooks/*.json` on every surface; the CLI also reads `hooks` in
 *   `.github/copilot/settings(.local).json` and Claude Code's `.claude/settings(.local).json`,
 *   which VS Code reads only with `chat.useClaudeHooks` (off by default). A malformed item drops
 *   out of a hook file and rejects every inline hook of a settings file. `disableAllHooks` turns
 *   off the hooks of its file, or on the CLI, in the repository's settings, every hook. Which
 *   event names count as documented depends on the surface (src/platforms/hooks.ts).
 *
 * Order: Copilot documents none ("combines all files", "additive"), so startup positions are the
 * order of the listing above (per directory from the repository root down, then the skills) and
 * every startup entry is unverified. Limits are advice, except VS Code's skill name rules.
 * User, account and plugin scopes are listed in `hidden`, never read.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import {
  codePointLength,
  estimateTokens,
  lineCount,
  tokensOf,
  utf8ByteLength,
} from '../../core/measure.js';
import { dirnamePosix, pathStatus } from '../../core/paths.js';
import type { Artifact, ArtifactKind } from '../../core/types.js';
import {
  isObject,
  issueKind,
  type JsonObject,
  own,
  type ParsedJson,
  type SpannedDocument,
} from '../../parse/json-access.js';
import type {
  FrontmatterResult,
  ImportDialect,
  ImportReference,
  JsonDocument,
} from '../../parse/types.js';
import { classify, isCandidateBasename } from '../classify.js';
import {
  copilotActivation,
  copilotFolder,
  copilotMisplacement,
  judgedByApplyTo,
  placement,
  VSCODE_SKILL_DESCRIPTION_MAX,
  VSCODE_SKILL_NAME_MAX,
  vscodeSkillNameIssue,
} from '../copilot.js';
import {
  COPILOT_REFERENCE_EVENTS,
  copilotHookItemIssue,
  copilotHookItems,
  HOOK_EVENTS,
  hookHandlers,
  VSCODE_LOCAL_EVENTS,
} from '../hooks.js';
import { hookInventoryIds, mcpInventoryIds } from '../inventory-ids.js';
import { isBundledSkill, pluginRootOf } from '../location.js';
import { mcpServers, urlWithoutType } from '../mcp.js';
import {
  basename,
  inClaudeFolder,
  inPayloadFolder,
  joinPath,
  nearestGitRoot,
  selfAndAncestors,
} from '../paths.js';
import { claudeProjectSettings, settingAt } from '../root-settings.js';
import { bodyOffset, normalizeName, pluginReaders, readersAt, skillLocation } from '../skills.js';
import type { SOURCES } from '../sources.js';
import { isBlank } from './codex-text.js';
import {
  claudeImportOutsideRoot,
  type ImportEdge,
  ImportGraph,
  looksLikeFilePath,
  scanRootIsRepository,
  withoutTrailingPunctuation,
} from './imports.js';
import type {
  Assumption,
  Certainty,
  ContextAgent,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  LoadRole,
  LoadTrigger,
  OutOfScope,
  Size,
  SkippedLoad,
} from './types.js';
import { TRIGGER_RANK } from './types.js';
import type { LoadView } from './view.js';

export interface CopilotLoadOptions {
  /**
   * Working directory, root-relative POSIX; `''` is the scan root. For VS Code, the folder opened
   * as the workspace; for the cloud agent, the directory it works in.
   */
  readonly cwd: string;
  readonly config: ResolvedConfig;
  /** Not used: Copilot documents no limit that depends on the context window. */
  readonly contextWindow?: number;
}

type Surface = 'cli' | 'vscode' | 'cloud';

const AGENT_OF: Readonly<Record<Surface, ContextAgent>> = {
  cli: 'copilot-cli',
  vscode: 'copilot-vscode',
  cloud: 'copilot-cloud',
};

type Evidence = readonly (keyof typeof SOURCES)[];

const INSTRUCTIONS: Readonly<Record<Surface, Evidence>> = {
  cli: ['copilotCliInstructions'],
  vscode: ['vscodeInstructions'],
  cloud: ['copilotRepoInstructions', 'copilotInstructionsSupport'],
};
const PATH_INSTRUCTIONS: Readonly<Record<Surface, Evidence>> = {
  cli: ['copilotCliInstructions', 'copilotRepoInstructions'],
  vscode: ['vscodeInstructions'],
  cloud: ['copilotRepoInstructions'],
};
const MISPLACED: Readonly<Record<Surface, Evidence>> = {
  cli: ['copilotRepoInstructions', 'copilotCliInstructions'],
  vscode: ['copilotRepoInstructions', 'vscodeInstructions'],
  cloud: ['copilotRepoInstructions'],
};
const SKILLS: Readonly<Record<Surface, Evidence>> = {
  cli: ['copilotSkills', 'copilotCliReference'],
  vscode: ['vscodeSkills'],
  cloud: ['copilotSkills', 'copilotAddSkills'],
};
const CLAUDE_RULES: Readonly<Record<Surface, Evidence>> = {
  cli: ['copilotCliReference'],
  vscode: ['vscodeInstructions'],
  cloud: [],
};
/** The CLI's `.claude/commands` files, "an alternative to skills". */
const CLI_COMMANDS: Evidence = ['copilotCliReference'];
/** The CLI's repository settings: `disabledSkills`, `disabledMcpServers`. */
const CLI_SETTINGS: Evidence = ['copilotCliConfigDir'];
/** Imports the CLI's reference and its how-to describe differently. */
const CLI_IMPORTS: Evidence = ['copilotCliInstructions', 'copilotCliReference'];
const HOOKS: Readonly<Record<Surface, Evidence>> = {
  cli: ['copilotHooksReference'],
  vscode: ['vscodeHooks', 'vscodeHooksReference'],
  cloud: ['copilotHooksReference'],
};
/** `disableAllHooks` in the CLI's repository settings or Claude Code's settings files. */
const CLI_HOOKS_OFF: Evidence = ['copilotHooksReference', 'copilotCliConfigDir'];
const CLI_MCP: Evidence = ['copilotCliMcp'];
const VSCODE_MCP: Evidence = ['vscodeMcp'];
const CODE_REVIEW: Evidence = ['copilotCodeReview'];

/** Lines per instruction file that GitHub recommends for code review (SOURCES.copilotCodeReview). */
export const CODE_REVIEW_ADVISED_LINES = 1000;

/** The instruction files Copilot finds by name, relative to the directory they belong to. */
type SlotName =
  | '.github/copilot-instructions.md'
  | 'AGENTS.md'
  | 'CLAUDE.md'
  | '.claude/CLAUDE.md'
  | 'CLAUDE.local.md'
  | 'GEMINI.md';

/** Startup order within one directory: the order of the sources' tables. */
const SLOT_ORDER: readonly SlotName[] = [
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
  'GEMINI.md',
];

/** Files whose `@path` references the CLI inlines. Not GEMINI.md or `*.instructions.md`. */
const IMPORTING_SLOTS: ReadonlySet<SlotName> = new Set<SlotName>([
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
]);

/** Kinds instr/filename-case reports for Copilot when only the letter case matches. */
const CASE_REPORTED: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'agents-md',
  'claude-md',
  'gemini-md',
]);

/** Kinds instr/empty-file reports for Copilot when they are blank. */
const EMPTY_REPORTED: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'agents-md',
  'claude-md',
  'gemini-md',
  'copilot-instructions',
]);

/**
 * Events the cloud agent fires (SOURCES.copilotHooksReference). `preCompact` fires only for
 * automatic compaction; `notification` never fires; `permissionRequest` does not fire or has no
 * effect.
 */
const CLOUD_EVENTS: ReadonlySet<string> = new Set([
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'userPromptTransformed',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'agentStop',
  'subagentStart',
  'subagentStop',
  'errorOccurred',
  'preCompact',
]);

const COPILOT_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS.copilot);

/** The CLI's skill folders of one directory, in its order of precedence. */
const CLI_SKILL_FOLDERS: readonly string[] = ['.github/skills', '.agents/skills', '.claude/skills'];

/** The CLI's repository settings files at the repository root, the shared one first. */
const CLI_SETTINGS_FILES: readonly string[] = [
  '.github/copilot/settings.json',
  '.github/copilot/settings.local.json',
];

/** Directory names whose unlisted contents may hold configuration Copilot reads. */
const CONFIG_DIRECTORIES: ReadonlySet<string> = new Set([
  '.github',
  '.claude',
  '.agents',
  '.vscode',
]);
const CONFIG_SUBDIRECTORIES: ReadonlySet<string> = new Set([
  'commands',
  'copilot',
  'hooks',
  'instructions',
  'rules',
  'skills',
]);

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

const ASSUMPTIONS: Readonly<Record<Surface, readonly Assumption[]>> = {
  cli: [
    {
      key: 'copilot.surface',
      value: 'cli',
      origin: 'default',
      evidence: ['copilotInstructionsSupport'],
    },
    {
      key: 'copilot-cli.trusted_folder',
      value: true,
      origin: 'default',
      evidence: ['copilotCliMcp', 'copilotHooksReference'],
    },
  ],
  vscode: [
    {
      key: 'copilot.surface',
      value: 'vscode',
      origin: 'default',
      evidence: ['copilotInstructionsSupport'],
    },
    {
      key: 'vscode.agent_harness',
      value: 'local',
      origin: 'default',
      evidence: ['vscodeInstructions'],
    },
    {
      key: 'vscode.chat.useAgentsMdFile',
      value: true,
      origin: 'default',
      evidence: ['vscodeInstructions'],
    },
    {
      key: 'vscode.chat.useClaudeHooks',
      value: false,
      origin: 'default',
      evidence: ['vscodeHooks'],
    },
    {
      key: 'vscode.chat.useClaudeMdFile',
      value: true,
      origin: 'default',
      evidence: ['vscodeInstructions'],
    },
    {
      key: 'vscode.chat.useNestedAgentsMdFiles',
      value: false,
      origin: 'default',
      evidence: ['vscodeInstructions'],
    },
    {
      key: 'vscode.github.copilot.chat.codeGeneration.useInstructionFiles',
      value: true,
      origin: 'default',
      evidence: ['vscodeInstructions'],
    },
    {
      key: 'vscode.workspace_trusted',
      value: true,
      origin: 'default',
      evidence: ['vscodeHooks', 'vscodeMcp'],
    },
  ],
  cloud: [
    {
      key: 'copilot.surface',
      value: 'cloud-agent',
      origin: 'default',
      evidence: ['copilotInstructionsSupport'],
    },
  ],
};

const HIDDEN: Readonly<Record<Surface, readonly HiddenScope[]>> = {
  cli: [
    { scope: 'managed', locations: ['policy hooks'], roles: ['hook'] },
    {
      scope: 'plugin',
      locations: ['installed plugins'],
      roles: ['hook', 'mcp-server', 'skill'],
    },
    {
      scope: 'user',
      locations: sorted([
        '$COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
        '~/.agents/skills/',
        '~/.copilot/copilot-instructions.md',
        '~/.copilot/hooks/',
        '~/.copilot/instructions/',
        '~/.copilot/mcp-config.json',
        '~/.copilot/settings.json',
        '~/.copilot/skills/',
      ]),
      roles: ['hook', 'instructions', 'mcp-server', 'rule', 'skill'],
    },
  ],
  vscode: [
    {
      scope: 'account',
      locations: ['organization instructions (GitHub organization settings)'],
      roles: ['instructions'],
    },
    { scope: 'plugin', locations: ['agent plugins and extensions'], roles: ['hook', 'skill'] },
    {
      scope: 'user',
      locations: sorted([
        '~/.agents/skills/',
        '~/.claude/CLAUDE.md',
        '~/.claude/rules/',
        '~/.claude/skills/',
        '~/.copilot/hooks/',
        '~/.copilot/instructions/',
        '~/.copilot/skills/',
        'VS Code profile: instructions and mcp.json',
      ]),
      roles: ['hook', 'instructions', 'mcp-server', 'rule', 'skill'],
    },
  ],
  cloud: [
    {
      scope: 'account',
      locations: [
        'cloud agent MCP configuration (repository settings)',
        'organization instructions',
        'personal instructions',
      ],
      roles: ['instructions', 'mcp-server'],
    },
  ],
};

/** Where an instruction file sits: the directory it belongs to and its name there. */
interface Slot {
  readonly directory: string;
  readonly name: SlotName;
}

const COPILOT_INSTRUCTIONS: SlotName = '.github/copilot-instructions.md';

/** Instruction files named the same in every directory. */
const SLOT_OF_KIND: Readonly<Partial<Record<ArtifactKind, SlotName>>> = {
  'agents-md': 'AGENTS.md',
  'claude-local-md': 'CLAUDE.local.md',
  'gemini-md': 'GEMINI.md',
};

function slotOf(path: string, kind: ArtifactKind): Slot | undefined {
  const directory = dirnamePosix(path);
  if (kind === 'copilot-instructions') {
    if (path === COPILOT_INSTRUCTIONS) return { directory: '', name: COPILOT_INSTRUCTIONS };
    return path.endsWith(`/${COPILOT_INSTRUCTIONS}`)
      ? { directory: path.slice(0, -COPILOT_INSTRUCTIONS.length - 1), name: COPILOT_INSTRUCTIONS }
      : undefined;
  }
  if (kind === 'claude-md') {
    return basename(directory) === '.claude'
      ? { directory: dirnamePosix(directory), name: '.claude/CLAUDE.md' }
      : { directory, name: 'CLAUDE.md' };
  }
  const name = SLOT_OF_KIND[kind];
  return name === undefined ? undefined : { directory, name };
}

/** True when `directory` is `root` or inside it. */
function within(directory: string, root: string): boolean {
  return root === '' || directory === root || directory.startsWith(`${root}/`);
}

function sizeOf(bytes: number, chars: number): Size {
  return { bytes, chars, tokens: tokensOf(chars) };
}

function textSize(text: string): Size {
  return {
    bytes: utf8ByteLength(text),
    chars: codePointLength(text),
    tokens: estimateTokens(text),
  };
}

/** The whole file: Copilot documents no transform of instruction text. */
function fileSize(artifact: Artifact): Size {
  return sizeOf(artifact.file.bytes.length, codePointLength(artifact.decoded.text));
}

/** Splits a comma-separated pattern string, keeping commas inside `{...}` braces. */
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

interface RuleTrigger {
  readonly trigger: LoadTrigger;
  readonly patterns?: readonly string[];
  readonly certainty: Certainty;
}

const UNKNOWN_TRIGGER: RuleTrigger = { trigger: 'unknown', certainty: 'unverified' };

/**
 * When VS Code applies a `.claude/rules` file: to the files its `paths` array matches, every file
 * (`**`) without one. A `paths` string and frontmatter VS Code may not read are not documented.
 */
function claudeRuleTrigger(frontmatter: FrontmatterResult): RuleTrigger {
  if (frontmatter.kind === 'absent') {
    return { trigger: 'on-path', patterns: ['**'], certainty: 'documented' };
  }
  if (frontmatter.kind !== 'valid') return { trigger: 'unknown', certainty: 'unverified' };
  const { data } = frontmatter;
  if (!data.keys.includes('paths')) {
    return { trigger: 'on-path', patterns: ['**'], certainty: 'documented' };
  }
  const value = data.values['paths'];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const patterns = value.filter((item: string) => item.trim() !== '');
    if (patterns.length > 0) return { trigger: 'on-path', patterns, certainty: 'documented' };
  }
  if (typeof value === 'string' && splitPatterns(value).length > 0) {
    return { trigger: 'on-path', patterns: splitPatterns(value), certainty: 'unverified' };
  }
  return UNKNOWN_TRIGGER;
}

/**
 * When the CLI applies a `.claude/rules` file: "the same way it reads
 * `.github/instructions/**\/*.instructions.md` files", to the files its `paths` (a string or a
 * list) or `applyTo` patterns match (SOURCES.copilotCliReference). A file with neither, like an
 * instructions file without `applyTo`, is not documented; nor is one with both keys, or an
 * `applyTo` list.
 */
function cliClaudeRuleTrigger(frontmatter: FrontmatterResult): RuleTrigger {
  if (frontmatter.kind !== 'valid') return UNKNOWN_TRIGGER;
  const { keys, values } = frontmatter.data;
  const both = keys.includes('paths') && keys.includes('applyTo');
  if (keys.includes('paths')) {
    const value = values['paths'];
    const patterns =
      typeof value === 'string'
        ? splitPatterns(value)
        : Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? value.map((item: string) => item.trim()).filter((item) => item !== '')
          : [];
    if (patterns.length === 0) return UNKNOWN_TRIGGER;
    return { trigger: 'on-path', patterns, certainty: both ? 'unverified' : 'documented' };
  }
  const { applyTo } = copilotActivation(frontmatter);
  if (applyTo.kind !== 'patterns' && applyTo.kind !== 'list') return UNKNOWN_TRIGGER;
  if (applyTo.patterns.length === 0) return UNKNOWN_TRIGGER;
  return {
    trigger: 'on-path',
    patterns: applyTo.patterns,
    certainty: applyTo.kind === 'patterns' ? 'documented' : 'unverified',
  };
}

/**
 * A Copilot hook file the hooks reference says is rejected whole: a `version` other than 1, or an
 * event whose value is not an array (SOURCES.copilotHooksReference).
 */
function rejectedHookFile(doc: ParsedJson): boolean {
  const root = doc.value;
  if (!isObject(root)) return false;
  const version = own(root, 'version');
  if (version !== undefined && version !== 1) return true;
  const hooks = own(root, 'hooks');
  if (!isObject(hooks)) return false;
  return Object.keys(hooks).some((event) => !Array.isArray(hooks[event]));
}

/**
 * A server with a `url` but neither `type` nor `command`: the CLI and VS Code document a `type`
 * for remote servers, not what they do without one.
 */
function serverCertainty(config: JsonObject): Certainty {
  return urlWithoutType(config) ? 'unverified' : 'documented';
}

/** One path that reaches an artifact, with the kind of file it is at that path. */
interface Reached {
  readonly path: string;
  readonly artifact: Artifact;
  readonly kind: ArtifactKind;
  readonly caseMismatch: boolean;
}

/** Every path that reaches `artifact`: its own, then its symlink aliases that classify. */
function reachedOf(artifact: Artifact): Reached[] {
  const reached: Reached[] = [
    {
      path: artifact.path,
      artifact,
      kind: artifact.kind,
      caseMismatch: artifact.caseMismatch !== undefined,
    },
  ];
  for (const alias of artifact.aliases) {
    // An alias is what the agent sees at that path, so its own name decides its role.
    const classification = classify(alias);
    if (classification === undefined) continue;
    reached.push({
      path: alias,
      artifact,
      kind: classification.kind,
      caseMismatch: classification.caseMismatch !== undefined,
    });
  }
  return reached;
}

/**
 * How Copilot CLI finds `@path` references: its tokenization is not documented, so Claude Code's
 * is reused, resolution relative to the file included.
 */
export const COPILOT_CLI_IMPORT_DIALECT: ImportDialect = 'claude';

/**
 * The files whose `@path` references Copilot CLI inlines when it loads them as instruction
 * files: `.github/copilot-instructions.md`, AGENTS.md, CLAUDE.md and `.claude/CLAUDE.md` in any
 * directory, reached by their exact names. The CLI reads them in the directories from the
 * repository root to the working directory, and in the directories of the files it works on.
 * The walker's import pass (src/io/imports.ts) starts from these files too.
 */
export function copilotCliImportRoots(artifacts: readonly Artifact[]): Artifact[] {
  return artifacts.filter((artifact) =>
    reachedOf(artifact).some((file) => {
      const slot = slotOf(file.path, file.kind);
      return !file.caseMismatch && slot !== undefined && IMPORTING_SLOTS.has(slot.name);
    }),
  );
}

/**
 * True when Copilot CLI inlines the references in a file of `kind` that a reference reached: in
 * every file but GEMINI.md and `*.instructions.md` files.
 */
export function copilotCliExpandsImported(kind: ArtifactKind): boolean {
  return kind !== 'gemini-md' && kind !== 'copilot-path-instructions';
}

interface Access {
  readonly trigger: 'startup' | 'on-path';
  readonly certainty: Certainty;
}

interface Frame {
  readonly artifact: Artifact;
  readonly path: string;
  readonly via: readonly string[];
  readonly edges: readonly ImportEdge[];
  readonly hop: number;
  next: number;
}

interface Measured {
  readonly path: string;
  readonly value: number;
}

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

class CopilotLoader {
  readonly #view: LoadView;
  readonly #surface: Surface;
  readonly #cwd: string;
  /** The repository root for the CLI and the cloud agent; the workspace folder for VS Code. */
  readonly #root: string;
  /** Directories from `#root` down to the working directory. */
  readonly #chain: readonly string[];
  readonly #reached: readonly Reached[];

  readonly #entries = new Map<string, LoadEntry>();
  readonly #skipped = new Map<string, SkippedLoad>();
  readonly #outOfScope = new Map<string, OutOfScope>();
  readonly #incomplete = new Set<string>();
  /** Copilot instruction files a path of which this surface reads or skips where it looks. */
  readonly #placed = new Set<Artifact>();
  /** CLI: files in context, and their text, so identical copies load once. */
  readonly #loaded = new Set<Artifact>();
  readonly #loadedText = new Set<string>();
  /** CLI: the names of the skills it lists, which a command of the same name gives way to. */
  readonly #skillNamesListed = new Set<string>();
  #graph: ImportGraph | undefined;
  #settings: readonly ParsedJson[] | undefined;
  /** CLI: how sure it is that the repository's settings turn every hook off, if they do. */
  #hooksOff: Certainty | undefined;
  #position = 0;

  // Usage of each limit.
  readonly #hops: Measured[] = [];
  readonly #lines: Measured[] = [];
  readonly #skillNames: Measured[] = [];
  readonly #skillDescriptions: Measured[] = [];

  constructor(view: LoadView, surface: Surface, cwd: string) {
    this.#view = view;
    this.#surface = surface;
    this.#cwd = cwd;
    this.#root = surface === 'vscode' ? cwd : (nearestGitRoot(view.snapshot, cwd) ?? '');
    this.#chain = selfAndAncestors(cwd)
      .filter((directory) => within(directory, this.#root))
      .reverse();
    this.#reached = view.artifacts.flatMap(reachedOf);
  }

  build(): LoadPlan {
    this.#instructions();
    this.#pathInstructions();
    if (this.#surface !== 'cloud') this.#claudeRules();
    this.#misplaced();
    this.#skills();
    if (this.#surface === 'cli') this.#commands();
    this.#mcp();
    this.#hooks();
    this.#unread();
    return this.#plan();
  }

  // -------------------------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------------------------

  /**
   * Where a directory sits: on the startup chain (`path`), below the working directory, elsewhere
   * in the repository (or workspace), or outside it (undefined).
   */
  #scope(directory: string): 'path' | 'below' | 'elsewhere' | undefined {
    if (!within(directory, this.#root)) return undefined;
    if (this.#chain.includes(directory)) return 'path';
    return within(directory, this.#cwd) ? 'below' : 'elsewhere';
  }

  #startup(): Access {
    // Copilot documents no order, so every position is unverified.
    return { trigger: 'startup', certainty: 'unverified' };
  }

  /** How this surface reaches an instruction file in `slot`, `not-read`, or not at all. */
  #instructionAccess(slot: Slot): Access | 'not-read' | undefined {
    const scope = this.#scope(slot.directory);
    if (scope === undefined) return undefined;
    switch (this.#surface) {
      case 'cli':
        if (slot.name === 'CLAUDE.local.md') return undefined;
        if (scope === 'path') return this.#startup();
        // "Directories nested in the path of a file it is working on"; files in another branch
        // than the working directory are not mentioned.
        return { trigger: 'on-path', certainty: scope === 'below' ? 'documented' : 'unverified' };
      case 'vscode':
        if (slot.name === 'GEMINI.md') return undefined;
        if (scope === 'path') return this.#startup();
        // chat.useNestedAgentsMdFiles is off by default.
        return slot.name === 'AGENTS.md' ? 'not-read' : undefined;
      case 'cloud':
        if (slot.name === 'AGENTS.md') {
          // The nearest AGENTS.md in the directory tree takes precedence.
          return scope === 'path'
            ? this.#startup()
            : { trigger: 'on-path', certainty: 'documented' };
        }
        if (slot.directory !== this.#root) return undefined;
        return slot.name === '.claude/CLAUDE.md' || slot.name === 'CLAUDE.local.md'
          ? undefined
          : this.#startup();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Instruction files
  // -------------------------------------------------------------------------------------------

  #instructions(): void {
    const evidence = INSTRUCTIONS[this.#surface];
    const startup: { file: Reached; slot: Slot }[] = [];
    const later: { file: Reached; slot: Slot; access: Access }[] = [];
    for (const file of this.#reached) {
      const slot = slotOf(file.path, file.kind);
      if (slot === undefined) continue;
      const access = this.#instructionAccess(slot);
      if (access === undefined) continue;
      if (file.kind === 'copilot-instructions') this.#placed.add(file.artifact);
      if (access === 'not-read') {
        this.#skip({
          role: 'instructions',
          path: file.path,
          code: 'not-read',
          certainty: 'documented',
          evidence,
        });
        continue;
      }
      if (file.caseMismatch) {
        // Found on case-insensitive file systems only; Copilot documents exact names.
        if (CASE_REPORTED.has(file.kind)) {
          this.#skip({
            role: 'instructions',
            path: file.path,
            code: 'case-mismatch',
            ruleId: 'instr/filename-case',
            size: fileSize(file.artifact),
            certainty: 'unverified',
            evidence,
          });
        }
        continue;
      }
      if (EMPTY_REPORTED.has(file.kind) && isBlank(file.artifact.decoded.text)) {
        // Whether Copilot skips a blank file or sends it as is is not documented.
        this.#skip({
          role: 'instructions',
          path: file.path,
          code: 'blank-file',
          ruleId: 'instr/empty-file',
          certainty: 'unverified',
          evidence,
        });
        continue;
      }
      if (access.trigger === 'startup') startup.push({ file, slot });
      else later.push({ file, slot, access });
    }
    const rank = (slot: Slot): number =>
      this.#chain.indexOf(slot.directory) * SLOT_ORDER.length + SLOT_ORDER.indexOf(slot.name);
    startup.sort((a, b) => rank(a.slot) - rank(b.slot) || compareStrings(a.file.path, b.file.path));
    for (const { file, slot } of startup) {
      this.#addInstructions(file, slot, this.#startup(), evidence);
    }
    later.sort((a, b) => compareStrings(a.file.path, b.file.path));
    for (const { file, slot, access } of later) {
      this.#addInstructions(file, slot, access, evidence);
    }
  }

  #addInstructions(file: Reached, slot: Slot, access: Access, evidence: Evidence): void {
    const { artifact, path } = file;
    const patterns = access.trigger === 'on-path' ? [`${slot.directory}/**`] : undefined;
    // The CLI removes identical copies of a file, such as a CLAUDE.md that links to AGENTS.md:
    // the copy loads, and adds no characters.
    const copy =
      this.#surface === 'cli' &&
      (this.#loaded.has(artifact) || this.#loadedText.has(artifact.decoded.text));
    if (copy && this.#entries.has(`import:${path}`)) return;
    if (this.#surface === 'cli') {
      this.#loaded.add(artifact);
      this.#loadedText.add(artifact.decoded.text);
    }
    this.#add({
      id: `instructions:${path}`,
      role: 'instructions',
      trigger: access.trigger,
      ...(access.trigger === 'startup' ? { position: ++this.#position } : {}),
      path,
      realPath: artifact.realPath,
      ...(patterns === undefined ? {} : { patterns }),
      size: copy ? sizeOf(artifact.file.bytes.length, 0) : fileSize(artifact),
      certainty: access.certainty,
      evidence,
    });
    this.#measureLines(path, artifact);
    if (!copy && this.#surface === 'cli' && IMPORTING_SLOTS.has(slot.name)) {
      this.#expand(path, artifact, access, patterns);
    }
  }

  /** Lines of an instruction file the cloud agent (and code review) uses. */
  #measureLines(path: string, artifact: Artifact): void {
    if (this.#surface === 'cloud') {
      this.#lines.push({ path, value: lineCount(artifact.decoded.text) });
    }
  }

  // -------------------------------------------------------------------------------------------
  // CLI `@path` references
  // -------------------------------------------------------------------------------------------

  #importGraph(): ImportGraph {
    this.#graph ??= new ImportGraph(this.#view);
    return this.#graph;
  }

  #frame(artifact: Artifact, path: string, via: readonly string[], hop: number): Frame | undefined {
    const graph = this.#importGraph();
    const doc = this.#view.markdown(artifact);
    if (!doc.analysis.complete) this.#incomplete.add(`markdown-budget:${artifact.path}`);
    const edges = graph.edges(artifact, COPILOT_CLI_IMPORT_DIALECT);
    if (!graph.spend(edges.length)) return undefined;
    return { artifact, path, via, edges, hop, next: 0 };
  }

  /**
   * References in `root` in the order the CLI inlines them: depth first, in source order, each
   * file once. The CLI's tokenization is not documented, so Claude Code's is reused, and every
   * file reached this way is unverified. A depth limit exists; its value is not documented.
   */
  #expand(
    rootPath: string,
    root: Artifact,
    access: Access,
    patterns: readonly string[] | undefined,
  ): void {
    const evidence = INSTRUCTIONS.cli;
    const repository = scanRootIsRepository(this.#view.snapshot);
    const first = this.#frame(root, rootPath, [], 0);
    if (first === undefined) {
      this.#incomplete.add(`import-budget:${rootPath}`);
      return;
    }
    const stack: Frame[] = [first];
    const visited = new Set<Artifact>([root]);
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const edge = frame.edges[frame.next];
      if (edge === undefined) {
        stack.pop();
        continue;
      }
      frame.next++;
      const { reference, target } = edge;
      if (target === undefined || !within(dirnamePosix(target), this.#root)) {
        // "Referenced files must remain within the repository"; "absolute paths and paths
        // beginning with `~/` are not loaded" (the how-to). The reference says paths "can be
        // relative to the instruction file's directory or absolute", so an absolute path is
        // unverified.
        const outside = claudeImportOutsideRoot(edge, repository);
        if (target !== undefined || outside !== undefined) {
          const absolute = outside === 'absolute';
          this.#skip({
            role: 'import',
            path: frame.path,
            name: reference.path,
            code: 'not-read',
            certainty: absolute ? 'unverified' : 'documented',
            evidence: absolute ? CLI_IMPORTS : evidence,
          });
        }
        continue;
      }
      const via = [...frame.via, frame.path];
      const hop = frame.hop + 1;
      const imported = this.#view.index.get(target);
      if (imported === undefined) {
        this.#unreadImport(reference, target, access, patterns, via, hop);
        continue;
      }
      if (visited.has(imported)) continue;
      visited.add(imported);
      if (this.#loaded.has(imported)) continue;
      this.#loaded.add(imported);
      this.#add({
        id: `import:${target}`,
        role: 'import',
        trigger: access.trigger,
        ...(access.trigger === 'startup' ? { position: ++this.#position } : {}),
        path: target,
        realPath: imported.realPath,
        via,
        ...(patterns === undefined ? {} : { patterns }),
        size: fileSize(imported),
        certainty: 'unverified',
        evidence,
      });
      this.#hops.push({ path: target, value: hop });
      // References are not expanded in GEMINI.md or `*.instructions.md` files.
      if (!copilotCliExpandsImported(imported.kind)) continue;
      const next = this.#frame(imported, target, via, hop);
      if (next === undefined) {
        this.#incomplete.add(`import-budget:${rootPath}`);
        return;
      }
      stack.push(next);
    }
  }

  /** A referenced file agentcheckup did not read: listed without a size, its references unknown. */
  #unreadImport(
    reference: ImportReference,
    target: string,
    access: Access,
    patterns: readonly string[] | undefined,
    via: readonly string[],
    hop: number,
  ): void {
    const status = pathStatus(this.#view.snapshot, target);
    if (status === 'missing') return;
    if (status === 'exists' && this.#view.snapshot.paths.has(`${target}/`)) return;
    this.#incomplete.add(`unread:${target}`);
    if (status === 'unknown') return;
    if (!looksLikeFilePath(withoutTrailingPunctuation(reference.path))) return;
    if (this.#entries.has(`import:${target}`)) return;
    this.#add({
      id: `import:${target}`,
      role: 'import',
      trigger: access.trigger,
      ...(access.trigger === 'startup' ? { position: ++this.#position } : {}),
      path: target,
      realPath: target,
      via,
      ...(patterns === undefined ? {} : { patterns }),
      certainty: 'unverified',
      evidence: INSTRUCTIONS.cli,
    });
    this.#hops.push({ path: target, value: hop });
  }

  // -------------------------------------------------------------------------------------------
  // Path-specific instructions and .claude/rules
  // -------------------------------------------------------------------------------------------

  /** The `.github/instructions` folders this surface reads, as path prefixes. */
  #instructionFolders(): string[] {
    const owners =
      this.#surface === 'cli'
        ? [...new Set([this.#root, this.#cwd])]
        : [this.#surface === 'vscode' ? this.#cwd : this.#root];
    return owners.map((owner) => `${joinPath(owner, '.github/instructions')}/`);
  }

  #readsPathInstructions(path: string): boolean {
    return this.#instructionFolders().some((prefix) => path.startsWith(prefix));
  }

  #pathInstructions(): void {
    const evidence = PATH_INSTRUCTIONS[this.#surface];
    for (const file of this.#reached) {
      if (file.kind !== 'copilot-path-instructions' || !this.#readsPathInstructions(file.path)) {
        continue;
      }
      const { artifact, path } = file;
      if (this.#placed.has(artifact)) continue;
      this.#placed.add(artifact);
      const activation = copilotActivation(this.#view.frontmatter(artifact));
      const base = {
        id: `rule:${path}`,
        role: 'rule',
        path,
        realPath: artifact.realPath,
        size: fileSize(artifact),
        evidence,
      } as const;
      const patterns = 'patterns' in activation.applyTo ? activation.applyTo.patterns : [];
      const onPath = { ...base, trigger: 'on-path', patterns } as const;
      switch (this.#surface) {
        case 'cli':
          // A file with an `applyTo` applies to matching files; others are not documented.
          this.#add(
            activation.applyTo.kind === 'patterns'
              ? { ...onPath, certainty: 'documented' }
              : { ...base, trigger: 'unknown', certainty: 'unverified' },
          );
          break;
        case 'vscode':
          switch (activation.vscode) {
            case 'on-path':
              this.#add({ ...onPath, certainty: 'documented' });
              break;
            case 'model-selected':
            case 'manual':
              this.#add({ ...base, trigger: activation.vscode, certainty: 'documented' });
              break;
            case 'unknown':
            case 'never':
              this.#add({ ...base, trigger: 'unknown', certainty: 'unverified' });
              break;
          }
          break;
        case 'cloud':
          this.#cloudPathInstructions(file, activation, base, onPath);
          break;
      }
    }
  }

  #cloudPathInstructions(
    file: Reached,
    activation: ReturnType<typeof copilotActivation>,
    base: Omit<LoadEntry, 'trigger' | 'certainty'>,
    onPath: Omit<LoadEntry, 'certainty'>,
  ): void {
    const { artifact, path } = file;
    const evidence = PATH_INSTRUCTIONS.cloud;
    if (activation.cloud === 'never') {
      const judged = judgedByApplyTo(this.#view, this.#view.snapshot, artifact);
      this.#skip({
        role: 'rule',
        path: judged ? artifact.path : path,
        code: judged ? 'no-apply-to' : 'not-read',
        ...(judged ? { ruleId: 'copilot/apply-to' } : {}),
        size: fileSize(artifact),
        certainty: 'documented',
        evidence,
      });
      return;
    }
    if (activation.excludeAgent === 'cloud-agent') {
      this.#skip({ role: 'rule', path, code: 'not-read', certainty: 'documented', evidence });
      return;
    }
    // `excludeAgent: coding-agent` is the value from before the agent's rename.
    const renamed = activation.frontmatter === 'valid' && this.#excludesCodingAgent(artifact);
    if (activation.cloud === 'on-path') {
      this.#add({ ...onPath, certainty: renamed ? 'unverified' : 'documented' });
    } else {
      this.#add({ ...base, trigger: 'unknown', certainty: 'unverified' });
    }
    this.#measureLines(path, artifact);
  }

  #excludesCodingAgent(artifact: Artifact): boolean {
    const frontmatter = this.#view.frontmatter(artifact);
    return (
      frontmatter.kind === 'valid' && frontmatter.data.values['excludeAgent'] === 'coding-agent'
    );
  }

  /**
   * The `.claude/rules` folders this surface reads, as path prefixes: the CLI's at the repository
   * root and in the working directory, VS Code's in the workspace folder. Both search them
   * recursively.
   */
  #claudeRuleFolders(): string[] {
    const owners = this.#surface === 'cli' ? [...new Set([this.#root, this.#cwd])] : [this.#cwd];
    return owners.map((owner) => `${joinPath(owner, '.claude/rules')}/`);
  }

  #readsClaudeRule(path: string): boolean {
    return this.#claudeRuleFolders().some((prefix) => path.startsWith(prefix));
  }

  #claudeRules(): void {
    for (const file of this.#reached) {
      if (file.kind !== 'claude-rule' || !this.#readsClaudeRule(file.path)) continue;
      const { artifact, path } = file;
      const frontmatter = this.#view.frontmatter(artifact);
      const { text } = artifact.decoded;
      // instr/empty-file's test for a rule: blank, or valid frontmatter and a blank body.
      if (
        isBlank(text) ||
        (frontmatter.kind === 'valid' && isBlank(text.slice(frontmatter.bodyOffset)))
      ) {
        // Whether Copilot skips a blank file or sends it as is is not documented.
        this.#skip({
          role: 'rule',
          path,
          code: 'blank-file',
          ruleId: 'instr/empty-file',
          certainty: 'unverified',
          evidence: CLAUDE_RULES[this.#surface],
        });
        continue;
      }
      const { trigger, patterns, certainty } =
        this.#surface === 'cli'
          ? cliClaudeRuleTrigger(frontmatter)
          : claudeRuleTrigger(frontmatter);
      this.#add({
        id: `rule:${path}`,
        role: 'rule',
        trigger,
        path,
        realPath: artifact.realPath,
        ...(patterns === undefined ? {} : { patterns }),
        size: fileSize(artifact),
        certainty,
        evidence: CLAUDE_RULES[this.#surface],
      });
    }
  }

  /**
   * Copilot instruction files no path of which this surface reads where it looks: skipped where
   * copilot/instructions-misplaced reports them, else not meant for Copilot here.
   */
  #misplaced(): void {
    for (const artifact of this.#view.artifacts) {
      if (
        artifact.kind !== 'copilot-instructions' &&
        artifact.kind !== 'copilot-path-instructions'
      ) {
        continue;
      }
      if (this.#placed.has(artifact)) continue;
      const paths = [artifact.path, ...artifact.aliases];
      if (!paths.some((path) => this.#scope(dirnamePosix(path)) !== undefined)) continue;
      const misplaced = copilotMisplacement(this.#view.snapshot, artifact);
      const role: LoadRole = artifact.kind === 'copilot-instructions' ? 'instructions' : 'rule';
      if (misplaced !== undefined) {
        const caseOnly = misplaced.where.kind === 'case';
        this.#skip({
          role,
          path: artifact.path,
          code: caseOnly ? 'case-mismatch' : 'wrong-location',
          ruleId: 'copilot/instructions-misplaced',
          size: fileSize(artifact),
          certainty: caseOnly ? 'unverified' : 'documented',
          evidence: MISPLACED[this.#surface],
        });
        continue;
      }
      // Where Copilot looks in another repository nested in this one, or in a folder another
      // session opens; else a file of the same name that is not meant for Copilot.
      const nested = paths.find(
        (path) => placement(this.#view.snapshot, path, copilotFolder(artifact)).kind === 'expected',
      );
      if (nested !== undefined) {
        if (this.#scope(dirnamePosix(nested)) === 'below') this.#out(nested, 'below-start-dir');
        continue;
      }
      this.#out(artifact.path, 'documentation');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------------------------

  /** How this surface reaches the skills root of `owner` (`<owner>/.github/skills`, ...). */
  #skillAccess(owner: string): Access | 'below' | undefined {
    const scope = this.#scope(owner);
    if (scope === undefined) return undefined;
    if (scope === 'below') return this.#surface === 'cloud' ? undefined : 'below';
    if (scope !== 'path') return undefined;
    if (owner === this.#root) return this.#startup();
    // Skills in the working directory or between it and the repository root: not documented.
    return this.#surface === 'cli' ? this.#startup() : undefined;
  }

  #skills(): void {
    const listed: { path: string; artifact: Artifact }[] = [];
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'skill') continue;
      const caseMismatch = artifact.caseMismatch !== undefined;
      let best: string | undefined;
      let below: string | undefined;
      let located = false;
      for (const path of [artifact.path, ...artifact.aliases]) {
        const location = skillLocation(path, caseMismatch);
        if (location === undefined) continue;
        located = true;
        if (!location.platforms.has('copilot')) continue;
        const owner = dirnamePosix(dirnamePosix(location.root));
        const access = this.#skillAccess(owner);
        if (access === 'below') below ??= path;
        else if (access !== undefined && (best === undefined || compareStrings(path, best) < 0)) {
          best = path;
        }
      }
      if (best === undefined) {
        if (below !== undefined) this.#out(below, 'below-start-dir');
        else if (!located) {
          const plugin = pluginReaders(this.#view.snapshot, artifact.path);
          if (plugin !== undefined && !plugin.includes('copilot')) {
            this.#out(artifact.path, 'other-agent-plugin');
          }
        }
        continue;
      }
      if (isBundledSkill(this.#view.snapshot, best)) {
        this.#out(best, 'payload-folder');
        continue;
      }
      listed.push({ path: best, artifact });
    }
    const kept = this.#surface === 'cli' ? this.#cliPrecedence(listed) : listed;
    kept.sort((a, b) => compareStrings(a.path, b.path));
    for (const { path, artifact } of kept) this.#skill(path, artifact);
  }

  /** A skill's name: its `name`, else its directory's. */
  #skillName(path: string, artifact: Artifact): string {
    const frontmatter = this.#view.frontmatter(artifact);
    const declared = frontmatter.kind === 'valid' ? frontmatter.data.values['name'] : undefined;
    return typeof declared === 'string' && declared.trim() !== ''
      ? declared.trim()
      : basename(dirnamePosix(path));
  }

  /**
   * Where the CLI looks for a skill first (SOURCES.copilotCliReference, "Skill locations"):
   * `.github/skills`, `.agents/skills` and `.claude/skills` of the project, the working directory,
   * then a parent directory's `.github/skills`. Parents are ranked closest first, which is not
   * documented, after the folders of the working directory; a parent's `.agents/skills` and
   * `.claude/skills` are not in the list (`documented: false`).
   */
  #cliSkillRank(path: string): {
    readonly rank: number;
    readonly parent: boolean;
    readonly documented: boolean;
  } {
    const root = skillLocation(path)?.root ?? '';
    const owner = dirnamePosix(dirnamePosix(root));
    const folder = (owner === '' ? root : root.slice(owner.length + 1)).toLowerCase();
    const order = Math.max(0, CLI_SKILL_FOLDERS.indexOf(folder));
    const distance = Math.max(0, this.#chain.length - 1 - this.#chain.indexOf(owner));
    return {
      rank: distance * CLI_SKILL_FOLDERS.length + order,
      parent: distance > 0,
      documented: distance === 0 || order === 0,
    };
  }

  /**
   * The CLI keeps the first skill of a name in its order of locations ("first found wins for
   * duplicate names") and skips the others. Two skills of one name in the same folder are both
   * listed: which one the CLI finds first is not documented (skill/duplicate-name reports them).
   * Records the names of the skills it keeps, which its commands give way to.
   */
  #cliPrecedence(listed: readonly { path: string; artifact: Artifact }[]): {
    path: string;
    artifact: Artifact;
  }[] {
    const ranked = listed
      .map((item) => ({
        ...item,
        name: this.#skillName(item.path, item.artifact),
        ...this.#cliSkillRank(item.path),
      }))
      .sort((a, b) => a.rank - b.rank || compareStrings(a.path, b.path));
    const first = new Map<string, (typeof ranked)[number]>();
    const kept: { path: string; artifact: Artifact }[] = [];
    for (const item of ranked) {
      const winner = first.get(item.name);
      if (winner === undefined) first.set(item.name, item);
      if (winner === undefined || winner.rank === item.rank) {
        kept.push({ path: item.path, artifact: item.artifact });
        this.#skillNamesListed.add(item.name);
        continue;
      }
      this.#skip({
        role: 'skill',
        path: item.path,
        name: item.name,
        code: 'shadowed-by-preferred',
        // The order of parent directories, and of a parent's other folders, is not documented.
        certainty: !winner.parent && item.documented ? 'documented' : 'unverified',
        evidence: SKILLS.cli,
      });
    }
    return kept;
  }

  /**
   * CLI: each `.claude/commands/*.md` file is a skill named after its file, "an alternative to
   * skills" with "lower priority than skills with the same name" (SOURCES.copilotCliReference).
   * It reads `description` and `disable-model-invocation`. In which directories the CLI looks for
   * the folder is not documented, nor whether it reads subfolders: the folders of the directories
   * on the startup chain are listed, as skills are, and every entry is unverified.
   */
  #commands(): void {
    const disabled = this.#cliSettingNames('disabledSkills');
    const listed: { path: string; artifact: Artifact; name: string }[] = [];
    for (const artifact of this.#view.artifacts) {
      if (artifact.kind !== 'claude-command') continue;
      const folder = inClaudeFolder(artifact.path, 'commands');
      if (folder === undefined) continue;
      const access = this.#skillAccess(folder.owner);
      if (access === 'below') {
        this.#out(artifact.path, 'below-start-dir');
        continue;
      }
      if (access === undefined) continue;
      listed.push({ path: artifact.path, artifact, name: basename(folder.relative).slice(0, -3) });
    }
    listed.sort((a, b) => compareStrings(a.path, b.path));
    for (const { path, artifact, name } of listed) {
      if (this.#skillNamesListed.has(name)) {
        this.#skip({
          role: 'skill',
          path,
          name,
          code: 'shadowed-by-preferred',
          certainty: 'documented',
          evidence: CLI_COMMANDS,
        });
        continue;
      }
      if (disabled.has(name)) {
        // `disabledSkills` names skills; whether it turns a command off is not documented.
        this.#skip({
          role: 'skill',
          path,
          name,
          code: 'disabled',
          certainty: 'unverified',
          evidence: [...CLI_COMMANDS, ...CLI_SETTINGS],
        });
        continue;
      }
      const frontmatter = this.#view.frontmatter(artifact);
      const values = frontmatter.kind === 'valid' ? frontmatter.data.values : undefined;
      const description = values?.['description'];
      const text = typeof description === 'string' ? description.trim() : '';
      const manual = values?.['disable-model-invocation'] === true;
      this.#add({
        id: `skill:${path}`,
        role: 'skill',
        trigger: manual ? 'manual' : 'startup',
        ...(manual ? {} : { position: ++this.#position }),
        path,
        realPath: artifact.realPath,
        name,
        size: textSize(text === '' ? name : `${name}\n${text}`),
        deferred: textSize(artifact.decoded.text.slice(bodyOffset(frontmatter))),
        certainty: 'unverified',
        evidence: CLI_COMMANDS,
      });
    }
  }

  #skill(path: string, artifact: Artifact): void {
    const evidence = SKILLS[this.#surface];
    const frontmatter = this.#view.frontmatter(artifact);
    const values = frontmatter.kind === 'valid' ? frontmatter.data.values : undefined;
    const declared = values?.['name'];
    const name = this.#skillName(path, artifact);
    const description = values?.['description'];
    const text = typeof description === 'string' ? description.trim() : '';
    if (this.#surface === 'vscode') {
      if (typeof declared === 'string') {
        this.#skillNames.push({ path, value: codePointLength(declared.trim()) });
      }
      if (typeof description === 'string') {
        this.#skillDescriptions.push({ path, value: codePointLength(text) });
      }
      if (this.#vscodeRejects(path, artifact, frontmatter)) return;
    }
    if (this.#surface === 'cli' && this.#cliSettingNames('disabledSkills').has(name)) {
      // "Skills discovered but not loaded."
      this.#skip({
        role: 'skill',
        path,
        name,
        code: 'disabled',
        certainty: 'documented',
        evidence: CLI_SETTINGS,
      });
      return;
    }
    // The CLI and VS Code document `disable-model-invocation` and `user-invocable`.
    const manual = this.#surface !== 'cloud' && values?.['disable-model-invocation'] === true;
    if (manual && values['user-invocable'] === false) {
      // Neither a slash command nor loaded by the model.
      this.#skip({
        role: 'skill',
        path,
        name,
        code: 'disabled',
        certainty: 'documented',
        evidence,
      });
      return;
    }
    // The listing: name and description. The exact text Copilot shows the model is not documented.
    const listing = text === '' ? name : `${name}\n${text}`;
    this.#add({
      id: `skill:${path}`,
      role: 'skill',
      trigger: manual ? 'manual' : 'startup',
      ...(manual ? {} : { position: ++this.#position }),
      path,
      realPath: artifact.realPath,
      name,
      size: textSize(listing),
      deferred: textSize(artifact.decoded.text.slice(bodyOffset(frontmatter))),
      // A parent directory's `.agents/skills` or `.claude/skills` is not a documented location.
      certainty:
        manual && (this.#surface !== 'cli' || this.#cliSkillRank(path).documented)
          ? 'documented'
          : 'unverified',
      evidence: manual ? evidence : [...evidence, 'agentSkillsSpec'],
    });
  }

  /**
   * VS Code does not load a skill whose `name` has invalid characters or is too long
   * (skill/name-format), or differs from its directory (skill/name-dir-mismatch). Skipped with the
   * rule that reports it; a skill no rule judges (in a template folder) is listed as unverified.
   */
  #vscodeRejects(path: string, artifact: Artifact, frontmatter: FrontmatterResult): boolean {
    if (frontmatter.kind !== 'valid') return false;
    const raw = frontmatter.data.values['name'];
    if (typeof raw !== 'string' || raw.trim() === '') return false;
    const judged =
      !isBundledSkill(this.#view.snapshot, artifact.path) && !inPayloadFolder(artifact.path);
    const issue = vscodeSkillNameIssue(raw);
    const directory = basename(dirnamePosix(path));
    const mismatch =
      normalizeName(directory) !== normalizeName(raw) &&
      pluginRootOf(this.#view.snapshot, path)?.root !== dirnamePosix(path);
    if (issue === undefined && !mismatch) return false;
    if (!judged) return false;
    const ruleId =
      issue !== undefined
        ? 'skill/name-format'
        : this.#nameDirReported(artifact)
          ? 'skill/name-dir-mismatch'
          : undefined;
    if (ruleId === undefined) return false;
    this.#skip({
      role: 'skill',
      path,
      name: raw.trim(),
      code: 'invalid-frontmatter',
      ruleId,
      // Only invalid characters are documented to make the skill fail to load.
      certainty: issue === 'characters' ? 'documented' : 'unverified',
      evidence: SKILLS.vscode,
    });
    return true;
  }

  /** Whether skill/name-dir-mismatch reports the skill for Copilot, as it walks its paths. */
  #nameDirReported(artifact: Artifact): boolean {
    const frontmatter = this.#view.frontmatter(artifact);
    if (frontmatter.kind !== 'valid') return false;
    const raw = frontmatter.data.values['name'];
    if (typeof raw !== 'string' || raw.trim() === '') return false;
    const name = normalizeName(raw);
    const reported = new Set<string>();
    for (const path of [artifact.path, ...artifact.aliases]) {
      const directory = dirnamePosix(path);
      if (directory === '') continue;
      const directoryName = basename(directory);
      if (reported.has(directoryName) || normalizeName(directoryName) === name) continue;
      if (pluginRootOf(this.#view.snapshot, path)?.root === directory) continue;
      reported.add(directoryName);
      const readers = readersAt(this.#view.snapshot, path, artifact.caseMismatch !== undefined);
      if (readers.has('copilot')) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // MCP servers
  // -------------------------------------------------------------------------------------------

  #mcp(): void {
    if (this.#surface === 'cli') this.#cliMcp();
    if (this.#surface === 'vscode') this.#vscodeMcp();
  }

  /**
   * `.mcp.json` and `.github/mcp.json` in each directory from the working directory up to the
   * repository root. In one directory `.mcp.json` wins; on a name conflict the file closer to the
   * working directory wins.
   */
  #cliMcp(): void {
    const taken = new Set<string>();
    const disabled = this.#cliSettingNames('disabledMcpServers');
    for (const directory of [...this.#chain].reverse()) {
      for (const [name, kind] of [
        ['.mcp.json', 'mcp-json'],
        ['.github/mcp.json', 'copilot-mcp'],
      ] as const) {
        const path = joinPath(directory, name);
        const doc = this.#configJson(path, kind);
        if (doc === undefined) continue;
        const { artifact, json } = doc;
        const servers = mcpServers(artifact, json);
        const inventoryIds = mcpInventoryIds(artifact.path, servers);
        servers.forEach((server, index) => {
          if (taken.has(server.name)) {
            this.#skip({
              role: 'mcp-server',
              path,
              name: server.name,
              code: 'shadowed-by-preferred',
              certainty: 'documented',
              evidence: CLI_MCP,
            });
            return;
          }
          taken.add(server.name);
          if (disabled.has(server.name)) {
            // "MCP servers configured but not started."
            this.#skip({
              role: 'mcp-server',
              path,
              name: server.name,
              code: 'disabled',
              certainty: 'documented',
              evidence: [...CLI_MCP, ...CLI_SETTINGS],
            });
            return;
          }
          this.#add({
            id: `mcp-server:${path}#${server.name}`,
            role: 'mcp-server',
            trigger: 'on-approval',
            path,
            realPath: artifact.realPath,
            name: server.name,
            inventoryId: inventoryIds[index] ?? '',
            certainty: serverCertainty(server.config),
            evidence: CLI_MCP,
          });
        });
      }
    }
    this.#configsBelow(['mcp-json', 'copilot-mcp'], (path) =>
      path.endsWith('.github/mcp.json') ? dirnamePosix(dirnamePosix(path)) : dirnamePosix(path),
    );
  }

  /** `.vscode/mcp.json` (`servers`) and `.mcp.json` (`mcpServers`) at the workspace root. */
  #vscodeMcp(): void {
    for (const [name, kind] of [
      ['.vscode/mcp.json', 'vscode-mcp'],
      ['.mcp.json', 'mcp-json'],
    ] as const) {
      const path = joinPath(this.#cwd, name);
      const doc = this.#configJson(path, kind);
      if (doc === undefined) continue;
      const { artifact, json } = doc;
      const servers = mcpServers(artifact, json);
      const inventoryIds = mcpInventoryIds(artifact.path, servers);
      servers.forEach((server, index) => {
        this.#add({
          id: `mcp-server:${path}#${server.name}`,
          role: 'mcp-server',
          trigger: 'on-approval',
          path,
          realPath: artifact.realPath,
          name: server.name,
          inventoryId: inventoryIds[index] ?? '',
          certainty: serverCertainty(server.config),
          evidence: VSCODE_MCP,
        });
      });
    }
    this.#configsBelow(['vscode-mcp'], (path) => dirnamePosix(dirnamePosix(path)));
  }

  /**
   * The parsed config file of `kind` at `path`. Flags one that exists but was not read, and one
   * that does not parse: no rule reports these files for Copilot, so the plan is incomplete.
   */
  #configJson(
    path: string,
    kind: ArtifactKind,
  ): { readonly artifact: Artifact; readonly json: ParsedJson } | undefined {
    const artifact = this.#configAt(path, kind);
    if (artifact === undefined) return undefined;
    const doc = this.#view.json(artifact);
    if (!doc.ok) {
      this.#incomplete.add(`unparsed:${path}`);
      return undefined;
    }
    return { artifact, json: doc };
  }

  #configAt(path: string, kind: ArtifactKind): Artifact | undefined {
    const artifact = this.#view.index.get(path);
    if (artifact !== undefined) return artifact.kind === kind ? artifact : undefined;
    const status = pathStatus(this.#view.snapshot, path);
    if (
      status === 'unknown' ||
      (status === 'exists' && !this.#view.snapshot.paths.has(`${path}/`))
    ) {
      this.#incomplete.add(`unread:${path}`);
    }
    return undefined;
  }

  /**
   * The CLI's repository settings that parse: `.github/copilot/settings.json` and
   * `.github/copilot/settings.local.json` at the repository root (SOURCES.copilotCliConfigDir).
   */
  #cliSettings(): readonly ParsedJson[] {
    if (this.#settings === undefined) {
      const docs: ParsedJson[] = [];
      for (const name of CLI_SETTINGS_FILES) {
        const path = joinPath(this.#root, name);
        const artifact = this.#configAt(path, 'copilot-settings');
        if (artifact === undefined) continue;
        const doc = this.#view.json(artifact);
        if (doc.ok) docs.push(doc);
        else this.#incomplete.add(`unparsed:${path}`);
      }
      this.#settings = docs;
    }
    return this.#settings;
  }

  /**
   * The names a list setting of the CLI's repository settings holds, such as `disabledSkills`.
   * The CLI merges these lists as a union, so a repository "can add entries, never remove"
   * (SOURCES.copilotCliConfigDir), and the names of both files count.
   */
  #cliSettingNames(key: string): ReadonlySet<string> {
    const names = new Set<string>();
    if (this.#surface !== 'cli') return names;
    for (const doc of this.#cliSettings()) {
      const value = settingAt(doc, [key]);
      if (!Array.isArray(value)) continue;
      for (const item of value as unknown[]) if (typeof item === 'string') names.add(item);
    }
    return names;
  }

  /** Config files of `kinds` that belong to a directory below the working directory. */
  #configsBelow(kinds: readonly ArtifactKind[], owner: (path: string) => string): void {
    for (const file of this.#reached) {
      if (!kinds.includes(file.kind)) continue;
      if (this.#scope(owner(file.path)) === 'below') this.#out(file.path, 'below-start-dir');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------------------------

  /** The `.github/hooks` folder this surface reads: at the repository or workspace root. */
  #hooksFolder(): string {
    return joinPath(this.#root, '.github/hooks');
  }

  #hooks(): void {
    this.#hooksOff = this.#repositoryHooksOff();
    const folder = this.#hooksFolder();
    for (const file of this.#reached) {
      if (file.kind !== 'copilot-hooks') continue;
      if (dirnamePosix(file.path) === folder) this.#copilotHookFile(file, 'hooks');
      else if (this.#scope(dirnamePosix(dirnamePosix(dirnamePosix(file.path)))) === 'below') {
        this.#out(file.path, 'below-start-dir');
      }
    }
    if (this.#surface === 'cli') {
      for (const name of ['.github/copilot/settings.json', '.github/copilot/settings.local.json']) {
        const path = joinPath(this.#root, name);
        const artifact = this.#configAt(path, 'copilot-settings');
        if (artifact !== undefined) {
          this.#copilotHookFile(
            { path, artifact, kind: artifact.kind, caseMismatch: false },
            'settings',
          );
        }
      }
    }
    if (this.#surface !== 'cloud') this.#claudeHooks();
  }

  /**
   * CLI: `disableAllHooks: true` at the top level of the repository's settings skips "every hook
   * from every source" (SOURCES.copilotHooksReference). The CLI reads it in
   * `.github/copilot/settings.json` and `.github/copilot/settings.local.json`, the local file
   * winning, and in Claude Code's `.claude/settings.json` and `.claude/settings.local.json`
   * (SOURCES.copilotCliConfigDir). Which of the two pairs wins, and the order within Claude
   * Code's, are not documented: a value set both ways makes the result unverified.
   */
  #repositoryHooksOff(): Certainty | undefined {
    if (this.#surface !== 'cli') return undefined;
    const values = (docs: readonly ParsedJson[] | readonly SpannedDocument[]): boolean[] =>
      docs.flatMap((doc) => {
        const value = settingAt(doc, ['disableAllHooks']);
        return typeof value === 'boolean' ? [value] : [];
      });
    const copilot = values(this.#cliSettings());
    const claude = values(claudeProjectSettings(this.#view, this.#root));
    const copilotValue = copilot.at(-1);
    const claudeValue = claude.at(-1);
    if (copilotValue !== true && claudeValue !== true) return undefined;
    const conflict = copilotValue === false || claudeValue === false || new Set(claude).size > 1;
    return conflict ? 'unverified' : 'documented';
  }

  /**
   * Why this surface does not run the hooks of a file: the repository's settings turn every hook
   * off (CLI), or `disableAllHooks: true` at the top of a `.github/hooks/*.json` file skips "only
   * the hooks declared in that file", on the CLI and the cloud agent (SOURCES.copilotHooksReference).
   * VS Code's Local harness does not document the key, so its hooks stay listed as unverified.
   */
  #hooksDisabled(doc: SpannedDocument | undefined):
    | {
        readonly certainty: Certainty;
        readonly evidence: Evidence;
      }
    | undefined {
    if (this.#hooksOff !== undefined) return { certainty: this.#hooksOff, evidence: CLI_HOOKS_OFF };
    if (doc === undefined || this.#surface === 'vscode') return undefined;
    return settingAt(doc, ['disableAllHooks']) === true
      ? { certainty: 'documented', evidence: HOOKS[this.#surface] }
      : undefined;
  }

  /** `.github/hooks/*.json`, or the `hooks` of `.github/copilot/settings(.local).json` (CLI). */
  #copilotHookFile(file: Reached, source: 'hooks' | 'settings'): void {
    const { artifact, path } = file;
    const evidence = HOOKS[this.#surface];
    const doc: JsonDocument = this.#view.json(artifact);
    if (!doc.ok) {
      const issue = doc.errors[0];
      // json/invalid-syntax reports `.github/hooks/*.json` files for Copilot, not settings files.
      if (issue === undefined || issueKind(issue) === 'limit' || source === 'settings') {
        this.#incomplete.add(`unparsed:${path}`);
        return;
      }
      // Invalid JSON rejects the whole file. Comments and trailing commas are not documented.
      this.#skip({
        role: 'hook',
        path,
        code: 'invalid-json',
        ruleId: 'json/invalid-syntax',
        certainty: issueKind(issue) === 'other' ? 'documented' : 'unverified',
        evidence,
      });
      return;
    }
    if (rejectedHookFile(doc)) {
      // A bad `version` or an event list that is not an array rejects the whole file.
      this.#skip({ role: 'hook', path, code: 'not-read', certainty: 'documented', evidence });
      return;
    }
    const handlers = hookHandlers(doc, 'copilot', { includeUnknown: true });
    const ids = hookInventoryIds(path, handlers, 'copilot');
    const inventoryIds = hookInventoryIds(artifact.path, handlers, 'copilot');
    const disabled = this.#hooksDisabled(source === 'hooks' ? doc : undefined);
    // In a hook file a malformed item "is dropped and logged" and its siblings load; inline hooks
    // in a settings file "remain strict": one malformed item rejects the whole `hooks` field.
    const strict =
      source === 'settings' &&
      copilotHookItems(doc).some((item) => copilotHookItemIssue(item) !== undefined);
    const offInVscode = this.#surface === 'vscode' && settingAt(doc, ['disableAllHooks']) === true;
    handlers.forEach((handler, index) => {
      const id = ids[index] ?? '';
      if (disabled !== undefined) {
        this.#skip({ id, role: 'hook', path, name: handler.event, code: 'disabled', ...disabled });
        return;
      }
      const issue = strict ? 'rejected' : copilotHookItemIssue(handler.handler);
      if (issue !== undefined) {
        this.#skip({
          id,
          role: 'hook',
          path,
          name: handler.event,
          code: 'not-read',
          certainty: issue === 'unknown-type' ? 'unverified' : 'documented',
          evidence,
        });
        return;
      }
      const fires = this.#fires(handler.event);
      if (fires === undefined) {
        this.#skip({
          id,
          role: 'hook',
          path,
          name: handler.event,
          code: 'not-read',
          certainty: 'unverified',
          evidence,
        });
        return;
      }
      if (fires === 'never') {
        this.#skip({
          id,
          role: 'hook',
          path,
          name: handler.event,
          code: 'not-read',
          // `notification` never fires in the cloud agent; `permissionRequest` may not.
          certainty: handler.event === 'notification' ? 'documented' : 'unverified',
          evidence,
        });
        return;
      }
      this.#add({
        id,
        role: 'hook',
        // The cloud agent runs the hooks of the cloned repository without asking.
        trigger: this.#surface === 'cloud' ? 'startup' : 'on-approval',
        path,
        realPath: artifact.realPath,
        name: handler.event,
        inventoryId: inventoryIds[index] ?? '',
        certainty: offInVscode ? 'unverified' : fires,
        evidence,
      });
    });
  }

  /** Whether this surface fires `event`: with what certainty, `never`, or unknown (undefined). */
  #fires(event: string): Certainty | 'never' | undefined {
    if (!COPILOT_EVENTS.has(event)) return undefined;
    // Copilot's event names are ASCII: camelCase, or PascalCase for VS Code's payload.
    const first = event.charCodeAt(0);
    const pascal = first >= 0x41 && first <= 0x5a;
    switch (this.#surface) {
      case 'cli':
        // A name only another surface documents, such as VS Code's `SubagentStart`, may fire.
        return COPILOT_REFERENCE_EVENTS.has(event) ? 'documented' : 'unverified';
      case 'vscode':
        // The Local harness documents eight events, by PascalCase name or Copilot alias. The
        // others may fire, as they do in VS Code's Copilot harness.
        return VSCODE_LOCAL_EVENTS.has(event) ? 'documented' : 'unverified';
      case 'cloud':
        if (pascal) return 'unverified';
        return CLOUD_EVENTS.has(event) ? 'documented' : 'never';
    }
  }

  /**
   * Claude Code's `.claude/settings.json` and `.claude/settings.local.json`: the CLI runs their
   * hooks for the events it knows; VS Code reads them only with `chat.useClaudeHooks`.
   */
  #claudeHooks(): void {
    const evidence = HOOKS[this.#surface];
    for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
      const path = joinPath(this.#root, name);
      const artifact = this.#configAt(path, 'claude-settings');
      if (artifact === undefined) continue;
      if (this.#surface === 'vscode') {
        this.#skip({ role: 'hook', path, code: 'not-read', certainty: 'documented', evidence });
        continue;
      }
      const doc = this.#view.json(artifact);
      if (!doc.ok) {
        // json/invalid-syntax reports it for Claude Code.
        this.#incomplete.add(`unparsed:${path}`);
        continue;
      }
      const handlers = hookHandlers(doc, 'claude-code', { includeUnknown: true });
      const ids = hookInventoryIds(path, handlers);
      const inventoryIds = hookInventoryIds(artifact.path, handlers);
      const disabled = this.#hooksDisabled(undefined);
      handlers.forEach((handler, index) => {
        const id = ids[index] ?? '';
        if (disabled !== undefined) {
          this.#skip({
            id,
            role: 'hook',
            path,
            name: handler.event,
            code: 'disabled',
            ...disabled,
          });
          return;
        }
        const fires = this.#fires(handler.event);
        if (fires === undefined || fires === 'never') {
          this.#skip({
            id,
            role: 'hook',
            path,
            name: handler.event,
            code: 'not-read',
            certainty: 'unverified',
            evidence,
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
          certainty: fires,
          evidence,
        });
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Files this surface would read that agentcheckup did not
  // -------------------------------------------------------------------------------------------

  #wouldRead(path: string, kind: ArtifactKind): boolean {
    const slot = slotOf(path, kind);
    if (slot !== undefined) {
      const access = this.#instructionAccess(slot);
      return access !== undefined && access !== 'not-read';
    }
    const directory = dirnamePosix(path);
    const cli = this.#surface === 'cli';
    const vscode = this.#surface === 'vscode';
    const cloud = this.#surface === 'cloud';
    if (kind === 'copilot-path-instructions') return this.#readsPathInstructions(path);
    if (kind === 'claude-rule') return !cloud && this.#readsClaudeRule(path);
    if (kind === 'claude-command') {
      const folder = inClaudeFolder(path, 'commands');
      if (!cli || folder === undefined) return false;
      const access = this.#skillAccess(folder.owner);
      return access !== undefined && access !== 'below';
    }
    if (kind === 'skill') {
      const location = skillLocation(path);
      if (location?.platforms.has('copilot') !== true) return false;
      const access = this.#skillAccess(dirnamePosix(dirnamePosix(location.root)));
      return access !== undefined && access !== 'below';
    }
    if (kind === 'mcp-json') {
      return cli ? this.#chain.includes(directory) : vscode && directory === this.#cwd;
    }
    if (kind === 'copilot-mcp') return cli && this.#chain.includes(dirnamePosix(directory));
    if (kind === 'vscode-mcp') return vscode && dirnamePosix(directory) === this.#cwd;
    if (kind === 'copilot-hooks') return directory === this.#hooksFolder();
    // `.github/copilot/settings(.local).json` and `.claude/settings(.local).json` at the root.
    if (kind === 'copilot-settings') {
      return cli && dirnamePosix(dirnamePosix(directory)) === this.#root;
    }
    return kind === 'claude-settings' && cli && dirnamePosix(directory) === this.#root;
  }

  #unread(): void {
    const { snapshot } = this.#view;
    const unread = new Set<string>(snapshot.ignoredFiles);
    for (const path of snapshot.paths) if (!path.endsWith('/')) unread.add(path);
    for (const entry of snapshot.skipped) unread.add(entry.path);
    for (const path of unread) {
      if (this.#view.index.has(path) || !isCandidateBasename(basename(path))) continue;
      if (this.#scope(dirnamePosix(path)) === undefined) continue;
      const classification = classify(path);
      if (classification !== undefined && this.#wouldRead(path, classification.kind)) {
        this.#incomplete.add(`unread:${path}`);
      }
    }
    for (const directory of snapshot.opaqueDirectories) {
      const segments = directory.split('/').filter((segment) => segment !== '');
      const holds = segments.some((segment, i) => {
        if (!CONFIG_DIRECTORIES.has(segment)) return false;
        const next = segments[i + 1];
        return next === undefined || CONFIG_SUBDIRECTORIES.has(next);
      });
      if (holds && this.#scope(segments.join('/')) !== undefined) {
        this.#incomplete.add(`unread:${directory}`);
      }
    }
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
    if (!this.#skipped.has(id)) this.#skipped.set(id, { ...skip, id });
  }

  #out(path: string, because: OutOfScope['because']): void {
    this.#outOfScope.set(`${path}\u0000${because}`, { path, because });
  }

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
    // The CLI resolves references "up to a depth limit"; its value is not documented.
    add(largest(this.#hops), {
      key: 'copilot-cli.import_max_hops',
      unit: 'hops',
      limit: null,
      effect: 'skips',
      evidence: CLI_IMPORTS,
    });
    add(largest(this.#lines), {
      key: 'copilot.code_review_instruction_lines',
      unit: 'lines',
      limit: CODE_REVIEW_ADVISED_LINES,
      effect: 'advice',
      evidence: CODE_REVIEW,
    });
    add(largest(this.#skillNames), {
      key: 'vscode.skill_name_max_chars',
      unit: 'chars',
      limit: VSCODE_SKILL_NAME_MAX,
      effect: 'skips',
      evidence: SKILLS.vscode,
    });
    add(largest(this.#skillDescriptions), {
      key: 'vscode.skill_description_max_chars',
      unit: 'chars',
      limit: VSCODE_SKILL_DESCRIPTION_MAX,
      effect: 'advice',
      evidence: SKILLS.vscode,
    });
    return limits.sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    );
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
    return {
      agent: AGENT_OF[this.#surface],
      cwd: this.#cwd,
      entries,
      skipped: [...this.#skipped.values()].sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id),
      ),
      outOfScope: [...this.#outOfScope.values()].sort(
        (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
      ),
      assumptions: ASSUMPTIONS[this.#surface],
      hidden: HIDDEN[this.#surface],
      limits: this.#limits(),
      totals: {
        startup: sizeOf(startup.bytes, startup.chars),
        onDemand: sizeOf(onDemand.bytes, onDemand.chars),
      },
      incomplete: [...this.#incomplete].sort(compareStrings),
    };
  }
}

/** The load plan of Copilot CLI for a session started in `options.cwd`. Pure. */
export function loadCopilotCli(view: LoadView, options: CopilotLoadOptions): LoadPlan {
  return new CopilotLoader(view, 'cli', options.cwd).build();
}

/** The load plan of Copilot in VS Code (Local harness) for the workspace `options.cwd`. Pure. */
export function loadCopilotVscode(view: LoadView, options: CopilotLoadOptions): LoadPlan {
  return new CopilotLoader(view, 'vscode', options.cwd).build();
}

/** The load plan of Copilot cloud agent working in `options.cwd`. Pure. */
export function loadCopilotCloud(view: LoadView, options: CopilotLoadOptions): LoadPlan {
  return new CopilotLoader(view, 'cloud', options.cwd).build();
}
