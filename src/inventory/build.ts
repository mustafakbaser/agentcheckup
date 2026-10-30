/**
 * Builds the security inventory from a scan's analysis: every MCP server, hook, permission and
 * environment override the repository configures, in configuration files and in the frontmatter
 * of Claude Code skills, commands and subagents, whether or not an agent loads it today. Pure:
 * it reads only the snapshot and the parses the rules already made (docs/adr/0007, section 4 of
 * the design; docs/adr/0012 for frontmatter).
 *
 * Detection is shared with the rules, so the inventory and the findings agree: the MCP walker and
 * mcp/url-without-type's condition (src/platforms/mcp.ts), the hook walker and
 * hooks/fails-open's logic (src/platforms/hooks.ts), hooks/script-missing's script resolution
 * (src/platforms/hook-command.ts), risk/remote-script-execution's detector, broad-allowed-tools'
 * broad grants and settings/ignored-permission-mode's modes (src/platforms/permissions.ts).
 *
 * Credentials never enter the inventory. Commands and arguments are redacted (./redact.ts),
 * `env` and `headers` keep names only, endpoint values are cut to their URL origin, and every
 * digest is built from that redacted form alone (decision 10).
 */
import { compareStrings } from '../core/compare.js';
import { hash53 } from '../core/fingerprint.js';
import { dirnamePosix } from '../core/paths.js';
import { positionAt } from '../core/text.js';
import {
  type Artifact,
  type ArtifactKind,
  type PlatformId,
  type Span,
  TOML_KINDS,
} from '../core/types.js';
import {
  isObject,
  issueKind,
  isTable,
  type JsonObject,
  type JsonPath,
  keySpanOf,
  own,
  ownObject,
  type ParsedJson,
  spanOf,
  type SpannedDocument,
} from '../parse/json-access.js';
import { classify, READERS } from '../platforms/classify.js';
import { pathAs, readingsOf } from '../platforms/readings.js';
import { codexServerEnabled } from '../platforms/codex-config.js';
import {
  claudeFrontmatterConfig,
  type FrontmatterReading,
  frontmatterDocument,
  hasMergeKey,
} from '../platforms/frontmatter-config.js';
import { hookCommandSyntax, resolveScript, scriptCandidate } from '../platforms/hook-command.js';
import {
  gateFailsOpen,
  type HookPlatform,
  hookHandlers,
  type HookSource,
  hookSourceOf,
} from '../platforms/hooks.js';
import { clinePlace } from '../platforms/cline-rules.js';
import {
  canonicalJson,
  envInventoryId,
  hookCommandLine,
  hookCommandLines,
  hookInventoryIds,
  hookTarget,
  mcpInventoryIds,
  numberRepeats,
  permInventoryId,
} from '../platforms/inventory-ids.js';
import type { LoadView } from '../platforms/load/view.js';
import { isBundledSkill, pluginRootOf } from '../platforms/location.js';
import {
  bareMcpServers,
  codexMcpServers,
  isClaudeMcpConfig,
  MCP_KINDS,
  type McpServer,
  mcpServers,
  sdkOnly,
  subagentMcpServers,
  transportOf,
  urlWithoutType,
} from '../platforms/mcp.js';
import {
  inClaudeFolder,
  inPayloadFolder,
  joinPath,
  nearestGitRoot,
  projectRootOf,
} from '../platforms/paths.js';
import {
  broadGrant,
  IGNORED_MODES,
  splitToolRules,
  SUBAGENT_IGNORED_MODES,
  SUBAGENT_PERMISSION_MODES,
} from '../platforms/permissions.js';
import { placement, skillLocation } from '../platforms/skills.js';
import {
  PLUGIN_HOOKS_FILE,
  type SkillsDirPlugin,
  skillsDirPlugin,
  skillsDirPluginOf,
  unreadPluginFiles,
} from '../platforms/skills-dir-plugins.js';
import {
  claudeHooksOff,
  claudeProjectSettings,
  COPILOT_CLI_SETTINGS,
  copilotCliHooksOff,
  settingAt,
} from '../platforms/root-settings.js';
import { checkSubagent, type SubagentCheck } from '../platforms/subagents.js';
import { isLoopbackHost } from '../rules/mcp/insecure-transport.js';
import { findRemoteExecution } from '../rules/risk/remote-script.js';
import {
  COMMAND_SETTINGS,
  envClass,
  type EnvClass,
  ignoredInRepositorySettings,
} from './env-class.js';
import { packageSpec } from './package-spec.js';
import { redactArgs, redactCommand, redactShown, urlOrigin } from './redact.js';
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PackageSpec,
  PermissionItem,
} from './types.js';

/**
 * JSON kinds the inventory reads: those that declare MCP servers (src/platforms/mcp.ts) or hooks
 * (src/platforms/hooks.ts). A file of these kinds that fails to parse is `incomplete`. The TOML
 * kinds among the MCP kinds are read on their own (`#addCodexConfig`).
 */
const JSON_KINDS: ReadonlySet<ArtifactKind> = new Set([
  ...[...MCP_KINDS].filter((kind) => !TOML_KINDS.has(kind)),
  'claude-settings',
  'claude-plugin-hooks',
  'codex-hooks',
  'cursor-hooks',
  'copilot-hooks',
  'copilot-settings',
  'devin-hooks',
]);

/**
 * Kinds whose frontmatter Claude Code reads hooks, MCP servers or permissions from: skills and
 * commands (`allowed-tools`, `hooks`; a command accepts a skill's fields, SOURCES.claudeSkills)
 * and subagents (`hooks`, `mcpServers`, `permissionMode`, SOURCES.claudeSubagents).
 */
const FRONTMATTER_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'skill',
  'claude-command',
  'claude-agent',
]);

/** Hooks in frontmatter use the format of Claude Code's settings files (SOURCES.claudeHooks). */
const FRONTMATTER_HOOKS: HookSource = { platform: 'claude-code', root: 'hooks' };

/**
 * Hooks in a GitHub Copilot custom agent's frontmatter use Copilot's hook format, an event map of
 * hook items (SOURCES.copilotHooksReference, "Agent-scoped hooks").
 */
const COPILOT_AGENT_HOOKS: HookSource = { platform: 'copilot', root: 'hooks' };

/**
 * A plugin's `hooks/hooks.json` wraps its events in `hooks`, and so does the manifest, whose
 * `hooks` object is the event map itself (SOURCES.claudePlugins).
 */
const PLUGIN_HOOKS: HookSource = { platform: 'claude-code', root: 'hooks' };

