import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type ContextScanResult, scanWithContext } from '../../src/core/engine.js';
import { rebaseResult } from '../../src/core/rebase.js';
import type { Snapshot } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import {
  activeChecks,
  evaluatePolicy,
  HOOKS_NOT_ENFORCED,
  type PolicyInput,
  type PolicySubject,
} from '../../src/policy/evaluate.js';
import { parsePolicy } from '../../src/policy/parse.js';
import type { Policy, PolicyReport, PolicyViolation } from '../../src/policy/types.js';
import { builtinRules } from '../../src/rules/index.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function policyOf(document: object): Policy {
  const result = parsePolicy({ policyVersion: 1, name: 'test policy', ...document });
  if ('errors' in result) throw new Error(result.errors.join('\n'));
  return result.policy;
}

/** A file digest. The CLI computes the real one from the policy file's bytes. */
const SHA256 = '0123456789abcdef'.repeat(4);

function evaluate(policy: Policy, input: Omit<PolicyInput, 'sha256'>): PolicyReport {
  return evaluatePolicy(policy, { sha256: SHA256, ...input });
}

function scan(files: FileMap): ContextScanResult {
  const result = scanWithContext(snapshotFrom(files, { paths: ['.git/'] }), {
    rules: builtinRules,
    matrix: true,
  });
  if (result.ruleFailures.length > 0) throw new Error(JSON.stringify(result.ruleFailures));
  return result;
}

function run(
  document: object,
  files: FileMap,
  options: Omit<PolicyInput, 'sha256' | 'current' | 'baseline'> & {
    readonly baseline?: FileMap;
  } = {},
): PolicyReport {
  const { baseline, ...rest } = options;
  return evaluate(policyOf(document), {
    current: scan(files),
    ...(baseline === undefined ? {} : { baseline: scan(baseline) }),
    ...rest,
  });
}

type Brief = Pick<PolicyViolation, 'check' | 'entry' | 'message'> & { at?: string };

/** Violations in a compact form: check, entry, `path:line` and message. */
function brief(report: PolicyReport): Brief[] {
  return report.violations.map((violation) => ({
    check: violation.check,
    entry: violation.entry,
    ...(violation.path === undefined ? {} : { at: `${violation.path}:${violation.line ?? '-'}` }),
    message: violation.message,
  }));
}

const messages = (report: PolicyReport): string[] =>
  report.violations.map((violation) => violation.message);

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const servers = (entries: Record<string, object>): string => json({ mcpServers: entries });
const npx = (spec: string): object => ({ command: 'npx', args: ['-y', spec] });
const uvx = (...args: string[]): object => ({ command: 'uvx', args });
const docker = (image: string): object => ({
  command: 'docker',
  args: ['run', '-i', '--rm', image],
});
const remote = (url: string): object => ({ type: 'http', url });

const settings = (value: object): FileMap => ({ '.claude/settings.json': json(value) });
const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;

// ---------------------------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------------------------

