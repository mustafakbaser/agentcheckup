import { describe, expect, it } from 'vitest';
import { envSyntaxMismatchRule } from '../../../src/rules/mcp/env-syntax-mismatch.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'mcp/env-syntax-mismatch';
const rules = [envSyntaxMismatchRule];

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('mcp/env-syntax-mismatch', () => {
  it("reports Cursor's ${env:NAME} in .mcp.json", () => {
    const text = json({
      mcpServers: {
        github: { command: 'npx', args: ['server', '--token', '${env:GITHUB_TOKEN}'] },
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.mcp.json',
        message:
          '"${env:GITHUB_TOKEN}" is Cursor\'s variable syntax, which Claude Code does not expand, so the server gets this text instead of the value of GITHUB_TOKEN. Write "${GITHUB_TOKEN}".',
        range: rangeOf(text, '"${env:GITHUB_TOKEN}"'),
      },
    ]);
  });

  it('reports Cursor built-ins, $NAME and %NAME% where Claude Code does not expand them', () => {
    const text = json({
      mcpServers: {
        files: {
          command: 'node',
          args: ['server.js'],
          env: { ROOT: '${workspaceFolder}/data', KEY: '$API_KEY' },
        },
        api: {
          type: 'http',
          url: 'https://api.tools.dev/%TENANT%/mcp',
          headers: { Authorization: 'Bearer $API_TOKEN' },
        },
      },
    });
    expect(run({ '.mcp.json': text }).map((finding) => finding.message)).toEqual([
      '"${workspaceFolder}" is a Cursor variable that Claude Code does not have, so the server gets this text unchanged.',
      'Claude Code does not expand "$API_KEY" in this field, so the server gets this text instead of the value of API_KEY. Write "${API_KEY}".',
      'Claude Code does not expand "%TENANT%" in this field, so the server gets this text instead of the value of TENANT. Write "${TENANT}".',
      'Claude Code does not expand "$API_TOKEN" in this field, so the server gets this text instead of the value of API_TOKEN. Write "${API_TOKEN}".',
    ]);
  });

  it('accepts Claude Code syntax and leaves shell-expanded arguments alone', () => {
    const text = json({
      mcpServers: {
        a: {
          command: 'bash',
          args: ['-c', 'server --home $HOME --port %PORT%'],
          env: {
            TOKEN: '${GITHUB_TOKEN}',
            URL: '${BASE:-https://x.dev}',
            PRICE: 'costs $5',
            LOWER: '$lower',
            MIXED: 'a$Bc',
          },
          description: '${env:NOT_A_SERVER_FIELD}',
        },
        b: {
          type: 'http',
          url: 'https://x.dev/mcp?q=50%25&s=%E2%9C%93%20ok',
          headers: { 'X-Id': '${ID}', P: '100%', OS: '%OS%' },
        },
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([]);
  });

  it('reports ${env:NAME} and Cursor built-ins in Gemini CLI settings', () => {
    const text = json({
      mcpServers: {
        github: {
          command: 'npx',
          env: { TOKEN: '${env:GITHUB_TOKEN}', OK: '$GITHUB_TOKEN', ALSO: '${GITHUB_TOKEN}' },
          cwd: '${workspaceFolder}',
        },
      },
    });
    expect(run({ '.gemini/settings.json': text }).map((finding) => finding.message)).toEqual([
      '"${env:GITHUB_TOKEN}" is Cursor\'s variable syntax, which Gemini CLI does not expand, so the server does not get the value of GITHUB_TOKEN. Write "$GITHUB_TOKEN".',
      '"${workspaceFolder}" is a Cursor variable. Gemini CLI reads it as an environment variable named "workspaceFolder", which is normally not set, so the server does not get the value Cursor would use.',
    ]);
  });

  it('checks inline plugin servers but accepts plugin variables', () => {
    const text = json({
      name: 'p',
      mcpServers: {
        s: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
          env: { TOKEN: '${user_config.api_token}', OTHER: '${env:OTHER}' },
        },
      },
    });
    expect(run({ '.claude-plugin/plugin.json': text })).toHaveLength(1);
  });

  it("does not report Cursor's own files or untargeted platforms", () => {
    const cursor = json({ mcpServers: { a: { command: 'x', env: { T: '${env:T}', U: '${U}' } } } });
    expect(run({ '.cursor/mcp.json': cursor })).toEqual([]);
    const claude = json({ mcpServers: { a: { command: 'x', args: ['${env:T}'] } } });
    expect(run({ '.mcp.json': claude, '.gemini/settings.json': claude }, ['cursor'])).toEqual([]);
    expect(run({ '.mcp.json': claude, '.gemini/settings.json': claude }, ['gemini'])).toHaveLength(
      1,
    );
  });

  it('ignores unterminated and overlong references', () => {
    const text = json({
      mcpServers: {
        a: { command: 'x', args: ['${env:BROKEN', `\${env:${'A'.repeat(200)}}`, '${env:}'] },
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([]);
  });

  it("skips .mcp.json files that belong to another agent's plugin", () => {
    const text = json({ mcpServers: { a: { command: 'x', args: ['${env:T}'] } } });
    const files = { 'p/.mcp.json': text, 'p/.codex-plugin/plugin.json': json({ name: 'p' }) };
    expect(run(files)).toEqual([]);
  });
});

describe('mcp/env-syntax-mismatch in Codex config.toml', () => {
  const FILE = '.codex/config.toml';

  it('reports references Codex passes on as text, as info', () => {
    const text = [
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["--dir", "${workspaceFolder}"]',
      'env = { GITHUB_TOKEN = "${GITHUB_TOKEN}", HOME_DIR = "$HOME" }',
      '[mcp_servers.remote]',
      'url = "https://x.dev/mcp"',
      'http_headers = { Authorization = "Bearer ${env:API_TOKEN}" }',
      '',
    ].join('\n');
    const result = lint({ [FILE]: text }, { rules });
    const found = findings(result, ID);
    expect(found.map(({ severity, range }) => [severity, range])).toEqual([
      ['info', rangeOf(text, '"${workspaceFolder}"')],
      ['info', rangeOf(text, '"${GITHUB_TOKEN}"')],
      ['info', rangeOf(text, '"$HOME"')],
      ['info', rangeOf(text, '"Bearer ${env:API_TOKEN}"')],
    ]);
    expect(found.map((item) => item.message)).toEqual([
      '"${workspaceFolder}" is a Cursor variable. Codex expands no variables in config.toml, so the server gets this text unchanged.',
      'Codex expands no variables in config.toml, so the server gets "${GITHUB_TOKEN}" as text instead of the value of GITHUB_TOKEN. To use the variable, list GITHUB_TOKEN in "env_vars" to pass it from the environment.',
      'Codex expands no variables in config.toml, so the server gets "$HOME" as text instead of the value of HOME. To use the variable, list HOME in "env_vars" to pass it from the environment.',
      'Codex expands no variables in config.toml, so the server gets "${env:API_TOKEN}" as text instead of the value of API_TOKEN. To use the variable, move the header to "env_http_headers", which names the variable that holds its value.',
    ]);
    expect(result.findings.every((finding) => finding.fix === undefined)).toBe(true);
  });

  it('does not report names, $ in arguments a shell may expand, or plain values', () => {
    const text = [
      '[mcp_servers.github]',
      'command = "sh"',
      'args = ["-c", "exec server --home $HOME"]',
      'env_vars = ["GITHUB_TOKEN"]',
      'env = { PRICE = "$5", ENCODED = "a%20b%20c" }',
      '[mcp_servers.remote]',
      'url = "https://x.dev/mcp?q=%E2%9C%93"',
      'env_http_headers = { Authorization = "API_TOKEN" }',
      'bearer_token_env_var = "TOKEN"',
      '',
    ].join('\n');
    expect(run({ [FILE]: text })).toEqual([]);
    expect(run({ [FILE]: '[mcp_servers.a]\ncommand = "${X}"\n' }, ['claude-code'])).toEqual([]);
  });
});
