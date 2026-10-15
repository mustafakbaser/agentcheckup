/**
 * What Cursor's agent loads for a workspace, from docs/platforms.md ("Cursor") and the sources it
 * cites. The plan treats `cwd` as the folder opened in Cursor: Cursor's "project root". Files
 * outside it are not part of the workspace and do not appear.
 *
 * - Instructions: the root AGENTS.md and CLAUDE.md are in every conversation; nested AGENTS.md
 *   files apply to their directory; the legacy root `.cursorrules` is still read.
 * - `.cursor/rules/**\/*.mdc`: the mode comes from the frontmatter (`cursorActivation`, shared
 *   with cursor/rule-never-applied). `.md` files there are ignored (cursor/md-file-ignored); a
 *   README is documentation. Nested `.cursor/rules` folders below the root are unverified, and
 *   so is frontmatter that does not parse: Cursor does not document how it reads it, so the mode
 *   is unknown. Such a rule is listed as `manual`, the one trigger that includes any rule, and
 *   marked unverified.
 * - Skills: SKILL.md at any depth below `.agents/skills`, `.cursor/skills`, `.claude/skills` and
 *   `.codex/skills`. Skills in nested `.cursor/skills` and `.agents/skills` folders apply only to
 *   files in that directory; nested `.claude` and `.codex` folders are unverified. `paths` (or
 *   the legacy `globs`) limits a skill to matching files; `disable-model-invocation: true` makes
 *   it manual. The skill's name is its folder, so a `name` that differs is a warning
 *   (skill/name-dir-mismatch), not a skip.
 * - MCP servers in the root `.cursor/mcp.json`. The docs do not say whether project servers wait
 *   for approval (they say tool calls do), so `on-approval` is unverified.
 * - Hooks in the root `.cursor/hooks.json`, and Claude Code hooks from the root
 *   `.claude/settings.json` and `.claude/settings.local.json` with their events mapped.
 *   `Notification` and `PermissionRequest` are not supported. Project hooks run only in trusted
 *   workspaces, hence `on-approval`.
 *
 * Startup positions: Cursor does not document the order in which it assembles instructions and
 * rules. Positions list instruction files first, then rules, each by path.
 *
 * Skills: the docs say the agent picks skills by their description and loads resources on
 * demand. A skill's `size` is its listing (name and description), counted at startup for skills
 * the model can pick, and `deferred` is the body, as in the Agent Skills specification.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { hash53 } from '../../core/fingerprint.js';
import { codePointLength, lineCount, utf8ByteLength } from '../../core/measure.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, ArtifactKind } from '../../core/types.js';
import { own } from '../../parse/json-access.js';
import type { JsonDocument } from '../../parse/types.js';
import { classify, isCandidateBasename } from '../classify.js';
import {
  CURSOR_RULE_LINE_ADVICE,
  cursorActivation,
  type CursorRuleMode,
  globList,
  isRulesReadme,
} from '../cursor-rules.js';
import {
  CURSOR_EVENT_FOR_CLAUDE,
  CURSOR_UNSUPPORTED_CLAUDE_EVENTS,
  HOOK_EVENTS,
  hookEvents,
  type HookHandler,
  hookHandlers,
} from '../hooks.js';
import { issueKind } from '../../parse/json-access.js';
import { isBundledSkill } from '../location.js';
import { mcpServers } from '../mcp.js';
import { basename } from '../paths.js';
import { bodyOffset, pluginReaders, skillLocation } from '../skills.js';
import { isBlank } from './codex-text.js';
import type {
  Assumption,
  Certainty,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  LoadRole,
  LoadTrigger,
  OutOfScope,
  Size,
  SkippedLoad,
  SourceKey,
} from './types.js';
import type { LoadView } from './view.js';

export interface CursorLoadOptions {
  /** The folder opened in Cursor, relative to the scan root. `''` is the root. */
  readonly cwd: string;
  readonly config: ResolvedConfig;
  /** Not used: Cursor documents no limit that depends on the context window. */
  readonly contextWindow?: number;
}

const ASSUMPTIONS: readonly Assumption[] = [
  // Rules apply only to Agent (Chat), not to Tab, Inline Edit or Bugbot.
  { key: 'cursor.mode', value: 'agent', origin: 'default', evidence: ['cursorRulesHelp'] },
  // "Include Third-Party Plugins, Skills, and Other Configs" is on by default.
  {
    key: 'cursor.thirdPartyConfigs',
    value: true,
    origin: 'default',
    evidence: ['cursorThirdPartyHooks'],
  },
  // Project hooks run only in trusted workspaces.
  { key: 'cursor.trustedWorkspace', value: true, origin: 'default', evidence: ['cursorHooks'] },
];

