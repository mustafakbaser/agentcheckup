/**
 * Hostile configuration files: very large ones, keys that name Object.prototype members, and
 * values of the wrong type. The builder must finish quickly, never throw, never touch prototypes,
 * and list what it can.
 */
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { buildInventory } from '../../src/inventory/build.js';
import { MAX_FRONTMATTER_LENGTH } from '../../src/parse/frontmatter.js';
import type { Inventory } from '../../src/inventory/types.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

function inventoryOf(files: FileMap): Inventory {
  return buildInventory(analyze(snapshotFrom(files), {}));
}

describe('large files', () => {
  it('lists thousands of servers, hooks, permissions and env keys in time', () => {
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 3_000; i++) {
      servers[`s${String(i)}`] = {
        command: 'npx',
        args: [
          '-y',
          `@acme/server-${String(i)}@1.0.${String(i)}`,
          ...Array<string>(20).fill('--flag'),
        ],
        env: { [`TOKEN_${String(i)}`]: 'x', LOG: 'debug' },
      };
    }
    const allow = Array.from({ length: 20_000 }, (_, i) => `Bash(task-${String(i)}:*)`);
    const env = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`VAR_${String(i)}`, 'v']),
    );
    const handlers = Array.from({ length: 2_000 }, (_, i) => ({
      type: 'command',
      command: `./hooks/h${String(i)}.sh --token t${String(i)}`,
    }));
    const start = performance.now();
    const inventory = inventoryOf({
      '.mcp.json': JSON.stringify({ mcpServers: servers }),
      '.claude/settings.json': JSON.stringify({
        permissions: { allow },
        env,
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: handlers }] },
      }),
    });
    const elapsed = performance.now() - start;
    expect(inventory.mcpServers).toHaveLength(3_000);
    expect(inventory.permissions).toHaveLength(20_000);
    expect(inventory.env).toHaveLength(5_000 + 3_000);
    expect(inventory.hooks).toHaveLength(2_000);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('redacts very long strings in linear time', () => {
    const long = 'a'.repeat(400_000);
    const start = performance.now();
    const inventory = inventoryOf({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          big: {
            command: `${long} --token ${long}`,
            args: [`--header=${long}`, `https://${'b'.repeat(200)}.example.com/${long}`, long],
          },
        },
      }),
      '.claude/settings.json': JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `curl ${'x '.repeat(100_000)}` }] }],
        },
      }),
    });
    expect(performance.now() - start).toBeLessThan(10_000);
    const big = inventory.mcpServers[0];
    expect(big?.command?.endsWith('--token …')).toBe(true);
    expect(big?.args?.[0]).toBe('--header=…');
    expect(big?.args?.[1]).toBe(`https://${'b'.repeat(200)}.example.com/…`);
  });
});

describe('prototype keys', () => {
  const NAMES = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString'];

  it('reads them as ordinary names and never touches prototypes', () => {
    // Object.fromEntries defines own properties, so `__proto__` is a key JSON.stringify writes.
    const map = (value: unknown) => Object.fromEntries(NAMES.map((name) => [name, value]));
    const text = (value: unknown) => JSON.stringify(value);
    const inventory = inventoryOf({
      '.mcp.json': text({
        mcpServers: map({
          command: 'npx',
          type: '__proto__',
          env: map('x'),
          headers: map('y'),
        }),
      }),
      '.claude/settings.json': text({
        env: map('1'),
        hooks: { ...map([{ hooks: [{ type: 'command', command: 'x' }] }]) },
        permissions: { allow: NAMES },
        enabledMcpjsonServers: NAMES,
      }),
      '.gemini/settings.json': text({ mcpServers: map({ url: 'https://x.example', trust: true }) }),
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>)['command']).toBeUndefined();
    expect(inventory.mcpServers.filter((s) => s.file === '.mcp.json').map((s) => s.name)).toEqual(
      [...NAMES].sort(),
    );
    const proto = inventory.mcpServers.find((s) => s.id === 'mcp:.mcp.json#__proto__');
    expect(proto).toMatchObject({
      transport: 'unknown',
      declaredType: '__proto__',
      envKeys: [...NAMES].sort(),
      headerKeys: [...NAMES].sort(),
    });
    expect(inventory.hooks.map((hook) => [hook.event, hook.known])).toEqual(
      expect.arrayContaining([
        ['__proto__', false],
        ['constructor', false],
      ]),
    );
    expect(inventory.hooks).toHaveLength(NAMES.length);
    expect(inventory.env.filter((item) => item.file === '.claude/settings.json')).toHaveLength(
      NAMES.length,
    );
    expect(
      inventory.permissions.filter((item) => item.key === 'mcpServers.__proto__.trust'),
    ).toHaveLength(1);
    const status = proto?.status ?? {};
    expect(Object.getPrototypeOf(status)).toBe(Object.prototype);
    expect(Object.keys(status)).toEqual(['claude-code']);
  });
});

