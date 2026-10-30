/**
 * Which agent reads which custom agent or subagent file, at which path, and what it does with
 * it: the loading behavior that the agent definitions (src/agents) and the load plans
 * (./load/subagents.ts) share. Pure: it reads only the snapshot and the parses the rules already
 * made. See docs/adr/0013-list-agent-definitions-and-their-models.md.
 *
 * Each agent's reading follows its documentation, cited per file:
 * - Claude Code reads `.claude/agents/**`; whether it loads a file is checkSubagent's answer, the
 *   one the load plan and instr/subagent-invalid give. Of two files in one folder with the same
 *   name it loads one, in an order that is not documented; of nested folders, the one closest to
 *   the working directory.
 * - Codex reads `.codex/agents/**.toml` in a trusted project; a file needs `name`, `description`
 *   and `developer_instructions`, or Codex ignores it with a warning, and a role `config.toml`
 *   declares wins over a file of the same name (source code).
 * - Cursor reads `.cursor/agents`, `.claude/agents` and the Markdown in `.codex/agents`, and on a
 *   name used twice takes `.cursor` over the others.
 * - Gemini CLI reads `.gemini/agents/*.md`, which must start with frontmatter and need a `name` of
 *   lowercase letters, digits, hyphens and underscores, and a `description`.
 * - GitHub Copilot reads `.github/agents`: in VS Code the folder itself, with or without a header,
 *   on the CLI subfolders too, as the cloud agent the root folder's `*.agent.md`. The CLI knows an
 *   agent by its path below `agents` (`team--reviewer`) and loads `.github/agents` before
 *   `.claude/agents`, the first of an id winning. VS Code and the CLI read `.claude/agents` as
 *   well: VS Code in Claude's format, the CLI as its own, `models` included.
 * - Devin Local reads `.devin/agents` and `.agents/agents` (experimental); of the files of one
 *   `agents/<name>/` directory it reads `AGENT.md`, then `AGENTS.md`, `agent.md`, `agents.md`, and
 *   it skips a profile named like a built-in one.
 * A file an agent reaches through a symlink is read at the symlink's path, as what it is there.
 *
 * The switches that turn an agent's custom agents off are read where a session starts
 * ({@link switchesAt}): a definition's own status, in {@link definitionFiles}, is that of a
 * session started in the directory that owns its folder; a load plan applies its own session's.
 */
import { compareStrings } from '../core/compare.js';
import { hash53 } from '../core/fingerprint.js';
import { dirnamePosix, joinRelative, pathStatus } from '../core/paths.js';
import { positionAt } from '../core/text.js';
import type { Artifact, ArtifactKind, SkipReason, Span, SymlinkProblem } from '../core/types.js';
import { issueKind, isTable, own, type SpannedDocument } from '../parse/json-access.js';
import type { FrontmatterData, FrontmatterResult } from '../parse/types.js';
import {
  claudeFrontmatterConfig,
  type FrontmatterReading,
  hasMergeKey,
} from './frontmatter-config.js';
import { codexProjectConfig } from './codex-config.js';
import { chainDirectories } from './load/codex-chain.js';
import type { Certainty, ContextAgent, SkipCode, SourceKey } from './load/types.js';
import type { LoadView } from './load/view.js';
import { classify } from './classify.js';
import { basename, joinPath, nearestGitRoot } from './paths.js';
import { readingsOf } from './readings.js';
import { rootSetting } from './root-settings.js';
import { checkSubagent, type SubagentIssue } from './subagents.js';

/**
 * What the agent does with the file:
 * - `loads`: the agent lists the definition;
 * - `skipped`: the agent drops it, for `reason`;
 * - `shadowed`: another definition with the same name wins;
 * - `unknown`: whether it loads is not documented.
 */
export type DefinitionStatus = 'loads' | 'skipped' | 'shadowed' | 'unknown';

/** The fields of a frontmatter block, with the spans of its keys and values in the file. */
export interface FileFields {
  readonly values: Readonly<Record<string, unknown>>;
  /** Span of the value of `key`, else of the key. */
  span(key: string): Span | undefined;
  keySpan(key: string): Span | undefined;
}

/**
 * Where the agent reads the definition's settings from:
 * - `frontmatter`: the fields of a Markdown file's frontmatter; `claudeFormat` when an agent
 *   other than Claude Code reads a `.claude/agents` file, in Claude's format.
 * - `toml`: a Codex agent file that parses.
 * - `none`: no fields agentcheckup can read: no frontmatter, a block that does not parse, or a
 *   role `config.toml` declares without a file.
 */
export type AgentFileSource =
  | {
      readonly kind: 'frontmatter';
      readonly artifact: Artifact;
      readonly fields: FileFields;
      readonly claudeFormat: boolean;
    }
  | { readonly kind: 'toml'; readonly artifact: Artifact; readonly doc: SpannedDocument }
  | { readonly kind: 'none' };

/** One custom agent or subagent file, or Codex role, as one agent reads it. */
export interface AgentFile {
  /** The path the agent reads it at; for a Codex role without a file, its `config.toml`. */
  readonly file: string;
  /** 1-based line of the name, or 1. */
  readonly line: number;
  readonly agent: ContextAgent;
  /** The name the agent knows it by, such as Copilot CLI's `team--reviewer`. */
  readonly name?: string;
  readonly status: DefinitionStatus;
  /** Why the agent skips it, may not load it, or shadows it. Trusted text without paths. */
  readonly reason?: string;
  /** For `shadowed`: the file of the definition that wins. */
  readonly shadowedBy?: string;
  /**
   * For `skipped`: the load plans' code. `invalid-subagent` for a file that fails the agent's
   * checks, `invalid-toml` for a Codex file that does not parse, `disabled` for a switch.
   */
  readonly skip?: Extract<SkipCode, 'invalid-subagent' | 'invalid-toml' | 'disabled'>;
  /** The description as written, which the agent lists with the name. */
  readonly description?: string;
  readonly certainty: Certainty;
  readonly evidence: readonly SourceKey[];
  /**
   * The directory that owns the agent folder (`a/.claude/agents/x.md` -> `a`): sessions started
   * there or below find it. Definitions of one agent collide when they share `scope` and `key`
   * (the name, or the id or file name the agent goes by); the lowest `rank` wins, then the first
   * in path order.
   */
  readonly scope: string;
  readonly key: string;
  readonly rank: number;
  /** The agent documents that a lower `rank` wins; otherwise which one wins is unverified. */
  readonly ranked: boolean;
  /** Hash of text the agent may read and agentcheckup cannot: any change of it is a change. */
  readonly opaque?: string;
  /**
   * A Gemini CLI remote agent: it runs elsewhere, and its agent card, which the repository does
   * not hold, gives its description and instructions.
   */
  readonly remote?: true;
  readonly source: AgentFileSource;
}

