import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { mcpServers } from './servers.js';
import { MCP_SOURCES } from './sources.js';

export const geminiServerNameRule = defineRule({
  meta: {
    id: 'mcp/gemini-server-name',
    title: 'Gemini CLI MCP server name contains an underscore',
    rationale: [
      'Gemini CLI names MCP tools `mcp_<server>_<tool>`, and its policy parser splits such a name at the first underscore after `mcp_` to find the server. A server named `my_server` is read as server `my` with tool `server_<tool>`, so wildcard rules such as `mcp_my_server_*` and other security policies for this server can fail silently. The documentation says: "Do not use underscores (`_`) in your MCP server names".',
      'Use hyphens instead, for example `my-server`.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['gemini-settings'],
    platforms: ['gemini'],
    sources: [SOURCES.geminiMcp, MCP_SOURCES.geminiPolicyEngine, MCP_SOURCES.geminiMcpToolName],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'server names with underscores');
      for (const server of mcpServers(artifact, doc)) {
        if (!server.name.includes('_')) continue;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, server.path)),
          message: `MCP server name ${quote(server.name)} contains "_", so Gemini CLI's policy parser misreads the server in its tool names and policy rules for it can fail silently. Rename it to ${quote(server.name.replaceAll('_', '-'))}.`,
        });
      }
      findings.finish();
    }
  },
});
