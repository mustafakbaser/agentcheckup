/**
 * What Devin Local loads for a workspace. Devin Local is the default agent of Devin Desktop
 * (formerly Windsurf; agent id `windsurf`) and shares its harness and configuration with Devin
 * CLI, so the Devin CLI pages are the sources (docs/platforms.md, "Devin Desktop"): "every
 * customization uses the Devin CLI format and discovery" (SOURCES.devinLocalCustomizations).
 * Cascade, the older agent, is not modeled. The plan treats `cwd` as the folder opened in Devin
 * Desktop: the workspace root. Files outside it are not part of the workspace, except hook files,
 * which Devin also finds in the directories above it up to the repository root.
 *
 * - Instructions: `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules` and `CLAUDE.md` at
 *   the workspace root load at session start; the same files in subdirectories load when the agent
 *   accesses files there (SOURCES.devinCliRules). Devin documents subdirectories for the AGENTS
 *   files only, so a nested `CLAUDE.md` or `.windsurfrules` is unverified.
 * - Global rules: `.devin/global_rules.md`, or `.windsurf/global_rules.md` when there is no
 *   `.devin` one; the `.windsurf` file is then `shadowed-by-preferred`.
 * - Workspace rules in `.devin/rules` and `.windsurf/rules`: the trigger comes from
 *   `windsurfActivation`, shared with the instr/windsurf-* rules. A missing or unknown `trigger`
 *   is the `unknown` trigger, unverified: Devin does not document it.
 * - `.cursor/rules/*.md` and `*.mdc`: the mode comes from `cursorActivation`, shared with Cursor's
 *   plan and the cursor/* rules. Devin reads the `.md` files Cursor ignores.
 * - Skills: `<name>/SKILL.md` in `.devin/skills`, `.windsurf/skills` and `.agents/skills`, and any
 *   SKILL.md below the imported `.claude/skills` and `.github/skills` (SKILL_ROOTS in
 *   src/platforms/skills.ts), listed by name and description. `triggers` without `model` keeps a
 *   skill out of the model's reach. Commands in `.claude/commands` are imported as skills.
 * - Hooks: `.devin/hooks.v1.json`, `hooks` in `.devin/config.json` and `.devin/config.local.json`,
 *   and Claude Code hooks in `.claude/settings.json` and `.claude/settings.local.json`, found in
 *   the working directory and the directories above it up to the repository root. They load with
 *   the session unless the workspace is in Restricted Mode, an assumption.
 * - MCP servers: `.devin/mcp_config.json` and `.devin/mcp_config.local.json`, the legacy
 *   `mcpServers` of `.devin/config.json`, and the imported `.mcp.json`, `.cursor/mcp.json`,
 *   `.claude/settings.json` and `.claude/settings.local.json`. `"disabled": true` turns a server
 *   off. Devin also imports the servers of `opencode.json` and `.zed/settings.json`, whose formats
 *   agentcheckup does not read: they are listed as unread, and the plan is incomplete.
 * - `read_config_from` in `.devin/config.json` turns imported sources off (`devinReadConfigFor`,
 *   shared with the rules through src/platforms/readers.ts): their files are `disabled`.
 *
 * Devin documents no order for the startup context and no size limit, so startup entries have no
 * position and the plan lists no limits. Files the classifier does not know (`AGENTS.local.md`,
 * `AGENT.md`, the global rules files) are not read: they are listed without a size, and the plan
 * is incomplete.
 *
 * Pure and deterministic: reads only the view, never the file system.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { codePointLength, tokensOf, utf8ByteLength } from '../../core/measure.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, ArtifactKind } from '../../core/types.js';
import { isObject, own } from '../../parse/json-access.js';
import { classify, isCandidateBasename } from '../classify.js';
import { cursorActivation, type CursorRuleMode } from '../cursor-rules.js';
import {
  DEVIN_EVENTS,
  devinEventInOtherCase,
  hookEvents,
  hookHandlers,
  hookSourceOf,
} from '../hooks.js';
import { hookInventoryIds, mcpInventoryIds } from '../inventory-ids.js';
import { isBundledSkill } from '../location.js';
import { mcpServers } from '../mcp.js';
import { basename, fileExists, joinPath, nearestGitRoot, selfAndAncestors } from '../paths.js';
import { bodyOffset, pluginReaders, skillLocation } from '../skills.js';
import {
  type DevinConfigSource,
  type DevinReadConfigFrom,
  devinReadConfigFor,
  devinReadConfigFrom,
  devinSourceOf,
  WINDSURF_MODE_TRIGGER,
  windsurfActivation,
} from '../windsurf-rules.js';
import { isBlank } from './codex-text.js';
import type {
  Assumption,
  Certainty,
  HiddenScope,
  LoadEntry,
  LoadPlan,
  LoadRole,
  LoadTrigger,
  OutOfScope,
  Size,
  SkippedLoad,
  SourceKey,
} from './types.js';
import { TRIGGER_RANK } from './types.js';
import type { LoadView } from './view.js';

export interface WindsurfLoadOptions {
  /** The folder opened in Devin Desktop, relative to the scan root. `''` is the root. */
  readonly cwd: string;
  readonly config: ResolvedConfig;
  /** Not used: Devin documents no limit that depends on the context window. */
  readonly contextWindow?: number;
}

