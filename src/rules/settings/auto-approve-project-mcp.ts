import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { at, isObject, keySpanOf, own } from '../json/access.js';
import { SOURCES } from '../sources.js';

export const autoApproveProjectMcpRule = defineRule({
  meta: {
    id: 'settings/auto-approve-project-mcp',
    title: 'Settings approve every project MCP server automatically',
    rationale: [
      'In interactive sessions, Claude Code asks before it uses a server from a project\'s `.mcp.json`. `"enableAllProjectMcpServers": true` approves every server in that file without asking, including servers that a later commit or pull request adds. In a committed `.claude/settings.json` it takes effect once a teammate trusts the project; from then on, whoever can change `.mcp.json` can start a new process on that teammate\'s machine without a prompt.',
      'List the servers you trust by name in `enabledMcpjsonServers` instead.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: ['claude-settings'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSettings, SOURCES.claudeMcp],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok || !isObject(doc.value)) continue;
      if (own(doc.value, 'enableAllProjectMcpServers') !== true) continue;
      context.report({
        artifact,
        ...at(keySpanOf(doc, ['enableAllProjectMcpServers'])),
        message:
          '"enableAllProjectMcpServers": true approves every server in this project\'s .mcp.json without a prompt, including servers that later commits add. List trusted servers in "enabledMcpjsonServers" instead.',
      });
    }
  },
});
