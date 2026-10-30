import { describe, expect, it } from 'vitest';
import type { ArtifactKind } from '../../src/core/types.js';
import type { ParsedJson } from '../../src/parse/json-access.js';
import { parseJson } from '../../src/parse/json.js';
import {
  CODEX_TOML_CONFIG_KEYS,
  COPILOT_EVENTS,
  COPILOT_REFERENCE_EVENTS,
  copilotHookItemIssue,
  copilotHookItems,
  DEVIN_EVENTS,
  failsOpen,
  gateFailsOpen,
  HOOK_PLATFORMS,
  hookEvents,
  hookHandlers,
  hookPlatformOf,
  hookSourceOf,
  VSCODE_LOCAL_EVENTS,
} from '../../src/platforms/hooks.js';
import { hookCommandLine, hookCommandLines } from '../../src/platforms/inventory-ids.js';
import {
  copilotMcpServers,
  mcpPlatform,
  mcpServers,
  transportOf,
  vscodeMcpServers,
} from '../../src/platforms/mcp.js';
import type { Artifact } from '../../src/core/types.js';

function doc(value: unknown): ParsedJson {
  const parsed = parseJson(JSON.stringify(value));
  if (!parsed.ok) throw new Error('test JSON does not parse');
  return parsed;
}

const artifact = (kind: ArtifactKind, path = 'x.json') => ({ kind, path }) as Artifact;

describe('MCP servers of the new kinds', () => {
  it('reads VS Code servers under "servers" only', () => {
    const parsed = doc({ servers: { a: { command: 'x' } }, mcpServers: { b: { command: 'y' } } });
    expect(vscodeMcpServers(parsed).map((s) => s.path)).toEqual([['servers', 'a']]);
    expect(mcpServers(artifact('vscode-mcp'), parsed).map((s) => s.name)).toEqual(['a']);
    expect(vscodeMcpServers(doc([1]))).toEqual([]);
  });

  it('reads both forms of .github/mcp.json, the mcpServers object first', () => {
    const bare = doc({ a: { command: 'x' }, note: 'text' });
    expect(copilotMcpServers(bare).map((s) => s.path)).toEqual([['a']]);
    // VS Code's format in the wrong file: `servers` is not a server, and starts nothing.
    const vscodeForm = doc({ servers: { v: { command: 'v' } } });
    expect(copilotMcpServers(vscodeForm)).toEqual([]);
    expect(
      copilotMcpServers(doc({ r: { url: 'https://x.example.com' }, t: { type: 'stdio' } })).map(
        (s) => s.name,
      ),
    ).toEqual(['r', 't']);
    const wrapped = doc({ mcpServers: { b: { command: 'y' } }, c: { command: 'z' } });
    expect(mcpServers(artifact('copilot-mcp'), wrapped).map((s) => s.path)).toEqual([
      ['mcpServers', 'b'],
    ]);
  });

  it('reads mcpServers in Devin Local files, and names the platform of each kind', () => {
    const parsed = doc({ mcpServers: { a: { url: 'https://x.example.com' } } });
    expect(mcpServers(artifact('devin-mcp'), parsed).map((s) => s.name)).toEqual(['a']);
    expect(mcpPlatform(artifact('vscode-mcp'))).toBe('copilot');
    expect(mcpPlatform(artifact('copilot-mcp'))).toBe('copilot');
    expect(mcpPlatform(artifact('devin-mcp'))).toBe('windsurf');
    expect(mcpPlatform(artifact('copilot-hooks'))).toBeUndefined();
  });

  it('tells the transport', () => {
    const of = (kind: ArtifactKind, config: Record<string, unknown>) =>
      transportOf({ kind }, config);
    expect(of('vscode-mcp', { type: 'sse', url: 'u' })).toBe('sse');
    expect(of('copilot-mcp', { type: 'local', command: 'x' })).toBe('stdio');
    expect(of('copilot-mcp', { type: 'streamable-http', url: 'u' })).toBe('http');
    expect(of('devin-mcp', { url: 'u' })).toBe('http');
    expect(of('devin-mcp', { url: 'u', transport: 'sse' })).toBe('sse');
    expect(of('devin-mcp', { url: 'u', transport: 'ws' })).toBe('unknown');
    // Outside Devin's files a url without type stays unknown.
    expect(of('mcp-json', { url: 'u', transport: 'sse' })).toBe('unknown');
    expect(of('gemini-settings', { httpUrl: 'u' })).toBe('http');
    expect(of('mcp-json', { type: 7 })).toBe('unknown');
  });
});

