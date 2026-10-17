import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAllowEntry, parsePolicy, UNKNOWN_FIELD_REASON } from '../../src/policy/parse.js';
import type { AllowEntry, Policy } from '../../src/policy/types.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/policy/${name}`, import.meta.url), 'utf8'));

function policyOf(document: unknown): Policy {
  const result = parsePolicy(document);
  if ('errors' in result) throw new Error(result.errors.join('\n'));
  return result.policy;
}

function errorsOf(document: unknown): readonly string[] {
  const result = parsePolicy(document);
  if ('policy' in result) throw new Error('expected errors');
  return result.errors;
}

const minimal = { policyVersion: 1, name: 'test policy' };

function entry(text: string): AllowEntry {
  const parsed = parseAllowEntry(text);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

describe('parsePolicy', () => {
  it('reads the design example', () => {
    const policy = policyOf(fixture('example.json'));
    expect(policy).toMatchObject({
      name: 'acme agent policy',
      mode: 'enforce',
      existing: 'report',
      forbid: ['bypass-permissions', 'auto-approve-project-mcp', 'broad-shell', 'gemini-trust'],
      denyTools: ['WebFetch'],
      denyCommands: ['curl', 'wget', 'ssh'],
      requireHooks: [
        {
          agent: 'claude-code',
          event: 'PreToolUse',
          matcher: 'Bash',
          script: 'scripts/hooks/guard.sh',
        },
      ],
      budgets: [
        { agent: 'claude-code', startupTokens: 8000 },
        { agent: 'codex', startupTokens: 8000 },
      ],
    });
    expect(policy.mcp.allow?.map((item) => item.kind)).toEqual([
      'npm',
      'pypi',
      'oci',
      'origin',
      'origin',
    ]);
  });

  it('reads the strict sample policy', () => {
    const policy = policyOf(fixture('strict.json'));
    expect(policy.forbid).toHaveLength(10);
    expect(policy.existing).toBe('fail');
    expect(policy.mcp).toMatchObject({ allowLocal: false, requirePin: true });
  });

  it('applies defaults to a minimal policy', () => {
    const policy = policyOf(minimal);
    expect(policy).toEqual({
      name: 'test policy',
      mode: 'enforce',
      existing: 'report',
      mcp: { allowLocal: false, requirePin: false },
      forbid: [],
      denyTools: [],
      denyCommands: [],
      requireHooks: [],
      budgets: [],
    });
  });

  it('keeps an empty allowlist, which allows nothing', () => {
    expect(policyOf({ ...minimal, mcp: { allow: [] } }).mcp.allow).toEqual([]);
    expect(policyOf({ ...minimal, mcp: {} }).mcp.allow).toBeUndefined();
  });

  it('reads objects with a null prototype, as src/io parses untrusted JSON', () => {
    const document = Object.assign(Object.create(null) as object, minimal, {
      budgets: Object.assign(Object.create(null) as object, { codex: { startupTokens: 10 } }),
    });
    expect(policyOf(document).budgets).toEqual([{ agent: 'codex', startupTokens: 10 }]);
  });

  it('lists budgets in agent order and lower-cases denied commands', () => {
    const policy = policyOf({
      ...minimal,
      budgets: { cursor: { startupTokens: 3 }, 'claude-code': { startupTokens: 1 } },
      permissions: { denyCommands: ['CURL', 'g++'] },
    });
    expect(policy.budgets.map((budget) => budget.agent)).toEqual(['claude-code', 'cursor']);
    expect(policy.denyCommands).toEqual(['curl', 'g++']);
  });

  it('normalizes a required hook script', () => {
    const policy = policyOf({
      ...minimal,
      hooks: { require: [{ agent: 'cursor', event: 'stop', script: './scripts//x.sh' }] },
    });
    expect(policy.requireHooks).toEqual([
      { agent: 'cursor', event: 'stop', script: 'scripts/x.sh' },
    ]);
  });
});

describe('allowlist entries', () => {
  it('reads npm entries, scoped or not, with an exact version', () => {
    expect(entry('npm:mcp-fetch-server')).toEqual({
      kind: 'npm',
      text: 'npm:mcp-fetch-server',
      name: 'mcp-fetch-server',
    });
    expect(entry('npm:@modelcontextprotocol/server-github@2025.4.8')).toMatchObject({
      name: '@modelcontextprotocol/server-github',
      version: '2025.4.8',
    });
    expect(entry('npm:@scope/name')).toMatchObject({ name: '@scope/name' });
    expect(entry('npm:foo@v1.2.3')).toMatchObject({ name: 'foo', version: '1.2.3' });
    expect(entry('npm:foo@=1.2.3-rc.1+build.5')).toMatchObject({ version: '1.2.3-rc.1+build.5' });
  });

  it('normalizes PyPI names as PEP 503 does', () => {
    expect(entry('pypi:MCP_Server.Fetch')).toMatchObject({
      kind: 'pypi',
      name: 'mcp-server-fetch',
    });
    expect(entry('pypi:mcp--server__fetch==1.0rc1')).toMatchObject({
      name: 'mcp-server-fetch',
      version: '1.0rc1',
    });
    expect(entry('pypi:a')).toMatchObject({ name: 'a' });
  });

  it('applies Docker defaults to images', () => {
    expect(entry('oci:ubuntu')).toMatchObject({ kind: 'oci', image: 'docker.io/library/ubuntu' });
    expect(entry('oci:acme/mcp')).toMatchObject({ image: 'docker.io/acme/mcp' });
    expect(entry('oci:docker.io/ubuntu')).toMatchObject({ image: 'docker.io/library/ubuntu' });
    expect(entry('oci:index.docker.io/acme/mcp')).toMatchObject({ image: 'docker.io/acme/mcp' });
    expect(entry('oci:localhost/mcp')).toMatchObject({ image: 'localhost/mcp' });
    expect(entry('oci:registry.acme.dev:5000/team/mcp')).toMatchObject({
      image: 'registry.acme.dev:5000/team/mcp',
    });
    const digest = `sha256:${'ab'.repeat(32)}`;
    expect(entry(`oci:ghcr.io/acme/mcp-db@${digest}`)).toMatchObject({
      image: 'ghcr.io/acme/mcp-db',
      digest,
    });
  });

  it('reads origins, with wildcards, ports and IPv6 hosts', () => {
    expect(entry('https://mcp.acme.internal')).toEqual({
      kind: 'origin',
      text: 'https://mcp.acme.internal',
      scheme: 'https',
      host: 'mcp.acme.internal',
      port: '',
      wildcard: false,
    });
    expect(entry('https://*.acme.dev')).toMatchObject({ host: 'acme.dev', wildcard: true });
    expect(entry('https://*.Acme.DEV:8443')).toMatchObject({ host: 'acme.dev', port: '8443' });
    expect(entry('https://MCP.acme.internal:443')).toMatchObject({
      host: 'mcp.acme.internal',
      port: '',
    });
    expect(entry('http://localhost:80')).toMatchObject({ host: 'localhost', port: '' });
    expect(entry('ws://[0:0::1]:9000')).toMatchObject({ host: '[::1]', port: '9000' });
    expect(entry('wss://127.0.0.1')).toMatchObject({ scheme: 'wss', host: '127.0.0.1' });
    // A host the URL parser rejects keeps its spelling and can never match a server.
    expect(entry('https://*.999:443')).toMatchObject({ host: '999', port: '' });
    expect(entry('https://a.999')).toMatchObject({ host: 'a.999' });
  });
});

describe('errors', () => {
  it('rejects unknown fields at every level, with the reason', () => {
    expect(
      errorsOf({
        ...minimal,
        polcyVersion: 1,
        mcp: { alow: [] },
        permissions: { denyTool: [] },
        hooks: { required: [] },
        budgets: { codex: { startupTokens: 1, extra: true } },
      }),
    ).toEqual([
      `Unknown field "polcyVersion" (did you mean "policyVersion"?). ${UNKNOWN_FIELD_REASON}`,
      `Unknown field "mcp.alow" (did you mean "mcp.allow"?). ${UNKNOWN_FIELD_REASON}`,
      `Unknown field "permissions.denyTool" (did you mean "permissions.denyTools"?). ${UNKNOWN_FIELD_REASON}`,
      `Unknown field "hooks.required" (did you mean "hooks.require"?). ${UNKNOWN_FIELD_REASON}`,
      `Unknown field "budgets.codex.extra". ${UNKNOWN_FIELD_REASON}`,
    ]);
    expect(UNKNOWN_FIELD_REASON).toBe(
      'Unknown fields are an error, so a typo cannot switch a check off.',
    );
  });

  it('gives one line per problem', () => {
    const errors = errorsOf({
      policyVersion: 2,
      name: 'line one\nline two',
      mode: 'warn',
      existing: true,
      mcp: {
        allow: [
          'npm:foo@^1.2.0',
          'npm:foo@latest',
          'npm:Foo Bar',
          'pypi:foo>=1.0',
          'pypi:foo==1.*',
          'pypi:-foo',
          'oci:ghcr.io/acme/mcp:latest',
          'oci:acme/mcp@sha256:abc',
          'oci:Acme/MCP',
          'https://mcp.acme.internal/v1',
          'https://user@mcp.acme.internal',
          'https://mcp.*.acme.dev',
          'https://*mcp.acme.dev',
          'https://*.acme.dev:99999',
          'ftp://files.acme.dev',
          'github',
          7,
        ],
        allowLocal: 'yes',
        requirePin: 1,
      },
      forbid: ['broad-shel', 'everything', 3],
      permissions: { denyTools: ['Bash(curl:*)'], denyCommands: ['curl -s', ''] },
      hooks: {
        require: [
          { agent: 'claude-code', event: 'PreTooluse' },
          { agent: 'claude-code', event: 'beforeShellExecution' },
          { agent: 'claude-code', event: 'Whatever' },
          { agent: 'vim', event: 'x' },
          { event: 3, matcher: 4, script: '', command: '' },
          'hook',
        ],
      },
      budgets: { windsurf: { startupTokens: 1 }, codx: {}, codex: { startupTokens: 0 }, cursor: 5 },
    });
    for (const error of errors) expect(error).not.toMatch(/[\n\r]/);
    expect(errors).toMatchSnapshot();
  });

  it('says when policyVersion is too new', () => {
    expect(errorsOf({ policyVersion: 2, name: 'x' })).toEqual([
      'policyVersion 2 is newer than this agentcheckup reads (1). Update agentcheckup to use this policy.',
    ]);
    expect(errorsOf({ policyVersion: '1', name: 'x' })).toEqual([
      'policyVersion: expected 1, got "1".',
    ]);
    expect(errorsOf({ policyVersion: 0.5, name: 'x' })).toEqual([
      'policyVersion: expected 1, got 0.5.',
    ]);
  });

  it('requires policyVersion and name', () => {
    expect(errorsOf({})).toEqual([
      'policyVersion is required. Add "policyVersion": 1.',
      'name is required. Reports show it, so readers know which policy failed.',
    ]);
    expect(errorsOf({ policyVersion: 1, name: '' })).toEqual(['name: must not be empty.']);
    expect(errorsOf({ policyVersion: 1, name: 'x'.repeat(121) })).toEqual([
      'name: must be at most 120 characters, got 121.',
    ]);
    // Code points, not UTF-16 units: 120 emoji are 240 units.
    expect(policyOf({ policyVersion: 1, name: '😀'.repeat(120) }).name).toHaveLength(240);
  });

  it('rejects documents of the wrong shape', () => {
    expect(errorsOf([])).toEqual(['expected a JSON object, got an array.']);
    expect(errorsOf(null)).toEqual(['expected a JSON object, got null.']);
    expect(errorsOf({ ...minimal, $schema: 1, mcp: [], permissions: 'x', hooks: null })).toEqual([
      '$schema: expected a string, got 1.',
      'mcp: expected an object, got an array.',
      'permissions: expected an object, got "x".',
      'hooks: expected an object, got null.',
    ]);
    expect(
      errorsOf({
        ...minimal,
        mcp: { allow: 'npm:x' },
        forbid: {},
        permissions: { denyTools: 'x' },
        hooks: { require: {} },
        budgets: [],
      }),
    ).toEqual([
      'mcp.allow: expected an array, got "npm:x".',
      'forbid: expected an array, got an object.',
      'permissions.denyTools: expected an array, got "x".',
      'hooks.require: expected an array, got an object.',
      'budgets: expected an object, got an array.',
    ]);
  });

  it("suggests the agent of another agent's hook event", () => {
    expect(
      errorsOf({ ...minimal, hooks: { require: [{ agent: 'codex', event: 'preCompact' }] } }),
    ).toEqual([
      'hooks.require[0].event: "preCompact" is not a Codex hook event. Did you mean "PreCompact"?',
    ]);
    expect(
      errorsOf({ ...minimal, hooks: { require: [{ agent: 'gemini', event: 'afterFileEdit' }] } }),
    ).toEqual([
      'hooks.require[0].event: "afterFileEdit" is a Cursor hook event, not a Gemini CLI one.',
    ]);
    // Agents by name: the windsurf hooks are Devin Local's.
    expect(
      errorsOf({ ...minimal, hooks: { require: [{ agent: 'windsurf', event: 'afterFileEdit' }] } }),
    ).toEqual([
      'hooks.require[0].event: "afterFileEdit" is a Cursor hook event, not a Devin Local one.',
    ]);
    expect(
      'policy' in
        parsePolicy({
          ...minimal,
          hooks: { require: [{ agent: 'windsurf', event: 'SessionStart' }] },
        }),
    ).toBe(true);
  });
});
