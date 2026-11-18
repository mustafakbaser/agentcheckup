import { RULESET_VERSION } from '../../core/meta.js';
import { claudeReservedServerName } from '../../platforms/mcp.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, mcpServers } from './servers.js';

const ID = 'mcp/reserved-server-name';

export const reservedServerNameRule = defineRule({
  meta: {
    id: ID,
    title: 'MCP server uses a name Claude Code reserves',
    rationale: [
      'Claude Code reserves the names of its built-in MCP servers, including `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview` and `Claude Browser`. A server in `.mcp.json` with one of these names is skipped at load time, with a warning asking you to rename it, so its tools never reach the session.',
      'Rename the server. agentcheckup offers no fix: the new name is yours to choose, and permission rules, `enabledMcpjsonServers` and scripts that name the server must change with it. Names are compared exactly; servers that a plugin declares are not checked, because the documentation does not say whether the reserved names apply to them.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['mcp-json'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeMcp],
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
      }, 'servers with reserved names');
      for (const server of mcpServers(artifact, doc)) {
        if (!claudeReservedServerName(context.snapshot, artifact, server.name)) continue;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, server.path)),
          message: `MCP server name ${quote(server.name)} is reserved for a built-in Claude Code server, so Claude Code skips this server at load time.`,
          guidance: `rename the server, and update the permission rules, "enabledMcpjsonServers" entries and scripts that name ${quote(server.name)}`,
        });
      }
      findings.finish();
    }
  },
});