/** The `read_config_from` sources whose files a workspace can hold, stated as assumptions. */
const PLANNED_SOURCES: readonly DevinConfigSource[] = [
  'agents_standard',
  'claude',
  'copilot',
  'cursor',
  'opencode',
  'windsurf',
  'zed',
];

const BASE_ASSUMPTIONS: readonly Assumption[] = [
  // New tabs in Devin Desktop start with Devin Local; Cascade is not modeled.
  { key: 'devin.agent', value: 'devin-local', origin: 'default', evidence: ['devinLocal'] },
  // In Restricted Mode agents are unavailable and hooks neither load nor run.
  { key: 'devin.restrictedMode', value: false, origin: 'default', evidence: ['devinLocal'] },
];

const HIDDEN: readonly HiddenScope[] = [
  {
    scope: 'managed',
    locations: ['/etc/devin/rules', 'organization permissions and MCP allowlists'],
    roles: ['mcp-server', 'rule'],
  },
  {
    scope: 'user',
    locations: [
      '~/.agents/skills',
      '~/.claude.json',
      '~/.claude/CLAUDE.md',
      '~/.claude/mcp_servers.json',
      '~/.claude/settings.json',
      '~/.claude/settings.local.json',
      '~/.codeium/<channel>/mcp_config.json',
      '~/.codeium/<channel>/skills',
      '~/.config/devin/AGENTS.md',
      '~/.config/devin/config.json',
      '~/.config/devin/mcp_config.json',
      '~/.config/devin/skills',
      '~/.config/opencode/opencode.json',
      '~/.config/zed/settings.json',
      '~/.copilot/skills',
      '~/.devin/global_rules.md',
      '~/.devin/rules',
    ],
    roles: ['hook', 'instructions', 'mcp-server', 'rule', 'skill'],
  },
  {
    // `read_config_from.cloud`, read from the user configuration only (SOURCES.devinReadConfigFrom).
    scope: 'account',
    locations: ['Devin Cloud: remote MCP servers and personal plugins'],
    roles: ['hook', 'mcp-server', 'rule', 'skill', 'subagent'],
  },
  {
    scope: 'plugin',
    locations: ['installed plugins'],
    roles: ['hook', 'mcp-server', 'rule', 'skill', 'subagent'],
  },
];

const TRIGGER_FOR_CURSOR_MODE: Readonly<Record<CursorRuleMode, LoadTrigger>> = {
  always: 'startup',
  globs: 'on-path',
  description: 'model-selected',
  manual: 'manual',
  unknown: 'unknown',
};

/** Instruction files Devin Local reads, by kind. */
const INSTRUCTION_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'agents-md',
  'claude-md',
  'windsurf-legacy-rules',
]);

/** Instruction files the classifier does not know, so the walker does not read them. */
const UNREAD_INSTRUCTIONS: ReadonlySet<string> = new Set(['AGENTS.local.md', 'AGENT.md']);

/** Where the global rules file sits, by the folder that holds it. */
const GLOBAL_RULES = 'global_rules.md';

/** Kinds of the files in {@link HOOK_FILES}. */
const HOOK_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'claude-settings',
  'devin-config',
  'devin-hooks',
]);

/** Files in a workspace root (or a directory above it) that may hold hooks for Devin Local. */
const HOOK_FILES: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.devin/config.json',
  '.devin/config.local.json',
  '.devin/hooks.json',
  '.devin/hooks.v1.json',
];

/** Devin Local's tool events, the only ones whose `matcher` applies (SOURCES.devinCliHookEvents). */
const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
]);

/** Files in the workspace root that declare MCP servers, with the kind each one has. */
const MCP_FILES: Readonly<Record<string, ArtifactKind>> = {
  '.claude/settings.json': 'claude-settings',
  '.claude/settings.local.json': 'claude-settings',
  '.cursor/mcp.json': 'cursor-mcp',
  '.devin/config.json': 'devin-config',
  '.devin/config.local.json': 'devin-config',
  '.devin/mcp_config.json': 'devin-mcp',
  '.devin/mcp_config.local.json': 'devin-mcp',
  '.mcp.json': 'mcp-json',
};

/**
 * Files in the workspace root whose MCP servers Devin imports in a format agentcheckup does not
 * read, by the `read_config_from` source that turns each one off: OpenCode's own server schema,
 * and Zed's `context_servers` (SOURCES.devinReadConfigFrom).
 */