/**
 * Where hooks apply: the agents that run them, the project root their commands name, a scope,
 * and whether the repository's settings leave them on ({@link HookItem.effective}; unless set,
 * as the file's settings say).
 */
interface HookPlacement {
  readonly platforms: readonly PlatformId[];
  /** The directory `$CLAUDE_PROJECT_DIR` names; undefined when it cannot be told. */
  readonly root: string | undefined;
  readonly scope?: HookItem['scope'];
  readonly effective?: boolean;
}

/** What each agent does with one MCP server ({@link McpServerItem.status}). */
type ServerStatus = (server: McpServer) => McpServerItem['status'];

/**
 * Builds the inventory. Every list is sorted by id, and every id is unique: a repeated id gets
 * an occurrence number (`:2`, `:3`) in document order, except permissions, where a repeated
 * value is the same grant and is listed once. Ids come from src/platforms/inventory-ids.ts, which
 * the loaders use too.
 */
export function buildInventory(view: LoadView): Inventory {
  const builder = new InventoryBuilder(view);
  for (const artifact of view.artifacts) builder.add(artifact);
  builder.addUnparsedConfigs();
  return builder.finish();
}

// ---------------------------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------------------------

function digestOf(fields: object): string {
  return hash53(canonicalJson(fields));
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function lineOf(artifact: Artifact, span: Span | undefined): number {
  return span === undefined ? 1 : positionAt(artifact.decoded, span.offset).line;
}

function sortedPlatforms(platforms: Iterable<PlatformId>): PlatformId[] {
  return [...new Set(platforms)].sort(compareStrings);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sortedKeys(value: unknown): string[] {
  return isObject(value) ? Object.keys(value).sort(compareStrings) : [];
}

/** `['mcpServers', 'github']` -> `mcpServers.github`. */
function pathKey(path: JsonPath): string {
  return path.map(String).join('.');
}

/**
 * Names of the environment variables a server gets: its `env` keys, and in Codex also the names
 * `env_vars` forwards, written as a string or as `{ name, source }` (SOURCES.codexMcp).
 */
function envKeysOf(artifact: Artifact, config: JsonObject): string[] {
  const names = new Set(sortedKeys(own(config, 'env')));
  if (artifact.kind === 'codex-config') {
    const forwarded = own(config, 'env_vars');
    if (Array.isArray(forwarded)) {
      for (const item of forwarded as unknown[]) {
        const name = isTable(item) ? own(item, 'name') : item;
        if (typeof name === 'string') names.add(name);
      }
    }
  }
  return [...names].sort(compareStrings);
}

/**
 * Names of the HTTP headers a server sends: `headers`, and in Codex `http_headers` and
 * `env_http_headers` (SOURCES.codexMcp).
 */
function headerKeysOf(artifact: Artifact, config: JsonObject): string[] {
  if (artifact.kind !== 'codex-config') return sortedKeys(own(config, 'headers'));
  const names = new Set([
    ...sortedKeys(own(config, 'http_headers')),
    ...sortedKeys(own(config, 'env_http_headers')),
  ]);
  return [...names].sort(compareStrings);
}

/** A remote server's URL: origin only, whether it uses TLS, whether it stays on the machine. */
function remoteUrl(value: string): McpServerItem['url'] {
  const text = value.trim();
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.host === '') return undefined;
  return {
    origin: urlOrigin(text).origin,
    tls: url.protocol === 'https:' || url.protocol === 'wss:',
    loopback: isLoopbackHost(url.hostname),
  };
}

/** The value an endpoint override shows: its URL origin, or nothing when it is not a URL. */
function endpointShown(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text.includes('://') || !URL.canParse(text) || new URL(text).host === '') return undefined;
  return urlOrigin(text).origin;
}

// ---------------------------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------------------------

interface Approvals {
  readonly enableAll?: boolean;
  readonly enabled: ReadonlySet<string>;
  readonly disabled: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

type Unsorted<T> = Omit<T, 'digest'> & { readonly digestFields: object };

class InventoryBuilder {
  readonly #view: LoadView;
  readonly #servers: Unsorted<McpServerItem>[] = [];
  readonly #hooks: Unsorted<HookItem>[] = [];
  readonly #permissions: Unsorted<PermissionItem>[] = [];
  readonly #env: Unsorted<EnvItem>[] = [];
  readonly #incomplete = new Set<string>();
  readonly #approvals = new Map<string, Approvals>();

  constructor(view: LoadView) {
    this.#view = view;
  }

