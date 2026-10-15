import { describe, expect, it } from 'vitest';
import { geminiServerNameRule } from '../../../src/rules/mcp/gemini-server-name.js';
import { geminiTrustRule } from '../../../src/rules/mcp/gemini-trust.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

describe('mcp/gemini-trust', () => {
  const ID = 'mcp/gemini-trust';
  const rules = [geminiTrustRule];

  it('reports a trusted server', () => {
    const text = json({
      mcpServers: {
        deploy: { command: 'deploy-mcp', trust: true },
        safe: { command: 'x', trust: false },
      },
    });
    expect(findings(lint({ '.gemini/settings.json': text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.gemini/settings.json',
        message:
          'MCP server "deploy" has "trust": true, so Gemini CLI runs every tool call from it without asking for confirmation.',
        range: rangeOf(text, '"trust"'),
      },
    ]);
  });

  it('does not report other values, other files or untargeted runs', () => {
    const text = json({ mcpServers: { a: { command: 'x', trust: 'true' }, b: { command: 'y' } } });
    expect(findings(lint({ '.gemini/settings.json': text }, { rules }), ID)).toEqual([]);
    const trusted = json({ mcpServers: { a: { command: 'x', trust: true } } });
    expect(
      findings(lint({ '.cursor/mcp.json': trusted, '.mcp.json': trusted }, { rules }), ID),
    ).toEqual([]);
    expect(
      findings(lint({ '.gemini/settings.json': trusted }, { rules, targets: ['claude-code'] }), ID),
    ).toEqual([]);
  });
});

describe('mcp/gemini-server-name', () => {
  const ID = 'mcp/gemini-server-name';
  const rules = [geminiServerNameRule];

  it('reports server names with underscores', () => {
    const text = json({
      mcpServers: { my_server: { command: 'x' }, 'my-server': { command: 'y' } },
    });
    expect(findings(lint({ '.gemini/settings.json': text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.gemini/settings.json',
        message:
          'MCP server name "my_server" contains "_", so Gemini CLI\'s policy parser misreads the server in its tool names and policy rules for it can fail silently. Rename it to "my-server".',
        range: rangeOf(text, '"my_server"'),
      },
    ]);
  });

  it('does not report Claude Code or Cursor files', () => {
    const text = json({ mcpServers: { my_server: { command: 'x' } } });
    expect(findings(lint({ '.mcp.json': text, '.cursor/mcp.json': text }, { rules }), ID)).toEqual(
      [],
    );
  });
});