const HIDDEN: readonly HiddenScope[] = [
  { scope: 'account', locations: ['User Rules (Cursor Settings)'], roles: ['rule'] },
  { scope: 'managed', locations: ['enterprise hooks'], roles: ['hook'] },
  { scope: 'team', locations: ['Team Rules', 'team hooks'], roles: ['hook', 'rule'] },
  {
    scope: 'user',
    locations: [
      '~/.agents/skills',
      '~/.claude/settings.json',
      '~/.claude/skills',
      '~/.codex/skills',
      '~/.cursor/hooks.json',
      '~/.cursor/mcp.json',
      '~/.cursor/rules',
      '~/.cursor/skills',
    ],
    roles: ['hook', 'mcp-server', 'rule', 'skill'],
  },
];

const TRIGGER_RANK: Readonly<Record<LoadTrigger, number>> = {
  startup: 0,
  'on-path': 1,
  'model-selected': 2,
  manual: 3,
  'on-approval': 4,
};

const TRIGGER_FOR_MODE: Readonly<Record<CursorRuleMode, LoadTrigger>> = {
  always: 'startup',
  globs: 'on-path',
  description: 'model-selected',
  manual: 'manual',
  unknown: 'manual',
};

/** Skills roots, as `<agent dir>/skills`. Cursor documents nesting for the first two only. */
const NESTED_SKILL_ROOTS: ReadonlySet<string> = new Set(['.agents/skills', '.cursor/skills']);

/** Directory names whose unlisted contents may hold configuration Cursor reads. */
const CONFIG_DIRECTORIES: ReadonlySet<string> = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.cursor',
]);

/**
 * True when an unlisted directory (trailing `/`) may hold files Cursor reads: an agent
 * directory itself, or its `skills` folder, or `.cursor/rules`, or anything below those.
 * `.claude/worktrees/` and the like do not count.
 */
function mayHoldConfig(directory: string): boolean {
  const segments = directory.split('/').filter((segment) => segment !== '');
  return segments.some((segment, i) => {
    if (!CONFIG_DIRECTORIES.has(segment)) return false;
    const next = segments[i + 1];
    return next === undefined || next === 'skills' || (segment === '.cursor' && next === 'rules');
  });
}

const CLAUDE_SETTINGS: ReadonlySet<string> = new Set([
  '.claude/settings.json',
  '.claude/settings.local.json',
]);

function sizeOf(bytes: number, chars: number): Size {
  return { bytes, chars, tokens: Math.ceil(chars / 4) };
}

function textSize(text: string): Size {
  return sizeOf(utf8ByteLength(text), codePointLength(text));
}

function fileSize(artifact: Artifact): Size {
  return sizeOf(artifact.file.bytes.length, codePointLength(artifact.decoded.text));
}

function compareEntries(a: LoadEntry, b: LoadEntry): number {
  const position =
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
  if (position !== 0) return position;
  const rank = TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger];
  if (rank !== 0) return rank;
  return compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
}

/** Where a `.cursor/rules` file sits: `top` in the root folder, `nested` in a deeper one. */
function rulesPlace(local: string): 'top' | 'nested' | undefined {
  const lower = local.toLowerCase();
  if (lower.startsWith('.cursor/rules/')) return 'top';
  return lower.includes('/.cursor/rules/') ? 'nested' : undefined;
}

