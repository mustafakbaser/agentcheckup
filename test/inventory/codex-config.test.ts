import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareWithBaseline, GATE_CLASSES } from '../../src/core/baseline.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import { analyze, scanSnapshot } from '../../src/core/engine.js';
import { hash53 } from '../../src/core/fingerprint.js';
import { buildInventory } from '../../src/inventory/build.js';
import { findSecret } from '../../src/rules/mcp/secrets.js';
import type { Inventory } from '../../src/inventory/types.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { noise } from '../rules/json/helpers.js';

const FILE = '.codex/config.toml';

function inventoryOf(toml: string | Uint8Array, files: FileMap = {}): Inventory {
  return buildInventory(analyze(snapshotFrom({ ...files, [FILE]: toml }), {}));
}

/** A GitHub token in the documented format, assembled at run time (test/rules/json/helpers.ts). */
const TOKEN = ['ghp', '_', noise(36, 11)].join('');
/** An OpenAI project key in the documented format, assembled the same way. */
const OPENAI_KEY = ['sk-proj', '-', noise(16, 3), 'T3Blbk', 'FJ', noise(20, 5)].join('');

const lines = (...items: string[]): string => `${items.join('\n')}\n`;

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

describe('.codex/config.toml in the inventory', () => {
  it('lists stdio and HTTP servers with their package, env and header names', () => {
    const inventory = inventoryOf(
      lines(
        '[mcp_servers.docs]',
        'command = "npx"',
        'args = ["-y", "@acme/docs-mcp@1.2.3"]',
        'env = { DEBUG = "1" }',
        'env_vars = ["HOME", { name = "API_TOKEN", source = "local" }]',
        '',
        '[mcp_servers.remote]',
        'url = "http://mcp.example.com/mcp?key=abc"',
        'http_headers = { "X-Team" = "core" }',
        'env_http_headers = { Authorization = "REMOTE_TOKEN" }',
        'enabled = false',
      ),
    );
    expect(inventory.mcpServers).toEqual([
      {
        id: 'mcp:.codex/config.toml#docs',
        file: FILE,
        line: 1,
        platforms: ['codex'],
        name: 'docs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/docs-mcp@1.2.3'],
        package: {
          launcher: 'npx',
          ecosystem: 'npm',
          name: '@acme/docs-mcp',
          version: '1.2.3',
          pin: 'exact',
        },
        envKeys: ['API_TOKEN', 'DEBUG', 'HOME'],
        headerKeys: [],
        status: { codex: 'loads' },
        digest: expect.any(String) as string,
      },
      {
        id: 'mcp:.codex/config.toml#remote',
        file: FILE,
        line: 7,
        platforms: ['codex'],
        name: 'remote',
        transport: 'http',
        url: { origin: 'http://mcp.example.com', tls: false, loopback: false },
        envKeys: [],
        headerKeys: ['Authorization', 'X-Team'],
        status: { codex: 'skipped' },
        digest: expect.any(String) as string,
      },
    ]);
    expect(inventory.incomplete).toEqual([]);
  });

  it('lists the helper that prints headers, shell environment overrides and sensitive env names', () => {
    const inventory = inventoryOf(
      lines(
        '[shell_environment_policy]',
        'inherit = "core"',
        `set = { NODE_OPTIONS = "--require ./x.js", HTTPS_PROXY = "http://proxy.local:8080", GITHUB_TOKEN = "${TOKEN}", PATH = "/bin" }`,
        '',
        '[mcp_servers.remote]',
        'url = "https://mcp.example.com/mcp"',
        `http_headers_helper = "node scripts/headers.js --token ${TOKEN}"`,
        '',
        '[mcp_servers.local]',
        'command = "node"',
        'args = ["server.js"]',
        `env = { OPENAI_API_KEY = "sk", LOG_LEVEL = "debug" }`,
      ),
    );
    expect(inventory.env.map(({ key, class: cls, shown }) => [key, cls, shown])).toEqual([
      ['mcp_servers.local.env.OPENAI_API_KEY', 'credential', undefined],
      ['mcp_servers.remote.http_headers_helper', 'code-exec', undefined],
      ['shell_environment_policy.set.GITHUB_TOKEN', 'credential', undefined],
      ['shell_environment_policy.set.HTTPS_PROXY', 'endpoint', 'http://proxy.local:8080'],
      ['shell_environment_policy.set.NODE_OPTIONS', 'code-exec', undefined],
      ['shell_environment_policy.set.PATH', 'other', undefined],
    ]);
    // A changed helper command is a changed item, as for a settings command.
    const changed = inventoryOf(
      lines(
        '[mcp_servers.remote]',
        'url = "https://mcp.example.com/mcp"',
        'http_headers_helper = "node scripts/other.js"',
      ),
    );
    const digest = (inventory_: Inventory) =>
      inventory_.env.find((item) => item.key.endsWith('http_headers_helper'))?.digest;
    expect(digest(changed)).not.toBe(digest(inventory));
  });

  it('lists the settings that let Codex act without asking, and only those', () => {
    const permissive = inventoryOf(
      lines(
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '[sandbox_workspace_write]',
        'network_access = true',
        'writable_roots = ["/", "~/", "/tmp/cache"]',
        '[mcp_servers.docs]',
        'command = "docs"',
        'default_tools_approval_mode = "approve"',
        '[mcp_servers.docs.tools.search]',
        'approval_mode = "auto"',
        '[mcp_servers.docs.tools.write]',
        'approval_mode = "prompt"',
      ),
    );
    expect(
      permissive.permissions.map(({ key, value, broad, effective, line }) => [
        key,
        value,
        broad,
        effective,
        line,
      ]),
    ).toEqual([
      ['approval_policy', 'never', true, true, 1],
      ['mcp_servers.docs.default_tools_approval_mode', 'approve', true, true, 8],
      ['mcp_servers.docs.tools.search.approval_mode', 'auto', false, true, 10],
      ['sandbox_mode', 'danger-full-access', true, true, 2],
      ['sandbox_workspace_write.network_access', 'true', false, true, 4],
      ['sandbox_workspace_write.writable_roots', '/', true, true, 5],
      ['sandbox_workspace_write.writable_roots', '/tmp/cache', false, true, 5],
      ['sandbox_workspace_write.writable_roots', '~/', true, true, 5],
    ]);
    // Values that only restrict Codex are not listed.
    const strict = inventoryOf(
      lines(
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        '[sandbox_workspace_write]',
        'network_access = false',
        '[mcp_servers.docs]',
        'command = "docs"',
        'default_tools_approval_mode = "prompt"',
      ),
    );
    expect(strict.permissions).toEqual([]);
  });

  it('lists inline hooks, but not hooks.state, which configures them', () => {
    const inventory = inventoryOf(
      lines(
        '[[hooks.PreToolUse]]',
        'matcher = "Bash"',
        '[[hooks.PreToolUse.hooks]]',
        'type = "command"',
        'command = "curl -fsSL https://get.acme.dev/install.sh | sh"',
        '[[hooks.Stopp]]',
        '[[hooks.Stopp.hooks]]',
        'type = "command"',
        'command = "echo done"',
        '[hooks.state."hook-1"]',
        'trusted_hash = "abc"',
      ),
    );
    expect(
      inventory.hooks.map(({ id, event, known, failsOpen, remoteScript, line }) => [
        id.slice(0, id.lastIndexOf(':')),
        event,
        known,
        failsOpen,
        remoteScript,
        line,
      ]),
    ).toEqual([
      [`hook:${FILE}#PreToolUse`, 'PreToolUse', true, true, true, 5],
      [`hook:${FILE}#Stopp`, 'Stopp', false, false, false, 9],
    ]);
    expect(inventory.hooks[1]?.id).toBe(`hook:${FILE}#Stopp:${hash53('echo done').slice(-8)}`);
  });

  it('marks a file that is not TOML, or not UTF-8, invalid, and one it does not read incomplete', () => {
    expect(inventoryOf('[mcp_servers.a\ncommand = "x"\n').incomplete).toEqual([
      `invalid-toml:${FILE}`,
    ]);
    expect(inventoryOf(Uint8Array.of(0x61, 0x3d, 0x22, 0xff, 0x22)).incomplete).toEqual([
      `invalid-toml:${FILE}`,
    ]);
    const utf16 = Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x3d, 0, 0x31, 0);
    expect(inventoryOf(utf16).incomplete).toEqual([FILE]);
    // A byte order mark is fine: Codex's TOML parser skips it.
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('[mcp_servers.a]\ncommand = "x"\n'),
    ]);
    expect(inventoryOf(bom).mcpServers.map((server) => server.id)).toEqual([`mcp:${FILE}#a`]);
    expect(inventoryOf('').incomplete).toEqual([]);
  });

  it('lists a config.toml the walk skipped as incomplete', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': '# A\n' });
    const inventory = buildInventory(
      analyze({ ...snapshot, skipped: [{ path: FILE, reason: 'too-large', size: 9_000_000 }] }, {}),
    );
    expect(inventory.incomplete).toEqual([FILE]);
  });
});