describe('mcp-not-allowed', () => {
  it('reports a server the allowlist does not name, as the design shows', () => {
    const report = run(
      { mcp: { allow: ['npm:@modelcontextprotocol/server-github'] } },
      { '.mcp.json': servers({ fetch: npx('mcp-fetch-server') }) },
    );
    expect(brief(report)).toEqual([
      {
        check: 'mcp-not-allowed',
        entry: 'npm:mcp-fetch-server',
        at: '.mcp.json:3',
        message:
          'MCP server "fetch" runs npm package mcp-fetch-server, which the policy does not allow.',
      },
    ]);
    expect(report.violations[0]?.id).toMatch(/^mcp-not-allowed:mcp:\.mcp\.json#fetch@[\da-f]{14}$/);
  });

  it('allows scoped and unscoped npm packages by name, and by exact version', () => {
    const report = run(
      {
        mcp: {
          allow: [
            'npm:@modelcontextprotocol/server-github',
            'npm:mcp-fetch-server',
            'npm:@acme/pinned@1.2.3',
          ],
        },
      },
      {
        '.mcp.json': servers({
          github: npx('@modelcontextprotocol/server-github@2025.4.8'),
          fetch: npx('mcp-fetch-server@latest'),
          pinned: npx('@acme/pinned@1.2.3'),
          pinnedV: npx('@acme/pinned@v1.2.3'),
          newer: npx('@acme/pinned@1.2.4'),
          ranged: npx('@acme/pinned@^1.2.3'),
          unversioned: npx('@acme/pinned'),
          lookalike: npx('@modelcontextprotocol/server-github-evil'),
          scopeless: npx('server-github'),
        }),
      },
    );
    expect(report.violations.map((violation) => violation.entry)).toEqual([
      'npm:@acme/pinned@1.2.4',
      'npm:@acme/pinned',
      'npm:@acme/pinned',
      'npm:@modelcontextprotocol/server-github-evil',
      'npm:server-github',
    ]);
  });

  it('matches PyPI names as PEP 503 normalizes them', () => {
    const report = run(
      { mcp: { allow: ['pypi:MCP_Server.Fetch', 'pypi:mcp-server-time==1.0.0'] } },
      {
        '.mcp.json': servers({
          fetch: uvx('mcp-server-fetch'),
          fetchExtras: uvx('--from', 'mcp_server_fetch[all]==2.0', 'mcp-server-fetch'),
          time: uvx('mcp-server-time@1.0.0'),
          timeV: uvx('mcp-server-time@V1.0.0'),
          timeOther: uvx('mcp-server-time==1.0.1'),
          timeAny: uvx('mcp-server-time'),
          npmTwin: npx('mcp-server-fetch'),
        }),
      },
    );
    expect(report.violations.map((violation) => violation.entry)).toEqual([
      'pypi:mcp-server-time==1.0.1',
      'pypi:mcp-server-time',
      'npm:mcp-server-fetch',
    ]);
    expect(messages(report)[0]).toBe(
      'MCP server "timeOther" runs PyPI package mcp-server-time==1.0.1, which the policy does not allow.',
    );
  });

  it('applies Docker defaults to images, and matches digests exactly', () => {
    const report = run(
      {
        mcp: {
          allow: ['oci:ubuntu', 'oci:acme/mcp', `oci:ghcr.io/acme/mcp-db@${DIGEST}`],
        },
      },
      {
        '.mcp.json': servers({
          ubuntu: docker('ubuntu:22.04'),
          library: docker('docker.io/library/ubuntu'),
          index: docker('index.docker.io/acme/mcp:1'),
          db: docker(`ghcr.io/acme/mcp-db@${DIGEST}`),
          dbTag: docker('ghcr.io/acme/mcp-db:latest'),
          dbOther: docker(`ghcr.io/acme/mcp-db@sha256:${'f'.repeat(64)}`),
          otherRegistry: docker('quay.io/acme/mcp'),
        }),
      },
    );
    expect(report.violations.map((violation) => violation.entry)).toEqual([
      'oci:ghcr.io/acme/mcp-db',
      `oci:ghcr.io/acme/mcp-db@sha256:${'f'.repeat(64)}`,
      'oci:quay.io/acme/mcp',
    ]);
    expect(messages(report)[0]).toBe(
      'MCP server "dbTag" runs container image ghcr.io/acme/mcp-db:latest, which the policy does not allow.',
    );
  });

  it('matches origins exactly, with ports, and wildcards on a label boundary', () => {
    const report = run(
      {
        mcp: {
          allow: [
            'https://mcp.acme.internal',
            'https://*.acme.dev',
            'http://localhost:3000',
            'https://*.ports.dev:8443',
          ],
        },
      },
      {
        '.mcp.json': servers({
          exact: remote('https://mcp.acme.internal/mcp?x=1'),
          defaultPort: remote('https://mcp.acme.internal:443/mcp'),
          otherPort: remote('https://mcp.acme.internal:8443/mcp'),
          otherScheme: remote('http://mcp.acme.internal/mcp'),
          sub: remote('https://api.acme.dev/mcp'),
          deep: remote('https://a.b.acme.dev/mcp'),
          suffixItself: remote('https://acme.dev/mcp'),
          evil: remote('https://evilacme.dev/mcp'),
          evilSub: remote('https://acme.dev.evil.com/mcp'),
          local: remote('http://localhost:3000/mcp'),
          localOther: remote('http://localhost:3001/mcp'),
          withPort: remote('https://x.ports.dev:8443/mcp'),
          withoutPort: remote('https://x.ports.dev/mcp'),
        }),
      },
    );
    expect(report.violations.map((violation) => violation.entry)).toEqual([
      'https://mcp.acme.internal:8443',
      'http://mcp.acme.internal',
      'https://acme.dev',
      'https://evilacme.dev',
      'https://acme.dev.evil.com',
      'http://localhost:3001',
      'https://x.ports.dev',
    ]);
    expect(messages(report)).toContain(
      'MCP server "evil" connects to https://evilacme.dev, which the policy does not allow.',
    );
  });

  it('fails closed on a command it cannot read', () => {
    const report = run(
      { mcp: { allow: ['npm:github', 'npm:server'] } },
      {
        '.mcp.json': servers({
          binary: { command: '/usr/local/bin/server' },
          git: npx('github:acme/server'),
          url: { url: 'not a url', type: 'http' },
        }),
      },
    );
    expect(brief(report).map(({ entry, message }) => ({ entry, message }))).toEqual([
      {
        entry: 'unknown',
        message:
          'MCP server "binary" runs a command agentcheckup cannot read as a package, so no allowlist entry can match it.',
      },
      {
        entry: 'unknown',
        message:
          'MCP server "git" runs npm package github:acme/server, whose version or source cannot be told, so no allowlist entry can match it.',
      },
      {
        entry: 'unknown',
        message:
          'MCP server "url" runs a command agentcheckup cannot read as a package, so no allowlist entry can match it.',
      },
    ]);
  });

  it('allows repository scripts only with allowLocal', () => {
    const files = { '.mcp.json': servers({ local: { command: 'node', args: ['./server.js'] } }) };
    expect(brief(run({ mcp: { allow: [] } }, files))).toEqual([
      {
        check: 'mcp-not-allowed',
        entry: 'local:./server.js',
        at: '.mcp.json:3',
        message:
          'MCP server "local" runs the repository script ./server.js, which the policy does not allow: mcp.allowLocal is off.',
      },
    ]);
    expect(run({ mcp: { allow: [], allowLocal: true } }, files).violations).toEqual([]);
  });

  it('checks nothing without an allowlist, and everything with an empty one', () => {
    const files = {
      '.mcp.json': servers({ a: npx('a') }),
      '.cursor/mcp.json': servers({ b: remote('https://b.dev') }),
    };
    expect(run({ mcp: { requirePin: false } }, files).violations).toEqual([]);
    expect(brief(run({ mcp: { allow: [] } }, files)).map((item) => item.at)).toEqual([
      '.cursor/mcp.json:3',
      '.mcp.json:3',
    ]);
  });
});

describe('mcp-unpinned', () => {
  it('reports every server that runs code without a pin', () => {
    const report = run(
      { mcp: { requirePin: true } },
      {
        '.mcp.json': servers({
          none: npx('mcp-fetch-server'),
          range: npx('mcp-fetch-server@^1.2.0'),
          tag: npx('mcp-fetch-server@latest'),
          unknown: { command: '/usr/local/bin/server' },
          exact: npx('mcp-fetch-server@1.2.0'),
          digest: docker(`ghcr.io/acme/mcp-db@${DIGEST}`),
          local: { command: 'node', args: ['./server.js'] },
          remote: remote('https://mcp.acme.internal/mcp'),
          image: docker('ghcr.io/acme/mcp-db:1'),
          pypi: uvx('mcp-server-fetch>=1'),
        }),
      },
    );
    expect(brief(report).map(({ entry, message }) => ({ entry, message }))).toEqual([
      {
        entry: 'npm:mcp-fetch-server',
        message:
          'MCP server "none" runs npm package mcp-fetch-server without a version, so whatever is newest runs; the policy requires an exact version, a digest or a repository script.',
      },
      {
        entry: 'npm:mcp-fetch-server',
        message:
          'MCP server "range" runs npm package mcp-fetch-server@^1.2.0, a version range; the policy requires an exact version, a digest or a repository script.',
      },
      {
        entry: 'npm:mcp-fetch-server',
        message:
          'MCP server "tag" runs npm package mcp-fetch-server@latest, a moving tag; the policy requires an exact version, a digest or a repository script.',
      },
      {
        entry: 'unknown',
        message:
          'MCP server "unknown" runs a command whose version cannot be told; the policy requires an exact version, a digest or a repository script.',
      },
      {
        entry: 'oci:ghcr.io/acme/mcp-db',
        message:
          'MCP server "image" runs container image ghcr.io/acme/mcp-db:1, a moving tag; the policy requires an exact version, a digest or a repository script.',
      },
      {
        entry: 'pypi:mcp-server-fetch',
        message:
          'MCP server "pypi" runs PyPI package mcp-server-fetch>=1, a version range; the policy requires an exact version, a digest or a repository script.',
      },
    ]);
  });

  it('says so when the version of a known package cannot be told', () => {
    const report = run(
      { mcp: { requirePin: true } },
      { '.mcp.json': servers({ git: npx('github:acme/server') }) },
    );
    expect(messages(report)).toEqual([
      'MCP server "git" runs npm package github:acme/server, whose version cannot be told; the policy requires an exact version, a digest or a repository script.',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

describe('forbidden-setting', () => {
  const ALL = {
    forbid: [
      'bypass-permissions',
      'auto-approve-project-mcp',
      'mcp-auto-approve',
      'broad-shell',
      'broad-write',
      'gemini-trust',
      'additional-directories',
      'env-endpoint',
      'env-tls',
      'env-code-exec',
    ],
  };

  it('reports each forbidden setting', () => {
    const report = run(ALL, {
      ...settings({
        permissions: {
          allow: ['Bash', 'Write', 'Bash(git status)', 'Write(src/**)', 'Edit'],
          deny: ['Bash'],
          defaultMode: 'bypassPermissions',
          additionalDirectories: ['../shared'],
        },
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: ['github'],
        env: {
          ANTHROPIC_BASE_URL: 'https://llm-gateway.example.com/v1',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          NODE_OPTIONS: '--require ./x.js',
          DISABLE_TELEMETRY: '1',
          ANTHROPIC_API_KEY: 'x',
        },
        apiKeyHelper: 'node ./key.js',
      }),
      '.gemini/settings.json': json({
        mcpServers: {
          trusted: { command: 'x', trust: true },
          careful: { command: 'y', trust: false },
        },
      }),
      '.claude/skills/ship/SKILL.md':
        '---\nname: ship\ndescription: Ships it.\nallowed-tools: Bash(*) Read\n---\nBody.\n',
    });
    expect(brief(report)).toEqual([
      {
        check: 'forbidden-setting',
        entry: 'broad-shell',
        at: '.claude/settings.json:4',
        message:
          'permissions.allow "Bash": Claude Code runs any shell command without asking; the policy forbids broad-shell.',
      },
      {
        check: 'forbidden-setting',
        entry: 'broad-write',
        at: '.claude/settings.json:5',
        message:
          'permissions.allow "Write": Claude Code writes any file without asking; the policy forbids broad-write.',
      },
      {
        check: 'forbidden-setting',
        entry: 'broad-write',
        at: '.claude/settings.json:8',
        message:
          'permissions.allow "Edit": Claude Code edits any file without asking; the policy forbids broad-write.',
      },
      {
        check: 'forbidden-setting',
        entry: 'bypass-permissions',
        at: '.claude/settings.json:13',
        message:
          'permissions.defaultMode "bypassPermissions" lets Claude Code run every tool without asking; the policy forbids bypass-permissions. Ignored here since Claude Code v2.1.257; older versions honor it.',
      },
      {
        check: 'forbidden-setting',
        entry: 'additional-directories',
        at: '.claude/settings.json:15',
        message:
          'permissions.additionalDirectories "../shared" gives Claude Code files outside the project; the policy forbids additional-directories.',
      },
      {
        check: 'forbidden-setting',
        entry: 'auto-approve-project-mcp',
        at: '.claude/settings.json:18',
        message:
          'enableAllProjectMcpServers is true, so Claude Code starts every MCP server in .mcp.json without asking; the policy forbids auto-approve-project-mcp.',
      },
      {
        check: 'forbidden-setting',
        entry: 'mcp-auto-approve',
        at: '.claude/settings.json:20',
        message:
          'enabledMcpjsonServers "github" lets Claude Code start that MCP server without asking; the policy forbids mcp-auto-approve.',
      },
      {
        check: 'forbidden-setting',
        entry: 'env-endpoint',
        at: '.claude/settings.json:23',
        message:
          'Env override ANTHROPIC_BASE_URL sends traffic to https://llm-gateway.example.com; the policy forbids env-endpoint.',
      },
      {
        check: 'forbidden-setting',
        entry: 'env-tls',
        at: '.claude/settings.json:24',
        message:
          'Env override NODE_TLS_REJECT_UNAUTHORIZED = 0 changes TLS certificate checks; the policy forbids env-tls.',
      },
      {
        check: 'forbidden-setting',
        entry: 'env-code-exec',
        at: '.claude/settings.json:25',
        message:
          'Env override NODE_OPTIONS can make the agent or the programs it starts run code; the policy forbids env-code-exec.',
      },
      {
        check: 'forbidden-setting',
        entry: 'env-code-exec',
        at: '.claude/settings.json:29',
        message: 'apiKeyHelper runs a command; the policy forbids env-code-exec.',
      },
      {
        check: 'forbidden-setting',
        entry: 'broad-shell',
        at: '.claude/skills/ship/SKILL.md:4',
        message:
          'allowed-tools "Bash(*)": Claude Code runs any shell command without asking; the policy forbids broad-shell.',
      },
      {
        check: 'forbidden-setting',
        entry: 'gemini-trust',
        at: '.gemini/settings.json:5',
        message:
          'mcpServers.trusted.trust is true, so Gemini CLI runs every tool call of that MCP server without confirmation; the policy forbids gemini-trust.',
      },
    ]);
    expect(report.violations.find((item) => item.path === '.claude/settings.json')?.agent).toBe(
      'claude-code',
    );
  });

  it('reports nothing the policy does not forbid, and nothing narrow', () => {
    const files = {
      ...settings({
        permissions: {
          allow: ['Bash(git status)', 'Write(src/**)', 'Read'],
          defaultMode: 'acceptEdits',
        },
        enableAllProjectMcpServers: false,
        env: { DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: 'x' },
      }),
      '.gemini/settings.json': json({ mcpServers: { careful: { command: 'y', trust: false } } }),
    };
    expect(run(ALL, files).violations).toEqual([]);
    expect(
      run({ forbid: ['broad-write'] }, settings({ permissions: { allow: ['Bash'] } })).violations,
    ).toEqual([]);
  });

  it('notes a grant no agent applies where it is set', () => {
    // A skill bundled inside another skill's folder is not loaded as a skill.
    const report = run(
      { forbid: ['broad-shell'] },
      {
        '.claude/skills/outer/SKILL.md': '---\nname: outer\ndescription: Outer.\n---\nBody.\n',
        '.claude/skills/outer/inner/SKILL.md':
          '---\nname: inner\ndescription: Inner.\nallowed-tools: Bash\n---\nBody.\n',
      },
    );
    expect(messages(report)).toEqual([
      'allowed-tools "Bash": Claude Code runs any shell command without asking; the policy forbids broad-shell. It has no effect where it is set today.',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Denied tools and commands
// ---------------------------------------------------------------------------------------------

describe('denied-tool', () => {
  const denied = (allow: string[], permissions: object = { denyCommands: ['curl'] }): string[] =>
    messages(run({ permissions }, settings({ permissions: { allow } })));

  it('reports a grant of a denied command, as the design shows', () => {
    const report = run(
      { permissions: { denyCommands: ['curl', 'wget', 'ssh'] } },
      settings({ permissions: { allow: ['Bash(curl:*)'] } }),
    );
    expect(brief(report)).toEqual([
      {
        check: 'denied-tool',
        entry: 'curl',
        at: '.claude/settings.json:4',
        message:
          'permissions.allow "Bash(curl:*)" lets Claude Code run curl without asking; the policy denies curl.',
      },
    ]);
    expect(report.violations[0]?.agent).toBe('claude-code');
  });

  it('treats Bash, Bash(*) and grants whose program cannot be told as every command', () => {
    expect(
      denied(['Bash', 'Bash(*)', 'Bash(* | sh)', 'Bash($(x))'], {
        denyCommands: ['curl', 'wget'],
      }),
    ).toEqual([
      'permissions.allow "Bash" lets Claude Code run any command without asking; the policy denies curl and wget.',
      'permissions.allow "Bash(*)" lets Claude Code run any command without asking; the policy denies curl and wget.',
      'permissions.allow "Bash(* | sh)" lets Claude Code run commands whose program cannot be told without asking; the policy denies curl and wget.',
      'permissions.allow "Bash($(x))" lets Claude Code run commands whose program cannot be told without asking; the policy denies curl and wget.',
    ]);
  });

  it('does not report shell grants of other programs, or grants that are not shell grants', () => {
    expect(
      denied([
        'Bash(git status)',
        'Bash(npm run test:*)',
        'Bash(curly)',
        'Read(curl)',
        'WebFetch(domain:curl.se)',
      ]),
    ).toEqual([]);
  });

  it('never reports deny or ask entries', () => {
    const report = run(
      { permissions: { denyTools: ['WebFetch'], denyCommands: ['curl'] } },
      settings({ permissions: { deny: ['Bash', 'WebFetch'], ask: ['Bash(curl:*)'] } }),
    );
    expect(report.violations).toEqual([]);
  });

  it('reports denied tools, MCP servers and their tools', () => {
    expect(
      denied(
        [
          'WebFetch',
          'WebFetch(domain:example.com)',
          'WebSearch',
          'mcp__github',
          'mcp__gitlab__*',
          'mcp__jira__create',
        ],
        {
          denyTools: ['WebFetch', 'mcp__github__create_issue', 'mcp__gitlab__delete', 'mcp__jira'],
        },
      ),
    ).toEqual([
      'permissions.allow "WebFetch" lets Claude Code use WebFetch without asking; the policy denies WebFetch.',
      'permissions.allow "WebFetch(domain:example.com)" lets Claude Code use WebFetch without asking; the policy denies WebFetch.',
      'permissions.allow "mcp__github" lets Claude Code use mcp__github without asking; the policy denies mcp__github__create_issue.',
      'permissions.allow "mcp__gitlab__*" lets Claude Code use mcp__gitlab__* without asking; the policy denies mcp__gitlab__delete.',
      'permissions.allow "mcp__jira__create" lets Claude Code use mcp__jira__create without asking; the policy denies mcp__jira.',
    ]);
  });

  it('names a denied tool and denied commands together', () => {
    expect(denied(['Bash(curl x)'], { denyTools: ['Bash'], denyCommands: ['curl'] })).toEqual([
      'permissions.allow "Bash(curl x)" lets Claude Code run curl without asking; the policy denies Bash and curl.',
    ]);
    expect(denied(['Bash(git status)'], { denyTools: ['Bash'], denyCommands: ['curl'] })).toEqual([
      'permissions.allow "Bash(git status)" lets Claude Code use Bash without asking; the policy denies Bash.',
    ]);
  });

  it("applies to a skill's allowed-tools, one rule at a time", () => {
    const report = run(
      { permissions: { denyCommands: ['curl'] } },
      {
        '.claude/skills/fetch/SKILL.md':
          '---\nname: fetch\ndescription: Fetches.\nallowed-tools: Bash(curl:*), Read, Bash(git log)\n---\nBody.\n',
        '.github/skills/sh/SKILL.md':
          '---\nname: sh\ndescription: Runs.\nallowed-tools: shell\n---\nBody.\n',
      },
    );
    expect(brief(report)).toEqual([
      {
        check: 'denied-tool',
        entry: 'curl',
        at: '.claude/skills/fetch/SKILL.md:4',
        message:
          'allowed-tools "Bash(curl:*)" lets the agent run curl without asking; the policy denies curl.',
      },
      {
        check: 'denied-tool',
        entry: 'curl',
        at: '.github/skills/sh/SKILL.md:4',
        message:
          'allowed-tools "shell" lets the agent run any command without asking; the policy denies curl.',
      },
    ]);
    expect(report.violations[0]?.agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

describe('hook-missing', () => {
  const claudeHook = settings({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh' }],
        },
      ],
    },
  });

  it('is satisfied by a configured hook of the agent and event', () => {
    for (const requirement of [
      { agent: 'claude-code', event: 'PreToolUse' },
      { agent: 'claude-code', event: 'PreToolUse', matcher: 'Bash' },
      { agent: 'claude-code', event: 'PreToolUse', script: 'scripts/guard.sh' },
      {
        agent: 'claude-code',
        event: 'PreToolUse',
        command: '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh',
      },
    ]) {
      const report = run({ hooks: { require: [requirement] } }, claudeHook);
      expect(report.violations, JSON.stringify(requirement)).toEqual([]);
      expect(report.notes).toEqual([{ id: 'hooks-not-enforced', message: HOOKS_NOT_ENFORCED }]);
    }
  });

  it('reports a requirement no hook meets, with the enforcement caveat', () => {
    const report = run(
      {
        hooks: {
          require: [
            { agent: 'claude-code', event: 'PreToolUse', matcher: 'Edit' },
            { agent: 'claude-code', event: 'PreToolUse', script: 'scripts/other.sh' },
            { agent: 'claude-code', event: 'Stop' },
            { agent: 'codex', event: 'PreToolUse', command: 'x' },
            { agent: 'gemini', event: 'BeforeTool' },
            { agent: 'copilot', event: 'preToolUse' },
          ],
        },
      },
      claudeHook,
    );
    expect(brief(report)).toEqual([
      {
        check: 'hook-missing',
        entry: 'claude-code PreToolUse matcher "Edit"',
        message: `The policy requires a Claude Code PreToolUse hook with matcher "Edit", and none is configured. ${HOOKS_NOT_ENFORCED}`,
      },
      {
        check: 'hook-missing',
        entry: 'claude-code PreToolUse script scripts/other.sh',
        message: `The policy requires a Claude Code PreToolUse hook that runs "scripts/other.sh", and none is configured. ${HOOKS_NOT_ENFORCED}`,
      },
      {
        check: 'hook-missing',
        entry: 'claude-code Stop',
        message: `The policy requires a Claude Code Stop hook, and none is configured. ${HOOKS_NOT_ENFORCED}`,
      },
      {
        check: 'hook-missing',
        entry: 'codex PreToolUse command "x"',
        message: `The policy requires a Codex PreToolUse hook with command "x", and none is configured. ${HOOKS_NOT_ENFORCED}`,
      },
      {
        check: 'hook-missing',
        entry: 'copilot preToolUse',
        message: `The policy requires a GitHub Copilot preToolUse hook, and none is configured. ${HOOKS_NOT_ENFORCED}`,
      },
      {
        check: 'hook-missing',
        entry: 'gemini BeforeTool',
        message: `The policy requires a Gemini CLI BeforeTool hook, and none is configured. ${HOOKS_NOT_ENFORCED}`,
      },
    ]);
    // Copilot's hooks serve three agents (CLI, VS Code, cloud), so the violation names none.
    expect(report.violations.map((violation) => violation.agent)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'codex',
      undefined,
      'gemini',
    ]);
    expect(report.notes).toEqual([]);
  });

  it('reports a requirement the policy repeats once', () => {
    const requirement = { agent: 'claude-code', event: 'Stop' };
    const report = run({ hooks: { require: [requirement, { ...requirement }] } }, {});
    expect(report.violations.map((violation) => violation.entry)).toEqual(['claude-code Stop']);
  });

  it("does not count another agent's hook", () => {
    const files = {
      '.codex/hooks.json': json({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
      }),
      '.cursor/hooks.json': json({
        version: 1,
        hooks: { beforeShellExecution: [{ command: './scripts/guard.sh' }] },
      }),
    };
    const report = run(
      {
        hooks: {
          require: [
            { agent: 'claude-code', event: 'PreToolUse' },
            { agent: 'codex', event: 'PreToolUse', matcher: 'Bash', command: 'x' },
            { agent: 'cursor', event: 'beforeShellExecution', script: 'scripts/guard.sh' },
          ],
        },
      },
      files,
    );
    expect(report.violations.map((violation) => violation.entry)).toEqual([
      'claude-code PreToolUse',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Startup budgets
// ---------------------------------------------------------------------------------------------

describe('startup-budget', () => {
  const large = (chars: number): string => `# Notes\n\n${'word '.repeat(chars / 5)}\n`;

  it('reports an agent whose largest plan exceeds its budget, as the design shows', () => {
    const files = { 'CLAUDE.md': large(40_000) };
    const current = scan(files);
    const tokens = current.context.plans.find((plan) => plan.agent === 'claude-code')?.totals
      .startup.tokens;
    expect(tokens).toBeGreaterThan(8000);
    const report = evaluate(policyOf({ budgets: { 'claude-code': { startupTokens: 8000 } } }), {
      current,
    });
    expect(brief(report)).toEqual([
      {
        check: 'startup-budget',
        entry: 'claude-code',
        message: `Claude Code loads ≈${(tokens ?? 0).toLocaleString('en-US')} tokens at session start in ./ (policy limit ≈8,000).`,
      },
    ]);
    expect(report.violations[0]?.agent).toBe('claude-code');
  });

  it('takes the largest of the root plan and every matrix plan', () => {
    const files = { 'AGENTS.md': '# Root\n\nShort.\n', 'packages/a/AGENTS.md': large(40_000) };
    const report = run({ budgets: { codex: { startupTokens: 8000 } } }, files);
    expect(messages(report)).toHaveLength(1);
    expect(messages(report)[0]).toMatch(
      /^Codex loads ≈[\d,]+ tokens at session start in \.\/packages\/a \(policy limit ≈8,000\)\.$/,
    );
  });

  it('reports nothing within the budget, and nothing for agents without one', () => {
    const files = { 'CLAUDE.md': large(40_000), 'AGENTS.md': '# Short\n' };
    expect(
      run(
        { budgets: { 'claude-code': { startupTokens: 100_000 }, codex: { startupTokens: 8000 } } },
        files,
      ).violations,
    ).toEqual([]);
  });

  it('fails closed when an agent was not planned', () => {
    const policy = policyOf({ budgets: { cursor: { startupTokens: 10 } } });
    const report = evaluate(policy, { current: { inventory: scan({}).inventory } });
    expect(messages(report)).toEqual([
      'Cursor has no load plan in this scan, so its startup context cannot be checked (policy limit ≈10).',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Unanalyzed configuration
// ---------------------------------------------------------------------------------------------

describe('unanalyzed-config', () => {
  const files = {
    '.codex/config.toml': '[mcp_servers.x\ncommand = "npx"\n',
    'pkg/.codex/config.toml': '[mcp_servers.y]\ncommand = "npx"\n',
    'tools/.codex/config.toml': Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x3d, 0, 0x31, 0),
    '.mcp.json': '{ "mcpServers": ',
    '.vscode/mcp.json': '{}',
  };

  // .vscode/mcp.json and pkg/.codex/config.toml are valid and analyzed: not reported.
  it('reports every file the inventory could not analyze', () => {
    expect(brief(run({ forbid: ['broad-shell'] }, files))).toEqual([
      {
        check: 'unanalyzed-config',
        entry: 'invalid-toml:.codex/config.toml',
        at: '.codex/config.toml:-',
        message:
          'This file is not valid TOML, so what it configures cannot be checked against the policy.',
      },
      {
        check: 'unanalyzed-config',
        entry: 'invalid-json:.mcp.json',
        at: '.mcp.json:-',
        message:
          'This file is not valid JSON, so what it configures cannot be checked against the policy.',
      },
      {
        check: 'unanalyzed-config',
        entry: 'tools/.codex/config.toml',
        at: 'tools/.codex/config.toml:-',
        message:
          'agentcheckup cannot analyze this file, so what it configures cannot be checked against the policy.',
      },
    ]);
  });

  it('is not checked by a policy that reads no inventory', () => {
    expect(run({ budgets: { codex: { startupTokens: 100_000 } } }, files).violations).toEqual([]);
    expect(activeChecks(policyOf({ budgets: { codex: { startupTokens: 1 } } }))).toEqual([
      'startup-budget',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Baselines, modes and notes
// ---------------------------------------------------------------------------------------------

describe('baselines', () => {
  const before = { '.mcp.json': servers({ fetch: npx('mcp-fetch-server') }) };
  const after = {
    '.mcp.json': servers({ fetch: npx('mcp-fetch-server'), time: npx('mcp-server-time') }),
  };
  const allowNothing = { mcp: { allow: [] } };

  it('marks violations the baseline has as unchanged, and fails only on new ones', () => {
    const report = run(allowNothing, after, { baseline: before });
    expect(
      report.violations.map(({ entry, baseline, fails }) => ({ entry, baseline, fails })),
    ).toEqual([
      { entry: 'npm:mcp-fetch-server', baseline: 'unchanged', fails: false },
      { entry: 'npm:mcp-server-time', baseline: 'new', fails: true },
    ]);
  });

  it('fails on every violation with existing: fail', () => {
    const report = run({ ...allowNothing, existing: 'fail' }, after, { baseline: before });
    expect(report.violations.map(({ baseline, fails }) => ({ baseline, fails }))).toEqual([
      { baseline: 'unchanged', fails: true },
      { baseline: 'new', fails: true },
    ]);
  });

  it('counts a changed server that already violated as new', () => {
    const changed = { '.mcp.json': servers({ fetch: npx('mcp-fetch-server@latest') }) };
    const report = run(allowNothing, changed, { baseline: before });
    expect(report.violations.map(({ baseline, fails }) => ({ baseline, fails }))).toEqual([
      { baseline: 'new', fails: true },
    ]);
  });

  it('fails on every violation without a baseline', () => {
    const report = run(allowNothing, after);
    expect(report.violations.every((violation) => violation.fails)).toBe(true);
    expect(report.violations.every((violation) => violation.baseline === undefined)).toBe(true);
  });

  it('never fails in audit mode', () => {
    const report = run({ ...allowNothing, mode: 'audit', existing: 'fail' }, after, {
      baseline: before,
    });
    expect(report.mode).toBe('audit');
    expect(report.violations).toHaveLength(2);
    expect(report.violations.some((violation) => violation.fails)).toBe(false);
    expect(report.notes).toEqual([
      { id: 'audit-mode', message: 'Audit mode: violations are reported but never fail the run.' },
    ]);
  });

  it('matches a baseline written from another directory', () => {
    const policy = policyOf(allowNothing);
    const current = scan(after);
    const plain = evaluate(policy, { current, baseline: scan(before) });
    const rebased = evaluate(policy, {
      current: rebaseResult(current, 'repo'),
      baseline: rebaseResult(scan(before), 'other/place'),
    });
    expect(rebased.violations.map(({ id, baseline }) => ({ id, baseline }))).toEqual(
      plain.violations.map(({ id, baseline }) => ({ id, baseline })),
    );
    expect(rebased.violations.map((violation) => violation.path)).toEqual([
      'repo/.mcp.json',
      'repo/.mcp.json',
    ]);
  });

  it('counts a budget violation as new only when the startup context grew', () => {
    const big = (chars: number): FileMap => ({ 'CLAUDE.md': `# A\n\n${'x'.repeat(chars)}\n` });
    const budget = { budgets: { 'claude-code': { startupTokens: 1000 } } };
    const status = (beforeChars: number, afterChars: number): unknown =>
      run(budget, big(afterChars), { baseline: big(beforeChars) }).violations.map(
        (violation) => violation.baseline,
      );
    expect(status(8000, 8000)).toEqual(['unchanged']);
    expect(status(9000, 8000)).toEqual(['unchanged']);
    expect(status(8000, 9000)).toEqual(['new']);
    expect(status(100, 9000)).toEqual(['new']);
  });

  it('notes what an old baseline cannot show', () => {
    const policy = policyOf({ ...allowNothing, budgets: { 'claude-code': { startupTokens: 1 } } });
    const baseline: PolicySubject = {};
    const report = evaluate(policy, { current: scan(after), baseline });
    expect(report.violations.every((violation) => violation.baseline === 'new')).toBe(true);
    expect(report.notes.map((note) => note.id)).toEqual([
      'baseline-without-inventory',
      'baseline-without-plans',
    ]);
  });

  it('notes that changes inside an unanalyzed file are not visible', () => {
    const toml = { '.codex/config.toml': '[a\n' };
    const report = run(
      { forbid: ['broad-shell'] },
      { '.codex/config.toml': '[b\n' },
      { baseline: toml },
    );
    expect(report.violations.map((violation) => violation.baseline)).toEqual(['unchanged']);
    expect(report.notes.map((note) => note.id)).toEqual(['unanalyzed-unchanged']);
  });
});

describe('the report', () => {
  it('carries the policy name, digest, mode and the number of checks', () => {
    const policy = policyOf({
      mcp: { allow: [], requirePin: true },
      forbid: ['broad-shell'],
      permissions: { denyTools: ['WebFetch'] },
      hooks: { require: [{ agent: 'claude-code', event: 'Stop' }] },
      budgets: { codex: { startupTokens: 1 } },
    });
    const report = evaluate(policy, { current: scan({}), insideScanRoot: true });
    expect(report).toMatchObject({
      name: 'test policy',
      sha256: SHA256,
      mode: 'enforce',
      insideScanRoot: true,
      checks: 7,
    });
    expect(report.notes.map((note) => note.id)).toEqual(['policy-inside-scan-root']);
    expect(evaluate(policyOf({}), { current: scan({}) })).toEqual({
      name: 'test policy',
      sha256: SHA256,
      mode: 'enforce',
      insideScanRoot: false,
      checks: 0,
      violations: [],
      notes: [],
    });
  });

  it('keeps hostile names raw for the reporters, on one line', () => {
    const name = 'evil\u001b]52;c;x\u0007\nname‮';
    const report = run({ mcp: { allow: [] } }, { '.mcp.json': servers({ [name]: npx('x') }) });
    const message = messages(report)[0] ?? '';
    expect(message).toContain('\u001b]52;c;x\u0007');
    expect(message).toContain('‮');
    expect(message).not.toMatch(/[\n\r]/);
  });
});

// ---------------------------------------------------------------------------------------------
// The strict sample policy over the context fixture
// ---------------------------------------------------------------------------------------------

async function contextFixture(): Promise<ContextScanResult> {
  const root = fileURLToPath(new URL('../fixtures/context', import.meta.url));
  const walked = await walk(root);
  const snapshot: Snapshot = {
    ...walked,
    paths: new Set([...walked.paths, '.git/']),
    opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
  };
  return scanWithContext(snapshot, { rules: builtinRules, matrix: true });
}

function strictPolicy(): Policy {
  const text = readFileSync(new URL('../fixtures/policy/strict.json', import.meta.url), 'utf8');
  const result = parsePolicy(JSON.parse(text));
  if ('errors' in result) throw new Error(result.errors.join('\n'));
  return result.policy;
}

describe('the strict sample policy', () => {
  it('reports the context fixture, deterministically', async () => {
    const current = await contextFixture();
    const policy = strictPolicy();
    const report = evaluate(policy, { current });
    const reversed: PolicySubject = {
      inventory: {
        mcpServers: [...current.inventory.mcpServers].reverse(),
        hooks: [...current.inventory.hooks].reverse(),
        permissions: [...current.inventory.permissions].reverse(),
        env: [...current.inventory.env].reverse(),
        incomplete: [...current.inventory.incomplete].reverse(),
      },
      context: { plans: [...current.context.plans].reverse() },
    };
    expect(evaluate(policy, { current: reversed })).toEqual(report);
    expect(evaluate(policy, { current })).toEqual(report);
    expect(new Set(report.violations.map((violation) => violation.id)).size).toBe(
      report.violations.length,
    );
    expect(
      brief(report).map(({ check, entry, at }) => `${check} ${entry} ${at ?? ''}`),
    ).toMatchSnapshot();
  });

  it('reports nothing for a repository that follows it', () => {
    const report = evaluate(strictPolicy(), {
      current: scan({
        'CLAUDE.md': '# Project\n\nUse pnpm.\n',
        'AGENTS.md': '# Project\n\nUse pnpm.\n',
        '.mcp.json': servers({
          github: npx('@modelcontextprotocol/server-github@2025.4.8'),
          fetch: uvx('mcp-server-fetch==1.0.0'),
          db: docker(`ghcr.io/acme/mcp-db@sha256:${'0123456789abcdef'.repeat(4)}`),
          internal: remote('https://mcp.acme.internal/mcp'),
        }),
        ...settings({
          permissions: { allow: ['Bash(pnpm test:*)', 'Read'], deny: ['WebFetch'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/scripts/hooks/guard.sh' },
                ],
              },
            ],
          },
        }),
        'scripts/hooks/guard.sh': '#!/bin/sh\nexit 0\n',
      }),
    });
    expect(report.violations).toEqual([]);
    expect(report.checks).toBe(7);
  });
});
