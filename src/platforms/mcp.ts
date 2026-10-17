import type { Artifact, ArtifactKind, PlatformId, Snapshot } from '../core/types.js';
import {
  isObject,
  type JsonObject,
  type JsonPath,
  own,
  type ParsedJson,
} from '../parse/json-access.js';
import { pluginRootOf } from './location.js';

export interface McpServer {
  readonly name: string;
  readonly config: JsonObject;
  /** Path of the server entry, e.g. `['mcpServers', 'github']`. */
  readonly path: JsonPath;
}

/** The object entries of `map` as servers under `base`, in document order. */
function serversIn(map: unknown, base: JsonPath): McpServer[] {
  if (!isObject(map)) return [];
  const out: McpServer[] = [];
  for (const name of Object.keys(map)) {
    const config = map[name];
    if (isObject(config)) out.push({ name, config, path: [...base, name] });
  }
  return out;
}

/**
 * The servers of VS Code's `.vscode/mcp.json`, which keeps them under `servers` rather than
 * `mcpServers` (SOURCES.vscodeMcp).
 */
export function vscodeMcpServers(doc: ParsedJson): McpServer[] {
  return isObject(doc.value) ? serversIn(own(doc.value, 'servers'), ['servers']) : [];
}

/**
 * The servers of the Copilot CLI's `.github/mcp.json`, which takes either an `mcpServers` object
 * or the bare form with server names as top-level keys (SOURCES.copilotCliMcp). The documentation
 * does not say how a file that mixes the two is read; the `mcpServers` object is taken when there
 * is one.
 */
export function copilotMcpServers(doc: ParsedJson): McpServer[] {
  const root = doc.value;
  if (!isObject(root)) return [];
  const wrapped = own(root, 'mcpServers');
  return isObject(wrapped) ? serversIn(wrapped, ['mcpServers']) : serversIn(root, []);
}

/**
 * Inline MCP server entries, in document order: `mcpServers` in `.mcp.json`, `.cursor/mcp.json`,
 * `.gemini/settings.json`, `.devin/mcp_config.json` and `.devin/config.json` (where Devin Local
 * kept servers before v3000.3, SOURCES.devinCliMcp), the inline map (or array of maps) a plugin
 * manifest declares, `servers` in `.vscode/mcp.json` ({@link vscodeMcpServers}), and either form
 * of `.github/mcp.json` ({@link copilotMcpServers}).
 */
export function mcpServers(artifact: Artifact, doc: ParsedJson): McpServer[] {
  if (artifact.kind === 'vscode-mcp') return vscodeMcpServers(doc);
  if (artifact.kind === 'copilot-mcp') return copilotMcpServers(doc);
  const root = doc.value;
  if (!isObject(root)) return [];
  const servers = own(root, 'mcpServers');
  if (artifact.kind === 'claude-plugin-manifest' && Array.isArray(servers)) {
    return servers.flatMap((entry: unknown, index) => serversIn(entry, ['mcpServers', index]));
  }
  return serversIn(servers, ['mcpServers']);
}

/** Kinds whose servers {@link mcpServers} reads. */
export const MCP_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'mcp-json',
  'cursor-mcp',
  'gemini-settings',
  'claude-plugin-manifest',
  'copilot-mcp',
  'vscode-mcp',
  'devin-mcp',
  'devin-config',
]);

const MCP_PLATFORM_BY_KIND: Readonly<Partial<Record<ArtifactKind, PlatformId>>> = {
  'mcp-json': 'claude-code',
  'claude-plugin-manifest': 'claude-code',
  'cursor-mcp': 'cursor',
  'gemini-settings': 'gemini',
  'copilot-mcp': 'copilot',
  'vscode-mcp': 'copilot',
  'devin-mcp': 'windsurf',
  'devin-config': 'windsurf',
};

/** The platform whose MCP loader reads servers from this kind of file. */
export function mcpPlatform(artifact: Artifact): PlatformId | undefined {
  return MCP_PLATFORM_BY_KIND[artifact.kind];
}

/**
 * False for a `.mcp.json` that belongs to another agent's plugin (a `.codex-plugin/plugin.json`
 * next to it, say, and no `.claude-plugin`): Claude Code does not load it as project config, so
 * Claude-specific findings do not apply.
 */
export function isClaudeMcpConfig(snapshot: Snapshot, artifact: Artifact): boolean {
  if (artifact.kind !== 'mcp-json') return artifact.kind === 'claude-plugin-manifest';
  const plugin = pluginRootOf(snapshot, artifact.path);
  return plugin === undefined || plugin.markers.includes('.claude-plugin');
}

/**
 * True for a server entry with a `url` but neither `type` nor `command`. Claude Code reads such an
 * entry as a stdio server, reports a configuration error and skips it (mcp/url-without-type).
 */
export function urlWithoutType(config: JsonObject): boolean {
  return (
    typeof own(config, 'url') === 'string' &&
    own(config, 'type') === undefined &&
    own(config, 'command') === undefined
  );
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';

const TRANSPORTS: Readonly<Record<string, McpTransport>> = {
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
 * `httpUrl` (streamable HTTP), else, in Devin Local's MCP files, a `url` with its `transport`
 * (`http`, the default, or `sse`; SOURCES.devinCliMcp). Any other `url` without `type` is
 * `unknown`: Claude Code skips it, and the other agents' documentation does not settle which
 * remote transport they pick.
 */
export function transportOf(artifact: Pick<Artifact, 'kind'>, config: JsonObject): McpTransport {
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
  if (
    (artifact.kind === 'devin-mcp' || artifact.kind === 'devin-config') &&
    typeof own(config, 'url') === 'string'
  ) {
    const transport = own(config, 'transport');
    if (transport === undefined || transport === 'http') return 'http';
    if (transport === 'sse') return 'sse';
  }
  return 'unknown';
}