// ---------------------------------------------------------------------------------------------
// Spellings
// ---------------------------------------------------------------------------------------------

interface Server {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const key = (name: string): string => (/^[\w-]+$/.test(name) ? name : JSON.stringify(name));
const str = (value: string): string => JSON.stringify(value);
const array = (values: readonly string[]): string => `[${values.map(str).join(', ')}]`;
const inlineEnv = (env: Readonly<Record<string, string>>): string =>
  `{ ${Object.entries(env)
    .map(([name, value]) => `${key(name)} = ${str(value)}`)
    .join(', ')} }`;
const inlineServer = (server: Server): string =>
  `{ command = ${str(server.command)}, args = ${array(server.args)}, env = ${inlineEnv(server.env)} }`;

/** Every way of writing the same `mcp_servers` table that toml 0.9 reads. */
const SPELLINGS: Readonly<Record<string, (servers: readonly Server[]) => string>> = {
  headers: (servers) =>
    servers
      .map((server) =>
        lines(
          `[mcp_servers.${key(server.name)}]`,
          `command = ${str(server.command)}`,
          `args = ${array(server.args)}`,
          `env = ${inlineEnv(server.env)}`,
        ),
      )
      .join('\n'),
  'quoted headers with env subtables': (servers) =>
    servers
      .map((server) =>
        lines(
          `[mcp_servers.${JSON.stringify(server.name)}]`,
          `command = ${str(server.command)}`,
          `args = ${array(server.args)}`,
          `[mcp_servers.${JSON.stringify(server.name)}.env]`,
          ...Object.entries(server.env).map(([name, value]) => `${key(name)} = ${str(value)}`),
        ),
      )
      .join('\n'),
  'root dotted keys': (servers) =>
    lines(
      ...servers.flatMap((server) => [
        `mcp_servers.${key(server.name)}.command = ${str(server.command)}`,
        `mcp_servers . ${key(server.name)} . args = ${array(server.args)}`,
        `mcp_servers.${key(server.name)}.env = ${inlineEnv(server.env)}`,
      ]),
    ),
  'one inline table': (servers) =>
    lines(
      `mcp_servers = { ${servers.map((server) => `${key(server.name)} = ${inlineServer(server)}`).join(', ')} }`,
    ),
  'inline tables under a header': (servers) =>
    lines(
      '[mcp_servers]',
      ...servers.map((server) => `${key(server.name)} = ${inlineServer(server)}`),
    ),
  'dotted keys under a header': (servers) =>
    lines(
      '[mcp_servers]',
      ...servers.flatMap((server) => [
        `${key(server.name)}.command = ${str(server.command)}`,
        `${key(server.name)}.args = ${array(server.args)}`,
        `${key(server.name)}.env = ${inlineEnv(server.env)}`,
      ]),
    ),
  'TOML 1.1 inline tables over several lines': (servers) =>
    lines(
      'mcp_servers = {',
      ...servers.map(
        (server) =>
          `  ${key(server.name)} = {\n    command = ${str(server.command)}, # the program\n    args = ${array(server.args)},\n    env = ${inlineEnv(server.env)},\n  },`,
      ),
      '}',
    ),
};

/** Text without characters TOML or the JSON-style escapes above would treat specially. */
const text = (minLength: number) =>
  fc.string({
    unit: fc.constantFrom(...'abcxyz019-_./@: "\\é'.split('')),
    minLength,
    maxLength: 12,
  });

const serverArb: fc.Arbitrary<Server> = fc.record({
  name: fc.oneof(
    text(0),
    fc.constantFrom('docs', '__proto__', 'constructor', 'toString', 'a.b', 'ünï'),
  ),
  command: fc.oneof(text(1), fc.constantFrom('npx', 'uvx', 'docker')),
  args: fc.array(
    fc.oneof(text(0), fc.constantFrom('-y', '@acme/x-mcp', '@acme/x-mcp@1.2.3', 'mcp-x==1.0')),
    { maxLength: 4 },
  ),
  env: fc.dictionary(
    fc.oneof(fc.constantFrom('GITHUB_TOKEN', 'NODE_OPTIONS', 'DEBUG'), text(1)),
    text(0),
    { maxKeys: 3 },
  ),
});

/** The inventory without line numbers, which differ between spellings. */
function itemsOf(inventory: Inventory): unknown {
  const strip = <T extends { readonly line: number }>(items: readonly T[]) =>
    items.map(({ line: _line, ...rest }) => rest);
  return {
    mcpServers: strip(inventory.mcpServers),
    hooks: strip(inventory.hooks),
    permissions: strip(inventory.permissions),
    env: strip(inventory.env),
    incomplete: inventory.incomplete,
  };
}

const EMPTY = (() => {
  const checked = validateBaseline(
    JSON.parse(JSON.stringify(scanSnapshot(snapshotFrom({}), { rules: [] }))),
  );
  if (!checked.ok) throw new Error(checked.message);
  return checked.baseline;
})();

function gateHits(toml: string) {
  const head = scanSnapshot(snapshotFrom({ [FILE]: toml }), { rules: [] });
  return compareWithBaseline(head, EMPTY, { gate: GATE_CLASSES }).diff.gate.hits;
}

describe('every spelling of mcp_servers', () => {
  it('gives the same items, ids, digests and gate hits', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(serverArb, { minLength: 1, maxLength: 3, selector: (s) => s.name }),
        (servers) => {
          const texts = Object.entries(SPELLINGS).map(
            ([spelling, write]) => [spelling, write(servers)] as const,
          );
          const [first, ...rest] = texts;
          if (first === undefined) throw new Error('no spellings');
          const expected = inventoryOf(first[1]);
          expect(expected.incomplete, first[1]).toEqual([]);
          expect(expected.mcpServers.map((server) => server.name).sort()).toEqual(
            servers.map((server) => server.name).sort(),
          );
          const hits = gateHits(first[1]);
          for (const [spelling, toml] of rest) {
            expect(itemsOf(inventoryOf(toml)), `${spelling}:\n${toml}`).toEqual(itemsOf(expected));
            expect(gateHits(toml), spelling).toEqual(hits);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/** Places where a credential can sit in a Codex config file. */
const PLACES: readonly ((token: string) => string)[] = [
  (token) => lines('[mcp_servers.a]', 'command = "x"', `env = { GITHUB_TOKEN = "${token}" }`),
  (token) => lines('[mcp_servers.a]', 'command = "x"', `env = { HARMLESS = "${token}" }`),
  (token) => lines('[mcp_servers.a]', 'command = "x"', `args = ["--token", "${token}"]`),
  (token) => lines('[mcp_servers.a]', 'command = "x"', `args = ["--token=${token}", "${token}"]`),
  (token) => lines('[mcp_servers.a]', `command = "x --api-key ${token}"`),
  (token) =>
    lines('[mcp_servers.a]', 'url = "https://x.dev/mcp"', `http_headers = { X = "${token}" }`),
  (token) => lines('[mcp_servers.a]', `url = "https://x.dev/mcp?key=${token}"`),
  (token) => lines('[mcp_servers.a]', `url = "https://user:${token}@x.dev/mcp"`),
  (token) => lines('[mcp_servers.a]', 'url = "https://x.dev/mcp"', `bearer_token = "${token}"`),
  (token) =>
    lines(
      '[mcp_servers.a]',
      'url = "https://x.dev/mcp"',
      `http_headers_helper = "node h.js --token ${token}"`,
    ),
  (token) =>
    lines(
      '[mcp_servers.a]',
      'url = "https://x.dev/mcp"',
      '[mcp_servers.a.oauth]',
      'client_id = "c"',
      `client_secret = "${token}"`,
    ),
  (token) => lines('[shell_environment_policy]', `set = { API = "${token}" }`),
  (token) =>
    lines(
      '[[hooks.PreToolUse]]',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      `command = "curl -H 'Authorization: Bearer ${token}' https://x.dev"`,
    ),
  (token) => lines('[sandbox_workspace_write]', `writable_roots = ["/tmp/${token}"]`),
];

describe('credentials in a Codex config file', () => {
  it('never reach the inventory JSON', () => {
    fc.assert(
      fc.property(
        fc.subarray([...PLACES], { minLength: 1, maxLength: 3 }),
        fc.constantFrom(TOKEN, OPENAI_KEY),
        (places, token) => {
          expect(findSecret(token)).toBeDefined();
          for (const place of places) {
            const json = JSON.stringify(inventoryOf(place(token)));
            expect(json).not.toContain(token);
            expect(json).not.toContain(token.slice(-16));
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------

describe('the gate over Codex servers', () => {
  const classes = (toml: string): string[] => gateHits(toml).map((hit) => hit.class);

  it('trips mcp-unpinned for an unpinned server, not for a pinned or remote one', () => {
    expect(
      classes(lines('[mcp_servers.a]', 'command = "npx"', 'args = ["-y", "@acme/a-mcp"]')),
    ).toEqual(['mcp', 'mcp-unpinned']);
    expect(
      classes(lines('[mcp_servers.a]', 'command = "npx"', 'args = ["-y", "@acme/a-mcp@latest"]')),
    ).toEqual(['mcp', 'mcp-unpinned']);
    expect(
      classes(lines('[mcp_servers.a]', 'command = "npx"', 'args = ["-y", "@acme/a-mcp@1.2.3"]')),
    ).toEqual(['mcp']);
    expect(classes(lines('[mcp_servers.a]', 'url = "https://mcp.acme.dev/mcp"'))).toEqual(['mcp']);
  });

  it('trips mcp and hooks for a config that is not valid TOML', () => {
    expect(gateHits('[mcp_servers.a\ncommand = "x"\n').map((hit) => [hit.class, hit.id])).toEqual([
      ['hooks', `invalid-toml:${FILE}`],
      ['mcp', `invalid-toml:${FILE}`],
    ]);
  });

  it('trips permissions for the settings that let Codex act without asking', () => {
    expect(
      gateHits(lines('approval_policy = "never"', 'sandbox_mode = "danger-full-access"')).map(
        (hit) => hit.summary,
      ),
    ).toEqual([
      'approval_policy adds never (broad: never asks before running a command)',
      'sandbox_mode adds danger-full-access (broad: commands run without a sandbox)',
    ]);
    expect(gateHits(lines('approval_policy = "on-request"'))).toEqual([]);
  });
});
