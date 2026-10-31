import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix } from '../../core/types.js';
import { jsonRemoveProperty } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf, own } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { type McpServer, mcpServers } from './servers.js';

const ID = 'mcp/gemini-trust';

function fixFor(artifact: Artifact, server: McpServer): Fix | undefined {
  const change = jsonRemoveProperty(artifact, [...server.path, 'trust']);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#remove`,
    class: 'review',
    title: `Remove "trust": true from MCP server ${quote(server.name)}`,
    changes: [change],
    notes: ['Gemini CLI asks for confirmation before each tool call from this server again.'],
  };
}

export const geminiTrustRule = defineRule({
  meta: {
    id: ID,
    title: 'Gemini CLI MCP server is trusted and skips tool confirmations',
    rationale: [
      'In Gemini CLI, `"trust": true` on an MCP server "bypasses all tool call confirmations for this server". Every tool the server offers, including tools a later version adds, runs without the user approving the call. In a committed `.gemini/settings.json` this applies to everyone who opens the project, unless folder trust is on and the project is not trusted.',
      "Remove `trust`, or allow only the specific tools you need with the server's `includeTools` list and Gemini CLI's policy rules.",
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: ['gemini-settings'],
    platforms: ['gemini'],
    sources: [SOURCES.geminiMcp],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary: 'Removes "trust" from the server, so Gemini CLI asks before each tool call again.',
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
      }, 'trusted servers');
      for (const server of mcpServers(artifact, doc)) {
        if (own(server.config, 'trust') !== true) continue;
        const fix = canEdit && findings.listsNext ? fixFor(artifact, server) : undefined;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, [...server.path, 'trust'])),
          message: `MCP server ${quote(server.name)} has "trust": true, so Gemini CLI runs every tool call from it without asking for confirmation.`,
          ...(fix === undefined ? {} : { fix }),
          ...(canEdit ? {} : { guidance: sharedFileGuidance(artifact) }),
        });
      }
      findings.finish();
    }
  },
});
