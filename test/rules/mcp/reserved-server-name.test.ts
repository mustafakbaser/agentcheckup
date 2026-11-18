import { describe, expect, it } from 'vitest';
import { reservedServerNameRule } from '../../../src/rules/mcp/reserved-server-name.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'mcp/reserved-server-name';
const rules = [reservedServerNameRule];

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('mcp/reserved-server-name', () => {
  it('reports each server in .mcp.json that takes a reserved name, as an error', () => {
    const text = json({
      mcpServers: {
        workspace: { command: 'node', args: ['w.js'] },
        'claude-in-chrome': { command: 'node' },
        'computer-use': { command: 'node' },
        'Claude Preview': { type: 'http', url: 'https://example.com/mcp' },
        'Claude Browser': { type: 'http', url: 'https://example.com/mcp' },
      },
    });
    const result = run({ '.mcp.json': text });
    expect(result.map((finding) => finding.range)).toEqual([
      rangeOf(text, '"workspace"'),
      rangeOf(text, '"claude-in-chrome"'),
      rangeOf(text, '"computer-use"'),
      rangeOf(text, '"Claude Preview"'),
      rangeOf(text, '"Claude Browser"'),
    ]);
    expect(result[0]).toMatchObject({
      severity: 'error',
      message:
        'MCP server name "workspace" is reserved for a built-in Claude Code server, so Claude Code skips this server at load time.',
    });
    const full = lint({ '.mcp.json': text }, { rules }).findings[0];
    expect(full?.guidance).toBe(
      'rename the server, and update the permission rules, "enabledMcpjsonServers" entries and scripts that name "workspace"',
    );
    expect(full?.fix).toBeUndefined();
  });

  it('does not report other names, other spellings or servers of a plugin', () => {
    const text = json({
      mcpServers: {
        Workspace: { command: 'node' },
        'workspace-tools': { command: 'node' },
        'claude preview': { command: 'node' },
        github: { command: 'npx' },
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([]);
    const reserved = json({ mcpServers: { workspace: { command: 'node' } } });
    // Plugin servers load under the plugin's name.
    expect(
      run({
        'plugin/.mcp.json': reserved,
        'plugin/.claude-plugin/plugin.json': json({ name: 'plugin' }),
      }),
    ).toEqual([]);
    expect(
      run({
        'plugin/.claude-plugin/plugin.json': json({
          name: 'p',
          mcpServers: { workspace: { command: 'node' } },
        }),
      }),
    ).toEqual([]);
    // Another agent's plugin, which Claude Code does not load.
    expect(
      run({ 'x/.mcp.json': reserved, 'x/.codex-plugin/plugin.json': json({ name: 'x' }) }),
    ).toEqual([]);
  });

  it('does not run when Claude Code is not targeted', () => {
    const text = json({ mcpServers: { workspace: { command: 'node' } } });
    expect(run({ '.mcp.json': text }, ['copilot'])).toEqual([]);
  });
});
