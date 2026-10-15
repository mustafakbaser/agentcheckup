/**
 * Property: a credential written into an MCP server's `env`, `headers`, `url` or arguments, into
 * Claude Code settings `env`, or into a hook command never reaches the inventory, neither in the
 * JSON a report prints nor in the text any digest or id hash is computed from (decision 10).
 */
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import type * as Fingerprint from '../../src/core/fingerprint.js';
import { buildInventory } from '../../src/inventory/build.js';
import { snapshotFrom } from '../helpers/lint.js';

const captured = vi.hoisted(() => ({ inputs: [] as string[] }));

vi.mock('../../src/core/fingerprint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Fingerprint>();
  return {
    ...actual,
    hash53: (input: string, seed?: number): string => {
      captured.inputs.push(input);
      return actual.hash53(input, seed);
    },
  };
});

beforeEach(() => {
  captured.inputs.length = 0;
});

const ALPHANUMERIC = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');

/** A random credential. The prefix keeps it from matching any fixed text in the config. */
const secretArb = fc
  .array(fc.constantFrom(...ALPHANUMERIC), { minLength: 16, maxLength: 32 })
  .map((chars) => `Qz${chars.join('')}`);

/** Where a credential sits in an argument list. */
const argForms: readonly ((secret: string) => string[])[] = [
  (s) => ['--token', s],
  (s) => ['--api-key', s],
  (s) => ['--auth', s],
  (s) => ['--header', `Authorization: Bearer ${s}`],
  (s) => ['-H', `X-Api-Key: ${s}`],
  (s) => ['-u', `admin:${s}`],
  (s) => [`--token=${s}`],
  (s) => [`--client-secret=${s}`],
  (s) => [`API_KEY=${s}`],
  (s) => ['-e', `GITHUB_TOKEN=${s}`],
  (s) => ['Authorization:', `Bearer ${s}`],
  (s) => [`--token ${s}`],
  (s) => [`https://admin:${s}@mcp.example.com/sse`],
  (s) => [`https://hooks.example.com/services/${s}`],
  (s) => [`https://mcp.example.com/mcp?api_key=${s}`],
  (s) => [`https://mcp.example.com/mcp#${s}`],
];

/** Environment values that carry a credential, for any variable name. */
const envForms: readonly ((secret: string) => string)[] = [
  (s) => s,
  (s) => `https://user:${s}@proxy.example.com:8080`,
  (s) => `https://gateway.example.com/${s}`,
  (s) => `https://gateway.example.com/v1?key=${s}`,
  (s) => `--require ./preload.js --secret=${s}`,
];

const envNames = [
  'GITHUB_TOKEN',
  'LOG_LEVEL',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ANTHROPIC_BASE_URL',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'DATABASE_URL',
  'CLAUDE_CODE_SHELL_PREFIX',
  'OTEL_EXPORTER_OTLP_HEADERS',
];

/** Hook commands with a credential in a redacted position. */
const commandForms: readonly ((secret: string) => string)[] = [
  (s) => `curl -fsS -H "Authorization: Bearer ${s}" https://api.example.com/v1`,
  (s) => `DEPLOY_TOKEN=${s} ./scripts/deploy.sh`,
  (s) => `./notify --token ${s} --channel ops`,
  (s) => `curl -X POST https://hooks.slack.example/services/${s}`,
  (s) => `node hook.js --password=${s}`,
];

const caseArb = fc.record({
  secret: secretArb,
  argForm: fc.nat(argForms.length - 1),
  envForm: fc.nat(envForms.length - 1),
  envName: fc.constantFrom(...envNames),
  commandForm: fc.nat(commandForms.length - 1),
  launcher: fc.constantFrom(
    ['npx', '-y', '@acme/mcp@1.0.0'],
    ['docker', 'run', '-i', 'acme/mcp:1'],
  ),
  exec: fc.boolean(),
});

type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never;

function filesFor(input: Case) {
  const { secret, launcher } = input;
  const args = [...launcher.slice(1), ...(argForms[input.argForm]?.(secret) ?? [])];
  const envValue = envForms[input.envForm]?.(secret) ?? secret;
  const command = commandForms[input.commandForm]?.(secret) ?? secret;
  const handler = input.exec
    ? { type: 'command', command: 'node', args: ['hook.js', '--token', secret] }
    : { type: 'command', command };
  return {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        local: {
          command: `API_KEY=${secret} ${launcher[0]}`,
          args,
          env: { [input.envName]: envValue, PLAIN: secret },
          headers: { Authorization: `Bearer ${secret}` },
        },
        remote: {
          type: 'http',
          url: `https://u:${secret}@mcp.example.com/${secret}?key=${secret}#${secret}`,
          headers: { 'X-Api-Key': secret, Cookie: `session=${secret}` },
        },
      },
    }),
    '.cursor/mcp.json': JSON.stringify({
      mcpServers: { cursor: { command: launcher[0], args, env: { [input.envName]: envValue } } },
    }),
    '.gemini/settings.json': JSON.stringify({
      mcpServers: {
        gemini: { httpUrl: `https://mcp.example.com/${secret}`, headers: { A: secret } },
      },
    }),
    '.claude/settings.json': JSON.stringify({
      env: { [input.envName]: envValue, OTHER: secret },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [handler] }],
        Stop: [{ hooks: [{ type: 'http', url: `https://hooks.example.com/${secret}` }] }],
      },
    }),
  };
}

describe('credentials never reach the inventory', () => {
  it('holds for generated configurations', () => {
    fc.assert(
      fc.property(caseArb, (input) => {
        captured.inputs.length = 0;
        const inventory = buildInventory(analyze(snapshotFrom(filesFor(input)), {}));
        expect(inventory.mcpServers).toHaveLength(4);
        expect(inventory.hooks).toHaveLength(2);
        expect(JSON.stringify(inventory)).not.toContain(input.secret);
        expect(captured.inputs.length).toBeGreaterThan(0);
        for (const text of captured.inputs) expect(text).not.toContain(input.secret);
      }),
      { numRuns: 300 },
    );
  });

  it('still lists the names and origins', () => {
    const files = filesFor({
      secret: 'QzSECRETabcdefghijklmnop',
      argForm: 0,
      envForm: 1,
      envName: 'HTTPS_PROXY',
      commandForm: 0,
      launcher: ['npx', '-y', '@acme/mcp@1.0.0'],
      exec: false,
    });
    const inventory = buildInventory(analyze(snapshotFrom(files), {}));
    const local = inventory.mcpServers.find((server) => server.id === 'mcp:.mcp.json#local');
    expect(local).toMatchObject({
      command: 'API_KEY=… npx',
      args: ['-y', '@acme/mcp@1.0.0', '--token', '…'],
      envKeys: ['HTTPS_PROXY', 'PLAIN'],
      headerKeys: ['Authorization'],
      package: { name: '@acme/mcp', pin: 'exact' },
    });
    const remote = inventory.mcpServers.find((server) => server.id === 'mcp:.mcp.json#remote');
    expect(remote?.url).toEqual({ origin: 'https://mcp.example.com', tls: true, loopback: false });
    expect(inventory.env.find((item) => item.key === 'HTTPS_PROXY')?.shown).toBe(
      'https://proxy.example.com:8080',
    );
    expect(inventory.hooks.find((hook) => hook.event === 'PreToolUse')?.command).toBe(
      'curl -fsS -H "… … …" https://api.example.com/…',
    );
  });
});