  add(artifact: Artifact): void {
    this.#addFrontmatter(artifact);
    if (FRONTMATTER_KINDS.has(artifact.kind)) return;
    if (TOML_KINDS.has(artifact.kind)) {
      this.#addCodexConfig(artifact);
      return;
    }
    if (!JSON_KINDS.has(artifact.kind)) return;
    // A `hooks/hooks.json` in a skill folder without a plugin manifest is not configuration.
    const plugin =
      artifact.kind === 'claude-plugin-hooks'
        ? skillsDirPluginOf(this.#view.snapshot, artifact.path, PLUGIN_HOOKS_FILE)
        : undefined;
    if (artifact.kind === 'claude-plugin-hooks' && plugin === undefined) return;
    // `.vscode/mcp.json` is read as JSONC, as VS Code reads it (src/core/engine.ts).
    const doc = this.#view.json(artifact);
    if (!doc.ok) {
      this.#incomplete.add(`invalid-json:${artifact.path}`);
      return;
    }
    if (MCP_KINDS.has(artifact.kind)) this.#addServers(artifact, doc);
    if (artifact.kind === 'claude-plugin-hooks' || artifact.kind === 'claude-plugin-manifest') {
      this.#addPluginHooks(artifact, doc, plugin);
    }
    const hooks = hookSourceOf(artifact);
    if (hooks !== undefined) this.#addHooks(artifact, doc, hooks);
    // Cascade's legacy `.devin/hooks.json`: its format is not modeled, so its hooks are not listed.
    else if (artifact.kind === 'devin-hooks') this.#incomplete.add(artifact.path);
    if (artifact.kind === 'claude-settings') this.#addSettings(artifact, doc);
  }

  /**
   * Configuration files whose servers and hooks are not listed: the files in Cline's hook and
   * plugin folders (scripts and JavaScript modules in no documented format), and inventory files
   * the walk skipped (too large or unreadable).
   */
  addUnparsedConfigs(): void {
    const { snapshot } = this.#view;
    for (const path of snapshot.paths) {
      if (!path.endsWith('/') && isUnparsedConfig(path)) this.#incomplete.add(path);
    }
    for (const entry of snapshot.skipped) {
      const kind = classify(entry.path)?.kind;
      if (
        kind !== undefined &&
        (JSON_KINDS.has(kind) || TOML_KINDS.has(kind) || FRONTMATTER_KINDS.has(kind))
      ) {
        this.#incomplete.add(entry.path);
      }
    }
  }

  finish(): Inventory {
    return {
      mcpServers: finishItems(this.#servers, 'suffix'),
      hooks: finishItems(this.#hooks, 'suffix'),
      permissions: finishItems(this.#permissions, 'dedupe'),
      env: finishItems(this.#env, 'suffix'),
      incomplete: [...this.#incomplete].sort(compareStrings),
    };
  }

  // MCP --------------------------------------------------------------------------------------

  /**
   * The servers of an MCP config file. A `.mcp.json` written as bare server keys, without
   * `mcpServers`, is read by the Copilot CLI alone ({@link bareMcpServers}), so its servers list
   * Copilot as their only platform.
   */
  #addServers(artifact: Artifact, doc: ParsedJson): void {
    this.#addServerList(
      artifact,
      doc,
      mcpServers(artifact, doc),
      sortedPlatforms(artifact.readers),
      (server) => this.#statusOf(artifact, server),
    );
    const bare = bareMcpServers(artifact, doc);
    // When the Copilot CLI starts a project's servers is not documented here.
    if (bare.length > 0) this.#addServerList(artifact, doc, bare, ['copilot'], () => ({}));
  }

  #addServerList(
    artifact: Artifact,
    doc: SpannedDocument,
    servers: readonly McpServer[],
    platforms: readonly PlatformId[],
    statusOf: ServerStatus,
    scope?: McpServerItem['scope'],
  ): void {
    const ids = mcpInventoryIds(artifact.path, servers);
    servers.forEach((server, index) => {
      const { config, name } = server;
      const declaredType = stringOf(own(config, 'type'));
      const rawCommand = stringOf(own(config, 'command'));
      const rawArgs = own(config, 'args');
      const command = rawCommand === undefined ? undefined : redactCommand(rawCommand);
      const args = Array.isArray(rawArgs) ? redactArgs(stringsOf(rawArgs)) : undefined;
      const spec: PackageSpec | undefined =
        command === undefined
          ? undefined
          : packageSpec([...command.split(/\s+/).filter((word) => word !== ''), ...(args ?? [])]);
      const urlText =
        (artifact.kind === 'gemini-settings' ? stringOf(own(config, 'httpUrl')) : undefined) ??
        stringOf(own(config, 'url'));
      const url = urlText === undefined ? undefined : remoteUrl(urlText);
      const env = own(config, 'env');
      const fields = {
        name,
        transport: transportOf(artifact, config),
        ...(declaredType === undefined ? {} : { declaredType }),
        ...(command === undefined ? {} : { command }),
        ...(args === undefined ? {} : { args }),
        ...(spec === undefined ? {} : { package: spec }),
        ...(url === undefined ? {} : { url }),
        envKeys: envKeysOf(artifact, config),
        headerKeys: headerKeysOf(artifact, config),
        status: statusOf(server),
        ...(scope === undefined ? {} : { scope }),
      };
      this.#servers.push({
        id: ids[index] ?? '',
        file: artifact.path,
        line: lineOf(artifact, keySpanOf(doc, server.path)),
        platforms,
        ...fields,
        digestFields: fields,
      });

      if (isObject(env)) {
        for (const key of Object.keys(env)) {
          const value = stringOf(env[key]);
          const cls = envClass(key, value);
          if (cls === 'other') continue;
          const path = [...server.path, 'env', key];
          // A subagent lists its servers by position; its env keys use the server's name, so a
          // server added before another leaves the other's keys as they were.
          const named = scope === 'subagent' ? ['mcpServers', name, 'env', key] : path;
          this.#pushEnv(artifact, doc, pathKey(named), cls, value, path, { platforms });
        }
      }
      // Codex runs this command to get the server's HTTP headers (SOURCES.codexMcp).
      const helper = own(config, 'http_headers_helper');
      if (artifact.kind === 'codex-config' && typeof helper === 'string') {
        const path = [...server.path, 'http_headers_helper'];
        const command = redactCommand(helper);
        this.#pushEnv(artifact, doc, pathKey(path), 'code-exec', undefined, path, {
          command,
          platforms,
        });
      }
      const trust = own(config, 'trust');
      if (artifact.kind === 'gemini-settings' && typeof trust === 'boolean') {
        this.#pushPermission(artifact, {
          key: `${pathKey(server.path)}.trust`,
          value: String(trust),
          broad: false,
          effective: true,
          line: lineOf(artifact, keySpanOf(doc, [...server.path, 'trust'])),
          platforms,
        });
      }
    });
  }

  /**
   * What each agent that reads the file does with the server. Claude Code: a `url` without `type`
   * is skipped (mcp/url-without-type), and so is a `"type": "sdk"` server, which only an SDK host
   * application registers (SOURCES.claudeMcp); a project `.mcp.json` server asks first unless the
   * project's settings approve or reject it; a plugin's server starts once the user installs and
   * enables the plugin, which is that approval. A `.mcp.json` of another agent's plugin is not
   * Claude Code's. Cursor connects project servers and asks before each tool call; Gemini CLI
   * connects them unless folder trust is on and the folder is not trusted (off by default). Codex
   * starts a project's servers in a trusted project, unless `enabled = false` in this file.
   */
  #statusOf(artifact: Artifact, server: McpServer): McpServerItem['status'] {
    if (artifact.kind === 'cursor-mcp') return { cursor: 'loads' };
    if (artifact.kind === 'gemini-settings') return { gemini: 'loads' };
    if (artifact.kind === 'codex-config') {
      return { codex: codexServerEnabled(server.config) ? 'loads' : 'skipped' };
    }
    const { snapshot } = this.#view;
    if (!isClaudeMcpConfig(snapshot, artifact)) return {};
    if (urlWithoutType(server.config) || sdkOnly(server.config))
      return { 'claude-code': 'skipped' };
    if (
      artifact.kind === 'claude-plugin-manifest' ||
      pluginRootOf(snapshot, artifact.path) !== undefined
    ) {
      return { 'claude-code': 'needs-approval' };
    }
    const approvals = this.#approvalsAt(dirnamePosix(artifact.path));
    if (approvals.disabled.has(server.name)) return { 'claude-code': 'skipped' };
    if (approvals.enableAll === true || approvals.enabled.has(server.name)) {
      return { 'claude-code': 'loads' };
    }
    return { 'claude-code': 'needs-approval' };
  }

  /**
   * `.mcp.json` approvals from the project's `.claude/settings.json` and
   * `.claude/settings.local.json`, which take effect once the folder is trusted. The local file's
   * `enableAllProjectMcpServers` wins; a rejection in either file wins over any approval.
   */
  #approvalsAt(root: string): Approvals {
    const cached = this.#approvals.get(root);
    if (cached !== undefined) return cached;
    let enableAll: boolean | undefined;
    const enabled = new Set<string>();
    const disabled = new Set<string>();
    for (const name of ['settings.json', 'settings.local.json']) {
      const artifact = this.#view.index.get(joinPath(root, `.claude/${name}`));
      if (artifact?.kind !== 'claude-settings') continue;
      const doc = this.#view.json(artifact);
      if (!doc.ok || !isObject(doc.value)) continue;
      const all = own(doc.value, 'enableAllProjectMcpServers');
      if (typeof all === 'boolean') enableAll = all;
      for (const item of stringsOf(own(doc.value, 'enabledMcpjsonServers'))) enabled.add(item);
      for (const item of stringsOf(own(doc.value, 'disabledMcpjsonServers'))) disabled.add(item);
    }
    const approvals: Approvals = {
      ...(enableAll === undefined ? {} : { enableAll }),
      enabled,
      disabled,
    };
    this.#approvals.set(root, approvals);
    return approvals;
  }

  // Hooks ------------------------------------------------------------------------------------

  #addHooks(
    artifact: Artifact,
    doc: SpannedDocument,
    source: HookSource,
    where: HookPlacement = {
      platforms: sortedPlatforms(artifact.readers),
      root: projectRootOf(artifact),
    },
  ): void {
    const { platform } = source;
    const { platforms, root, scope, effective = this.#hooksOn(artifact, doc) } = where;
    const syntax = hookCommandSyntax(this.#view.snapshot, platform, root ?? '');
    const hooks = hookHandlers(doc, platform, { includeUnknown: true, root: source.root });
    const ids = hookInventoryIds(artifact.path, hooks, platform);
    hooks.forEach((hook, index) => {
      const { handler, type } = hook;
      const rawCommands = rawCommandsOf(handler, platform);
      // Claude Code's exec form joins `command` and `args`; a Copilot hook shows its first
      // command field, and its digest covers all of them.
      const command = hookCommandLine(handler, platform);
      const target = command === undefined ? hookTarget(handler) : undefined;
      const variants = platform === 'copilot' ? hookCommandLines(handler, platform) : [];
      const matcher = stringOf(own(hook.group, 'matcher'));
      const script =
        root === undefined ? undefined : scriptOf(handler, hook.path, type, platform, root, syntax);
      const fields = {
        event: hook.event,
        known: hook.known,
        ...(matcher === undefined ? {} : { matcher }),
        ...(type === undefined ? {} : { type }),
        ...(command === undefined ? {} : { command }),
        ...(script === undefined ? {} : { script }),
        failsOpen: hook.known && gateFailsOpen(platform, hook),
        remoteScript: rawCommands.some(
          (raw) => findRemoteExecution(raw, 0, raw.length) !== undefined,
        ),
        ...(scope === undefined ? {} : { scope }),
      };
      this.#hooks.push({
        id: ids[index] ?? '',
        file: artifact.path,
        line: lineOf(artifact, spanOf(doc, [...hook.path, 'command']) ?? keySpanOf(doc, hook.path)),
        platforms,
        ...fields,
        effective,
        // Only a hook that is off has `effective` in its digest, so the others keep theirs.
        digestFields: {
          ...fields,
          ...(target === undefined ? {} : { target }),
          ...(variants.length > 1 ? { commands: variants } : {}),
          ...(effective ? {} : { effective }),
        },
      });
    });
  }

  /**
   * The hooks of a Claude Code plugin: those of `hooks/hooks.json` in a plugin of a skills folder,
   * and the inline `hooks` object of any manifest. Claude Code runs them once the plugin is on;
   * `$CLAUDE_PROJECT_DIR` names the directory that holds the skills folder. Inline hooks in a list
   * are not analyzed, nor are the files a manifest names ({@link #addPluginFiles}), so the
   * manifest is incomplete.
   */
  #addPluginHooks(
    artifact: Artifact,
    doc: SpannedDocument,
    plugin: SkillsDirPlugin | undefined,
  ): void {
    const owner = plugin?.owner ?? skillsDirPlugin(artifact.path)?.owner;
    if (artifact.kind === 'claude-plugin-manifest') {
      this.#addPluginFiles(artifact, doc);
      const inline = isTable(doc.value) ? own(doc.value, 'hooks') : undefined;
      if (Array.isArray(inline) && inline.some(isTable)) this.#incomplete.add(artifact.path);
      if (!isTable(inline)) return;
    }
    this.#addHooks(artifact, doc, PLUGIN_HOOKS, {
      platforms: ['claude-code'],
      root: owner,
      // `disableAllHooks` in the session's settings turns plugin hooks off too.
      effective: owner === undefined || !claudeHooksOff(this.#view, owner),
    });
  }

  /**
   * Whether the repository's own settings leave the hooks of a hook or settings file on, for the
   * agent whose hook configuration it is:
   * - Claude Code: `disableAllHooks: true` in the settings that a session started where the file
   *   is reads ({@link claudeHooksOff}) turns off its project and local hooks;
   * - Copilot CLI: `disableAllHooks: true` in its repository settings, or in Claude Code's, skips
   *   every hook, and only the CLI runs the inline hooks of its settings files
   *   ({@link copilotCliHooksOff});
   * - Copilot: `disableAllHooks: true` at the top of a `.github/hooks/*.json` file skips "only the
   *   hooks declared in that file" on the CLI and the cloud agent (SOURCES.copilotHooksReference).
   *   The cloud agent does not read the CLI's settings, so those leave such a file's hooks on.
   */
  #hooksOn(artifact: Artifact, doc: SpannedDocument): boolean {
    if (artifact.kind === 'claude-settings') {
      return !claudeHooksOff(this.#view, projectRootOf(artifact));
    }
    if (artifact.kind === 'copilot-hooks') return settingAt(doc, ['disableAllHooks']) !== true;
    if (artifact.kind !== 'copilot-settings') return true;
    // `<root>/.github/copilot/settings.json`
    const root = dirnamePosix(projectRootOf(artifact));
    const settings = COPILOT_CLI_SETTINGS.flatMap((name) => {
      const file = this.#view.index.get(joinPath(root, name));
      if (file?.kind !== 'copilot-settings') return [];
      const parsed = this.#view.json(file);
      return parsed.ok ? [parsed] : [];
    });
    return copilotCliHooksOff(settings, claudeProjectSettings(this.#view, root)) === undefined;
  }

  /**
   * The files a skills-folder plugin's manifest names in `hooks` and `mcpServers`, such as
   * `"hooks": "./config/hooks.json"`: Claude Code loads their hooks and servers with the plugin's
   * own `hooks/hooks.json` and `.mcp.json` (SOURCES.claudePlugins). The inventory does not read
   * them, so the manifest is incomplete, and both gates fail closed on it.
   */
  #addPluginFiles(artifact: Artifact, doc: SpannedDocument): void {
    const plugin = skillsDirPlugin(artifact.path);
    if (plugin === undefined) return;
    const { snapshot } = this.#view;
    const unread = (['hooks', 'mcpServers'] as const).some(
      (key) => unreadPluginFiles(snapshot, doc, key, plugin.folder).length > 0,
    );
    if (unread) this.#incomplete.add(artifact.path);
  }

  // Codex config.toml -------------------------------------------------------------------------

  /**
   * A `.codex/config.toml`: its MCP servers, inline hooks, permission settings and environment
   * overrides. A file that is not valid TOML is `invalid-toml:<path>`; one agentcheckup's parser
   * does not read (a limit, UTF-16 text) is incomplete.
   */
  #addCodexConfig(artifact: Artifact): void {
    const doc = this.#view.toml(artifact);
    if (!doc.ok) {
      const issue = doc.errors[0];
      const kind = issue === undefined ? 'limit' : issueKind(issue);
      this.#incomplete.add(
        kind === 'limit' || kind === 'unsupported'
          ? artifact.path
          : `invalid-toml:${artifact.path}`,
      );
      return;
    }
    this.#addServers(artifact, doc);
    const hooks = hookSourceOf(artifact);
    if (hooks !== undefined) this.#addHooks(artifact, doc, hooks);
    this.#addCodexSettings(artifact, doc);
  }

  /**
   * Codex settings that let it act without asking, as the Codex configuration reference
   * describes them (SOURCES.codexConfigReference, SOURCES.codexMcp): `approval_policy = "never"`,
   * `sandbox_mode = "danger-full-access"`, network access and extra writable roots in the
   * workspace-write sandbox, and MCP tool approval modes other than `prompt`. Values that only
   * restrict Codex are not listed. `shell_environment_policy.set` entries are environment
   * overrides for every command Codex runs.
   */
  #addCodexSettings(artifact: Artifact, doc: ParsedJson): void {
    const root = doc.value;
    if (!isTable(root)) return;
    const platforms = sortedPlatforms(artifact.readers);
    const permission = (key: string, value: string, path: JsonPath, broad: boolean): void => {
      this.#pushPermission(artifact, {
        key,
        value,
        broad,
        effective: true,
        line: lineOf(artifact, spanOf(doc, path)),
        platforms,
      });
    };

    if (own(root, 'approval_policy') === 'never') {
      permission('approval_policy', 'never', ['approval_policy'], true);
    }
    if (own(root, 'sandbox_mode') === 'danger-full-access') {
      permission('sandbox_mode', 'danger-full-access', ['sandbox_mode'], true);
    }
    const sandbox = own(root, 'sandbox_workspace_write');
    if (isTable(sandbox)) {
      const key = 'sandbox_workspace_write';
      if (own(sandbox, 'network_access') === true) {
        permission(`${key}.network_access`, 'true', [key, 'network_access'], false);
      }
      const roots = own(sandbox, 'writable_roots');
      if (Array.isArray(roots)) {
        roots.forEach((path: unknown, index) => {
          if (typeof path !== 'string') return;
          const at = [key, 'writable_roots', index];
          permission(`${key}.writable_roots`, path, at, isRootOrHome(path));
        });
      }
    }
    for (const server of codexMcpServers(doc)) {
      const modes: { readonly path: JsonPath; readonly value: unknown }[] = [
        {
          path: [...server.path, 'default_tools_approval_mode'],
          value: own(server.config, 'default_tools_approval_mode'),
        },
      ];
      const tools = own(server.config, 'tools');
      if (isTable(tools)) {
        for (const tool of Object.keys(tools)) {
          const config = tools[tool];
          if (!isTable(config)) continue;
          const path = [...server.path, 'tools', tool, 'approval_mode'];
          modes.push({ path, value: own(config, 'approval_mode') });
        }
      }
      for (const { path, value } of modes) {
        // `prompt` asks before every call; `approve` approves every call.
        if (typeof value !== 'string' || value === 'prompt') continue;
        permission(pathKey(path), value, path, value === 'approve');
      }
    }

    const policy = own(root, 'shell_environment_policy');
    const set = isTable(policy) ? own(policy, 'set') : undefined;
    if (isTable(set)) {
      for (const key of Object.keys(set)) {
        const value = stringOf(set[key]);
        const path = ['shell_environment_policy', 'set', key];
        this.#pushEnv(artifact, doc, pathKey(path), envClass(key, value), value, path);
      }
    }
  }

  // Claude Code settings ----------------------------------------------------------------------

  #addSettings(artifact: Artifact, doc: ParsedJson): void {
    const root = doc.value;
    if (!isObject(root)) return;
    const platforms = sortedPlatforms(artifact.readers);
    const permission = (
      key: string,
      value: string,
      path: JsonPath,
      broad: boolean,
      effective: boolean,
    ): void => {
      this.#pushPermission(artifact, {
        key,
        value,
        broad,
        effective,
        line: lineOf(artifact, spanOf(doc, path)),
        platforms,
      });
    };

    const permissions = ownObject(root, 'permissions');
    if (permissions !== undefined) {
      for (const list of ['allow', 'ask', 'deny']) {
        const values = own(permissions, list);
        if (!Array.isArray(values)) continue;
        values.forEach((value: unknown, index) => {
          if (typeof value !== 'string') return;
          const broad = broadGrant(value)?.platform === 'claude-code';
          permission(`permissions.${list}`, value, ['permissions', list, index], broad, true);
        });
      }
      const mode = own(permissions, 'defaultMode');
      if (typeof mode === 'string') {
        // Claude Code ignores these two modes in project and local settings
        // (settings/ignored-permission-mode); bypassPermissions runs everything without asking.
        permission(
          'permissions.defaultMode',
          mode,
          ['permissions', 'defaultMode'],
          mode === 'bypassPermissions',
          !IGNORED_MODES.has(mode),
        );
      }
      const directories = own(permissions, 'additionalDirectories');
      if (Array.isArray(directories)) {
        directories.forEach((directory: unknown, index) => {
          if (typeof directory !== 'string') return;
          permission(
            'permissions.additionalDirectories',
            directory,
            ['permissions', 'additionalDirectories', index],
            isRootOrHome(directory),
            true,
          );
        });
      }
    }

    // Every session starts as this subagent, with its prompt, tools and model, and runs its
    // frontmatter hooks and inline MCP servers (SOURCES.claudeSubagents; "Any file" may set it).
    const agent = own(root, 'agent');
    if (typeof agent === 'string') permission('agent', agent, ['agent'], false, true);

    const enableAll = own(root, 'enableAllProjectMcpServers');
    if (typeof enableAll === 'boolean') {
      permission(
        'enableAllProjectMcpServers',
        String(enableAll),
        ['enableAllProjectMcpServers'],
        false,
        true,
      );
    }
    const enabled = own(root, 'enabledMcpjsonServers');
    if (Array.isArray(enabled)) {
      enabled.forEach((name: unknown, index) => {
        if (typeof name !== 'string') return;
        permission('enabledMcpjsonServers', name, ['enabledMcpjsonServers', index], false, true);
      });
    }

    const env = ownObject(root, 'env');
    if (env !== undefined) {
      for (const key of Object.keys(env)) {
        const value = stringOf(env[key]);
        // Claude Code drops some variables from project and local settings.
        const effective = !ignoredInRepositorySettings(key, value);
        this.#pushEnv(artifact, doc, key, envClass(key, value), value, ['env', key], {
          effective,
        });
      }
    }
    for (const key of COMMAND_SETTINGS) {
      const value = own(root, key);
      const command = isObject(value) ? stringOf(own(value, 'command')) : stringOf(value);
      if (command === undefined) continue;
      this.#pushEnv(artifact, doc, key, 'code-exec', undefined, [key], {
        command: redactCommand(command),
      });
    }
  }

  // Frontmatter ------------------------------------------------------------------------------

  /**
   * The hooks, MCP servers and permissions in the frontmatter of a skill, command or subagent:
   * every block Claude Code may read (src/platforms/frontmatter-config.ts), each item once. A file
   * Claude Code reaches through a symlink in an agent folder is read as what it is there. A block
   * agentcheckup cannot read may declare any of them, so its file is incomplete.
   */
  #addFrontmatter(artifact: Artifact): void {
    this.#addCopilotAgent(artifact);
    const kinds = frontmatterKinds(artifact);
    const [first] = kinds;
    if (first === undefined) return;
    const config = claudeFrontmatterConfig(artifact.decoded.text, this.#view.frontmatter(artifact));
    // At the path that makes it a skill, command or subagent, so the gate knows what it is.
    if (config.unreadable) this.#incomplete.add(first.path);
    if (config.readings.length === 0) return;
    const before = this.#counts();
    for (const { kind, path } of kinds) {
      // Items carry the path the agent reads the file at, a symlink's when one leads there.
      const at = path === artifact.path ? artifact : { ...artifact, path };
      if (kind === 'claude-agent') this.#addSubagent(at, path, config.readings);
      else this.#addSkill(at, kind, path, config.readings);
    }
    this.#dropRepeats(before);
  }

  /**
   * A GitHub Copilot custom agent. The `hooks` event map of its frontmatter runs "only while that
   * agent is selected", "in addition to session, user, repository, plugin, and policy hooks", on
   * the CLI (SOURCES.copilotHooksReference, "Agent-scoped hooks") and in VS Code
   * (SOURCES.vscodeCustomAgentFile): listed with the subagent scope, its commands resolved from
   * the repository root. A `hooks` value that is not an event map may hold hooks agentcheckup
   * cannot read, and the inventory does not list the MCP servers of `mcp-servers` yet
   * (SOURCES.copilotCustomAgents, SOURCES.copilotCliAgents): either makes its file incomplete,
   * so the gate and a policy fail closed. So does frontmatter agentcheckup cannot read, as for a
   * Claude Code subagent: a block that does not parse or is past a parser limit, which Copilot's
   * reader may still read (src/agents lists the agent as `unknown`), and a `<<` merge key, which
   * it may merge into `hooks`.
   */
  #addCopilotAgent(artifact: Artifact): void {
    const path = pathAs(artifact, 'copilot-agent');
    if (path === undefined) return;
    const frontmatter = this.#view.frontmatter(artifact);
    if (frontmatter.kind === 'absent') return;
    if (frontmatter.kind !== 'valid') {
      this.#incomplete.add(path);
      return;
    }
    const { values } = frontmatter.data;
    if (Object.hasOwn(values, 'mcp-servers') || hasMergeKey(values)) this.#incomplete.add(path);
    if (!Object.hasOwn(values, 'hooks')) return;
    if (!isTable(values['hooks'])) {
      this.#incomplete.add(path);
      return;
    }
    const at = path === artifact.path ? artifact : { ...artifact, path };
    this.#addHooks(at, frontmatterDocument(frontmatter.data), COPILOT_AGENT_HOOKS, {
      platforms: ['copilot'],
      root: nearestGitRoot(this.#view.snapshot, dirnamePosix(path)) ?? '',
      scope: 'subagent',
    });
  }

  /**
   * A skill's or command's `allowed-tools` and `hooks`. Claude Code applies both to skills and
   * commands; GitHub Copilot applies a skill's `allowed-tools` (skill/broad-allowed-tools), and the
   * Copilot CLI a command's, which it reads as a skill (SOURCES.copilotCliReference). Hooks
   * are registered when the skill or command is invoked and run for the rest of the session
   * (SOURCES.claudeHooks, "Hooks in skills and agents"). Neither takes effect for a skill bundled
   * inside another skill, or for a file in a payload folder of another directory's agent folder,
   * which the loaders leave out ({@link loadableFrom}).
   */
  #addSkill(
    artifact: Artifact,
    kind: 'skill' | 'claude-command',
    path: string,
    readings: readonly FrontmatterReading[],
  ): void {
    const command = kind === 'claude-command';
    const reach: ReadonlySet<PlatformId> = command
      ? new Set(READERS['claude-command'])
      : placement(this.#view, artifact).reach;
    const owner = command
      ? inClaudeFolder(path, 'commands')?.owner
      : skillOwner(path, artifact.caseMismatch !== undefined);
    const loadable =
      loadableFrom(path, owner) && (command || !isBundledSkill(this.#view.snapshot, path));
    for (const { doc } of readings) {
      this.#addAllowedTools(artifact, doc, reach, loadable);
      this.#addHooks(artifact, doc, FRONTMATTER_HOOKS, {
        platforms: loadable && reach.has('claude-code') ? ['claude-code'] : [],
        root: owner,
        scope: 'skill',
      });
    }
  }

  /**
   * `allowed-tools`, one permission per tool rule. A rule takes effect where an agent that
   * applies it loads the file: Claude Code or GitHub Copilot for a rule of no particular agent,
   * the agent a broad grant names otherwise.
   */
  #addAllowedTools(
    artifact: Artifact,
    doc: SpannedDocument,
    reach: ReadonlySet<PlatformId>,
    loadable: boolean,
  ): void {
    const values = doc.value;
    if (!isTable(values) || !Object.hasOwn(values, 'allowed-tools')) return;
    const value = values['allowed-tools'];
    const entries = typeof value === 'string' ? [value] : stringsOf(value);
    if (entries.length === 0) return;
    const line = lineOf(artifact, keySpanOf(doc, ['allowed-tools']));
    const platforms = sortedPlatforms(reach);
    for (const rule of entries.flatMap(splitToolRules)) {
      const grant = broadGrant(rule);
      const effective =
        loadable &&
        (grant === undefined
          ? reach.has('claude-code') || reach.has('copilot')
          : reach.has(grant.platform));
      this.#pushPermission(artifact, {
        key: 'allowed-tools',
        value: rule,
        broad: grant !== undefined,
        effective,
        line,
        platforms,
      });
    }
  }

  /**
   * A subagent's `hooks`, inline `mcpServers` and `permissionMode` (SOURCES.claudeSubagents). Its
   * hooks run and its servers connect only while it runs. Whether Claude Code loads the file
   * decides what takes effect ({@link subagentLoading}): a skipped file runs none of its hooks,
   * starts none of its servers and applies no mode. Claude Code drops a mode it does not know, and
   * `bypassPermissions` never takes effect on its own (SUBAGENT_IGNORED_MODES).
   */
  #addSubagent(artifact: Artifact, path: string, readings: readonly FrontmatterReading[]): void {
    const loading = subagentLoading(artifact.decoded.text, readings);
    const runs = loading === 'loads' || loading === 'unknown';
    const platforms: readonly PlatformId[] = ['claude-code'];
    for (const { doc } of readings) {
      this.#addHooks(artifact, doc, FRONTMATTER_HOOKS, {
        platforms: runs ? platforms : [],
        root: inClaudeFolder(path, 'agents')?.owner,
        scope: 'subagent',
      });

      const { servers, documented } = subagentMcpServers(doc);
      const status: ServerStatus = (server) => {
        if (!documented || loading === 'unknown') return {};
        if (!runs) return { 'claude-code': 'skipped' };
        // Inline servers use the format of `.mcp.json` (mcp/url-without-type).
        return { 'claude-code': urlWithoutType(server.config) ? 'skipped' : 'loads' };
      };
      this.#addServerList(artifact, doc, servers, platforms, status, 'subagent');

      const values = doc.value;
      const mode = isTable(values) ? own(values, 'permissionMode') : undefined;
      if (typeof mode === 'string') {
        this.#pushPermission(artifact, {
          key: 'permissionMode',
          value: mode,
          broad: mode === 'bypassPermissions',
          effective:
            runs && SUBAGENT_PERMISSION_MODES.has(mode) && !SUBAGENT_IGNORED_MODES.has(mode),
          line: lineOf(artifact, spanOf(doc, ['permissionMode'])),
          platforms,
        });
      }
    }
  }

  /** How many items each list holds, to tell the items one file adds from the ones before. */
  #counts(): readonly number[] {
    return [this.#servers, this.#hooks, this.#permissions, this.#env].map((list) => list.length);
  }

  /**
   * Leaves one of each item that two readings of the same file both list: the same id and the
   * same digest fields. Items that differ between the readings stay, numbered as repeats.
   */
  #dropRepeats(before: readonly number[]): void {
    dropRepeats(this.#servers, before[0] ?? 0);
    dropRepeats(this.#hooks, before[1] ?? 0);
    dropRepeats(this.#permissions, before[2] ?? 0);
    dropRepeats(this.#env, before[3] ?? 0);
  }

  // Items ------------------------------------------------------------------------------------

  #pushPermission(artifact: Artifact, item: Omit<PermissionItem, 'id' | 'file' | 'digest'>): void {
    const value = redactShown(item.value);
    const fields = { key: item.key, value, broad: item.broad, effective: item.effective };
    this.#permissions.push({
      id: permInventoryId(artifact.path, item.key, value),
      file: artifact.path,
      line: item.line,
      platforms: item.platforms,
      ...fields,
      digestFields: fields,
    });
  }

  /**
   * An environment override. Its digest covers what the item shows: key, class, the URL origin of
   * an endpoint, and a `tls` switch value, so that NODE_TLS_REJECT_UNAUTHORIZED going from 1 to 0
   * is a changed item. Any other value may be a secret, so it is neither shown nor hashed
   * (decision 10): a changed NODE_OPTIONS value under the same key is not a changed item. A settings key that runs a
   * command passes `command`, its redacted command line, which the digest also covers, as it
   * covers a hook's command: a changed helper command is a changed item. An override the agent
   * drops is `effective: false`, which only such items' digests cover, so the digests of the
   * others stay as they were.
   */
  #pushEnv(
    artifact: Artifact,
    doc: SpannedDocument,
    key: string,
    cls: EnvClass,
    value: string | undefined,
    path: JsonPath,
    options: {
      readonly command?: string;
      readonly platforms?: readonly PlatformId[];
      readonly effective?: boolean;
    } = {},
  ): void {
    const { command, effective = true } = options;
    const platforms = options.platforms ?? sortedPlatforms(artifact.readers);
    const shown =
      cls === 'endpoint' ? endpointShown(value) : cls === 'tls' ? switchShown(value) : undefined;
    const fields = { key, class: cls, ...(shown === undefined ? {} : { shown }) };
    this.#env.push({
      id: envInventoryId(artifact.path, key),
      file: artifact.path,
      line: lineOf(artifact, keySpanOf(doc, path)),
      platforms,
      ...fields,
      effective,
      digestFields: { ...fields, command, ...(effective ? {} : { effective }) },
    });
  }
}

