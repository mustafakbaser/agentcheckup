/**
 * Codex's project configuration: one `.codex/config.toml` layer per directory from the project
 * root down to the working directory, "closest wins; trusted projects only" (SOURCES.codexConfigBasic).
 * Layers merge table by table, and a value in a closer layer replaces the one below it
 * (`merge_toml_values` in codex-rs/config/src/loader/mod.rs, SOURCES.codexConfigLoader).
 *
 * The Codex loader, instr/codex-size-budget and the codex/* rules read the configuration through
 * this module, so they agree on which value applies, which keys Codex ignores in a project file
 * and which MCP server entries it rejects. Pure: reads only the view.
 */
import { pathStatus } from '../core/paths.js';
import type { Artifact } from '../core/types.js';
import {
  issueKind,
  isTable,
  type JsonObject,
  type JsonPath,
  own,
  type ParsedJson,
} from '../parse/json-access.js';
import type { ParseIssue } from '../parse/types.js';
import type { LoadView } from './load/view.js';
import { joinPath } from './paths.js';

/** Where a project layer sits, relative to its directory. */
export const CODEX_CONFIG_FILE = '.codex/config.toml';

export interface CodexConfigLayer {
  /** The directory whose `.codex/config.toml` this is. */
  readonly directory: string;
  /** The path Codex opens; may be a symlink alias of `artifact.path`. */
  readonly path: string;
  readonly artifact: Artifact;
  readonly doc: ParsedJson;
}

/**
 * A layer agentcheckup could not read as Codex does:
 * - `invalid`: not valid TOML, or not UTF-8. Codex stops at startup in a trusted project.
 * - `unparsed`: a limit of agentcheckup's parser, or UTF-16 text.
 * - `unread`: the file exists, but the scan did not read it.
 */
export type CodexLayerProblem =
  | {
      readonly kind: 'invalid' | 'unparsed';
      readonly directory: string;
      readonly path: string;
      readonly artifact: Artifact;
      readonly issue: ParseIssue;
    }
  | { readonly kind: 'unread'; readonly directory: string; readonly path: string };

/** A value of the merged configuration and the layer that sets it. */
export interface CodexSetting {
  readonly value: unknown;
  readonly layer: CodexConfigLayer;
}

export interface CodexProjectConfig {
  /** The directories Codex reads layers from, the project root first. */
  readonly directories: readonly string[];
  /** The layers agentcheckup parsed, the project root first. */
  readonly layers: readonly CodexConfigLayer[];
  /** Layers it could not read, the project root first. */
  readonly problems: readonly CodexLayerProblem[];
  /**
   * The value at `path` in the merged configuration and the closest layer that sets it, or
   * undefined when no parsed layer does. A closer layer that sets a parent key to something other
   * than a table replaces the tables below it, and with them the value.
   */
  setting(path: JsonPath): CodexSetting | undefined;
  /**
   * The table at `path` in the merged configuration, its keys from every layer that has the
   * table, each value from the closest one; undefined when the merged value is not a table. A
   * new null-prototype object, for reading only.
   */
  table(path: JsonPath): JsonObject | undefined;
}

type Lookup =
  | { readonly kind: 'found'; readonly value: unknown }
  | { readonly kind: 'absent' }
  /** A key on the way is not a table, so this layer replaces everything below it. */
  | { readonly kind: 'blocked' };

function lookup(root: unknown, path: JsonPath): Lookup {
  let value = root;
  for (const segment of path) {
    if (!isTable(value)) return { kind: 'blocked' };
    if (typeof segment !== 'string' || !Object.hasOwn(value, segment)) return { kind: 'absent' };
    value = value[segment];
  }
  return { kind: 'found', value };
}

const configs = new WeakMap<object, Map<string, CodexProjectConfig>>();

/**
 * The project configuration Codex reads in `directories`: the project root first, down to the
 * working directory (`chainDirectories` of ./load/codex-chain.ts; Codex finds the project root of
 * its configuration as it finds the root of the AGENTS.md chain, and `project_root_markers` in a
 * project layer has no effect on either). Built once per view index and directory list.
 */