describe('values of the wrong type', () => {
  it.each([
    ['an array root', '[1, 2, 3]'],
    ['a string root', '"servers"'],
    ['a null root', 'null'],
    ['mcpServers as a string', '{ "mcpServers": "github" }'],
    ['mcpServers as an array', '{ "mcpServers": [{ "a": { "command": "x" } }] }'],
    ['a server as a number', '{ "mcpServers": { "a": 7 } }'],
    ['a server as null', '{ "mcpServers": { "a": null } }'],
  ])('ignores %s', (_, text) => {
    const inventory = inventoryOf({ '.mcp.json': text, '.cursor/mcp.json': text });
    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.incomplete).toEqual([]);
  });

  it('reads what it can from mistyped fields', () => {
    const inventory = inventoryOf({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          a: {
            command: 42,
            args: 'not a list',
            env: ['X'],
            headers: 'Authorization: x',
            url: 5,
            type: { http: true },
          },
          b: {
            command: 'npx',
            args: [1, null, true, { x: 1 }, '-y', 'pkg@1.0.0'],
            env: { A: 1, B: null, C: { nested: true }, D_TOKEN: [1] },
            url: 'javascript:alert(1)',
          },
          c: { type: 'http', url: 'http://[::1' },
        },
      }),
      '.claude/settings.json': JSON.stringify({
        permissions: {
          allow: 'Bash',
          ask: [null, 1, ['Bash']],
          deny: { Bash: true },
          defaultMode: 5,
          additionalDirectories: '/',
        },
        enableAllProjectMcpServers: 'true',
        enabledMcpjsonServers: { a: true },
        env: ['A=1'],
        apiKeyHelper: ['x'],
        statusLine: { type: 'command', command: 7 },
        hooks: {
          PreToolUse: { matcher: 'Bash' },
          Stop: [null, 1, { hooks: 'x' }, { hooks: [null, 'cmd', { type: 7, command: 8 }] }],
        },
      }),
      '.claude/skills/x/SKILL.md':
        '---\nname: x\ndescription: X. Use when x.\nallowed-tools: 7\n---\n',
      '.claude/skills/y/SKILL.md':
        '---\nname: y\ndescription: Y. Use when y.\nallowed-tools:\n  - Bash\n  - 3\n  - { a: 1 }\n---\n',
    });
    const a = inventory.mcpServers.find((server) => server.name === 'a');
    expect(a).toMatchObject({ transport: 'unknown', envKeys: [], headerKeys: [] });
    expect(a?.command).toBeUndefined();
    expect(a?.args).toBeUndefined();
    expect(a?.url).toBeUndefined();
    const b = inventory.mcpServers.find((server) => server.name === 'b');
    expect(b?.args).toEqual(['-y', 'pkg@1.0.0']);
    expect(b?.package).toMatchObject({ name: 'pkg', pin: 'exact' });
    expect(b?.envKeys).toEqual(['A', 'B', 'C', 'D_TOKEN']);
    expect(b?.url).toBeUndefined();
    expect(inventory.mcpServers.find((server) => server.name === 'c')?.url).toBeUndefined();
    expect(inventory.env.map((item) => item.key)).toEqual(['mcpServers.b.env.D_TOKEN']);
    // Only the hook with a type and a command shape remains, without a command.
    expect(inventory.hooks.map(({ event, command, type }) => ({ event, command, type }))).toEqual([
      { event: 'Stop', command: undefined, type: undefined },
    ]);
    expect(inventory.permissions.map((item) => item.id)).toEqual([
      'perm:.claude/skills/y/SKILL.md#allowed-tools=Bash',
    ]);
  });
});

