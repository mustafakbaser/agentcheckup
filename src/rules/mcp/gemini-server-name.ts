import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonRenameKey } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { at, FileFindings, isObject, keySpanOf, own, ownObject } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { type McpServer, mcpServers } from './servers.js';
import { MCP_SOURCES } from './sources.js';

const ID = 'mcp/gemini-server-name';

/** Gemini CLI settings that name MCP servers: `mcp.allowed` and `mcp.excluded`. */
function namedElsewhere(root: unknown, name: string): boolean {
  if (!isObject(root)) return false;
  const mcp = ownObject(root, 'mcp');
  if (mcp === undefined) return false;
  return ['allowed', 'excluded'].some((key) => {
    const list = own(mcp, key);
    return Array.isArray(list) && list.includes(name);
  });
}

function fixFor(artifact: Artifact, server: McpServer, renamed: string): Fix | undefined {
  const change = jsonRenameKey(artifact, server.path, renamed);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#rename`,
    class: 'review',
    title: `Rename MCP server ${quote(server.name)} to ${quote(renamed)}`,
    changes: [change],
    notes: [
      `Tool names change from mcp_${server.name}_… to mcp_${renamed}_…: update policy rules and scripts that name them.`,
    ],
  };
}

export const geminiServerNameRule = defineRule({
  meta: {
    id: ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Renames the server, replacing each "_" with "-". Not offered when another server has that name or "mcp.allowed" or "mcp.excluded" names the server.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const canEdit = editable(artifact);
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'server names with underscores');
      for (const server of mcpServers(artifact, doc)) {
        if (!server.name.includes('_')) continue;
        const renamed = server.name.replaceAll('_', '-');
        const listed = namedElsewhere(doc.value, server.name);
        const fix =
          canEdit && !listed && findings.listsNext ? fixFor(artifact, server, renamed) : undefined;
        const guidance = !canEdit
          ? sharedFileGuidance(artifact)
          : listed
            ? `rename it in "mcp.allowed" or "mcp.excluded" too`
            : undefined;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, server.path)),
          message: `MCP server name ${quote(server.name)} contains "_", so Gemini CLI's policy parser misreads the server in its tool names and policy rules for it can fail silently. Rename it to ${quote(renamed)}.`,
          ...(fix === undefined ? {} : { fix }),
          ...(guidance === undefined ? {} : { guidance }),
        });
      }
      findings.finish();
    }
  },
});
