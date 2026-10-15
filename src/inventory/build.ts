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
import type { Artifact, ArtifactKind, PlatformId, Span } from '../core/types.js';
import {
  isObject,
  type JsonObject,
  type JsonPath,
  keySpanOf,
  own,
  ownObject,
  type ParsedJson,
  spanOf,
} from '../parse/json-access.js';
import { classify } from '../platforms/classify.js';
import { hookCommandSyntax, resolveScript, scriptCandidate } from '../platforms/hook-command.js';
import {
  gateFailsOpen,
  type HookPlatform,
  hookHandlers,
  hookPlatformOf,
} from '../platforms/hooks.js';
import type { LoadView } from '../platforms/load/view.js';
import { isBundledSkill, pluginRootOf } from '../platforms/location.js';
import { isClaudeMcpConfig, type McpServer, mcpServers, urlWithoutType } from '../platforms/mcp.js';
import { inPayloadFolder, joinPath, projectRootOf } from '../platforms/paths.js';
import { broadGrant, IGNORED_MODES, splitToolRules } from '../platforms/permissions.js';
import { placement } from '../platforms/skills.js';
import { isLoopbackHost } from '../rules/mcp/insecure-transport.js';
import { findSecret } from '../rules/mcp/secrets.js';
import { findRemoteExecution } from '../rules/risk/remote-script.js';
import { COMMAND_SETTINGS, envClass, type EnvClass } from './env-class.js';
import { packageSpec } from './package-spec.js';
import { REDACTED, redactArgs, redactCommand, urlOrigin } from './redact.js';
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PackageSpec,
  PermissionItem,
} from './types.js';

/** Kinds whose `mcpServers` the MCP walker reads. */
const MCP_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'mcp-json',
  'cursor-mcp',
  'gemini-settings',
  'claude-plugin-manifest',
]);

/** JSON kinds the inventory reads. A file of these kinds that fails to parse is `incomplete`. */
const JSON_KINDS: ReadonlySet<ArtifactKind> = new Set([
  ...MCP_KINDS,
  'claude-settings',
  'codex-hooks',
  'cursor-hooks',
]);

/**
 * Builds the inventory. Every list is sorted by id, and every id is unique: a repeated id gets
 * an occurrence number (`:2`, `:3`) in document order, except permissions, where a repeated
 * value is the same grant and is listed once.
 */
export function buildInventory(view: LoadView): Inventory {
  const builder = new InventoryBuilder(view);
  for (const artifact of view.artifacts) builder.add(artifact);
  builder.addUnparsedConfigs();
  return builder.finish();
}

// ---------------------------------------------------------------------------------------------
// Canonical form and digests
// ---------------------------------------------------------------------------------------------

/** JSON with object keys sorted by code point and `undefined` fields left out. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

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

/** True when `path` is `name` or ends with `/name`. */
function endsWithPath(path: string, name: string): boolean {
  return path === name || path.endsWith(`/${name}`);
}

/** At most this many vendor tokens are masked in one permission value. */
const MAX_MASKED = 64;

/**
 * A permission value with credentials of a known vendor format masked. Permission values are
 * patterns, so they are not redacted like commands: cutting URLs would merge distinct rules.
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

function quoteArg(arg: string): string {
  return arg === '' || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg;
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

const TRANSPORTS: Readonly<Record<string, McpServerItem['transport']>> = {
  stdio: 'stdio',
  local: 'stdio',
  http: 'http',
  'streamable-http': 'http',
  streamableHttp: 'http',
  sse: 'sse',
  ws: 'ws',
};

/**
 * The transport an entry declares: its `type`, else stdio for a `command`, else Gemini CLI's
 * `httpUrl` (streamable HTTP). A `url` without `type` is `unknown`: Claude Code skips it, and the
 * other agents' documentation does not settle which remote transport they pick.
 */
