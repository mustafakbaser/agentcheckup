import type { Artifact, ArtifactKind, PlatformId, Snapshot } from '../../core/types.js';
import { pluginRootOf } from '../../platforms/location.js';
import { isObject, type JsonObject, type JsonPath, own, type ParsedJson } from '../json/access.js';

export interface McpServer {
  readonly name: string;
  readonly config: JsonObject;
  /** Path of the server entry, e.g. `['mcpServers', 'github']`. */
  readonly path: JsonPath;
}

/**
 * Inline MCP server entries, in document order: `mcpServers` in `.mcp.json`, `.cursor/mcp.json`
 * and `.gemini/settings.json`, and the inline map (or array of maps) a plugin manifest declares.
 */
export function mcpServers(artifact: Artifact, doc: ParsedJson): McpServer[] {
  const root = doc.value;
  if (!isObject(root)) return [];
  const servers = own(root, 'mcpServers');
  const out: McpServer[] = [];
  const addMap = (map: unknown, base: JsonPath): void => {
    if (!isObject(map)) return;
    for (const name of Object.keys(map)) {
      const config = map[name];
      if (isObject(config)) out.push({ name, config, path: [...base, name] });
    }
  };
  if (artifact.kind === 'claude-plugin-manifest' && Array.isArray(servers)) {
    servers.forEach((entry: unknown, index) => {
      addMap(entry, ['mcpServers', index]);
    });
  } else {
    addMap(servers, ['mcpServers']);
  }
  return out;
}

const MCP_PLATFORM_BY_KIND: Readonly<Partial<Record<ArtifactKind, PlatformId>>> = {
  'mcp-json': 'claude-code',
  'claude-plugin-manifest': 'claude-code',
  'cursor-mcp': 'cursor',
  'gemini-settings': 'gemini',
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
