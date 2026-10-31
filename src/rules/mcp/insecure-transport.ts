import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonReplaceValue } from '../../fix/edits.js';
import { configDocument, TOML_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { at, FileFindings, type JsonPath, keySpanOf, own, spanOf } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, mcpPlatform, mcpServers } from './servers.js';

const ID = 'mcp/insecure-transport';

/** Loopback destinations, where unencrypted traffic never leaves the machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '[::1]' ||
    // Not loopback, but a client connecting to it reaches the local machine.
    host === '0.0.0.0' ||
    host === '[::]'
  );
}

/** The insecure scheme and host of `value`, or undefined when it is secure, local or unparsable. */
export function insecureHost(value: string): { scheme: string; host: string } | undefined {
  const text = value.trim();
  if (text.includes('$') || text.includes('{') || text.includes('%')) return undefined;
  const lower = text.toLowerCase();
  const scheme = lower.startsWith('http://')
    ? 'http'
    : lower.startsWith('ws://')
      ? 'ws'
      : undefined;
  if (scheme === undefined || !URL.canParse(text)) return undefined;
  const { hostname } = new URL(text);
  if (hostname === '' || isLoopbackHost(hostname)) return undefined;
  return { scheme, host: hostname };
}

/** Replaces the scheme of the URL at `path` with `secure` (`https://` or `wss://`). */
function secureFix(
  artifact: Artifact,
  server: string,
  path: JsonPath,
  value: string,
  secure: string,
): Fix | undefined {
  const scheme = value.indexOf('://');
  if (scheme === -1) return undefined;
  const lead = value.length - value.trimStart().length;
  const url = `${value.slice(0, lead)}${secure}${value.slice(scheme + 3)}`;
  const change = jsonReplaceValue(artifact, path, url);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#${secure === 'wss://' ? 'wss' : 'https'}`,
    class: 'review',
    title: `Connect to MCP server ${quote(server)} over ${secure}`,
    changes: [change],
    notes: [
      `Check that the server accepts ${secure} at this address; a port that serves only plain ${secure === 'wss://' ? 'ws://' : 'http://'} fails the connection.`,
    ],
  };
}

export const insecureTransportRule = defineRule({
  meta: {
    id: ID,
    title: 'MCP server uses an unencrypted connection to another host',
    rationale: [
      'An `http://` or `ws://` URL sends every tool call, result and header, including `Authorization` tokens, in clear text. Anyone on the network path, for example on a shared Wi-Fi network, can read the traffic and change tool results, which the agent then trusts. `claude plugin validate` also warns about `http://` and `ws://` URLs to hosts other than loopback.',
      'Loopback hosts such as `localhost`, `127.0.0.1` and `::1` are not reported. A Claude Code server with `"type": "sse"` gets an `info` finding, because Claude Code has deprecated the SSE transport in favor of `"type": "http"`. Codex servers in `.codex/config.toml` are checked too; the rule offers no fix there.',
      'Use `https://` or `wss://`.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: [
      'mcp-json',
      'claude-plugin-manifest',
      'cursor-mcp',
      'gemini-settings',
      'codex-config',
    ],
    platforms: ['claude-code', 'cursor', 'gemini', 'codex'],
    sources: [
      SOURCES.claudePlugins,
      SOURCES.claudeMcp,
      SOURCES.cursorMcp,
      SOURCES.geminiMcp,
      SOURCES.codexMcp,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Changes http:// to https:// and ws:// to wss:// in the server URL. Moving off the deprecated SSE transport is left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platform = mcpPlatform(artifact);
      if (platform === undefined || !context.targets.has(platform)) continue;
      const doc = configDocument(context, artifact);
      if (!doc.ok) continue;
      const canEdit = editable(artifact);
      const toml = TOML_KINDS.has(artifact.kind);
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'findings about MCP transports');
      for (const server of mcpServers(artifact, doc)) {
        for (const field of toml ? ['url'] : ['url', 'httpUrl']) {
          const value = own(server.config, field);
          if (typeof value !== 'string') continue;
          const insecure = insecureHost(value);
          if (insecure === undefined) continue;
          const secure = insecure.scheme === 'ws' ? 'wss://' : 'https://';
          const path = [...server.path, field];
          // No fix builder edits TOML.
          const fix =
            canEdit && !toml && findings.listsNext
              ? secureFix(artifact, server.name, path, value, secure)
              : undefined;
          const guidance = !canEdit
            ? sharedFileGuidance(artifact)
            : toml
              ? `change the URL to ${secure} if the server accepts it at this address`
              : undefined;
          findings.report({
            artifact,
            ...at(spanOf(doc, path)),
            message: `MCP server ${quote(server.name)} connects to ${quote(insecure.host)} over unencrypted ${insecure.scheme}://, so anyone on the network path can read and change its traffic, including credentials in headers. Use ${secure}.`,
            platforms: [platform],
            ...(fix === undefined ? {} : { fix }),
            ...(guidance === undefined ? {} : { guidance }),
          });
        }
        if (
          platform === 'claude-code' &&
          own(server.config, 'type') === 'sse' &&
          isClaudeMcpConfig(context.snapshot, artifact)
        ) {
          findings.report({
            artifact,
            ...at(spanOf(doc, [...server.path, 'type']) ?? keySpanOf(doc, server.path)),
            severity: 'info',
            message: `MCP server ${quote(server.name)} uses the SSE transport, which Claude Code has deprecated. Use "type": "http" if the server supports Streamable HTTP.`,
            platforms: [platform],
            guidance:
              'check whether the server offers a Streamable HTTP endpoint (often /mcp), then set "type": "http" and point "url" at it',
          });
        }
      }
      findings.finish();
    }
  },
});