/** The load plan of Cursor's agent for the workspace `options.cwd`. Pure and deterministic. */
export function loadCursor(view: LoadView, options: CursorLoadOptions): LoadPlan {
  const { cwd } = options;
  const prefix = cwd === '' ? '' : `${cwd}/`;
  const inWorkspace = (path: string): boolean => path.startsWith(prefix);
  const local = (path: string): string => path.slice(prefix.length);

  const entries: LoadEntry[] = [];
  const skipped: SkippedLoad[] = [];
  const outOfScope: OutOfScope[] = [];
  const limits: LimitUsage[] = [];
  const incomplete = new Set<string>();
  /** Listing sizes of skills the model can pick: in context at startup. */
  const listed: Size[] = [];
  const deferred: Size[] = [];

  const skip = (
    role: LoadRole,
    path: string,
    code: SkippedLoad['code'],
    certainty: Certainty,
    evidence: readonly SourceKey[],
    extra: { readonly name?: string; readonly ruleId?: string } = {},
  ): void => {
    skipped.push({
      id: `${role}:${path}${extra.name === undefined ? '' : `#${extra.name}`}`,
      role,
      path,
      ...extra,
      code,
      certainty,
      evidence,
    });
  };

  /** A config file that does not parse: skipped when json/invalid-syntax reports it. */
  const unparsable = (
    role: LoadRole,
    path: string,
    doc: Extract<JsonDocument, { ok: false }>,
    evidence: readonly SourceKey[],
  ): void => {
    const issue = doc.errors[0];
    if (issue === undefined || issueKind(issue) === 'limit') {
      incomplete.add(`unparsed:${path}`);
      return;
    }
    // Cursor does not document how it handles a config file it cannot parse.
    skip(role, path, 'invalid-json', 'unverified', evidence, { ruleId: 'json/invalid-syntax' });
  };

  // ------------------------------------------------------------------------------------------
  // Instructions
  // ------------------------------------------------------------------------------------------

  const instruction = (
    path: string,
    artifact: Artifact,
    kind: ArtifactKind,
    caseMismatch: boolean,
  ): void => {
    const directory = dirnamePosix(local(path));
    if (kind !== 'agents-md' && directory !== '') return;
    const evidence = kind === 'agents-md' ? ['cursorRules'] : ['cursorRulesHelp'];
    if (caseMismatch) {
      // Found on case-insensitive file systems only; Cursor documents neither case.
      skip('instructions', path, 'case-mismatch', 'unverified', evidence, {
        ruleId: 'instr/filename-case',
      });
      return;
    }
    if (isBlank(artifact.decoded.text)) {
      skip('instructions', path, 'blank-file', 'unverified', evidence, {
        ruleId: 'instr/empty-file',
      });
      return;
    }
    const nested = directory !== '';
    entries.push({
      id: `instructions:${path}`,
      role: 'instructions',
      trigger: nested ? 'on-path' : 'startup',
      path,
      realPath: artifact.realPath,
      ...(nested ? { patterns: [dirnamePosix(path)] } : {}),
      size: fileSize(artifact),
      certainty: 'documented',
      evidence,
    });
  };

  // ------------------------------------------------------------------------------------------
  // .cursor/rules
  // ------------------------------------------------------------------------------------------

  const rule = (path: string, artifact: Artifact, kind: ArtifactKind): void => {
    const place = rulesPlace(local(path));
    if (place === undefined) return;
    const nested = place === 'nested';
    if (kind === 'cursor-rule-md') {
      if (isRulesReadme(path)) {
        outOfScope.push({ path, because: 'documentation' });
        return;
      }
      skip('rule', path, 'not-mdc', nested ? 'unverified' : 'documented', ['cursorRules'], {
        ruleId: 'cursor/md-file-ignored',
      });
      return;
    }
    const activation = cursorActivation(view.frontmatter(artifact));
    const trigger = TRIGGER_FOR_MODE[activation.mode];
    entries.push({
      id: `rule:${path}`,
      role: 'rule',
      trigger,
      path,
      realPath: artifact.realPath,
      ...(trigger === 'on-path' && activation.globs.length > 0
        ? { patterns: activation.globs }
        : {}),
      size: fileSize(artifact),
      certainty: activation.documented && !nested ? 'documented' : 'unverified',
      evidence: ['cursorRules'],
    });
    limits.push({
      key: 'cursor.rule_lines',
      unit: 'lines',
      limit: CURSOR_RULE_LINE_ADVICE,
      used: lineCount(artifact.decoded.text),
      subject: path,
      effect: 'advice',
      evidence: ['cursorRules'],
    });
  };

  // ------------------------------------------------------------------------------------------
  // Skills
  // ------------------------------------------------------------------------------------------

  const skill = (path: string, artifact: Artifact, caseMismatch: boolean): void => {
    const location = skillLocation(path, caseMismatch);
    if (location === undefined) {
      const plugin = pluginReaders(view.snapshot, path);
      if (plugin !== undefined && !plugin.includes('cursor')) {
        outOfScope.push({ path, because: 'other-agent-plugin' });
      }
      return;
    }
    if (!location.platforms.has('cursor') || !inWorkspace(location.root)) return;
    if (isBundledSkill(view.snapshot, path)) {
      outOfScope.push({ path, because: 'payload-folder' });
      return;
    }
    const scope = dirnamePosix(dirnamePosix(location.root));
    const segment = location.root.slice(scope === '' ? 0 : scope.length + 1);
    const nested = scope !== cwd;

    // Cursor takes a skill's identity from its folder.
    const name = basename(dirnamePosix(path));
    const frontmatter = view.frontmatter(artifact);
    const values = frontmatter.kind === 'valid' ? frontmatter.data.values : undefined;
    const description = values?.['description'];
    // The listing: name and description. The exact text Cursor shows the model is not documented.
    const listing = typeof description === 'string' ? `${name}\n${description.trim()}` : name;
    const disabled = values?.['disable-model-invocation'] === true;
    const pathsValue = values?.['paths'] ?? values?.['globs'];
    const patterns = pathsValue === undefined || pathsValue === null ? [] : globList(pathsValue);

    let trigger: LoadTrigger = 'model-selected';
    let scoped: readonly string[] | undefined;
    if (disabled) trigger = 'manual';
    else if (patterns !== undefined && patterns.length > 0) {
      trigger = 'on-path';
      scoped = patterns;
    } else if (nested) {
      trigger = 'on-path';
      scoped = [scope];
    }
    const documented =
      frontmatter.kind === 'valid' &&
      !artifact.decoded.hasBom &&
      patterns !== undefined &&
      // How `paths` combines with a nested folder's directory is not documented.
      (!nested || ((patterns.length === 0 || disabled) && NESTED_SKILL_ROOTS.has(segment)));

    const size = textSize(listing);
    const body = textSize(artifact.decoded.text.slice(bodyOffset(frontmatter)));
    entries.push({
      id: `skill:${path}`,
      role: 'skill',
      trigger,
      path,
      realPath: artifact.realPath,
      name,
      ...(scoped === undefined ? {} : { patterns: scoped }),
      size,
      deferred: body,
      certainty: documented ? 'documented' : 'unverified',
      evidence: ['cursorSkills', 'agentSkillsSpec'],
    });
    if (trigger === 'model-selected') listed.push(size);
    else deferred.push(size);
    deferred.push(body);
  };

  // ------------------------------------------------------------------------------------------
  // MCP servers and hooks
  // ------------------------------------------------------------------------------------------

  const mcp = (path: string, artifact: Artifact): void => {
    if (local(path).toLowerCase() !== '.cursor/mcp.json') return;
    const doc = view.json(artifact);
    if (!doc.ok) {
      unparsable('mcp-server', path, doc, ['cursorMcp']);
      return;
    }
    for (const server of mcpServers(artifact, doc)) {
      entries.push({
        id: `mcp-server:${path}#${server.name}`,
        role: 'mcp-server',
        trigger: 'on-approval',
        path,
        realPath: artifact.realPath,
        name: server.name,
        inventoryId: `mcp:${artifact.path}#${server.name}`,
        certainty: 'unverified',
        evidence: ['cursorMcp'],
      });
    }
  };

  /** Occurrences of each `<path>#<event>:<digest>`, for repeated identical hooks. */
  const occurrences = new Map<string, number>();
  /** `<event>:<hash53 of the command>`, then `:<n>` from the second identical hook on. */
  const hookName = (path: string, handler: HookHandler): string => {
    const command = own(handler.handler, 'command');
    const base = `${handler.event}:${hash53(typeof command === 'string' ? command : '')}`;
    const key = `${path}#${base}`;
    const count = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, count);
    return count === 1 ? base : `${base}:${count}`;
  };

  const hookEntry = (
    path: string,
    artifact: Artifact,
    name: string,
    certainty: Certainty,
    evidence: readonly SourceKey[],
  ): void => {
    entries.push({
      id: `hook:${path}#${name}`,
      role: 'hook',
      trigger: 'on-approval',
      path,
      realPath: artifact.realPath,
      name,
      inventoryId: `hook:${artifact.path}#${name}`,
      certainty,
      evidence,
    });
  };

  const cursorHooks = (path: string, artifact: Artifact): void => {
    if (local(path).toLowerCase() !== '.cursor/hooks.json') return;
    const doc = view.json(artifact);
    if (!doc.ok) {
      unparsable('hook', path, doc, ['cursorHooks']);
      return;
    }
    const known = HOOK_EVENTS.cursor;
    for (const event of hookEvents(doc, 'cursor')) {
      if (known.includes(event.name)) continue;
      skip('hook', path, 'unknown-event', 'documented', ['cursorHooks'], {
        name: event.name,
        ruleId: 'hooks/unknown-event',
      });
    }
    for (const handler of hookHandlers(doc, 'cursor')) {
      hookEntry(path, artifact, hookName(path, handler), 'documented', ['cursorHooks']);
    }
  };

  const claudeHooks = (path: string, artifact: Artifact): void => {
    if (!CLAUDE_SETTINGS.has(local(path).toLowerCase())) return;
    const doc = view.json(artifact);
    if (!doc.ok) {
      // json/invalid-syntax reports it for Claude Code; Cursor's handling is not documented.
      incomplete.add(`unparsed:${path}`);
      return;
    }
    const evidence = ['cursorThirdPartyHooks', 'cursorHooks'];
    for (const handler of hookHandlers(doc, 'claude-code')) {
      const name = hookName(path, handler);
      if (Object.hasOwn(CURSOR_EVENT_FOR_CLAUDE, handler.event)) {
        hookEntry(path, artifact, name, 'documented', evidence);
      } else {
        // Notification and PermissionRequest are documented as unsupported; other events have
        // no documented mapping.
        const unsupported = CURSOR_UNSUPPORTED_CLAUDE_EVENTS.has(handler.event);
        skip('hook', path, 'not-read', unsupported ? 'documented' : 'unverified', evidence, {
          name,
        });
      }
    }
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
    // Other kinds belong to other agents.
    if (kind === 'agents-md' || kind === 'claude-md' || kind === 'cursor-legacy-rules') {
      instruction(path, artifact, kind, caseMismatch);
    } else if (kind === 'cursor-rule' || kind === 'cursor-rule-md') {
      rule(path, artifact, kind);
    } else if (kind === 'skill') {
      skill(path, artifact, caseMismatch);
    } else if (kind === 'cursor-mcp') {
      mcp(path, artifact);
    } else if (kind === 'cursor-hooks') {
      cursorHooks(path, artifact);
    } else if (kind === 'claude-settings') {
      claudeHooks(path, artifact);
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

  // ------------------------------------------------------------------------------------------
  // Files Cursor would read that agentcheckup did not
  // ------------------------------------------------------------------------------------------

  const wouldRead = (path: string, kind: ArtifactKind): boolean => {
    const where = local(path);
    const lower = where.toLowerCase();
    if (kind === 'agents-md') return true;
    if (kind === 'claude-md' || kind === 'cursor-legacy-rules') return dirnamePosix(where) === '';
    if (kind === 'cursor-rule') return rulesPlace(where) !== undefined;
    if (kind === 'cursor-mcp') return lower === '.cursor/mcp.json';
    if (kind === 'cursor-hooks') return lower === '.cursor/hooks.json';
    if (kind === 'claude-settings') return CLAUDE_SETTINGS.has(lower);
    if (kind !== 'skill') return false;
    const location = skillLocation(path);
    return location?.platforms.has('cursor') === true && inWorkspace(location.root);
  };

  const { snapshot } = view;
  const unread = new Set<string>(snapshot.ignoredFiles);
  for (const path of snapshot.paths) if (!path.endsWith('/')) unread.add(path);
  for (const entry of snapshot.skipped) unread.add(entry.path);
  for (const path of unread) {
    if (!inWorkspace(path) || view.index.has(path) || !isCandidateBasename(basename(path))) {
      continue;
    }
    const classification = classify(path);
    if (classification !== undefined && wouldRead(path, classification.kind)) {
      incomplete.add(`unread:${path}`);
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

  const startupOrder = entries
    .filter((entry) => entry.trigger === 'startup' && entry.size !== undefined)
    .sort(
      (a, b) =>
        Number(a.role !== 'instructions') - Number(b.role !== 'instructions') ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.id, b.id),
    );
  const positions = new Map(startupOrder.map((entry, index) => [entry.id, index + 1]));
  const placed = entries
    .map((entry) => {
      const position = positions.get(entry.id);
      return position === undefined ? entry : { ...entry, position };
    })
    .sort(compareEntries);

  const total = (sizes: readonly Size[]): Size =>
    sizeOf(
      sizes.reduce((sum, size) => sum + size.bytes, 0),
      sizes.reduce((sum, size) => sum + size.chars, 0),
    );
  const startupSizes = [
    ...startupOrder.flatMap((entry) => (entry.size === undefined ? [] : [entry.size])),
    ...listed,
  ];
  const onDemandSizes = [
    ...placed
      .filter((entry) => entry.trigger !== 'startup' && entry.role !== 'skill')
      .map((entry) => entry.size)
      .filter((size) => size !== undefined),
    ...deferred,
  ];

  return {
    agent: 'cursor',
    cwd,
    entries: placed,
    skipped: skipped.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id)),
    outOfScope: outOfScope.sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
    ),
    assumptions: ASSUMPTIONS,
    hidden: HIDDEN,
    limits: limits.sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    ),
    totals: { startup: total(startupSizes), onDemand: total(onDemandSizes) },
    incomplete: [...incomplete].sort(compareStrings),
  };
}
