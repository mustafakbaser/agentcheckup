import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonInsertProperty } from '../../fix/edits.js';
import { urlWithoutType } from '../../platforms/mcp.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf, own } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, type McpServer, mcpServers } from './servers.js';

const ID = 'mcp/url-without-type';

export interface InferredType {
  readonly type: 'http' | 'sse' | 'ws';
  /** True when nothing in the URL names the transport: `http` is then a default. */
  readonly guessed: boolean;
}

/**
 * The transport a server URL implies: `ws` for `ws://` and `wss://`, `sse` when the last path
 * segment is `sse`, otherwise `http`, which is a guess unless the path ends in `/mcp` (the
 * Streamable HTTP endpoint the MCP specification uses in its examples). Query and fragment are
 * ignored; variable references such as `${HOST}` need not parse as a URL.
 */
export function inferServerType(url: string): InferredType {
  const text = url.trim().toLowerCase();
  if (text.startsWith('ws://') || text.startsWith('wss://')) return { type: 'ws', guessed: false };
  const scheme = text.indexOf('://');
  let rest = scheme === -1 ? text : text.slice(scheme + 3);
  for (const stop of ['?', '#']) {
    const at = rest.indexOf(stop);
    if (at !== -1) rest = rest.slice(0, at);
  }
  const slash = rest.indexOf('/');
  let path = slash === -1 ? '' : rest.slice(slash);
  while (path.endsWith('/')) path = path.slice(0, -1);
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last === 'sse') return { type: 'sse', guessed: false };
  return { type: 'http', guessed: last !== 'mcp' };
}

function fixFor(artifact: Artifact, server: McpServer): Fix | undefined {
  const url = own(server.config, 'url');
  if (typeof url !== 'string') return undefined;
  const inferred = inferServerType(url);
  const change = jsonInsertProperty(artifact, server.path, 'type', inferred.type, {
    position: 'first',
  });
  if (change === undefined) return undefined;
  const notes = [
    `Claude Code will offer to start MCP server ${quote(server.name)}; \`claude -p\` starts it without asking.`,
  ];
  if (inferred.guessed) {
    notes.push(
      `"${inferred.type}" is a guess: the URL does not end in /mcp or /sse. Use "sse" if the server only speaks Server-Sent Events.`,
    );
  }
  return {
    id: `${ID}#${inferred.type}`,
    class: 'review',
    title: `Add "type": "${inferred.type}" to MCP server ${quote(server.name)}`,
    changes: [change],
    notes,
  };
}

export const urlWithoutTypeRule = defineRule({
  meta: {
    id: ID,
    title: 'MCP server has a "url" but no "type"',
    rationale: [
      'Claude Code reads an MCP server entry without `type` as a stdio server, so an entry with a `url` but no `type` is a configuration error: Claude Code skips the server and reports `MCP server "<name>" has a "url" but no "type"`. This applies to `.mcp.json` and to servers that a plugin manifest declares inline.',
      'Add `"type": "http"`, or `"sse"` or `"ws"` to match the server.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['mcp-json', 'claude-plugin-manifest'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeMcp, SOURCES.claudePlugins],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Adds "type" as the first property of the server: "ws" for ws:// and wss:// URLs, "sse" when the path ends in /sse, otherwise "http". Always a review fix, because it lets Claude Code start the server.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      if (!isClaudeMcpConfig(context.snapshot, artifact)) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const canEdit = editable(artifact);
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'servers with a "url" but no "type"');
      for (const server of mcpServers(artifact, doc)) {
        if (!urlWithoutType(server.config)) continue;
        const fix = canEdit ? fixFor(artifact, server) : undefined;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, server.path)),
          message: `MCP server ${quote(server.name)} has a "url" but no "type", so Claude Code reads it as a stdio server and skips it. Add "type": "http" (or "sse" or "ws").`,
          ...(fix === undefined ? {} : { fix }),
          ...(canEdit ? {} : { guidance: sharedFileGuidance(artifact) }),
        });
      }
      findings.finish();
    }
  },
});
