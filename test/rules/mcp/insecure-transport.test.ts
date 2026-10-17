import { describe, expect, it } from 'vitest';
import { insecureHost, insecureTransportRule } from '../../../src/rules/mcp/insecure-transport.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'mcp/insecure-transport';
const rules = [insecureTransportRule];

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('mcp/insecure-transport', () => {
  it('reports http:// to a remote host', () => {
    const text = json({ mcpServers: { api: { type: 'http', url: 'http://api.tools.dev/mcp' } } });
    expect(run({ '.mcp.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.mcp.json',
        message:
          'MCP server "api" connects to "api.tools.dev" over unencrypted http://, so anyone on the network path can read and change its traffic, including credentials in headers. Use https://.',
        range: rangeOf(text, '"http://api.tools.dev/mcp"'),
      },
    ]);
  });

  it('reports ws://, Cursor and Gemini CLI servers, and plugin servers', () => {
    expect(
      run({
        '.mcp.json': json({ mcpServers: { live: { type: 'ws', url: 'ws://push.tools.dev/mcp' } } }),
      })[0]?.message,
    ).toMatch(/over unencrypted ws:\/\/, .*Use wss:\/\/\.$/);
    expect(
      run({
        '.cursor/mcp.json': json({ mcpServers: { a: { url: 'HTTP://API.TOOLS.DEV/mcp' } } }),
      })[0]?.message,
    ).toContain('connects to "api.tools.dev"');
    const gemini = json({
      mcpServers: {
        a: { httpUrl: 'http://10.0.0.5:8080/mcp' },
        b: { url: 'http://192.168.1.2/sse' },
      },
    });
    expect(run({ '.gemini/settings.json': gemini })).toHaveLength(2);
    expect(
      run({
        '.claude-plugin/plugin.json': json({
          name: 'p',
          mcpServers: { a: { type: 'http', url: 'http://x.dev' } },
        }),
      }),
    ).toHaveLength(1);
  });

  it('does not report loopback, encrypted or templated URLs', () => {
    const urls = [
      'http://localhost:3000/mcp',
      'http://127.0.0.1:8080/mcp',
      'http://127.1/mcp',
      'http://[::1]:9000/mcp',
      'http://0.0.0.0:3000/mcp',
      'http://mcp.localhost/mcp',
      'https://api.tools.dev/mcp',
      'wss://push.tools.dev/mcp',
      '${API_BASE_URL:-http://api.tools.dev}/mcp',
      'http://${HOST}/mcp',
      'http://%HOST%/mcp',
      'not a url',
      'http://',
    ];
    const servers = Object.fromEntries(urls.map((url, i) => [`s${i}`, { type: 'http', url }]));
    expect(run({ '.mcp.json': json({ mcpServers: servers }) })).toEqual([]);
    expect(insecureHost('http://[::1]/x')).toBeUndefined();
  });

  it('notes the deprecated SSE transport for Claude Code only', () => {
    const text = json({ mcpServers: { old: { type: 'sse', url: 'https://old.tools.dev/sse' } } });
    expect(run({ '.mcp.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'info',
        path: '.mcp.json',
        message:
          'MCP server "old" uses the SSE transport, which Claude Code has deprecated. Use "type": "http" if the server supports Streamable HTTP.',
        range: rangeOf(text, '"sse"'),
      },
    ]);
    expect(run({ '.cursor/mcp.json': text })).toEqual([]);
  });

  it('respects targets', () => {
    const text = json({ mcpServers: { api: { url: 'http://api.tools.dev/mcp' } } });
    expect(
      run({ '.mcp.json': text, '.cursor/mcp.json': text }, ['cursor']).map(
        (finding) => finding.path,
      ),
    ).toEqual(['.cursor/mcp.json']);
  });

  it("keeps the http:// warning but drops the Claude Code SSE note for another agent's plugin", () => {
    const text = json({
      mcpServers: { old: { type: 'sse', url: 'http://old.tools.dev/sse' } },
    });
    const result = run({ 'p/.mcp.json': text, 'p/.codex-plugin/plugin.json': json({ name: 'p' }) });
    expect(result.map((finding) => finding.severity)).toEqual(['warn']);
  });
});

describe('mcp/insecure-transport in Codex config.toml', () => {
  const FILE = '.codex/config.toml';

  it('reports http:// to a remote host, with guidance instead of a fix', () => {
    const text = '[mcp_servers.api]\nurl = "http://api.tools.dev/mcp"\n';
    const result = lint({ [FILE]: text }, { rules });
    expect(findings(result, ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: FILE,
        message:
          'MCP server "api" connects to "api.tools.dev" over unencrypted http://, so anyone on the network path can read and change its traffic, including credentials in headers. Use https://.',
        range: rangeOf(text, '"http://api.tools.dev/mcp"'),
      },
    ]);
    expect(result.findings[0]?.fix).toBeUndefined();
    expect(result.findings[0]?.guidance).toBe(
      'change the URL to https:// if the server accepts it at this address',
    );
  });

  it('does not report https://, loopback hosts, other fields or other targets', () => {
    const text = [
      '[mcp_servers.secure]',
      'url = "https://api.tools.dev/mcp"',
      '[mcp_servers.local]',
      'url = "http://localhost:3000/api/mcp"',
      '[mcp_servers.other]',
      'command = "x"',
      'httpUrl = "http://api.tools.dev/mcp"',
      '',
    ].join('\n');
    expect(run({ [FILE]: text })).toEqual([]);
    expect(run({ [FILE]: '[mcp_servers.a]\nurl = "http://api.tools.dev"\n' }, ['cursor'])).toEqual(
      [],
    );
  });
});