/**
 * The value of a `tls` override as reports show it, only when it is an on/off switch such as
 * NODE_TLS_REJECT_UNAUTHORIZED=0. Any other value may be a secret (decision 10) and stays hidden.
 */
function switchShown(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  return SWITCH_VALUES.has(text) ? text : undefined;
}

const SWITCH_VALUES: ReadonlySet<string> = new Set(['0', '1', 'true', 'false', 'yes', 'no']);

/**
 * A configuration file that can declare hooks the inventory cannot list: a file in Cline's hook
 * or plugin folders. Cheap tests first: every path of the scan passes through here.
 */
function isUnparsedConfig(path: string): boolean {
  if (!path.toLowerCase().includes('.cline')) return false;
  const role = clinePlace(path)?.role;
  return role === 'hook' || role === 'plugin';
}

/**
 * The raw strings a hook runs as commands, for the remote-script check: `command`, and for a
 * GitHub Copilot hook every command field (src/platforms/inventory-ids.ts).
 */
function rawCommandsOf(handler: JsonObject, platform: HookPlatform): string[] {
  const fields =
    platform === 'copilot'
      ? ['bash', 'command', 'powershell', 'linux', 'osx', 'windows', 'exec']
      : ['command'];
  return fields.flatMap((field) => {
    const value = own(handler, field);
    return typeof value === 'string' ? [value] : [];
  });
}