export function codexProjectConfig(
  view: Pick<LoadView, 'snapshot' | 'index' | 'toml'>,
  directories: readonly string[],
): CodexProjectConfig {
  let byDirectories = configs.get(view.index);
  if (byDirectories === undefined) {
    byDirectories = new Map();
    configs.set(view.index, byDirectories);
  }
  const key = directories.join('\u0000');
  const hit = byDirectories.get(key);
  if (hit !== undefined) return hit;

  const layers: CodexConfigLayer[] = [];
  const problems: CodexLayerProblem[] = [];
  for (const directory of directories) {
    const path = joinPath(directory, CODEX_CONFIG_FILE);
    const artifact = view.index.get(path);
    if (artifact?.kind !== 'codex-config') {
      if (pathStatus(view.snapshot, path) !== 'missing') {
        problems.push({ kind: 'unread', directory, path });
      }
      continue;
    }
    const doc = view.toml(artifact);
    if (doc.ok) {
      layers.push({ directory, path, artifact, doc });
      continue;
    }
    const issue = doc.errors[0] ?? { code: '', message: '', span: { offset: 0, length: 0 } };
    const kind = issueKind(issue);
    problems.push({
      kind: kind === 'limit' || kind === 'unsupported' ? 'unparsed' : 'invalid',
      directory,
      path,
      artifact,
      issue,
    });
  }

  const config: CodexProjectConfig = {
    directories: [...directories],
    layers,
    problems,
    setting(path) {
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer === undefined) continue;
        const found = lookup(layer.doc.value, path);
        if (found.kind === 'blocked') return undefined;
        if (found.kind === 'found') return { value: found.value, layer };
      }
      return undefined;
    },
    table(path) {
      let merged: Record<string, unknown> | undefined;
      for (const layer of layers) {
        const found = lookup(layer.doc.value, path);
        if (found.kind === 'absent') continue;
        if (found.kind === 'blocked' || !isTable(found.value)) {
          merged = undefined;
          continue;
        }
        merged ??= nullObject();
        for (const name of Object.keys(found.value)) merged[name] = found.value[name];
      }
      return merged;
    },
  };
  byDirectories.set(key, config);
  return config;
}

function nullObject(): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  Object.setPrototypeOf(object, null);
  return object;
}

// ---------------------------------------------------------------------------------------------
// AGENTS.md settings
// ---------------------------------------------------------------------------------------------

/**
 * Where a setting comes from, in precedence order: the repository's project configuration, the
 * scan's rule option, Codex's default.
 */
export type SettingOrigin = 'repository' | 'rule-option' | 'default';

export interface CodexDocSettings {
  /** `project_doc_max_bytes`: the AGENTS.md byte budget. */
  readonly maxBytes: {
    readonly value: number;
    readonly origin: SettingOrigin;
    /** The layer that sets it, when the origin is the repository. */
    readonly path?: string;
  };
  /** `project_doc_fallback_filenames`: names Codex tries after AGENTS.md, as written. */
  readonly fallbackNames: {
    readonly value: readonly string[];
    readonly origin: 'repository' | 'default';
    readonly path?: string;
  };
}

/**
 * `project_doc_max_bytes` and `project_doc_fallback_filenames` as Codex applies them in the
 * working directory: the repository's value when its configuration sets a valid one (a positive
 * integer; an array of strings), else `ruleMaxBytes` (the `maxBytes` option of
 * instr/codex-size-budget, or the default) and no fallback names.
 */
export function codexDocSettings(
  config: CodexProjectConfig,
  ruleMaxBytes: { readonly value: number; readonly origin: 'rule-option' | 'default' },
): CodexDocSettings {
  const max = config.setting(['project_doc_max_bytes']);
  const maxBytes =
    max !== undefined &&
    typeof max.value === 'number' &&
    Number.isSafeInteger(max.value) &&
    max.value > 0
      ? { value: max.value, origin: 'repository' as const, path: max.layer.path }
      : ruleMaxBytes;
  const names = config.setting(['project_doc_fallback_filenames']);
  const list: readonly unknown[] = Array.isArray(names?.value) ? names.value : [];
  const strings = list.filter((name): name is string => typeof name === 'string');
  const fallbackNames =
    names !== undefined && Array.isArray(names.value) && strings.length === list.length
      ? { value: strings, origin: 'repository' as const, path: names.layer.path }
      : { value: [], origin: 'default' as const };
  return { maxBytes, fallbackNames };
}

/**
 * The fallback names Codex looks for, in order: empty names, `.`, `..` and names with `/` or NUL
 * are skipped, as are repeats and AGENTS.override.md and AGENTS.md themselves
 * (`candidate_filenames` in codex-rs/core/src/agents_md.rs, SOURCES.codexAgentsMdSource). On
 * Windows Codex also skips names with `\` or `:`, which agentcheckup does not model.
 */