/**
 * One list per artifact list. The engine, the load plans and the rules that read definitions
 * share a scan's list, and its parses, so they share one discovery.
 */
const CACHE = new WeakMap<readonly Artifact[], readonly AgentFile[]>();

/**
 * Every custom agent and subagent file, once for each agent that reads it, after the name
 * collisions, before any switch. In discovery order. A load plan applies its session's switches
 * with {@link switchedOff}.
 */
export function agentFiles(view: LoadView): readonly AgentFile[] {
  const cached = CACHE.get(view.artifacts);
  if (cached !== undefined) return cached;
  const files = discover(view);
  CACHE.set(view.artifacts, files);
  return files;
}

const DEFINITIONS = new WeakMap<readonly Artifact[], readonly AgentFile[]>();

/**
 * {@link agentFiles}, each with the switches of a session started in the directory that owns its
 * folder: what `agentcheckup agents` lists.
 */
export function definitionFiles(view: LoadView): readonly AgentFile[] {
  const cached = DEFINITIONS.get(view.artifacts);
  if (cached !== undefined) return cached;
  const files = agentFiles(view).map((file) =>
    switchedOff(file, switchesAt(view, file.agent, file.scope)),
  );
  DEFINITIONS.set(view.artifacts, files);
  return files;
}

function discover(view: LoadView): AgentFile[] {
  const files: AgentFile[] = [];
  const roles = declaredCodexRoles(view);
  const declaredFiles = new Map(
    roles.flatMap((role) => (role.file === undefined ? [] : [[role.file, role] as const])),
  );
  // A file an agent reaches through a symlink is read at the symlink's path, as what it is there.
  const readings = view.artifacts.flatMap((artifact) =>
    readingsOf(artifact).map((reading) => ({ artifact, ...reading })),
  );
  for (const { artifact, kind, path } of readings) {
    if (kind === 'codex-agent') {
      files.push(...codexAgentFile(view, artifact, path, declaredFiles.get(path)));
    } else {
      files.push(...(READERS_BY_KIND[kind]?.(view, artifact, path) ?? []));
    }
  }
  const agentFilePaths = new Set(
    readings.filter((reading) => reading.kind === 'codex-agent').map((reading) => reading.path),
  );
  for (const role of roles) {
    if (role.file === undefined || !agentFilePaths.has(role.file)) {
      files.push(codexConfigRole(view, role));
    }
  }
  files.push(...unreadFiles(view, new Set(declaredFiles.keys())));
  return shadowRepeats(files);
}

/** Why the scan did not read a file, as trusted text. */
const UNREAD_REASONS: Readonly<Record<Exclude<SkipReason, 'import-limit'>, string>> = {
  'too-large': 'it is larger than the scan reads',
  binary: 'it looks binary',
  'special-file': 'it is not a regular file',
  unreadable: 'it could not be read',
  'file-limit': 'the scan reached its file limit',
  'byte-limit': 'the scan reached its byte limit',
  'depth-limit': 'it is deeper than the scan goes',
};

/** Symlink problems behind which the agent still reads a file the scan does not. */
const UNREAD_LINKS: Readonly<Partial<Record<SymlinkProblem, string>>> = {
  'outside-root': 'it is a symlink to a file outside the repository',
};

/** The agents that read an agent file of each kind, before anything is read of it. */
const UNREAD_READERS: Readonly<Partial<Record<ArtifactKind, readonly ContextAgent[]>>> = {
  'claude-agent': ['claude-code', 'cursor', 'copilot-cli', 'copilot-vscode'],
  'codex-agent': ['codex'],
  'cursor-agent': ['cursor'],
  'gemini-agent': ['gemini'],
  'devin-agent': ['windsurf'],
};

function readersOf(kind: ArtifactKind, path: string): readonly ContextAgent[] {
  return kind === 'copilot-agent' ? copilotReaders(path) : (UNREAD_READERS[kind] ?? []);
}

/**
 * Agent files the walk saw but did not read: past a size or count limit, unreadable, or a symlink
 * to a file outside the repository. The agent may load each of them, and nothing in it can be
 * measured, so each is `unknown` for every agent that reads its folder. Its digest follows its
 * size, so that a change shows.
 */
function unreadFiles(view: LoadView, declared: ReadonlySet<string>): AgentFile[] {
  const candidates = [
    ...view.snapshot.skipped.flatMap((entry) =>
      entry.reason === 'import-limit'
        ? []
        : [{ path: entry.path, why: UNREAD_REASONS[entry.reason], size: entry.size }],
    ),
    ...view.snapshot.unresolvedSymlinks.flatMap((link) => {
      const why = UNREAD_LINKS[link.problem];
      return why === undefined ? [] : [{ path: link.path, why, size: undefined }];
    }),
  ];
  const files: AgentFile[] = [];
  for (const { path, why, size } of candidates) {
    const kind = classify(path)?.kind;
    if (kind === undefined || declared.has(path)) continue;
    const place = folderPlace(path);
    const scope = kind === 'codex-agent' ? codexOwner(path) : (place?.owner ?? '');
    for (const agent of readersOf(kind, path)) {
      const name = copilotId(agent, path) ?? nameFromPath(agent, path, place);
      const { key, rank, ranked } = placeOf(agent, path, name, place?.folder);
      files.push({
        file: path,
        line: 1,
        agent,
        name,
        status: 'unknown',
        reason: `the scan did not read the file: ${why}`,
        certainty: 'unverified',
        evidence: EVIDENCE[agent],
        scope,
        // Only an id the agent takes from the path is known without reading the file.
        key: agent.startsWith('copilot-') ? key : '',
        rank,
        ranked,
        opaque: hash53(`${why}\u0000${String(size ?? '')}`),
        source: { kind: 'none' },
      });
    }
  }
  return files;
}