function transportOf(artifact: Artifact, config: JsonObject): McpServerItem['transport'] {
  const type = own(config, 'type');
  if (type !== undefined) {
    return typeof type === 'string' && Object.hasOwn(TRANSPORTS, type)
      ? (TRANSPORTS[type] ?? 'unknown')
      : 'unknown';
  }
  if (typeof own(config, 'command') === 'string') return 'stdio';
  if (artifact.kind === 'gemini-settings' && typeof own(config, 'httpUrl') === 'string') {
    return 'http';
  }
  return 'unknown';
}

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
    if (!JSON_KINDS.has(artifact.kind)) return;
    const doc = this.#view.json(artifact);
    if (!doc.ok) {
      this.#incomplete.add(`invalid-json:${artifact.path}`);
      return;
    }
    if (MCP_KINDS.has(artifact.kind)) this.#addServers(artifact, doc);
    const hookPlatform = hookPlatformOf(artifact);
    if (hookPlatform !== undefined) this.#addHooks(artifact, doc, hookPlatform);
    if (artifact.kind === 'claude-settings') this.#addSettings(artifact, doc);
  }

  /**
   * Configuration files the classifier does not read, so their servers and hooks are not listed:
   * Codex's `config.toml` (TOML is not parsed), VS Code's `.vscode/mcp.json`, the Copilot CLI's
   * `.github/mcp.json`, Copilot's `.github/hooks/*.json`, and inventory files the walk skipped
   * (too large or unreadable).
   */
  addUnparsedConfigs(): void {
    const { snapshot } = this.#view;
    for (const path of snapshot.paths) {
      if (path.endsWith('/')) continue;
      if (
        endsWithPath(path, '.codex/config.toml') ||
        endsWithPath(path, '.vscode/mcp.json') ||
        endsWithPath(path, '.github/mcp.json') ||
        isCopilotHookFile(path)
      ) {
        this.#incomplete.add(path);
      }
    }
    for (const entry of snapshot.skipped) {
      const kind = classify(entry.path)?.kind;
      if (kind !== undefined && (JSON_KINDS.has(kind) || kind === 'skill')) {
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

  #addServers(artifact: Artifact, doc: ParsedJson): void {
    const platforms = sortedPlatforms(artifact.readers);
    for (const server of mcpServers(artifact, doc)) {
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
        envKeys: sortedKeys(env),
        headerKeys: sortedKeys(own(config, 'headers')),
        status: this.#statusOf(artifact, server),
      };
      this.#servers.push({
        id: `mcp:${artifact.path}#${name}`,
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
          this.#pushEnv(artifact, doc, `${pathKey(server.path)}.env.${key}`, cls, value, [
            ...server.path,
            'env',
            key,
          ]);
        }
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
    }
  }

  /**
   * What each agent that reads the file does with the server. Claude Code: a `url` without `type`
   * is skipped (mcp/url-without-type); a project `.mcp.json` server asks first unless the
   * project's settings approve or reject it; a plugin's server starts once the user installs and
   * enables the plugin, which is that approval. A `.mcp.json` of another agent's plugin is not
   * Claude Code's. Cursor connects project servers and asks before each tool call; Gemini CLI
   * connects them unless folder trust is on and the folder is not trusted (off by default).
   */
  #statusOf(artifact: Artifact, server: McpServer): McpServerItem['status'] {
    if (artifact.kind === 'cursor-mcp') return { cursor: 'loads' };
    if (artifact.kind === 'gemini-settings') return { gemini: 'loads' };
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

  #addHooks(artifact: Artifact, doc: ParsedJson, platform: HookPlatform): void {
    const platforms = sortedPlatforms(artifact.readers);
    const root = projectRootOf(artifact);
    const syntax = hookCommandSyntax(this.#view.snapshot, platform, root);
    for (const hook of hookHandlers(doc, platform, { includeUnknown: true })) {
      const { handler, type } = hook;
      const rawCommand = stringOf(own(handler, 'command'));
      const rawArgs = own(handler, 'args');
      let command: string | undefined;
      if (rawCommand !== undefined) {
        command = redactCommand(rawCommand);
        // Claude Code's exec form: `command` is the program and `args` its arguments.
        if (Array.isArray(rawArgs)) {
          command = [command, ...redactArgs(stringsOf(rawArgs)).map(quoteArg)].join(' ');
        }
      }
      const target = command === undefined ? hookTarget(handler) : undefined;
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
        remoteScript:
          rawCommand !== undefined &&
          findRemoteExecution(rawCommand, 0, rawCommand.length) !== undefined,
      };
      const what = command ?? canonicalJson(target ?? {});
      this.#hooks.push({
        id: `hook:${artifact.path}#${hook.event}:${hash53(what).slice(-8)}`,
        file: artifact.path,
        line: lineOf(artifact, spanOf(doc, [...hook.path, 'command']) ?? keySpanOf(doc, hook.path)),
        platforms,
        ...fields,
        digestFields: { ...fields, ...(target === undefined ? {} : { target }) },
      });
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
    const value = maskTokens(item.value);
    const fields = { key: item.key, value, broad: item.broad, effective: item.effective };
    this.#permissions.push({
      id: `perm:${artifact.path}#${item.key}=${value}`,
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
  ): void {
    const shown =
      cls === 'endpoint' ? endpointShown(value) : cls === 'tls' ? switchShown(value) : undefined;
    const fields = { key, class: cls, ...(shown === undefined ? {} : { shown }) };
    this.#env.push({
      id: `env:${artifact.path}#${key}`,
      file: artifact.path,
      line: lineOf(artifact, keySpanOf(doc, path)),
      platforms: sortedPlatforms(artifact.readers),
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

/** `.github/hooks/<name>.json`, where GitHub Copilot reads hooks. */
function isCopilotHookFile(path: string): boolean {
  const parts = path.split('/');
  const count = parts.length;
  return (
    count >= 3 &&
    parts[count - 2] === 'hooks' &&
    parts[count - 3] === '.github' &&
    (parts[count - 1] ?? '').endsWith('.json')
  );
}

/** `/`, `~` and `~/`: a working directory that reaches every file of the machine or the user. */
function isRootOrHome(directory: string): boolean {
  const text = directory.trim();
  return text === '/' || text === '//' || text === '~' || text === '~/';
}

/**
 * What a hook without a command calls, as far as decision 10 lets a digest see it: an HTTP
 * hook's URL origin, an MCP tool hook's server and tool names. HookItem has no field for them,
 * so they are covered by the id and digest but not shown. A prompt or agent hook's prompt is
 * neither shown nor covered.
 */
function hookTarget(handler: JsonObject): object | undefined {
  const url = stringOf(own(handler, 'url'));
  if (url !== undefined) return { url: urlOrigin(url.trim()).origin };
  const server = stringOf(own(handler, 'server'));
  const tool = stringOf(own(handler, 'tool'));
  if (server !== undefined || tool !== undefined) return { server, tool };
  return undefined;
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
 * order; `dedupe` keeps the first item with an id.
 */
function finishItems<T extends Identified>(
  items: readonly T[],
  repeats: 'suffix' | 'dedupe',
): (Omit<T, 'digestFields'> & { readonly digest: string })[] {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const out: (Omit<T, 'digestFields'> & { readonly digest: string })[] = [];
  for (const item of items) {
    let id = item.id;
    if (used.has(id)) {
      if (repeats === 'dedupe') continue;
      let count = counts.get(item.id) ?? 1;
      do {
        count++;
        id = `${item.id}:${count}`;
      } while (used.has(id));
      counts.set(item.id, count);
    }
    used.add(id);
    const { digestFields, ...rest } = item;
    out.push({ ...rest, id, digest: digestOf(digestFields) });
  }
  return out.sort((a, b) => compareStrings(a.id, b.id));
}