export function codexFallbackNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (name === '' || name === '.' || name === '..') continue;
    if (name.includes('/') || name.includes('\u0000')) continue;
    if (name === 'AGENTS.override.md' || name === 'AGENTS.md' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Keys Codex ignores in a project file
// ---------------------------------------------------------------------------------------------

/**
 * Top-level keys Codex removes from every project layer, with a startup warning
 * (`PROJECT_LOCAL_CONFIG_DENYLIST` in codex-rs/config/src/loader/mod.rs, SOURCES.codexConfigLoader):
 * repository content must not choose where credentials go or which local commands run.
 */
export const CODEX_PROJECT_DENYLIST: readonly string[] = [
  'openai_base_url',
  'chatgpt_base_url',
  'apps_mcp_product_sku',
  'responses_api_metadata',
  'model_provider',
  'model_providers',
  'notify',
  'profile',
  'profiles',
  'experimental_realtime_webrtc_call_base_url',
  'experimental_realtime_ws_base_url',
  'otel',
];

/**
 * Nested keys `sanitize_project_config` always removes from a project layer, with the same
 * warning. Keys it removes only when a credential broker is configured are not listed.
 */
export const CODEX_PROJECT_REMOVED_PATHS: readonly (readonly string[])[] = [
  ['features', 'respect_system_proxy'],
  ['features', 'system_proxy_fallback'],
  ['features', 'credential_masking'],
  ['features', 'multi_agent_v2', 'message_board_remote'],
  ['tui', 'keymap', 'chat', 'previous_permission_mode'],
  ['tui', 'keymap', 'chat', 'next_permission_mode'],
];

/**
 * Why Codex ignores a key in a project layer:
 * - `removed`: the loader drops it and warns at startup.
 * - `before-project`: Codex reads it before it loads project layers (`project_root_markers` and
 *   `projects`, which choose the project root and its trust), so a project file cannot set it.
 * - `user-only`: `hooks.state` holds hook trust and is read from user and session layers only
 *   (codex-rs/hooks/src/config_rules.rs, SOURCES.codexHookState).
 */
export type IgnoredReason = 'removed' | 'before-project' | 'user-only';

export interface IgnoredKey {
  readonly path: JsonPath;
  readonly reason: IgnoredReason;
}

/** The keys of one project layer that Codex ignores, in document order of their first key. */
export function codexIgnoredKeys(doc: ParsedJson): IgnoredKey[] {
  const root = doc.value;
  if (!isTable(root)) return [];
  const out: IgnoredKey[] = [];
  for (const key of Object.keys(root)) {
    if (CODEX_PROJECT_DENYLIST.includes(key)) out.push({ path: [key], reason: 'removed' });
    else if (key === 'project_root_markers' || key === 'projects') {
      out.push({ path: [key], reason: 'before-project' });
    }
  }
  for (const path of CODEX_PROJECT_REMOVED_PATHS) {
    if (lookup(root, path).kind === 'found') out.push({ path, reason: 'removed' });
  }
  const hooks = own(root, 'hooks');
  if (isTable(hooks) && Object.hasOwn(hooks, 'state')) {
    out.push({ path: ['hooks', 'state'], reason: 'user-only' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------------------------

/** Fields Codex rejects on a stdio server, in the order it checks them. */
const NOT_FOR_STDIO = [
  'url',
  'bearer_token_env_var',
  'bearer_token',
  'http_headers_helper',
  'http_headers',
  'env_http_headers',
  'oauth',
  'oauth_resource',
  'auth',
];

/** Fields Codex rejects on a streamable HTTP server, in the order it checks them. */
const NOT_FOR_HTTP = ['args', 'env', 'env_vars', 'cwd', 'bearer_token'];

/**
 * Why Codex rejects a server entry, as `TryFrom<RawMcpServerConfig>` in
 * codex-rs/config/src/mcp_types.rs does (SOURCES.codexMcpTypes), or undefined:
 * - `no-transport`: neither `command` nor `url` ("invalid transport").
 * - `unsupported-field`: a field the transport does not take, such as `url` next to `command`
 *   ("url is not supported for stdio") or `bearer_token`, which no transport takes.
 */
export type CodexServerProblem =
  | { readonly kind: 'no-transport' }
  | {
      readonly kind: 'unsupported-field';
      readonly field: string;
      readonly transport: 'stdio' | 'streamable_http';
    };

export function codexServerProblem(config: JsonObject): CodexServerProblem | undefined {
  const has = (field: string): boolean => own(config, field) !== undefined;
  if (has('command')) {
    const field = NOT_FOR_STDIO.find(has);
    return field === undefined
      ? undefined
      : { kind: 'unsupported-field', field, transport: 'stdio' };
  }
  if (has('url')) {
    const field = NOT_FOR_HTTP.find(has);
    return field === undefined
      ? undefined
      : { kind: 'unsupported-field', field, transport: 'streamable_http' };
  }
  return { kind: 'no-transport' };
}

/** `enabled = false` turns a server off (SOURCES.codexMcp). */
export function codexServerEnabled(config: JsonObject): boolean {
  return own(config, 'enabled') !== false;
}

/**
 * The setting that turns Codex's hooks on or off in this working directory: `features.hooks`,
 * else its deprecated alias `features.codex_hooks`, when the merged configuration sets one to a
 * boolean. Hooks are on by default (SOURCES.codexHooks, SOURCES.codexConfigReference).
 */
export function codexHooksSetting(config: CodexProjectConfig): CodexSetting | undefined {
  const setting =
    config.setting(['features', 'hooks']) ?? config.setting(['features', 'codex_hooks']);
  return setting !== undefined && typeof setting.value === 'boolean' ? setting : undefined;
}
