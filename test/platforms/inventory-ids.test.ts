/**
 * The one implementation of each inventory id format, shared by the loaders and the inventory
 * builder (src/platforms/inventory-ids.ts).
 */
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { hash53 } from '../../src/core/fingerprint.js';
import { buildInventory } from '../../src/inventory/build.js';
import { urlOrigin } from '../../src/inventory/redact.js';
import { parseJson } from '../../src/parse/json.js';
import { hookHandlers } from '../../src/platforms/hooks.js';
import {
  canonicalJson,
  envInventoryId,
  hookCommandLine,
  hookInventoryIds,
  mcpInventoryIds,
  numberRepeats,
  permInventoryId,
} from '../../src/platforms/inventory-ids.js';
import { snapshotFrom } from '../helpers/lint.js';

function handlersOf(text: string) {
  const doc = parseJson(text);
  if (!doc.ok) throw new Error('bad JSON');
  return hookHandlers(doc, 'claude-code', { includeUnknown: true });
}

describe('numberRepeats', () => {
  it('numbers repeats from 2 in order and never reuses an id', () => {
    expect(numberRepeats(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a:2', 'a:3']);
    expect(numberRepeats(['a:2', 'a', 'a'])).toEqual(['a:2', 'a', 'a:3']);
    expect(numberRepeats([])).toEqual([]);
  });
});

describe('ids', () => {
  it('formats MCP, permission and environment ids', () => {
    expect(mcpInventoryIds('.mcp.json', [{ name: 'a' }, { name: 'b' }, { name: 'a' }])).toEqual([
      'mcp:.mcp.json#a',
      'mcp:.mcp.json#b',
      'mcp:.mcp.json#a:2',
    ]);
    expect(permInventoryId('s.json', 'permissions.allow', 'Bash(x)')).toBe(
      'perm:s.json#permissions.allow=Bash(x)',
    );
    expect(envInventoryId('s.json', 'NODE_OPTIONS')).toBe('env:s.json#NODE_OPTIONS');
  });

  it('hashes what a hook runs without its credentials', () => {
    const hooks = (token: string): string =>
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: `curl -H "Authorization: Bearer ${token}" x` },
                { type: 'command', command: 'echo', args: ['--token', token] },
                { type: 'http', url: `https://hooks.example.com/services/${token}` },
                { type: 'mcp_tool', server: 'srv', tool: 'run' },
                { type: 'prompt', prompt: token },
              ],
            },
          ],
        },
      });
    const one = hookInventoryIds('f', handlersOf(hooks('Qz1111111111111111')));
    const two = hookInventoryIds('f', handlersOf(hooks('Qz2222222222222222')));
    expect(two).toEqual(one);
    expect(one).toHaveLength(5);
    expect(new Set(one).size).toBe(5);
    expect(one[1]).toBe(`hook:f#PreToolUse:${hash53('echo --token …').slice(-8)}`);
    expect(one[2]).toBe(
      `hook:f#PreToolUse:${hash53(canonicalJson({ url: urlOrigin('https://hooks.example.com/x').origin })).slice(-8)}`,
    );
    expect(hookCommandLine({ command: 'node', args: ['a b', ''] })).toBe('node "a b" ""');
    expect(hookCommandLine({ command: 7 })).toBeUndefined();
  });

  it('matches the inventory builder, repeated MCP names included', () => {
    const files = {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'p',
        mcpServers: [{ a: { command: 'x' } }, { a: { command: 'y' } }],
      }),
      '.claude/settings.json': JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'x' },
                { type: 'command', command: 'x' },
              ],
            },
          ],
        },
      }),
    };
    const inventory = buildInventory(analyze(snapshotFrom(files)));
    expect(inventory.mcpServers.map((item) => item.id)).toEqual(
      mcpInventoryIds('.claude-plugin/plugin.json', [{ name: 'a' }, { name: 'a' }]),
    );
    expect(inventory.hooks.map((item) => item.id)).toEqual(
      hookInventoryIds('.claude/settings.json', handlersOf(files['.claude/settings.json'])),
    );
  });

  it('writes canonical JSON', () => {
    expect(canonicalJson({ b: 1, a: [undefined, 'x'], c: undefined })).toBe(
      '{"a":[null,"x"],"b":1}',
    );
  });
});
