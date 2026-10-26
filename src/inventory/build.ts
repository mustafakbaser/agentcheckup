/**
 * Builds the security inventory from a scan's analysis: every MCP server, hook, permission and
 * environment override the repository configures, whether or not an agent loads it today. Pure:
 * it reads only the snapshot and the parses the rules already made (docs/adr/0007, section 4 of
 * the design).
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
} from '../parse/json-access.js';
import { classify } from '../platforms/classify.js';
import { codexServerEnabled } from '../platforms/codex-config.js';
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
  transportOf,
  urlWithoutType,
} from '../platforms/mcp.js';
import { inPayloadFolder, joinPath, projectRootOf } from '../platforms/paths.js';
import { broadGrant, IGNORED_MODES, splitToolRules } from '../platforms/permissions.js';
import { placement } from '../platforms/skills.js';
import { isLoopbackHost } from '../rules/mcp/insecure-transport.js';
import { findSecret } from '../rules/mcp/secrets.js';
import { findRemoteExecution } from '../rules/risk/remote-script.js';
import { COMMAND_SETTINGS, envClass, type EnvClass } from './env-class.js';
import { packageSpec } from './package-spec.js';
import { REDACTED, redactArgs, redactCommand, redactPermission, urlOrigin } from './redact.js';
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
  'codex-hooks',
  'cursor-hooks',
  'copilot-hooks',
  'copilot-settings',
  'devin-hooks',
]);

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

/** At most this many vendor tokens are masked in one permission value. */
const MAX_MASKED = 64;

/**
 * A permission value with credentials of a known vendor format masked where they stand, so the
 * words around them stay readable; {@link redactPermission} then removes the rest.
 */
function maskTokens(text: string): string {
  let out = text;
  for (let round = 0; round < MAX_MASKED; round++) {
    const secret = findSecret(out);
    if (secret === undefined) break;
    out = `${out.slice(0, secret.start)}${REDACTED}${out.slice(secret.start + secret.length)}`;
  }
  return out;
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
    if (artifact.kind === 'skill') {
      this.#addSkill(artifact);
      return;
    }
    if (TOML_KINDS.has(artifact.kind)) {
      this.#addCodexConfig(artifact);
      return;
    }
    if (!JSON_KINDS.has(artifact.kind)) return;
    // `.vscode/mcp.json` is read as JSONC, as VS Code reads it (src/core/engine.ts).
    const doc = this.#view.json(artifact);
    if (!doc.ok) {
      this.#incomplete.add(`invalid-json:${artifact.path}`);
      return;
    }
    if (MCP_KINDS.has(artifact.kind)) this.#addServers(artifact, doc);
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
        (JSON_KINDS.has(kind) || TOML_KINDS.has(kind) || kind === 'skill')
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
    );
    const bare = bareMcpServers(artifact, doc);
    if (bare.length > 0) this.#addServerList(artifact, doc, bare, ['copilot'], true);
  }

  #addServerList(
    artifact: Artifact,
    doc: ParsedJson,
    servers: readonly McpServer[],
    platforms: readonly PlatformId[],
    bare = false,
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
        // When the Copilot CLI starts a project's servers is not documented here.
        status: bare ? {} : this.#statusOf(artifact, server),
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
          this.#pushEnv(artifact, doc, pathKey(path), cls, value, path, undefined, platforms);
        }
      }
      // Codex runs this command to get the server's HTTP headers (SOURCES.codexMcp).
      const helper = own(config, 'http_headers_helper');
      if (artifact.kind === 'codex-config' && typeof helper === 'string') {
        const path = [...server.path, 'http_headers_helper'];
        const command = redactCommand(helper);
        this.#pushEnv(
          artifact,
          doc,
          pathKey(path),
          'code-exec',
          undefined,
          path,
          command,
          platforms,
        );
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
   * is skipped (mcp/url-without-type); a project `.mcp.json` server asks first unless the
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
    if (urlWithoutType(server.config)) return { 'claude-code': 'skipped' };
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

  #addHooks(artifact: Artifact, doc: ParsedJson, source: HookSource): void {
    const { platform } = source;
    const platforms = sortedPlatforms(artifact.readers);
    const root = projectRootOf(artifact);
    const syntax = hookCommandSyntax(this.#view.snapshot, platform, root);
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
      const script = scriptOf(handler, hook.path, type, platform, root, syntax);
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
      };
      this.#hooks.push({
        id: ids[index] ?? '',
        file: artifact.path,
        line: lineOf(artifact, spanOf(doc, [...hook.path, 'command']) ?? keySpanOf(doc, hook.path)),
        platforms,
        ...fields,
        digestFields: {
          ...fields,
          ...(target === undefined ? {} : { target }),
          ...(variants.length > 1 ? { commands: variants } : {}),
        },
      });
    });
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
        this.#pushEnv(artifact, doc, key, envClass(key, value), value, ['env', key]);
      }
    }
    for (const key of COMMAND_SETTINGS) {
      const value = own(root, key);
      const command = isObject(value) ? stringOf(own(value, 'command')) : stringOf(value);
      if (command === undefined) continue;
      this.#pushEnv(artifact, doc, key, 'code-exec', undefined, [key], redactCommand(command));
    }
  }

  // Skills -----------------------------------------------------------------------------------

  /**
   * A skill's `allowed-tools`, one permission per tool rule. Claude Code and GitHub Copilot apply
   * the field (skill/broad-allowed-tools); it takes effect where one of them loads the skill.
   */
  #addSkill(artifact: Artifact): void {
    const frontmatter = this.#view.frontmatter(artifact);
    if (frontmatter.kind !== 'valid') return;
    const { values } = frontmatter.data;
    if (!Object.hasOwn(values, 'allowed-tools')) return;
    const value = values['allowed-tools'];
    const entries = typeof value === 'string' ? [value] : stringsOf(value);
    if (entries.length === 0) return;
    const { snapshot } = this.#view;
    const reach = placement(this.#view, artifact).reach;
    const loadable = !isBundledSkill(snapshot, artifact.path) && !inPayloadFolder(artifact.path);
    const line = lineOf(artifact, frontmatter.data.keySpan('allowed-tools'));
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

  // Items ------------------------------------------------------------------------------------

  #pushPermission(artifact: Artifact, item: Omit<PermissionItem, 'id' | 'file' | 'digest'>): void {
    const value = redactPermission(maskTokens(item.value));
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
   * covers a hook's command: a changed helper command is a changed item.
   */
  #pushEnv(
    artifact: Artifact,
    doc: ParsedJson,
    key: string,
    cls: EnvClass,
    value: string | undefined,
    path: JsonPath,
    command?: string,
    platforms: readonly PlatformId[] = sortedPlatforms(artifact.readers),
  ): void {
    const shown =
      cls === 'endpoint' ? endpointShown(value) : cls === 'tls' ? switchShown(value) : undefined;
    const fields = { key, class: cls, ...(shown === undefined ? {} : { shown }) };
    this.#env.push({
      id: envInventoryId(artifact.path, key),
      file: artifact.path,
      line: lineOf(artifact, keySpanOf(doc, path)),
      platforms,
      ...fields,
      digestFields: { ...fields, command },
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
