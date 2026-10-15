import { RULESET_VERSION } from '../../core/meta.js';
import { urlWithoutType } from '../../platforms/mcp.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, mcpServers } from './servers.js';

export const urlWithoutTypeRule = defineRule({
  meta: {
    id: 'mcp/url-without-type',
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
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      if (!isClaudeMcpConfig(context.snapshot, artifact)) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'servers with a "url" but no "type"');
      for (const server of mcpServers(artifact, doc)) {
        if (!urlWithoutType(server.config)) continue;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, server.path)),
          message: `MCP server ${quote(server.name)} has a "url" but no "type", so Claude Code reads it as a stdio server and skips it. Add "type": "http" (or "sse" or "ws").`,
        });
      }
      findings.finish();
    }
  },
});
