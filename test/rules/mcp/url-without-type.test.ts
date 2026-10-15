import { describe, expect, it } from 'vitest';
import { urlWithoutTypeRule } from '../../../src/rules/mcp/url-without-type.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'mcp/url-without-type';
const rules = [urlWithoutTypeRule];

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('mcp/url-without-type', () => {
  it('reports a server with a url and no type in .mcp.json', () => {
    const text = json({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        notion: { url: 'https://mcp.notion.com/mcp' },
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.mcp.json',
        message:
          'MCP server "notion" has a "url" but no "type", so Claude Code reads it as a stdio server and skips it. Add "type": "http" (or "sse" or "ws").',
        range: rangeOf(text, '"notion"'),
      },
    ]);
  });

  it('reports inline servers in a plugin manifest, as a map or inside an array', () => {
    const text = json({
      name: 'deploy-tools',
      mcpServers: ['./mcp/servers.json', { api: { url: 'https://api.tools.dev/mcp' } }],
    });
    const result = run({ 'plugin/.claude-plugin/plugin.json': text });
    expect(result.map((finding) => finding.range)).toEqual([rangeOf(text, '"api"')]);
    const map = json({ name: 'x', mcpServers: { api: { url: 'https://api.tools.dev/mcp' } } });
    expect(run({ '.claude-plugin/plugin.json': map })).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const text = json({ mcpServers: { remote: { url: 'https://r.dev/mcp' } } }).replaceAll(
      '\n',
      '\r\n',
    );
    expect(run({ '.mcp.json': text })[0]?.range.start).toEqual({ line: 3, column: 5 });
  });

  it('does not report servers with a type, a command, or no url', () => {
    const text = json({
      mcpServers: {
        a: { type: 'http', url: 'https://a.dev/mcp' },
        b: { type: 'sse', url: 'https://b.dev/sse' },
        c: { type: 'streamable-http', url: 'https://c.dev/mcp' },
        d: { command: 'node', args: ['server.js'], url: 'https://ignored.dev' },
        e: { command: 'uvx', args: ['mcp-server-git'] },
        f: { url: 42 },
        g: 'not an object',
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([]);
  });

  it('does not apply to Cursor or Gemini CLI files, or when Claude Code is not targeted', () => {
    const server = json({ mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } });
    expect(run({ '.cursor/mcp.json': server, '.gemini/settings.json': server })).toEqual([]);
    expect(run({ '.mcp.json': server }, ['cursor'])).toEqual([]);
  });

  it('ignores files that are not valid JSON or have no mcpServers object', () => {
    expect(
      run({
        '.mcp.json': '{ "mcpServers": ',
        'a/.mcp.json': '[]',
        'b/.mcp.json': '{"mcpServers": []}',
      }),
    ).toEqual([]);
  });

  it("skips .mcp.json files that belong to another agent's plugin", () => {
    // twentyhq/twenty: packages/twenty-agent-skills is a Codex plugin.
    const server = json({ mcpServers: { 'twenty-docs': { url: 'https://docs.twenty.com/mcp' } } });
    const manifest = json({ name: 'twenty' });
    expect(
      run({
        'packages/skills/.mcp.json': server,
        'packages/skills/.codex-plugin/plugin.json': manifest,
      }),
    ).toEqual([]);
    // A plugin that also targets Claude Code, and a Claude plugin, are checked.
    expect(
      run({
        'both/.mcp.json': server,
        'both/.codex-plugin/plugin.json': manifest,
        'both/.claude-plugin/plugin.json': manifest,
        'claude/.mcp.json': server,
        'claude/.claude-plugin/plugin.json': manifest,
      }).map((finding) => finding.path),
    ).toEqual(['both/.mcp.json', 'claude/.mcp.json']);
  });
});