describe('hooks of the new kinds', () => {
  it('names the platform and where each file keeps its events', () => {
    expect(hookSourceOf(artifact('copilot-hooks', '.github/hooks/a.json'))).toEqual({
      platform: 'copilot',
      root: 'hooks',
    });
    expect(hookPlatformOf(artifact('copilot-settings', '.github/copilot/settings.json'))).toBe(
      'copilot',
    );
    expect(hookSourceOf(artifact('devin-config', '.devin/config.json'))).toEqual({
      platform: 'windsurf',
      root: 'hooks',
    });
    expect(hookSourceOf(artifact('devin-hooks', 'a/.devin/hooks.v1.json'))).toEqual({
      platform: 'windsurf',
      root: 'document',
    });
    expect(hookSourceOf(artifact('devin-hooks', '.devin/hooks.json'))).toBeUndefined();
    expect(hookSourceOf(artifact('vscode-mcp', '.vscode/mcp.json'))).toBeUndefined();
    expect(HOOK_PLATFORMS).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'gemini',
      'copilot',
      'windsurf',
    ]);
  });

  it('reads Copilot handlers directly under each event, defaulting to command hooks', () => {
    const parsed = doc({
      version: 1,
      hooks: {
        preToolUse: [{ bash: './a.sh', matcher: 'bash' }, 'not an object'],
        postToolUse: [{ type: 'http', url: 'https://x.example.com' }],
        onSave: [{ bash: 'x' }],
      },
    });
    const handlers = hookHandlers(parsed, 'copilot', { includeUnknown: true });
    expect(handlers.map(({ event, known, path, type }) => [event, known, path, type])).toEqual([
      ['preToolUse', true, ['hooks', 'preToolUse', 0], 'command'],
      ['postToolUse', true, ['hooks', 'postToolUse', 0], 'http'],
      ['onSave', false, ['hooks', 'onSave', 0], 'command'],
    ]);
    expect(COPILOT_EVENTS).toEqual(expect.arrayContaining(['agentStop', 'Stop', 'SubagentStart']));
  });

  it("reads Devin Local's hooks.v1.json as the events object, with or without a wrapper", () => {
    const events = {
      PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: 'a' }] }],
    };
    expect(hookEvents(doc(events), 'windsurf', 'document').map((e) => e.path)).toEqual([
      ['PreToolUse'],
    ]);
    expect(hookEvents(doc({ hooks: events }), 'windsurf', 'document').map((e) => e.path)).toEqual([
      ['hooks', 'PreToolUse'],
    ]);
    // The default reads only the "hooks" key.
    expect(hookEvents(doc(events), 'windsurf')).toEqual([]);
    const handlers = hookHandlers(doc(events), 'windsurf', { root: 'document' });
    expect(handlers.map((h) => h.path)).toEqual([['PreToolUse', 0, 'hooks', 0]]);
    expect(DEVIN_EVENTS).toContain('PostCompaction');
    expect(CODEX_TOML_CONFIG_KEYS.has('state')).toBe(true);
  });

  it('fails closed for a Copilot preToolUse command hook only', () => {
    expect(failsOpen('copilot', 'command', {}, 'preToolUse')).toBe(false);
    expect(failsOpen('copilot', 'command', {}, 'PreToolUse')).toBe(true);
    expect(failsOpen('copilot', 'http', {}, 'preToolUse')).toBe(true);
    expect(failsOpen('copilot', 'prompt', {}, 'sessionStart')).toBe(false);
    expect(failsOpen('windsurf', 'command', {}, 'PreToolUse')).toBe(true);
    expect(failsOpen('windsurf', 'prompt', {}, 'PreToolUse')).toBe(false);
    const [gate] = hookHandlers(doc({ hooks: { preToolUse: [{ bash: 'x' }] } }), 'copilot');
    expect(gate === undefined ? undefined : gateFailsOpen('copilot', gate)).toBe(false);
  });

  it('shows every command field of a Copilot hook', () => {
    const handler = { bash: './a.sh', powershell: '.\\a.ps1', exec: 'node', args: ['b c.js'] };
    expect(hookCommandLines(handler, 'copilot')).toEqual([
      { field: 'bash', line: './a.sh' },
      { field: 'powershell', line: '.\\a.ps1' },
      { field: 'exec', line: 'node "b c.js"' },
    ]);
    expect(hookCommandLine(handler, 'copilot')).toBe('./a.sh');
    // Other platforms read only "command".
    expect(hookCommandLine(handler)).toBeUndefined();
    expect(hookCommandLines({ command: 'x' }, 'claude-code')).toEqual([
      { field: 'command', line: 'x' },
    ]);
  });
});

describe('Copilot hook items and event names', () => {
  it('finds what makes a hook item fail validation, and accepts every documented form', () => {
    for (const item of [
      { type: 'command', bash: './a.sh' },
      { command: 'x' },
      { powershell: 'x' },
      { exec: 'node', args: ['a.js'] },
      { linux: './a.sh', windows: 'a.ps1' },
      { exec: 'node', linux: './a.sh' },
      { type: 'http', url: 'https://hooks.example.com' },
      { type: 'prompt', prompt: '/review' },
    ]) {
      expect(copilotHookItemIssue(item), JSON.stringify(item)).toBeUndefined();
    }
    expect(copilotHookItemIssue('./a.sh')).toBe('not-an-object');
    expect(copilotHookItemIssue({ type: 'command' })).toBe('no-command');
    expect(copilotHookItemIssue({ bash: 7 })).toBe('no-command');
    expect(copilotHookItemIssue({ exec: 'node', bash: 'x' })).toBe('exec-combined');
    expect(copilotHookItemIssue({ type: 'http' })).toBe('no-url');
    expect(copilotHookItemIssue({ type: 'prompt' })).toBe('no-prompt');
    expect(copilotHookItemIssue({ type: 'agent', bash: 'x' })).toBe('unknown-type');
    expect(copilotHookItems(doc({ hooks: { a: [1, { bash: 'x' }], b: { bash: 'y' } } }))).toEqual([
      1,
      { bash: 'x' },
    ]);
  });

  it('lists per surface only the names its reference documents', () => {
    for (const event of [...COPILOT_REFERENCE_EVENTS, ...VSCODE_LOCAL_EVENTS]) {
      expect(COPILOT_EVENTS, event).toContain(event);
    }
    expect(COPILOT_REFERENCE_EVENTS.has('SubagentStart')).toBe(false);
    expect(COPILOT_REFERENCE_EVENTS.has('Notification')).toBe(false);
    expect(COPILOT_REFERENCE_EVENTS.has('PermissionRequest')).toBe(true);
    expect(VSCODE_LOCAL_EVENTS.has('SessionEnd')).toBe(false);
    expect(VSCODE_LOCAL_EVENTS.has('userPromptSubmitted')).toBe(true);
  });
});
