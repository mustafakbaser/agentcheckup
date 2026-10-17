import { describe, expect, it } from 'vitest';
import { configInvalidRule } from '../../../src/rules/codex/config-invalid.js';
import { findings, lint } from '../../helpers/lint.js';
import { rangeOf } from '../json/helpers.js';

const ID = 'codex/config-invalid';
const rules = [configInvalidRule];
const FILE = '.codex/config.toml';

function run(
  files: Record<string, string | Uint8Array>,
  targets?: Parameters<typeof lint>[1]['targets'],
) {
  return findings(
    lint(files, { rules, paths: ['.git/HEAD'], ...(targets ? { targets } : {}) }),
    ID,
  );
}

const lines = (...items: string[]): string => `${items.join('\n')}\n`;

describe('codex/config-invalid', () => {
  it('reports TOML that Codex cannot parse, at the first problem', () => {
    const text = lines('[mcp_servers.docs]', 'command = "npx"', 'command = "node"');
    expect(run({ [FILE]: text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: FILE,
        message:
          'This file is not valid TOML: Key "command" is defined more than once. In a trusted project Codex stops at startup with "Error parsing project config file", so no session starts here.',
        range: rangeOf(text, 'command', 1),
      },
    ]);
    expect(run({ [FILE]: 'model = \n' })[0]?.message).toContain('Expected a value after "=".');
  });

  it('reports a file that is not UTF-8', () => {
    const bytes = Uint8Array.of(0x61, 0x20, 0x3d, 0x20, 0x22, 0xc3, 0x28, 0x22, 0x0a);
    expect(run({ [FILE]: bytes }).map((found) => [found.severity, found.message])).toEqual([
      [
        'error',
        'This file is not valid UTF-8, so Codex cannot read it and stops at startup with "Failed to read project config file", in trusted and untrusted projects alike.',
      ],
    ]);
  });

  it('accepts TOML 1.1, a byte order mark and every spelling of a table', () => {
    const toml11 = lines(
      'mcp_servers = {',
      '  docs = { command = "npx", args = ["-y", "@acme/docs"], }, # trailing comma',
      '}',
      'note = "\\e[1m\\x41"',
      'at = 07:32',
    );
    expect(run({ [FILE]: toml11 })).toEqual([]);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a = 1\n')]);
    expect(run({ [FILE]: bom })).toEqual([]);
    expect(run({ [FILE]: '' })).toEqual([]);
  });

  it('leaves files agentcheckup does not parse alone: limits and UTF-16', () => {
    const utf16 = Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x3d, 0, 0x31, 0);
    expect(run({ [FILE]: utf16 })).toEqual([]);
    expect(run({ [FILE]: `a = ${'['.repeat(100)}${']'.repeat(100)}\n` })).toEqual([]);
  });

  it('warns about server entries Codex rejects', () => {
    const text = lines(
      '[mcp_servers.none]',
      'args = ["x"]',
      '[mcp_servers.both]',
      'command = "npx"',
      'url = "https://x.dev/mcp"',
      '[mcp_servers.token]',
      'url = "https://x.dev/mcp"',
      'bearer_token = "abc"',
      '[mcp_servers.stdio_only]',
      'url = "https://x.dev/mcp"',
      'env = { A = "1" }',
    );
    const found = run({ [FILE]: text });
    expect(found.map(({ severity, range }) => [severity, range])).toEqual([
      ['warn', rangeOf(text, 'none')],
      ['warn', rangeOf(text, 'url')],
      ['warn', rangeOf(text, 'bearer_token')],
      ['warn', rangeOf(text, 'env')],
    ]);
    expect(found.map((item) => item.message)).toEqual([
      'MCP server "none" has neither "command" nor "url", so it has no transport ("invalid transport"). Codex rejects the entry; whether it then stops at startup or only drops the server is not verified.',
      'MCP server "both" is a local (stdio) server, and Codex does not take "url" there ("url is not supported for stdio"). Codex rejects the entry; whether it then stops at startup or only drops the server is not verified.',
      'MCP server "token" sets "bearer_token", which Codex does not take on any server ("bearer_token is not supported for streamable_http"). Codex rejects the entry; whether it then stops at startup or only drops the server is not verified.',
      'MCP server "stdio_only" is a remote (streamable HTTP) server, and Codex does not take "env" there ("env is not supported for streamable_http"). Codex rejects the entry; whether it then stops at startup or only drops the server is not verified.',
    ]);
  });

  it('judges a server as Codex merges it with the layers above', () => {
    const files = {
      [FILE]: lines('[mcp_servers.docs]', 'command = "npx"'),
      // Only turns the root's server off: no transport of its own, which is fine.
      [`pkg/${FILE}`]: lines('[mcp_servers.docs]', 'enabled = false'),
      // Adds a url to the root's stdio server.
      [`tools/${FILE}`]: lines('[mcp_servers.docs]', 'url = "https://x.dev/mcp"'),
    };
    expect(run(files).map((found) => [found.path, found.message.slice(0, 40)])).toEqual([
      [`tools/${FILE}`, 'MCP server "docs" is a local (stdio) ser'],
    ]);
  });

  it('accepts valid servers of both transports', () => {
    const text = lines(
      '[mcp_servers.local]',
      'command = "npx"',
      'args = ["-y", "@acme/docs@1.0.0"]',
      'env = { A = "1" }',
      'env_vars = ["HOME"]',
      '[mcp_servers.remote]',
      'url = "https://x.dev/mcp"',
      'bearer_token_env_var = "X_TOKEN"',
      'http_headers = { "X-Team" = "core" }',
    );
    expect(run({ [FILE]: text })).toEqual([]);
  });

  it('runs only for Codex', () => {
    expect(run({ [FILE]: '[a\n' }, ['claude-code'])).toEqual([]);
  });
});
