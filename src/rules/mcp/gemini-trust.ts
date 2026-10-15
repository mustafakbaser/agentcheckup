import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf, own } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { mcpServers } from './servers.js';

export const geminiTrustRule = defineRule({
  meta: {
    id: 'mcp/gemini-trust',
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
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'trusted servers');
      for (const server of mcpServers(artifact, doc)) {
        if (own(server.config, 'trust') !== true) continue;
        findings.report({
          artifact,
          ...at(keySpanOf(doc, [...server.path, 'trust'])),
          message: `MCP server ${quote(server.name)} has "trust": true, so Gemini CLI runs every tool call from it without asking for confirmation.`,
        });
      }
      findings.finish();
    }
  },
});