const UNREAD_MCP_FILES: Readonly<Record<string, DevinConfigSource>> = {
  'opencode.json': 'opencode',
  '.zed/settings.json': 'zed',
};

/**
 * True when an unlisted directory (trailing `/`) may hold files Devin Local reads: `.devin` or
 * `.windsurf` and anything below, `.cursor` and its rules, the skills and commands folders it
 * imports, and the workspace's own `.zed`.
 */
function mayHoldConfig(directory: string): boolean {
  const segments = directory.split('/').filter((segment) => segment !== '');
  return segments.some((segment, i) => {
    const next = segments[i + 1];
    if (segment === '.devin' || segment === '.windsurf') return true;
    // Devin reads `.zed/settings.json` at the workspace root only.
    if (segment === '.zed') return i === 0 && next === undefined;
    if (segment === '.cursor') return next === undefined || next === 'rules';
    if (segment === '.agents' || segment === '.github') {
      return next === undefined || next === 'skills';
    }
    if (segment === '.claude') {
      return next === undefined || next === 'skills' || next === 'commands';
    }
    return false;
  });
}

function sizeOf(bytes: number, chars: number): Size {
  return { bytes, chars, tokens: tokensOf(chars) };
}

function textSize(text: string): Size {
  return sizeOf(utf8ByteLength(text), codePointLength(text));
}

function fileSize(artifact: Artifact): Size {
  return sizeOf(artifact.file.bytes.length, codePointLength(artifact.decoded.text));
}

function compareEntries(a: LoadEntry, b: LoadEntry): number {
  return (
    TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
    compareStrings(a.path, b.path) ||
    compareStrings(a.id, b.id)
  );
}

/** `X/.devin/rules/a.md` -> `X`: the directory that owns a rules folder or a config folder. */
function ownerOf(path: string, depth: number): string {
  let directory = path;
  for (let i = 0; i < depth; i++) directory = dirnamePosix(directory);
  return directory;
}

/** Where a `.cursor/rules` file sits below the workspace root, or undefined outside one. */
function cursorRulesPlace(
  local: string,
): { readonly owner: string; readonly direct: boolean } | undefined {
  const segments = local.split('/');
  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i]?.toLowerCase() !== '.cursor' || segments[i + 1]?.toLowerCase() !== 'rules') {
      continue;
    }
    return { owner: segments.slice(0, i).join('/'), direct: i + 3 === segments.length };
  }
  return undefined;
}

/**
 * When Devin Local hands a skill to the model, from its `triggers` (default `[user, model]`,
 * SOURCES.devinCliSkills): `model-selected` while the list has `model`, `manual` with only `user`.
 * The documentation does not define the values one by one, so any explicit list is unverified,
 * and a value that is not a list of strings, or a list with neither, is `unknown`.
 */
function skillTrigger(triggers: unknown): { trigger: LoadTrigger; documented: boolean } {
  if (triggers === undefined || triggers === null) {
    return { trigger: 'model-selected', documented: true };
  }
  if (!Array.isArray(triggers) || !triggers.every((item) => typeof item === 'string')) {
    return { trigger: 'unknown', documented: false };
  }
  if (triggers.includes('model')) return { trigger: 'model-selected', documented: false };
  if (triggers.includes('user')) return { trigger: 'manual', documented: false };
  return { trigger: 'unknown', documented: false };
}