/** How each kind of agent file is read at `path`, and by which agents. */
const READERS_BY_KIND: Readonly<
  Partial<Record<ArtifactKind, (view: LoadView, artifact: Artifact, path: string) => AgentFile[]>>
> = {
  'claude-agent': claudeAgentFile,
  'cursor-agent': (view, artifact, path) => markdownFile(view, artifact, path, ['cursor'], false),
  'gemini-agent': (view, artifact, path) => markdownFile(view, artifact, path, ['gemini'], false),
  'copilot-agent': (view, artifact, path) =>
    markdownFile(view, artifact, path, copilotReaders(path), false),
  'devin-agent': (view, artifact, path) => markdownFile(view, artifact, path, ['windsurf'], false),
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function lineOf(artifact: Artifact, span: Span | undefined): number {
  return span === undefined ? 1 : positionAt(artifact.decoded, span.offset).line;
}

function fieldsOf(data: FrontmatterData): FileFields {
  return {
    values: data.values,
    span: (key) => data.valueSpan(key) ?? data.keySpan(key),
    keySpan: (key) => data.keySpan(key),
  };
}

/** The fields of a reading: its spans already point into the file. */
function readingFields(reading: FrontmatterReading): FileFields {
  const values = reading.doc.value;
  return {
    values: isTable(values) ? values : {},
    span: (key) => reading.doc.valueSpan([key]) ?? reading.doc.keySpan([key]),
    keySpan: (key) => reading.doc.keySpan([key]),
  };
}

/** The text of a field as one string, or undefined for other types. */
export function stringField(fields: FileFields, key: string): string | undefined {
  const value = own(fields.values, key);
  return typeof value === 'string' ? value : undefined;
}

/** `text` trimmed, or undefined when nothing is left. */
function nonEmpty(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** `name` as written, when it is a non-empty string. */
function nameOf(fields: FileFields): string | undefined {
  return nonEmpty(stringField(fields, 'name'));
}

/** The name a file gives an agent that does not read `name`: the file name without suffixes. */
function fileStem(path: string): string {
  const file = basename(path);
  const lower = file.toLowerCase();
  for (const suffix of ['.agent.md', '.md', '.toml']) {
    if (lower.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  return file;
}

/** The agent folders, spelled as the agents document them. */
const AGENT_FOLDERS: readonly string[] = [
  '.cursor/agents',
  '.claude/agents',
  '.codex/agents',
  '.gemini/agents',
  '.github/agents',
  '.devin/agents',
  '.agents/agents',
];

/**
 * Where a file sits in an agent folder: the folder as documented, the directory that owns it, the
 * path below it, and whether the path spells the folder exactly.
 */
export interface FolderPlace {
  readonly folder: string;
  readonly owner: string;
  readonly relative: string;
  /**
   * False for a folder whose letter case differs, such as `.Claude/agents`: the agent finds it
   * only where the file system ignores case.
   */
  readonly exactCase: boolean;
}

/**
 * The first of `folders` on the path from the root, matched on whole path segments and without
 * case: `x.cursor/agents` is not `.cursor/agents`, and `.Claude/agents` is one only where the file
 * system ignores case. Undefined outside them.
 */
export function folderPlace(
  path: string,
  folders: readonly string[] = AGENT_FOLDERS,
): FolderPlace | undefined {
  const segments = path.split('/');
  for (let i = 0; i + 2 < segments.length; i++) {
    const written = `${segments[i] ?? ''}/${segments[i + 1] ?? ''}`;
    const folder = folders.find((candidate) => candidate === written.toLowerCase());
    if (folder === undefined) continue;
    return {
      folder,
      owner: segments.slice(0, i).join('/'),
      relative: segments.slice(i + 2).join('/'),
      exactCase: written === folder,
    };
  }
  return undefined;
}

/** Devin Local's file names in an `agents/<name>/` directory, the first present winning. */
const DEVIN_DIRECTORY_FILES = ['AGENT.md', 'AGENTS.md', 'agent.md', 'agents.md'];

/** True for Devin Local's documented `agents/<name>/AGENT.md` layout (and its other names). */
function devinLayout(place: FolderPlace): boolean {
  const parts = place.relative.split('/');
  return (
    (place.folder === '.devin/agents' || place.folder === '.agents/agents') &&
    parts.length === 2 &&
    DEVIN_DIRECTORY_FILES.includes(parts[1] ?? '')
  );
}

/**
 * True when a folder sits between the agent folder and the file. Devin Local's
 * `agents/<name>/AGENT.md` is its own documented layout, not a subfolder.
 */
function inSubfolder(place: FolderPlace | undefined): boolean {
  return place !== undefined && place.relative.includes('/') && !devinLayout(place);
}

/**
 * The name a file gives an agent without a `name`: Devin Local names a directory-layout profile
 * after its directory (SOURCES.devinSubagents); the others take the file name.
 */
function nameFromPath(agent: ContextAgent, path: string, place: FolderPlace | undefined): string {
  if (agent === 'windsurf' && place !== undefined && devinLayout(place)) {
    return place.relative.slice(0, place.relative.indexOf('/'));
  }
  return fileStem(path);
}

/** The digest of text agentcheckup cannot read for an agent, so that any change shows. */
function opaqueOf(artifact: Artifact): string {
  return hash53(artifact.decoded.text);
}

// ---------------------------------------------------------------------------------------------
// Claude Code's folder: Claude Code, and Cursor and Copilot reading it
// ---------------------------------------------------------------------------------------------

const SKIP_REASONS: Readonly<Record<SubagentIssue['code'], string>> = {
  'misplaced-frontmatter': 'the frontmatter does not start on line 1',
  'unclosed-frontmatter': 'the frontmatter has no closing line',
  'unsupported-frontmatter': 'the frontmatter is not YAML',
  'invalid-yaml': 'the frontmatter is not valid YAML',
  'name-missing': 'no name',
  'name-empty': 'an empty name',
  'name-leading-dash': 'the name starts with "-"',
  'name-colon': 'the name contains ":"',
  'name-too-long': 'the name is too long',
  'description-missing': 'no description',
  'description-empty': 'an empty description',
};

/**
 * Why Claude Code may not load a file checkSubagent calls `unknown`: its own reader may accept
 * what the documented form rejects (src/platforms/skill-repair.ts).
 */
const UNKNOWN_REASONS: Readonly<Partial<Record<FrontmatterResult['kind'], string>>> = {
  absent: "only Claude Code's own reader finds the frontmatter",
  unclosed: "only Claude Code's own reader finds the frontmatter",
  invalid: "the frontmatter is not valid YAML, which Claude Code's reader may accept",
  valid: 'the frontmatter uses a << merge key',
};

function claudeAgentFile(view: LoadView, artifact: Artifact, path: string): AgentFile[] {
  const frontmatter = view.frontmatter(artifact);
  const check = checkSubagent(artifact.decoded.text, frontmatter);
  // Cursor and the Copilot CLI and VS Code agent read the folder too, in their own way, whether
  // or not Claude Code calls the file documentation.
  const others = markdownFile(
    view,
    artifact,
    path,
    ['cursor', 'copilot-cli', 'copilot-vscode'],
    true,
  );
  if (check.status === 'documentation') return others;
  const place = folderPlace(path, ['.claude/agents']);
  const owner = place?.owner ?? '';
  // The fields Claude Code reads: the documented parse, else the block its reader finds or
  // repairs (src/platforms/frontmatter-config.ts). A block it may read and agentcheckup cannot,
  // such as one with a `<<` merge key or past a parser limit, may set any field.
  const config = claudeFrontmatterConfig(artifact.decoded.text, frontmatter);
  const [reading] = config.readings;
  const fields = reading === undefined ? undefined : readingFields(reading);
  const firstIssue = check.status === 'skipped' ? check.issues[0] : undefined;
  const merged = config.readings.some((item) => hasMergeKey(item.doc.value));
  const unreadable = config.unreadable && check.status !== 'skipped';
  const reason =
    firstIssue !== undefined
      ? SKIP_REASONS[firstIssue.code]
      : unreadable
        ? merged
          ? 'the frontmatter uses a << merge key'
          : "the frontmatter is past agentcheckup's parser limits"
        : check.status === 'unknown'
          ? UNKNOWN_REASONS[frontmatter.kind]
          : undefined;
  const status =
    check.status === 'skipped'
      ? 'skipped'
      : check.status === 'loads' && !unreadable
        ? 'loads'
        : 'unknown';
  // Claude Code reads a name or description of another type as text, as checkSubagent does.
  const name =
    check.status === 'loads'
      ? nonEmpty(check.name)
      : fields === undefined
        ? undefined
        : nameOf(fields);
  const description =
    check.status === 'loads'
      ? check.description
      : fields === undefined
        ? undefined
        : stringField(fields, 'description');
  const claude: AgentFile = {
    file: path,
    line: fields === undefined ? 1 : lineOf(artifact, fields.keySpan('name')),
    agent: 'claude-code',
    ...(name === undefined ? {} : { name }),
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(status === 'skipped' ? { skip: 'invalid-subagent' as const } : {}),
    ...(description === undefined ? {} : { description }),
    certainty: owner === '' && place?.exactCase === true ? 'documented' : 'unverified',
    evidence: ['claudeSubagents'],
    scope: owner,
    key: name ?? '',
    rank: 0,
    ranked: false,
    ...(unreadable ? { opaque: opaqueOf(artifact) } : {}),
    source:
      fields === undefined
        ? { kind: 'none' }
        : { kind: 'frontmatter', artifact, fields, claudeFormat: false },
  };
  return [claude, ...others];
}

// ---------------------------------------------------------------------------------------------
// Markdown agent files: Cursor, Gemini CLI, GitHub Copilot, Devin Local
// ---------------------------------------------------------------------------------------------

/**
 * The Copilot surfaces that read a `.github/agents` file (SOURCES.vscodeCustomAgents etc.). The
 * cloud agent reads the repository's own folder, at the root (SOURCES.copilotCustomAgents).
 */
function copilotReaders(path: string): ContextAgent[] {
  const place = folderPlace(path, ['.github/agents']);
  const readers: ContextAgent[] = ['copilot-cli'];
  if (!inSubfolder(place)) readers.push('copilot-vscode');
  if (place?.owner === '' && place.exactCase && path.toLowerCase().endsWith('.agent.md')) {
    readers.push('copilot-cloud');
  }
  return readers;
}

/** Why Devin Local skips a profile named like one of its own. */
const BUILT_IN_REASON = 'the name is a built-in profile';

/** Why Gemini CLI skips a name that is not a slug (SOURCES.geminiSubagents). */
const NAME_PATTERN_REASON = 'the name is not lowercase letters, digits, hyphens and underscores';

/** Fields each agent requires; a file without one is skipped. */
const REQUIRED: Readonly<Partial<Record<ContextAgent, readonly string[]>>> = {
  gemini: ['name', 'description'],
  'copilot-cli': ['description'],
  'copilot-cloud': ['description'],
};

/** Gemini CLI's names: lowercase letters, digits, hyphens and underscores (SOURCES.geminiSubagents). */
const GEMINI_NAME = /^[\d_a-z-]+$/;

/**
 * The `target` that keeps a Copilot surface from reading a file: the CLI reads both
 * (SOURCES.copilotCustomAgents: unset means both environments).
 */
const OTHER_TARGET: Readonly<Partial<Record<ContextAgent, string>>> = {
  'copilot-vscode': 'github-copilot',
  'copilot-cloud': 'vscode',
};

const EVIDENCE: Readonly<Record<ContextAgent, readonly SourceKey[]>> = {
  'claude-code': ['claudeSubagents'],
  codex: ['codexSubagents'],
  cursor: ['cursorSubagents'],
  gemini: ['geminiSubagents'],
  'copilot-cli': ['copilotCliAgents'],
  'copilot-vscode': ['vscodeCustomAgents'],
  'copilot-cloud': ['copilotCustomAgents'],
  windsurf: ['devinSubagents'],
  cline: [],
};

/**
 * Where a definition stands among the agent's folders and what it is known by:
 * - Cursor takes `.cursor/agents` over `.claude/agents` and `.codex/agents`, by name
 *   (SOURCES.cursorSubagents); which of the last two wins is not documented.
 * - The Copilot CLI goes by the path below `agents`, loading `.github/agents` before
 *   `.claude/agents`, the first of an id winning; the same name under two ids loads twice
 *   (SOURCES.copilotCliAgents).
 * - The Copilot cloud agent deduplicates by file name (SOURCES.copilotCustomAgents).
 * - The others go by name, in an order that is not documented.
 */
function placeOf(
  agent: ContextAgent,
  path: string,
  name: string,
  folder: string | undefined,
): Pick<AgentFile, 'key' | 'rank' | 'ranked'> {
  if (agent === 'cursor') {
    return { key: name, rank: folder === '.cursor/agents' ? 0 : 1, ranked: true };
  }
  if (agent === 'copilot-cli') {
    return { key: name, rank: folder === '.github/agents' ? 0 : 1, ranked: true };
  }
  if (agent === 'copilot-cloud') return { key: fileStem(path), rank: 0, ranked: false };
  return { key: name, rank: 0, ranked: false };
}

/**
 * What an agent does with a file that has no frontmatter, in its own folder:
 * - `loads`: Copilot in VS Code, whose header is optional (SOURCES.vscodeCustomAgents); Cursor and
 *   Devin Local, whose fields are all optional, the name taken from the file or its directory
 *   (SOURCES.cursorSubagents, SOURCES.devinSubagents), though neither shows a file without a
 *   header, so unverified.
 * - `skipped`: Gemini CLI, whose files "MUST start with YAML frontmatter"
 *   (SOURCES.geminiSubagents); the Copilot CLI and cloud agent, which need a description.
 */
const WITHOUT_FRONTMATTER: Readonly<
  Partial<Record<ContextAgent, { readonly loads: boolean; readonly reason?: string }>>
> = {
  'copilot-vscode': { loads: true },
  cursor: { loads: true },
  windsurf: { loads: true },
  gemini: { loads: false, reason: 'no frontmatter' },
  'copilot-cli': { loads: false, reason: 'no description' },
  'copilot-cloud': { loads: false, reason: 'no description' },
};

/** Devin Local's built-in profiles: a custom profile of one of these names is skipped. */
const DEVIN_BUILT_INS: ReadonlySet<string> = new Set(['subagent_explore', 'subagent_general']);

/**
 * For a Devin Local file in an `agents/<name>/` directory, the file of that directory it reads
 * instead, if one comes before it (SOURCES.devinSubagents).
 */
function devinPreferred(
  view: LoadView,
  path: string,
  place: FolderPlace | undefined,
): string | undefined {
  if (place === undefined || !devinLayout(place)) return undefined;
  const index = DEVIN_DIRECTORY_FILES.indexOf(basename(path));
  if (index <= 0) return undefined;
  const directory = dirnamePosix(path);
  return DEVIN_DIRECTORY_FILES.slice(0, index)
    .map((name) => `${directory}/${name}`)
    .find((sibling) => pathStatus(view.snapshot, sibling) === 'exists');
}

function markdownFile(
  view: LoadView,
  artifact: Artifact,
  path: string,
  agents: readonly ContextAgent[],
  claudeFormat: boolean,
): AgentFile[] {
  const frontmatter = view.frontmatter(artifact);
  if (frontmatter.kind === 'unsupported') return [];
  const place = folderPlace(path);
  const owner = place?.owner ?? '';
  const nested = inSubfolder(place);
  const exactCase = place?.exactCase === true;
  const files: AgentFile[] = [];
  for (const agent of agents) {
    // In Claude's folder a file without frontmatter is not an agent: Claude Code calls it
    // documentation, and no other agent says it reads one.
    const absent = frontmatter.kind === 'absent' ? WITHOUT_FRONTMATTER[agent] : undefined;
    if (frontmatter.kind === 'absent' && (claudeFormat || absent === undefined)) continue;
    const certainty: Certainty =
      owner === '' && exactCase && !(nested && agent !== 'copilot-cli')
        ? 'documented'
        : 'unverified';
    const name = copilotId(agent, path) ?? nameFromPath(agent, path, place);
    const base = {
      file: path,
      agent,
      certainty,
      evidence: EVIDENCE[agent],
      scope: owner,
    };
    const preferred = agent === 'windsurf' ? devinPreferred(view, path, place) : undefined;
    if (preferred !== undefined) {
      files.push({
        ...base,
        line: 1,
        name,
        status: 'shadowed',
        reason: 'another file of its directory comes first',
        shadowedBy: preferred,
        ...placeOf(agent, path, name, place?.folder),
        source: { kind: 'none' },
      });
      continue;
    }
    if (absent !== undefined) {
      const builtIn = agent === 'windsurf' && DEVIN_BUILT_INS.has(name);
      const loads = absent.loads && !builtIn;
      const reason = builtIn ? BUILT_IN_REASON : absent.reason;
      files.push({
        ...base,
        line: 1,
        name,
        status: loads ? 'loads' : 'skipped',
        ...(loads ? {} : { reason, skip: 'invalid-subagent' as const }),
        // Copilot in VS Code documents a file without a header; the others do not show one.
        ...(loads && agent !== 'copilot-vscode' ? { certainty: 'unverified' as const } : {}),
        ...placeOf(agent, path, name, place?.folder),
        source: { kind: 'none' },
      });
      continue;
    }
    if (frontmatter.kind !== 'valid') {
      // How these agents read a block that does not parse is not documented. Gemini CLI reads a
      // list of remote agents from one file (SOURCES.geminiRemoteAgents), one by one.
      const list =
        agent === 'gemini' &&
        frontmatter.kind === 'invalid' &&
        frontmatter.errors.some((issue) => issue.code === 'not-a-mapping');
      files.push({
        ...base,
        line: 1,
        name,
        status: 'unknown',
        reason: list
          ? 'the frontmatter is a list, as of remote agents, which agentcheckup does not read one by one'
          : 'the frontmatter is not valid YAML',
        certainty: 'unverified',
        ...placeOf(agent, path, name, place?.folder),
        opaque: opaqueOf(artifact),
        source: { kind: 'none' },
      });
      continue;
    }
    const fields = fieldsOf(frontmatter.data);
    const named = copilotId(agent, path) ?? nameOf(fields) ?? nameFromPath(agent, path, place);
    const description = stringField(fields, 'description');
    const reason = skipReason(agent, fields, named);
    // A Gemini CLI remote agent runs elsewhere: its card, not the file, describes it, so what the
    // model sees of it is not known.
    const remote = agent === 'gemini' && stringField(fields, 'kind') === 'remote';
    const remoteFields = remote
      ? { remote: true as const, evidence: ['geminiSubagents', 'geminiRemoteAgents'] }
      : {};
    // agentcheckup reads YAML without merge keys (ADR 0003), and none of these agents documents
    // whether its reader merges them: a `<<` may set any field the file leaves out, the model or a
    // required one included. A key the file sets beside it wins either way, so a skip that key
    // decides holds. The file's text goes into its digest, so a change still shows.
    if (hasMergeKey(frontmatter.data) && (reason === undefined || mayFill(reason, fields))) {
      files.push({
        ...base,
        ...remoteFields,
        line: lineOf(artifact, fields.keySpan('name')),
        name: named,
        status: 'unknown',
        reason: 'the frontmatter uses a << merge key',
        certainty: 'unverified',
        ...(description === undefined ? {} : { description }),
        ...placeOf(agent, path, named, place?.folder),
        opaque: opaqueOf(artifact),
        source: { kind: 'frontmatter', artifact, fields, claudeFormat },
      });
      continue;
    }
    files.push({
      ...base,
      ...(remote
        ? {
            ...remoteFields,
            ...(reason === undefined ? { certainty: 'unverified' as const } : {}),
          }
        : {}),
      line: lineOf(artifact, fields.keySpan('name')),
      name: named,
      status: reason === undefined ? 'loads' : 'skipped',
      ...(reason === undefined ? {} : { reason, skip: 'invalid-subagent' as const }),
      ...(description === undefined ? {} : { description }),
      ...placeOf(agent, path, named, place?.folder),
      source: { kind: 'frontmatter', artifact, fields, claudeFormat },
    });
  }
  return files;
}

/** Skip reasons that judge a definition's name. */
const NAME_REASONS: ReadonlySet<string> = new Set([BUILT_IN_REASON, NAME_PATTERN_REASON]);

/**
 * True when a merge key may supply what `reason` says is missing: a field the file leaves out, or
 * the name a name rule judged, when the file gives none of its own.
 */
function mayFill(reason: string, fields: FileFields): boolean {
  return reason.startsWith('no ') || (NAME_REASONS.has(reason) && nameOf(fields) === undefined);
}

/**
 * Why Gemini CLI skips a remote agent: it needs a `name` slug, and `agent_card_url` or
 * `agent_card_json`, but no description (SOURCES.geminiRemoteAgents).
 */
function remoteSkipReason(fields: FileFields): string | undefined {
  if (!GEMINI_NAME.test(nameOf(fields) ?? '')) {
    return NAME_PATTERN_REASON;
  }
  const card = ['agent_card_url', 'agent_card_json'].some(
    (key) => (stringField(fields, key)?.trim() ?? '') !== '',
  );
  return card ? undefined : 'no agent_card_url or agent_card_json';
}

/** Why `agent` skips a file with these fields and name, or undefined when it loads it. */
function skipReason(agent: ContextAgent, fields: FileFields, name: string): string | undefined {
  if (agent === 'gemini' && stringField(fields, 'kind') === 'remote') {
    return remoteSkipReason(fields);
  }
  const missing = (REQUIRED[agent] ?? []).find(
    (key) => (stringField(fields, key)?.trim() ?? '') === '',
  );
  if (missing !== undefined) return `no ${missing}`;
  if (agent === 'windsurf' && DEVIN_BUILT_INS.has(name)) return BUILT_IN_REASON;
  const target = stringField(fields, 'target')?.trim();
  if (target !== undefined && target === OTHER_TARGET[agent]) return `its target is ${target}`;
  if (agent === 'gemini' && !GEMINI_NAME.test(nameOf(fields) ?? '')) {
    return NAME_PATTERN_REASON;
  }
  return undefined;
}

/**
 * The id the Copilot CLI gives a file in `.github/agents` or `.claude/agents`: its path below the
 * folder without `.agent.md` or `.md`, with `--` for each `/` (SOURCES.copilotCliAgents).
 * Undefined for other agents, which name an agent by its `name`.
 */
function copilotId(agent: ContextAgent, path: string): string | undefined {
  if (agent !== 'copilot-cli') return undefined;
  const place = folderPlace(path, ['.github/agents', '.claude/agents']);
  if (place === undefined) return undefined;
  const stem = fileStem(place.relative);
  const folder = dirnamePosix(place.relative);
  return (folder === '' ? stem : `${folder}/${stem}`).replaceAll('/', '--');
}

// ---------------------------------------------------------------------------------------------
// Codex agent files
// ---------------------------------------------------------------------------------------------

/**
 * A role a `.codex/config.toml` declares in `[agents.<name>]` (SOURCES.codexConfigReference):
 * its own description, and the agent file `config_file` names, relative to the `.codex` folder.
 */
interface DeclaredRole {
  readonly name: string;
  readonly config: Artifact;
  readonly line: number;
  readonly description?: string;
  /** True when the role names a `config_file`, wherever it points. */
  readonly configFile: boolean;
  /** The agent file, root-relative; undefined without `config_file` or outside the scan. */
  readonly file?: string;
}

/**
 * The roles each `.codex/config.toml` declares: the tables under `[agents]`; its other keys are
 * settings (codex-rs/agent-roles/src/loader.rs).
 */
function declaredCodexRoles(view: LoadView): DeclaredRole[] {
  const roles: DeclaredRole[] = [];
  for (const config of view.artifacts) {
    if (config.kind !== 'codex-config') continue;
    const doc = view.toml(config);
    const agents = doc.ok && isTable(doc.value) ? own(doc.value, 'agents') : undefined;
    if (!doc.ok || !isTable(agents)) continue;
    for (const name of Object.keys(agents)) {
      const role = agents[name];
      if (!isTable(role)) continue;
      const description = own(role, 'description');
      const configFile = own(role, 'config_file');
      // An absolute path or one that leaves the repository is a file agentcheckup cannot read.
      const file =
        typeof configFile === 'string' && !configFile.startsWith('/')
          ? joinRelative(dirnamePosix(config.path), configFile)
          : undefined;
      roles.push({
        name,
        config,
        line: lineOf(config, doc.keySpan(['agents', name])),
        ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}),
        configFile: configFile !== undefined,
        ...(file === undefined || file.startsWith('..') ? {} : { file }),
      });
    }
  }
  return roles;
}

/**
 * The directory that owns a `.codex` folder, the first on the path, matched on a whole segment:
 * `a/.codex/agents/x.toml` -> `a`.
 */
function codexOwner(path: string): string {
  const segments = path.split('/');
  const index = segments.findIndex(
    (segment, i) => i < segments.length - 1 && segment.toLowerCase() === '.codex',
  );
  return index <= 0 ? '' : segments.slice(0, index).join('/');
}

/**
 * A Codex agent file (codex-rs/agent-roles/src/agent_role_config.rs, loader.rs). A file Codex
 * finds in `.codex/agents` needs a `name`, a `description` and `developer_instructions`; a file a
 * role in `config.toml` names takes the role's name and description when it has none, and needs
 * no `developer_instructions`, though one it has may not be blank. Codex ignores a file that does
 * not meet them, or whose fields do not have their types, with a warning.
 */
function codexAgentFile(
  view: LoadView,
  artifact: Artifact,
  path: string,
  declared: DeclaredRole | undefined,
): AgentFile[] {
  const place = folderPlace(path, ['.codex/agents']);
  const base = {
    file: path,
    agent: 'codex' as const,
    evidence: ['codexSubagents'],
    scope: codexOwner(path),
    // A role config.toml declares wins over a file of the same name Codex finds (loader.rs).
    rank: declared === undefined ? 1 : 0,
    ranked: true,
  };
  const doc = view.toml(artifact);
  if (!doc.ok) {
    const name = declared?.name ?? fileStem(path);
    const [issue] = doc.errors;
    // Past agentcheckup's own limits, or UTF-16: Codex may still read it.
    const unread = issue !== undefined && issueKind(issue) !== 'other';
    return [
      {
        ...base,
        line: 1,
        name,
        key: name,
        status: unread ? 'unknown' : 'skipped',
        reason: unread
          ? "the file is past agentcheckup's parser limits"
          : 'the file is not valid TOML',
        ...(unread ? {} : { skip: 'invalid-toml' as const }),
        certainty: unread ? 'unverified' : 'source-code',
        ...(unread ? { opaque: opaqueOf(artifact) } : {}),
        source: { kind: 'none' },
      },
    ];
  }
  const root = doc.value;
  const raw = (key: string): unknown => (isTable(root) ? own(root, key) : undefined);
  const text = (key: string): string | undefined => {
    const value = raw(key);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const name = text('name') ?? declared?.name;
  const description = text('description') ?? declared?.description;
  const instructions = raw('developer_instructions');
  const blankInstructions = typeof instructions === 'string' && instructions.trim() === '';
  const modelRaw = raw('model');
  const reason =
    name === undefined
      ? 'no name'
      : description === undefined
        ? 'no description'
        : blankInstructions || (declared === undefined && instructions === undefined)
          ? 'no developer_instructions'
          : modelRaw !== undefined && typeof modelRaw !== 'string'
            ? 'model is not a string'
            : undefined;
  return [
    {
      ...base,
      line: lineOf(artifact, doc.keySpan(['name'])),
      name: name ?? fileStem(path),
      key: name ?? '',
      status: reason === undefined ? 'loads' : 'skipped',
      ...(reason === undefined ? {} : { reason, skip: 'invalid-subagent' as const }),
      ...(description === undefined ? {} : { description }),
      // Codex reads project agent files only in a trusted project, from the root down to the
      // working directory.
      certainty:
        reason === undefined
          ? place?.owner === '' && place.exactCase
            ? 'documented'
            : 'unverified'
          : 'source-code',
      source: { kind: 'toml', artifact, doc },
    },
  ];
}

/**
 * A role `config.toml` declares without an agent file agentcheckup reads. Without `config_file`
 * it is the role itself; with one that does not exist, Codex drops the role (loader.rs); with one
 * agentcheckup does not read, such as an absolute path, its model is not known.
 */
function codexConfigRole(view: LoadView, role: DeclaredRole): AgentFile {
  const base = {
    file: role.config.path,
    line: role.line,
    agent: 'codex' as const,
    name: role.name,
    evidence: ['codexConfigReference'],
    scope: codexOwner(role.config.path),
    key: role.name,
    rank: 0,
    ranked: true,
    ...(role.description === undefined ? {} : { description: role.description }),
    source: { kind: 'none' } as const,
  };
  if (!role.configFile) {
    return role.description === undefined
      ? { ...base, status: 'unknown', reason: 'no description', certainty: 'unverified' }
      : { ...base, status: 'loads', certainty: 'unverified' };
  }
  if (role.file !== undefined && pathStatus(view.snapshot, role.file) === 'missing') {
    return {
      ...base,
      status: 'skipped',
      reason: 'its config_file does not exist',
      skip: 'invalid-subagent',
      certainty: 'source-code',
    };
  }
  return {
    ...base,
    status: 'unknown',
    reason: 'its config_file is not a file agentcheckup reads',
    certainty: 'unverified',
  };
}

// ---------------------------------------------------------------------------------------------
// Switches that turn custom agents off
// ---------------------------------------------------------------------------------------------

/** What turns an agent's custom agents off for a session, if anything does. */
export interface Switches {
  /** Why every custom agent of the agent is off, as trusted text without paths. */
  readonly off?: string;
  /** Agents turned off one by one, by name, and why. */
  readonly agentsOff?: ReadonlyMap<string, string>;
}

const NO_SWITCHES: Switches = {};

const SWITCHES = new WeakMap<readonly Artifact[], Map<string, Switches>>();

/**
 * The switches of `agent` for a session started in `directory`, which both default to on:
 * - Codex: `agents.enabled` or `features.multi_agent` set to false in the `.codex/config.toml`
 *   layers from the repository root down to the directory, the closest winning
 *   (SOURCES.codexConfigReference, ../codex-config.ts).
 * - Gemini CLI: `experimental.enableAgents` set to false, or `agents.overrides.<name>.enabled`
 *   for one agent, in the directory's `.gemini/settings.json` (SOURCES.geminiSubagents).
 */
export function switchesAt(view: LoadView, agent: ContextAgent, directory: string): Switches {
  if (agent !== 'codex' && agent !== 'gemini') return NO_SWITCHES;
  let cache = SWITCHES.get(view.artifacts);
  if (cache === undefined) {
    cache = new Map();
    SWITCHES.set(view.artifacts, cache);
  }
  const key = `${agent}\u0000${directory}`;
  let switches = cache.get(key);
  if (switches === undefined) {
    switches = agent === 'codex' ? codexSwitches(view, directory) : geminiSwitches(view, directory);
    cache.set(key, switches);
  }
  return switches;
}

function codexSwitches(view: LoadView, directory: string): Switches {
  const root = nearestGitRoot(view.snapshot, directory) ?? directory;
  const config = codexProjectConfig(view, chainDirectories(root, directory));
  for (const path of [
    ['agents', 'enabled'],
    ['features', 'multi_agent'],
  ]) {
    const setting = config.setting(path);
    if (setting?.value === false) {
      const where = setting.layer.directory === '' ? "the root's" : 'a nested';
      return { off: `multi-agent tools are off in ${where} .codex/config.toml` };
    }
  }
  return NO_SWITCHES;
}

function geminiSwitches(view: LoadView, directory: string): Switches {
  const file = joinPath(directory, '.gemini/settings.json');
  const where = directory === '' ? "the root's" : 'a nested';
  if (rootSetting(view, file, ['experimental', 'enableAgents'])?.value === false) {
    return { off: `subagents are off in ${where} .gemini/settings.json` };
  }
  const overrides = rootSetting(view, file, ['agents', 'overrides'])?.value;
  const agentsOff = new Map<string, string>();
  if (isTable(overrides)) {
    for (const name of Object.keys(overrides)) {
      const entry = overrides[name];
      if (isTable(entry) && own(entry, 'enabled') === false) {
        agentsOff.set(name, `the agent is turned off in ${where} .gemini/settings.json`);
      }
    }
  }
  return agentsOff.size === 0 ? NO_SWITCHES : { agentsOff };
}

/** The file, skipped when a switch of the session turns it off. */
export function switchedOff(file: AgentFile, switches: Switches): AgentFile {
  if (file.status === 'skipped') return file;
  const reason =
    switches.off ?? (file.name === undefined ? undefined : switches.agentsOff?.get(file.name));
  if (reason === undefined) return file;
  const { shadowedBy: _shadowedBy, ...rest } = file;
  return { ...rest, status: 'skipped', reason, skip: 'disabled', certainty: 'documented' };
}

// ---------------------------------------------------------------------------------------------
// Name collisions
// ---------------------------------------------------------------------------------------------

const SHADOW_REASONS: Readonly<Partial<Record<ContextAgent, string>>> = {
  'copilot-cli': 'another agent file has the same id',
  'copilot-cloud': 'another agent file has the same file name',
};

/**
 * Marks the files another of the same agent, scope and key wins over: the lowest rank, then the
 * first in path order. Where the agent does not document that order, the loser's status is
 * unverified. Files in different scopes never collide here: a nested agent folder serves sessions
 * started there, where it wins over the root's.
 */
function shadowRepeats(files: readonly AgentFile[]): AgentFile[] {
  const winners = new Map<string, AgentFile>();
  const keyOf = (file: AgentFile): string => `${file.agent}\u0000${file.scope}\u0000${file.key}`;
  const ordered = [...files].sort((a, b) => a.rank - b.rank || compareStrings(a.file, b.file));
  for (const file of ordered) {
    if (file.status !== 'loads' || file.key === '') continue;
    if (!winners.has(keyOf(file))) winners.set(keyOf(file), file);
  }
  // A definition that may load keeps a documented precedence over a later rank: Codex takes a role
  // a config.toml declares over a file of the same name it finds, whether or not agentcheckup can
  // read the role (loader.rs).
  for (const file of ordered) {
    if (file.status !== 'unknown' || !file.ranked || file.key === '') continue;
    const winner = winners.get(keyOf(file));
    if (winner !== undefined && file.rank < winner.rank) winners.set(keyOf(file), file);
  }
  return files.map((file) => {
    if (file.status !== 'loads' || file.key === '') return file;
    const winner = winners.get(keyOf(file));
    if (winner === undefined || winner === file) return file;
    // The order is documented, and the winner surely loads: the loser surely does not.
    const certain = file.ranked && winner.rank < file.rank && winner.status === 'loads';
    return {
      ...file,
      status: 'shadowed',
      reason: SHADOW_REASONS[file.agent] ?? 'another definition has the same name',
      shadowedBy: winner.file,
      certainty: certain ? file.certainty : 'unverified',
    };
  });
}