describe('frontmatter of skills, commands and subagents', () => {
  it('lists thousands of hooks and servers in time, with a line for each', () => {
    const hooks = Array.from(
      { length: 600 },
      (_, i) => `        - type: command\n          command: ./hooks/h${String(i)}.sh`,
    ).join('\n');
    const servers = Array.from(
      { length: 250 },
      (_, i) =>
        `  - s${String(i)}:\n      command: npx\n      args: ["-y", "@acme/s${String(i)}@1.0.0"]`,
    ).join('\n');
    const text = `---\nname: many\ndescription: Many.\nhooks:\n  PreToolUse:\n    - hooks:\n${hooks}\nmcpServers:\n${servers}\n---\n`;
    // Under the 64 KiB frontmatter limit; past it, the file is incomplete instead.
    expect(text.length).toBeLessThan(MAX_FRONTMATTER_LENGTH);
    const start = performance.now();
    const inventory = inventoryOf({ '.claude/agents/many.md': text });
    const elapsed = performance.now() - start;
    expect(inventory.hooks).toHaveLength(600);
    expect(inventory.mcpServers).toHaveLength(250);
    expect(new Set(inventory.hooks.map((hook) => hook.line)).size).toBe(600);
    expect(new Set(inventory.mcpServers.map((server) => server.line)).size).toBe(250);
    const doubled = text.replace('hooks:\n  PreToolUse:\n    - hooks:\n', `$&${hooks}\n`);
    expect(doubled.length).toBeGreaterThan(MAX_FRONTMATTER_LENGTH);
    expect(inventoryOf({ '.claude/agents/many.md': doubled }).incomplete).toEqual([
      '.claude/agents/many.md',
    ]);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('finds hooks behind thousands of keys in time', () => {
    const keys = Array.from({ length: 3_000 }, (_, i) => `k${String(i)}: v`).join('\n');
    const hooks = Array.from(
      { length: 600 },
      (_, i) => `        - command: ./h${String(i)}.sh`,
    ).join('\n');
    const text = `---\nname: a\ndescription: d\n${keys}\nhooks:\n  PreToolUse:\n    - hooks:\n${hooks}\n---\n`;
    // A few files, not more: each adds the same work, and the coverage run in CI is slow.
    const files = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`.claude/agents/a${String(i)}.md`, text]),
    );
    const start = performance.now();
    const inventory = inventoryOf(files);
    expect(inventory.hooks).toHaveLength(1_800);
    expect(performance.now() - start).toBeLessThan(15_000);
  });

  it('never expands an alias bomb, and lists the file as incomplete', () => {
    const levels = Array.from(
      { length: 12 },
      (_, i) =>
        `l${String(i + 1)}: &l${String(i + 1)} [${Array<string>(10)
          .fill(`*l${String(i)}`)
          .join(', ')}]`,
    );
    const text = `---\nname: bomb\ndescription: Bomb.\nl0: &l0 [x]\n${levels.join('\n')}\nhooks: *l12\n---\n`;
    const start = performance.now();
    const inventory = inventoryOf({ '.claude/agents/bomb.md': text });
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(inventory.incomplete).toEqual(['.claude/agents/bomb.md']);
    expect(inventory.hooks).toEqual([]);
  });

  it('reads prototype names as ordinary names and ignores values of the wrong type', () => {
    const inventory = inventoryOf({
      '.claude/agents/proto.md': [
        '---',
        'name: proto',
        'description: Proto.',
        'permissionMode: 7',
        'hooks:',
        '  __proto__:',
        '    - hooks:',
        '        - type: command',
        '          command: x',
        '  constructor: "not a list"',
        'mcpServers:',
        '  - 7',
        '  - null',
        '  - __proto__:',
        '      command: npx',
        '  - [nested]',
        '---',
        '',
      ].join('\n'),
      '.claude/agents/scalar.md': '---\nname: s\ndescription: S.\nhooks: 5\nmcpServers: "x"\n---\n',
    });
    expect(Object.prototype).not.toHaveProperty('command');
    expect(inventory.hooks.map((hook) => [hook.event, hook.known, hook.line])).toEqual([
      ['__proto__', false, 9],
    ]);
    expect(inventory.mcpServers.map((server) => server.name)).toEqual(['__proto__']);
    expect(inventory.permissions).toEqual([]);
    expect(inventory.incomplete).toEqual([]);
  });
});