/** The load plan of Devin Local for the workspace `options.cwd`. Pure and deterministic. */
export function loadWindsurf(view: LoadView, options: WindsurfLoadOptions): LoadPlan {
  const { cwd } = options;
  const { snapshot } = view;
  const prefix = cwd === '' ? '' : `${cwd}/`;
  const inWorkspace = (path: string): boolean => path.startsWith(prefix);
  const local = (path: string): string => path.slice(prefix.length);

  const entries: LoadEntry[] = [];
  const skipped: SkippedLoad[] = [];
  const outOfScope = new Map<string, OutOfScope>();
  const incomplete = new Set<string>();
  /** Listing sizes of skills the model can pick: in context at startup. */
  const listed: Size[] = [];
  const deferred: Size[] = [];

  const out = (path: string, because: OutOfScope['because']): void => {
    outOfScope.set(`${path}\u0000${because}`, { path, because });
  };

  const skip = (
    role: LoadRole,
    path: string,
    code: SkippedLoad['code'],
    certainty: Certainty,
    evidence: readonly SourceKey[],
    extra: {
      readonly id?: string;
      readonly name?: string;
      readonly ruleId?: string;
      readonly size?: Size;
    } = {},
  ): void => {
    const { id, ...rest } = extra;
    skipped.push({
      id: id ?? `${role}:${path}${extra.name === undefined ? '' : `#${extra.name}`}`,
      role,
      path,
      ...rest,
      code,
      certainty,
      evidence,
    });
  };

  // ------------------------------------------------------------------------------------------
  // read_config_from
  // ------------------------------------------------------------------------------------------

  /** The workspace's own `read_config_from`, from `<cwd>/.devin/config.json`. */
  const workspaceSettings = devinReadConfigFrom(view, cwd);

  /**
   * Whether Devin Local imports `source` for the file at `path`, by the `read_config_from` of the
   * nearest `.devin/config.json` at or above its directory inside the workspace, as the rules
   * decide (src/platforms/readers.ts), else the workspace's own. `nested`: a configuration below
   * the workspace root decides differently from the workspace's, and Devin does not document
   * reading one there. Devin's own files have no source and are always read.
   */
  const sourceState = (
    path: string,
    source: DevinConfigSource | undefined,
  ): { readonly enabled: boolean; readonly nested: boolean } => {
    if (source === undefined) return { enabled: true, nested: false };
    const found = devinReadConfigFor(view, dirnamePosix(path));
    const settings: DevinReadConfigFrom =
      found.config === undefined || !inWorkspace(found.config) ? workspaceSettings : found;
    const enabled = settings.enabled[source];
    return { enabled, nested: enabled !== workspaceSettings.enabled[source] };
  };

  /**
   * Whether `read_config_from` turns `source` off for the file at `path`. Skips it as `disabled`
   * and returns true when it does.
   */
  const disabled = (
    role: LoadRole,
    path: string,
    source: DevinConfigSource | undefined,
    extra: { readonly id?: string; readonly name?: string } = {},
  ): boolean => {
    const state = sourceState(path, source);
    if (state.enabled) return false;
    const certainty = state.nested ? 'unverified' : 'documented';
    skip(role, path, 'disabled', certainty, ['devinReadConfigFrom'], extra);
    return true;
  };

  /** True when a nested `.devin/config.json` decides whether Devin imports the file. */
  const nestedSettings = (path: string, source: DevinConfigSource | undefined): boolean =>
    sourceState(path, source).nested;

  // ------------------------------------------------------------------------------------------
  // Instructions: AGENTS.md, .windsurfrules and CLAUDE.md
  // ------------------------------------------------------------------------------------------

  const instruction = (
    path: string,
    artifact: Artifact,
    kind: ArtifactKind,
    caseMismatch: boolean,
  ): void => {
    const directory = dirnamePosix(local(path));
    const source = devinSourceOf({ kind, path });
    // Devin CLI discovers lowercase `agents.md` files since v3000.4.16, and the Devin Desktop FAQ
    // names both spellings, so instr/filename-case leaves `agents.md` alone for Devin.
    const lowerAgentsMd = basename(path) === 'agents.md';
    const evidence: readonly SourceKey[] =
      kind !== 'agents-md'
        ? ['devinCliRules', 'devinReadConfigFrom']
        : lowerAgentsMd
          ? ['devinCliRules', 'devinCliChangelog', 'devinDesktopFaq']
          : ['devinCliRules'];
    if (disabled('instructions', path, source)) return;
    if (caseMismatch && !lowerAgentsMd) {
      // Found on case-insensitive file systems only; Devin documents neither case.
      skip('instructions', path, 'case-mismatch', 'unverified', evidence, {
        ruleId: 'instr/filename-case',
        size: fileSize(artifact),
      });
      return;
    }
    if (isBlank(artifact.decoded.text)) {
      // What Devin does with a blank file is not documented.
      skip('instructions', path, 'blank-file', 'unverified', evidence, {
        ruleId: 'instr/empty-file',
      });
      return;
    }
    const nested = directory !== '';
    const documented =
      (!caseMismatch || lowerAgentsMd) &&
      (!nested || kind === 'agents-md') &&
      !nestedSettings(path, source);
    entries.push({
      id: `instructions:${path}`,
      role: 'instructions',
      trigger: nested ? 'on-path' : 'startup',
      path,
      realPath: artifact.realPath,
      ...(nested ? { patterns: [dirnamePosix(path)] } : {}),
      size: fileSize(artifact),
      certainty: documented ? 'documented' : 'unverified',
      evidence,
    });
  };

  /**
   * An instruction or global rules file the walker did not read: listed without a size where
   * Devin Local loads it, and the plan is incomplete.
   */
  const unreadInstruction = (
    path: string,
    owner: string,
    source: DevinConfigSource | undefined,
    documentedNested: boolean,
  ): void => {
    const nested = owner !== cwd;
    entries.push({
      id: `instructions:${path}`,
      role: 'instructions',
      trigger: nested ? 'on-path' : 'startup',
      path,
      realPath: path,
      ...(nested ? { patterns: [owner] } : {}),
      certainty:
        (!nested || documentedNested) && !nestedSettings(path, source)
          ? 'documented'
          : 'unverified',
      evidence: ['devinCliRules'],
    });
    incomplete.add(`unread:${path}`);
  };

  // ------------------------------------------------------------------------------------------
  // Workspace rules: .devin/rules, .windsurf/rules and .cursor/rules
  // ------------------------------------------------------------------------------------------

  /**
   * A rule's entry. In a rules folder below the workspace root, Devin loads the rule when it
   * accesses files there; an always-on rule becomes one for that directory, and anything else
   * about nested rules folders is unverified.
   */
  const ruleEntry = (
    path: string,
    artifact: Artifact,
    owner: string,
    trigger: LoadTrigger,
    globs: readonly string[],
    documented: boolean,
    evidence: readonly SourceKey[],
  ): void => {
    const nested = owner !== cwd;
    const effective: LoadTrigger = nested && trigger === 'startup' ? 'on-path' : trigger;
    const patterns =
      nested && trigger === 'startup'
        ? [owner]
        : effective === 'on-path' && globs.length > 0
          ? globs
          : undefined;
    entries.push({
      id: `rule:${path}`,
      role: 'rule',
      trigger: effective,
      path,
      realPath: artifact.realPath,
      ...(patterns === undefined ? {} : { patterns }),
      size: fileSize(artifact),
      certainty: documented && (!nested || trigger === 'startup') ? 'documented' : 'unverified',
      evidence,
    });
  };

  const windsurfRule = (path: string, artifact: Artifact): void => {
    const owner = ownerOf(path, 3);
    const source = devinSourceOf({ kind: 'windsurf-rule', path });
    if (disabled('rule', path, source)) return;
    const frontmatter = view.frontmatter(artifact);
    const { text } = artifact.decoded;
    // instr/empty-file's test for a rule: blank, or valid frontmatter and a blank body.
    if (
      isBlank(text) ||
      (frontmatter.kind === 'valid' && isBlank(text.slice(bodyOffset(frontmatter))))
    ) {
      skip('rule', path, 'blank-file', 'unverified', ['devinCliRules'], {
        ruleId: 'instr/empty-file',
      });
      return;
    }
    const activation = windsurfActivation(frontmatter);
    const evidence: readonly SourceKey[] =
      activation.mode === 'unknown' ? ['devinCliRules'] : ['devinCliRules', 'windsurfRules'];
    ruleEntry(
      path,
      artifact,
      owner,
      WINDSURF_MODE_TRIGGER[activation.mode],
      activation.globs,
      activation.documented && !nestedSettings(path, source),
      evidence,
    );
  };

  const cursorRule = (path: string, artifact: Artifact, kind: ArtifactKind): void => {
    const place = cursorRulesPlace(local(path));
    if (place === undefined) return;
    const source = devinSourceOf({ kind, path });
    if (disabled('rule', path, source)) return;
    const activation = cursorActivation(view.frontmatter(artifact));
    ruleEntry(
      path,
      artifact,
      place.owner === '' ? cwd : joinPath(cwd, place.owner),
      TRIGGER_FOR_CURSOR_MODE[activation.mode],
      activation.globs,
      // Devin documents `.cursor/rules/*.md` and `*.mdc`: files directly in the folder.
      activation.documented && place.direct && !nestedSettings(path, source),
      ['devinCliRules', 'devinReadConfigFrom'],
    );
  };

  // ------------------------------------------------------------------------------------------
  // Skills and imported commands
  // ------------------------------------------------------------------------------------------

  const skill = (path: string, artifact: Artifact, caseMismatch: boolean): void => {
    const location = skillLocation(path, caseMismatch);
    if (location === undefined) {
      const plugin = pluginReaders(snapshot, path);
      if (plugin !== undefined && !plugin.includes('windsurf')) out(path, 'other-agent-plugin');
      return;
    }
    if (!location.platforms.has('windsurf') || !inWorkspace(location.root)) return;
    if (isBundledSkill(snapshot, path)) {
      out(path, 'payload-folder');
      return;
    }
    // Devin documents project skills at the project root only.
    const scope = dirnamePosix(dirnamePosix(location.root));
    if (scope !== cwd) {
      out(path, 'below-start-dir');
      return;
    }
    const source = devinSourceOf({ kind: 'skill', path });
    const directory = basename(dirnamePosix(path));
    if (disabled('skill', path, source, { id: `skill:${path}`, name: directory })) return;

    const frontmatter = view.frontmatter(artifact);
    const values = frontmatter.kind === 'valid' ? frontmatter.data.values : undefined;
    const declared = values?.['name'];
    // `name` defaults to the directory name.
    const name =
      typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : directory;
    const description = values?.['description'];
    // The listing: name and description, as in the Agent Skills specification. Devin does not
    // document what the model sees.
    const listing = typeof description === 'string' ? `${name}\n${description.trim()}` : name;
    const { trigger, documented } = skillTrigger(values?.['triggers']);
    const size = textSize(listing);
    const body = textSize(artifact.decoded.text.slice(bodyOffset(frontmatter)));
    entries.push({
      id: `skill:${path}`,
      role: 'skill',
      trigger,
      path,
      realPath: artifact.realPath,
      name,
      size,
      deferred: body,
      certainty:
        documented &&
        frontmatter.kind !== 'invalid' &&
        !artifact.decoded.hasBom &&
        !caseMismatch &&
        !nestedSettings(path, source)
          ? 'documented'
          : 'unverified',
      evidence: [
        'devinCliSkills',
        'devinLocalCustomizations',
        ...(source === undefined ? [] : ['devinReadConfigFrom']),
        'agentSkillsSpec',
      ],
    });
    if (trigger === 'model-selected') listed.push(size);
    else deferred.push(size);
    deferred.push(body);
  };

  /**
   * A command in `.claude/commands`, which Devin imports as a skill. How such a skill is invoked is
   * not documented.
   */
  const command = (path: string, artifact: Artifact): void => {
    if (!local(path).startsWith('.claude/commands/')) return;
    const name = basename(path).replace(/\.md$/i, '');
    const source = devinSourceOf({ kind: 'claude-command', path });
    if (disabled('command', path, source, { id: `command:${path}`, name })) return;
    entries.push({
      id: `command:${path}`,
      role: 'command',
      trigger: 'model-selected',
      path,
      realPath: artifact.realPath,
      name,
      size: fileSize(artifact),
      certainty: 'unverified',
      evidence: ['devinReadConfigFrom', 'devinCliSkills'],
    });
  };

  // ------------------------------------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------------------------------------

  /**
   * Directories whose hook files Devin Local reads: the working directory and those above it up
   * to the repository root. Without a `.git` in the scan, every directory up to the scan root,
   * those above the working directory unverified.
   */
  const gitRoot = nearestGitRoot(snapshot, cwd);
  const hookDirectories = new Map<string, Certainty>();
  for (const directory of selfAndAncestors(cwd)) {
    hookDirectories.set(
      directory,
      directory === cwd || gitRoot !== undefined ? 'documented' : 'unverified',
    );
    if (directory === gitRoot) break;
  }

  /**
   * True when a Claude Code hook's matcher names tools. Devin matches it against its own tool
   * names, such as `exec`, and documents no mapping from Claude Code's, such as `Bash`.
   */
  const namesTools = (event: string, group: unknown): boolean => {
    if (!TOOL_EVENTS.has(event)) return false;
    const matcher = isObject(group) ? own(group, 'matcher') : undefined;
    return typeof matcher === 'string' && matcher !== '' && matcher !== '*';
  };

  const hooks = (path: string, kind: ArtifactKind, artifact: Artifact, where: Certainty): void => {
    const source = hookSourceOf({ kind, path });
    if (source === undefined) {
      // Cascade's `.devin/hooks.json`: Devin Local reads `hooks.v1.json`.
      skip('hook', path, 'not-read', 'unverified', ['devinCliHooks']);
      return;
    }
    const doc = view.json(artifact);
    if (!doc.ok) {
      // Devin does not document what it does with a file it cannot parse.
      incomplete.add(`unparsed:${path}`);
      return;
    }
    const claude = kind === 'claude-settings';
    // `read_config_from.claude` controls the hooks in `.claude/` (SOURCES.devinCliHooks).
    const importedFrom = devinSourceOf({ kind, path });
    const evidence: readonly SourceKey[] = claude
      ? ['devinCliHooks', 'devinReadConfigFrom']
      : ['devinCliHooks'];
    const handlers = hookHandlers(doc, source.platform, {
      includeUnknown: true,
      root: source.root,
    });
    const ids = hookInventoryIds(path, handlers, source.platform);
    const inventoryIds = hookInventoryIds(artifact.path, handlers, source.platform);
    const events: readonly string[] = DEVIN_EVENTS;
    if (!claude) {
      // Devin fires only its documented events, so hooks under another name never run
      // (hooks/unknown-event). Whether it matches a name in another letter case is not
      // documented.
      for (const event of hookEvents(doc, source.platform, source.root)) {
        if (events.includes(event.name)) continue;
        skip(
          'hook',
          path,
          'unknown-event',
          devinEventInOtherCase(event.name) ? 'unverified' : 'documented',
          ['devinCliHooks', 'devinCliHookEvents'],
          { name: event.name, ruleId: 'hooks/unknown-event' },
        );
      }
    }
    handlers.forEach((handler, index) => {
      const id = ids[index] ?? '';
      const name = handler.event;
      if (!claude && !events.includes(name)) return;
      if (disabled('hook', path, importedFrom, { id, name })) return;
      if (!events.includes(name)) {
        // A Claude Code event Devin does not fire is one it does not read; how it treats such a
        // name is not documented.
        skip('hook', path, 'not-read', 'unverified', evidence, { id, name });
        return;
      }
      const certain =
        where === 'documented' &&
        !((claude && namesTools(name, handler.group)) || nestedSettings(path, importedFrom));
      entries.push({
        id,
        role: 'hook',
        trigger: 'startup',
        path,
        realPath: artifact.realPath,
        name,
        inventoryId: inventoryIds[index] ?? '',
        certainty: certain ? 'documented' : 'unverified',
        evidence,
      });
    });
  };

  // ------------------------------------------------------------------------------------------
  // MCP servers
  // ------------------------------------------------------------------------------------------

  const mcp = (path: string, artifact: Artifact): void => {
    const doc = view.json(artifact);
    if (!doc.ok) {
      // Devin does not document what it does with a file it cannot parse.
      incomplete.add(`unparsed:${path}`);
      return;
    }
    const devinFile = artifact.kind === 'devin-mcp' || artifact.kind === 'devin-config';
    const source = devinSourceOf(artifact);
    // Servers in `.devin/config.json` predate v3000.3; Devin moves them to the dedicated files on
    // startup, and where they end up is not documented.
    const legacy = artifact.kind === 'devin-config';
    const evidence: readonly SourceKey[] = devinFile
      ? ['devinCliMcp']
      : ['devinCliMcp', 'devinReadConfigFrom'];
    const servers = mcpServers(artifact, doc);
    const inventoryIds = mcpInventoryIds(artifact.path, servers);
    servers.forEach((server, index) => {
      const name = server.name;
      if (disabled('mcp-server', path, source, { name })) return;
      if (own(server.config, 'disabled') === true) {
        // Documented for Devin's own files; the imported formats have no such field.
        skip('mcp-server', path, 'disabled', devinFile ? 'documented' : 'unverified', evidence, {
          name,
        });
        return;
      }
      entries.push({
        id: `mcp-server:${path}#${name}`,
        role: 'mcp-server',
        trigger: 'startup',
        path,
        realPath: artifact.realPath,
        name,
        inventoryId: inventoryIds[index] ?? '',
        certainty: legacy || nestedSettings(path, source) ? 'unverified' : 'documented',
        evidence,
      });
    });
  };

  // ------------------------------------------------------------------------------------------
  // Dispatch over every path that reaches an artifact
  // ------------------------------------------------------------------------------------------

  const visit = (
    path: string,
    artifact: Artifact,
    kind: ArtifactKind,
    caseMismatch: boolean,
  ): void => {
    const where = local(path);
    if (INSTRUCTION_KINDS.has(kind)) {
      instruction(path, artifact, kind, caseMismatch);
    } else if (kind === 'windsurf-rule') {
      windsurfRule(path, artifact);
    } else if (kind === 'cursor-rule' || kind === 'cursor-rule-md') {
      cursorRule(path, artifact, kind);
    } else if (kind === 'skill') {
      skill(path, artifact, caseMismatch);
    } else if (kind === 'claude-command') {
      command(path, artifact);
    }
    if (Object.hasOwn(MCP_FILES, where) && MCP_FILES[where] === kind) {
      mcp(path, artifact);
    } else if (kind === 'mcp-json' || kind === 'cursor-mcp' || kind === 'devin-mcp') {
      // Project configuration of a workspace opened deeper.
      out(path, 'below-start-dir');
    }
    if (HOOK_KINDS.has(kind)) {
      // Devin looks for hook files from the working directory up, never below it.
      const owner = ownerOf(path, 2);
      if (owner !== cwd && inWorkspace(owner)) out(path, 'below-start-dir');
    }
  };

  for (const artifact of view.artifacts) {
    if (inWorkspace(artifact.path)) {
      visit(artifact.path, artifact, artifact.kind, artifact.caseMismatch !== undefined);
    }
    for (const alias of artifact.aliases) {
      if (!inWorkspace(alias)) continue;
      // An alias is what the agent sees at that path, so its own name decides its role.
      const classification = classify(alias);
      if (classification === undefined) continue;
      visit(alias, artifact, classification.kind, classification.caseMismatch !== undefined);
    }
  }

  // Hook files in the working directory and above it.
  for (const [directory, where] of hookDirectories) {
    for (const name of HOOK_FILES) {
      const path = joinPath(directory, name);
      const artifact = view.index.get(path);
      const kind = classify(path)?.kind;
      if (artifact === undefined || kind === undefined || !HOOK_KINDS.has(artifact.kind)) continue;
      hooks(path, kind, artifact, where);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Files the classifier does not know: AGENTS.local.md, AGENT.md, the global rules, and the
  // MCP files of OpenCode and Zed
  // ------------------------------------------------------------------------------------------

  const present = new Set<string>(snapshot.ignoredFiles);
  for (const path of snapshot.paths) if (!path.endsWith('/')) present.add(path);
  for (const entry of snapshot.skipped) present.add(entry.path);
  const candidates = [...present].filter(inWorkspace).sort(compareStrings);

  for (const path of candidates) {
    if (view.index.has(path)) continue;
    const where = local(path);
    if (Object.hasOwn(UNREAD_MCP_FILES, where)) {
      const source = UNREAD_MCP_FILES[where];
      // Devin imports their servers at session start; which ones they declare is not read.
      if (!disabled('mcp-server', path, source)) incomplete.add(`unread:${path}`);
      continue;
    }
    const name = basename(path);
    if (UNREAD_INSTRUCTIONS.has(name)) {
      if (!disabled('instructions', path, 'agents_standard')) {
        unreadInstruction(path, dirnamePosix(path), 'agents_standard', true);
      }
      continue;
    }
    if (name !== GLOBAL_RULES) continue;
    const folder = basename(dirnamePosix(path));
    if (folder !== '.devin' && folder !== '.windsurf') continue;
    const owner = ownerOf(path, 2);
    if (folder === '.windsurf') {
      if (disabled('instructions', path, 'windsurf')) continue;
      if (fileExists(snapshot, joinPath(owner, `.devin/${GLOBAL_RULES}`))) {
        // Devin loads only `.devin/global_rules.md` when both exist.
        skip('instructions', path, 'shadowed-by-preferred', 'documented', ['devinCliRules']);
        continue;
      }
    }
    unreadInstruction(path, owner, folder === '.windsurf' ? 'windsurf' : undefined, false);
  }

  // ------------------------------------------------------------------------------------------
  // Files Devin Local would read that agentcheckup did not
  // ------------------------------------------------------------------------------------------

  const wouldRead = (path: string, kind: ArtifactKind): boolean => {
    const where = local(path);
    if (INSTRUCTION_KINDS.has(kind) || kind === 'windsurf-rule') return true;
    if (kind === 'cursor-rule' || kind === 'cursor-rule-md') {
      return cursorRulesPlace(where) !== undefined;
    }
    if (kind === 'claude-command') return where.startsWith('.claude/commands/');
    if (kind === 'skill') {
      const location = skillLocation(path);
      return location?.platforms.has('windsurf') === true && inWorkspace(location.root);
    }
    return Object.hasOwn(MCP_FILES, where) && MCP_FILES[where] === kind;
  };

  for (const path of candidates) {
    if (view.index.has(path) || !isCandidateBasename(basename(path))) continue;
    const classification = classify(path);
    if (classification !== undefined && wouldRead(path, classification.kind)) {
      incomplete.add(`unread:${path}`);
    }
  }
  for (const [directory] of hookDirectories) {
    for (const name of HOOK_FILES) {
      const path = joinPath(directory, name);
      if (!view.index.has(path) && present.has(path)) incomplete.add(`unread:${path}`);
    }
  }
  for (const directory of snapshot.opaqueDirectories) {
    if (inWorkspace(directory) && mayHoldConfig(local(directory))) {
      incomplete.add(`unread:${directory}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Assembly
  // ------------------------------------------------------------------------------------------

  const total = (sizes: readonly Size[]): Size =>
    sizeOf(
      sizes.reduce((sum, size) => sum + size.bytes, 0),
      sizes.reduce((sum, size) => sum + size.chars, 0),
    );
  const sorted = entries.sort(compareEntries);
  const startupSizes = [
    ...sorted.flatMap((entry) =>
      entry.trigger === 'startup' && entry.role !== 'skill' && entry.size !== undefined
        ? [entry.size]
        : [],
    ),
    ...listed,
  ];
  const onDemandSizes = [
    ...sorted.flatMap((entry) =>
      entry.trigger !== 'startup' && entry.role !== 'skill' && entry.size !== undefined
        ? [entry.size]
        : [],
    ),
    ...deferred,
  ];

  const assumptions: Assumption[] = [
    ...BASE_ASSUMPTIONS,
    ...PLANNED_SOURCES.map((source) => ({
      key: `devin.read_config_from.${source}`,
      value: workspaceSettings.enabled[source],
      origin: workspaceSettings.origin[source],
      evidence: ['devinReadConfigFrom'],
    })),
  ];

  return {
    agent: 'windsurf',
    cwd,
    entries: sorted,
    skipped: skipped.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id)),
    outOfScope: [...outOfScope.values()].sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
    ),
    assumptions: assumptions.sort((a, b) => compareStrings(a.key, b.key)),
    hidden: HIDDEN,
    // Devin Local documents no size limit (SOURCES.windsurfRules).
    limits: [],
    totals: { startup: total(startupSizes), onDemand: total(onDemandSizes) },
    incomplete: [...incomplete].sort(compareStrings),
  };
}
