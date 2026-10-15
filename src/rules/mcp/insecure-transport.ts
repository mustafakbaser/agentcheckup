import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf, own, spanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, mcpPlatform, mcpServers } from './servers.js';

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

export const insecureTransportRule = defineRule({
  meta: {
    id: 'mcp/insecure-transport',
    title: 'MCP server uses an unencrypted connection to another host',
    rationale: [
      'An `http://` or `ws://` URL sends every tool call, result and header, including `Authorization` tokens, in clear text. Anyone on the network path, for example on a shared Wi-Fi network, can read the traffic and change tool results, which the agent then trusts. `claude plugin validate` also warns about `http://` and `ws://` URLs to hosts other than loopback.',
      'Loopback hosts such as `localhost`, `127.0.0.1` and `::1` are not reported. A Claude Code server with `"type": "sse"` gets an `info` finding, because Claude Code has deprecated the SSE transport in favor of `"type": "http"`.',
      'Use `https://` or `wss://`.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: ['mcp-json', 'claude-plugin-manifest', 'cursor-mcp', 'gemini-settings'],
    platforms: ['claude-code', 'cursor', 'gemini'],
    sources: [SOURCES.claudePlugins, SOURCES.claudeMcp, SOURCES.cursorMcp, SOURCES.geminiMcp],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platform = mcpPlatform(artifact);
      if (platform === undefined || !context.targets.has(platform)) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'findings about MCP transports');
      for (const server of mcpServers(artifact, doc)) {
        for (const field of ['url', 'httpUrl']) {
          const value = own(server.config, field);
          if (typeof value !== 'string') continue;
          const insecure = insecureHost(value);
          if (insecure === undefined) continue;
          const secure = insecure.scheme === 'ws' ? 'wss://' : 'https://';
          findings.report({
            artifact,
            ...at(spanOf(doc, [...server.path, field])),
            message: `MCP server ${quote(server.name)} connects to ${quote(insecure.host)} over unencrypted ${insecure.scheme}://, so anyone on the network path can read and change its traffic, including credentials in headers. Use ${secure}.`,
            platforms: [platform],
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
          });
        }
      }
      findings.finish();
    }
  },
});