/** Removes, from `start` on, each item whose id and digest fields an earlier one has. */
function dropRepeats(list: Identified[], start: number): void {
  const seen = new Set<string>();
  const kept = list.slice(start).filter((item) => {
    const key = `${item.id}\u0000${canonicalJson(item.digestFields)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  list.splice(start, list.length - start, ...kept);
}

/** A kind whose frontmatter Claude Code reads hooks, MCP servers or permissions from. */
type FrontmatterKind = 'skill' | 'claude-command' | 'claude-agent';

function isFrontmatterKind(kind: ArtifactKind | undefined): kind is FrontmatterKind {
  return kind !== undefined && FRONTMATTER_KINDS.has(kind);
}

/**
 * What `artifact` is to Claude Code, each kind with the path that makes it one: its own kind, and
 * the kind of each symlink that points at it. A symlink in `.claude/agents/` to an `AGENTS.md` is
 * folded into the `AGENTS.md` artifact (src/core/engine.ts), but Claude Code follows it and reads
 * a subagent.
 */
function frontmatterKinds(
  artifact: Artifact,
): { readonly kind: FrontmatterKind; readonly path: string }[] {
  return readingsOf(artifact).flatMap(({ kind, path }) =>
    isFrontmatterKind(kind) ? [{ kind, path }] : [],
  );
}

/**
 * The directory that owns the skills folder `path` is in: `a/.claude/skills/x/SKILL.md` -> `a`.
 * Undefined outside a known skills folder, such as in a plugin.
 */
function skillOwner(path: string, caseMismatch: boolean): string | undefined {
  const root = skillLocation(path, caseMismatch)?.root;
  return root === undefined ? undefined : dirnamePosix(dirnamePosix(root));
}

/**
 * False for a file the loaders leave out when they plan from the repository root: one in a
 * template, example or fixture folder that does not belong to the root's own agent folders
 * (`scope !== 'path' && inPayloadFolder(path)` in src/platforms/load/claude-code.ts). Files of
 * the root's agent folders load whatever their folders are called, such as
 * `.claude/commands/templates/new.md`.
 */
function loadableFrom(path: string, owner: string | undefined): boolean {
  return owner === '' || !inPayloadFolder(path);
}

const LOADING_RANK: Readonly<Record<SubagentCheck['status'], number>> = {
  documentation: 0,
  skipped: 1,
  unknown: 2,
  loads: 3,
};

/**
 * Whether Claude Code loads a subagent, from the readings of its frontmatter: `loads` when the
 * documented reading loads, `unknown` when only a reading the documentation does not describe
 * does (Claude Code's retry, or the block its own reader finds), else what the documented check
 * says.
 */
function subagentLoading(
  text: string,
  readings: readonly FrontmatterReading[],
): SubagentCheck['status'] {
  let loading: SubagentCheck['status'] = 'documentation';
  for (const reading of readings) {
    const status = checkSubagent(text, reading.parse).status;
    const seen = status === 'loads' && !reading.documented ? 'unknown' : status;
    if (LOADING_RANK[seen] > LOADING_RANK[loading]) loading = seen;
  }
  return loading;
}

/** `/`, `~` and `~/`: a working directory that reaches every file of the machine or the user. */
function isRootOrHome(directory: string): boolean {
  const text = directory.trim();
  return text === '/' || text === '//' || text === '~' || text === '~/';
}

/**
 * The repository script a command hook runs, resolved as hooks/script-missing resolves it. A
 * relative path counts only in Cursor, which runs project hooks from the project root; Claude
 * Code runs them in the session's working directory, so the file it means is not certain.
 */
function scriptOf(
  handler: JsonObject,
  path: JsonPath,
  type: string | undefined,
  platform: HookPlatform,
  root: string,
  syntax: ReturnType<typeof hookCommandSyntax>,
): string | undefined {
  if (type !== 'command' || platform === 'gemini') return undefined;
  const candidate = scriptCandidate(handler, path, syntax);
  if (candidate === undefined) return undefined;
  const resolved = resolveScript(candidate.word, platform, root);
  if (resolved === undefined || (resolved.plain && platform !== 'cursor')) return undefined;
  return resolved.path;
}

interface Identified {
  readonly id: string;
  readonly digestFields: object;
}

/**
 * Sorted items with unique ids and their digests. `suffix` numbers repeated ids in document
 * order ({@link numberRepeats}); `dedupe` keeps the first item with an id.
 *
 * MCP server and hook ids arrive numbered per file, as the loaders number them, so `suffix`
 * changes one of them only when ids of two files collide, which takes a `#` in a path.
 */
function finishItems<T extends Identified>(
  items: readonly T[],
  repeats: 'suffix' | 'dedupe',
): (Omit<T, 'digestFields'> & { readonly digest: string })[] {
  const out: (Omit<T, 'digestFields'> & { readonly digest: string })[] = [];
  const ids = repeats === 'suffix' ? numberRepeats(items.map((item) => item.id)) : undefined;
  const used = new Set<string>();
  items.forEach((item, index) => {
    const id = ids === undefined ? item.id : (ids[index] ?? item.id);
    if (used.has(id)) return;
    used.add(id);
    const { digestFields, ...rest } = item;
    out.push({ ...rest, id, digest: digestOf(digestFields) });
  });
  return out.sort((a, b) => compareStrings(a.id, b.id));
}
