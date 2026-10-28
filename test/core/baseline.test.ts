import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareWithBaseline,
  type CurrentScan,
  GATE_CLASSES,
  newRuleIds,
  parseGateClasses,
  SECURITY_GATE_CLASSES,
} from '../../src/core/baseline.js';
import { type BaselineReport, validateBaseline } from '../../src/core/baseline-input.js';
import type { AgentDefinition, AgentsReport, ModelSetting } from '../../src/agents/types.js';
import type { GateClass } from '../../src/core/baseline-types.js';
import { FINGERPRINT_VERSION } from '../../src/core/meta.js';
import type { Finding, RuleMeta } from '../../src/core/types.js';
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PermissionItem,
} from '../../src/inventory/types.js';
import type {
  ContextAgent,
  LoadEntry,
  LoadPlan,
  Size,
  SkippedLoad,
} from '../../src/platforms/load/types.js';

/** Override for deeper local fuzzing, e.g. `BASELINE_PROPERTY_RUNS=5000 vitest run test/core`. */
const RUNS = Number(process.env['BASELINE_PROPERTY_RUNS'] ?? 200);

type Report = CurrentScan & BaselineReport;

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

function finding(
  ruleId: string,
  path: string,
  fingerprint: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    ruleId,
    severity: 'warn',
    category: 'risk',
    message: `${ruleId} fires here.`,
    path,
    range: { start: { line: 3, column: 1 }, end: { line: 3, column: 9 } },
    related: [],
    platforms: ['claude-code'],
    fingerprint,
    ...overrides,
  };
}

function rule(id: string, since: string): RuleMeta {
  return {
    id,
    title: `Title of ${id}`,
    rationale: 'Why it matters.',
    category: 'risk',
    severity: 'warn',
    appliesTo: ['agents-md'],
    platforms: ['codex'],
    sources: [
      { title: 'Docs', url: 'https://example.com', checked: '2026-10-15', status: 'verified' },
    ],
    since,
  };
}

function mcp(name: string, overrides: Partial<McpServerItem> = {}): McpServerItem {
  const file = overrides.file ?? '.mcp.json';
  return {
    id: `mcp:${file}#${name}`,
    file,
    line: 2,
    platforms: ['claude-code'],
    digest: `${name}-1`,
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `@acme/${name}-mcp`],
    package: { launcher: 'npx', ecosystem: 'npm', name: `@acme/${name}-mcp`, pin: 'none' },
    envKeys: [],
    headerKeys: [],
    status: { 'claude-code': 'needs-approval' },
    ...overrides,
  };
}

function hook(event: string, overrides: Partial<HookItem> = {}): HookItem {
  const file = overrides.file ?? '.claude/settings.json';
  return {
    id: `hook:${file}#${event}:00c0ffee`,
    file,
    line: 5,
    platforms: ['claude-code'],
    digest: `${event}-1`,
    event,
    known: true,
    matcher: 'Bash',
    command: '"$CLAUDE_PROJECT_DIR"/scripts/hooks/guard.sh',
    script: 'scripts/hooks/guard.sh',
    failsOpen: false,
    remoteScript: false,
    ...overrides,
  };
}

function permission(
  key: string,
  value: string,
  overrides: Partial<PermissionItem> = {},
): PermissionItem {
  const file = overrides.file ?? '.claude/settings.json';
  return {
    id: `perm:${file}#${key}=${value}`,
    file,
    line: 7,
    platforms: ['claude-code'],
    digest: `${key}=${value}-1`,
    key,
    value,
    broad: false,
    effective: true,
    ...overrides,
  };
}

function env(key: string, cls: EnvItem['class'], overrides: Partial<EnvItem> = {}): EnvItem {
  const file = overrides.file ?? '.claude/settings.json';
  return {
    id: `env:${file}#${key}`,
    file,
    line: 9,
    platforms: ['claude-code'],
    digest: `${key}-1`,
    key,
    class: cls,
    ...overrides,
  };
}

function inventory(input: Partial<Inventory> = {}): Inventory {
  return { mcpServers: [], hooks: [], permissions: [], env: [], incomplete: [], ...input };
}

const size = (chars: number): Size => ({ bytes: chars, chars, tokens: Math.ceil(chars / 4) });

function entry(path: string, overrides: Partial<LoadEntry> = {}): LoadEntry {
  return {
    id: `instructions:${path}`,
    role: 'instructions',
    trigger: 'startup',
    position: 1,
    path,
    realPath: path,
    size: size(400),
    certainty: 'documented',
    evidence: [],
    ...overrides,
  };
}

function skip(path: string, overrides: Partial<SkippedLoad> = {}): SkippedLoad {
  return {
    id: `instructions:${path}`,
    role: 'instructions',
    path,
    code: 'shadowed-by-claude-md',
    ruleId: 'instr/agents-md-ignored-by-claude',
    certainty: 'documented',
    evidence: [],
    ...overrides,
  };
}

function plan(agent: ContextAgent, cwd: string, overrides: Partial<LoadPlan> = {}): LoadPlan {
  return {
    agent,
    cwd,
    entries: [],
    skipped: [],
    outOfScope: [],
    assumptions: [],
    hidden: [],
    limits: [],
    totals: { startup: size(0), onDemand: size(0) },
    incomplete: [],
    ...overrides,
  };
}

interface ReportInput {
  readonly findings?: readonly Finding[];
  /** `null` leaves the inventory out, as in reports made before it existed. */
  readonly inventory?: Partial<Inventory> | null;
  readonly agents?: AgentsReport;
  readonly plans?: readonly LoadPlan[];
  readonly pathBase?: string;
  readonly ruleset?: string;
  readonly rules?: readonly RuleMeta[];
}

function report(input: ReportInput = {}): Report {
  return {
    schemaVersion: 1,
    tool: { name: 'agentcheckup', version: '0.1.0' },
    ruleset: input.ruleset ?? '2026.10',
    fingerprintVersion: FINGERPRINT_VERSION,
    rules: input.rules ?? [],
    findings: input.findings ?? [],
    ...(input.pathBase === undefined ? {} : { pathBase: input.pathBase }),
    ...(input.inventory === null ? {} : { inventory: inventory(input.inventory) }),
    ...(input.agents === undefined ? {} : { agents: input.agents }),
    ...(input.plans === undefined
      ? {}
      : {
          context: { agents: ['claude-code', 'codex', 'cursor'], sources: {}, plans: input.plans },
        }),
  };
}

function compare(before: Report, after: Report, gate: readonly GateClass[] = GATE_CLASSES) {
  return compareWithBaseline(after, before, { gate });
}

function hits(before: Report, after: Report, gate: readonly GateClass[] = GATE_CLASSES) {
  return compare(before, after, gate).diff.gate.hits;
}

/** JSON.parse into null-prototype objects, as src/io does for a baseline file. */
function parse(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown): unknown =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.assign(Object.create(null) as object, value)
      : value,
  ) as unknown;
}

/** What a rebase onto `prefix` does to every path and every id that embeds one. */
function rebased(source: Report, prefix: string): Report {
  const join = (path: string): string => (path === '' ? prefix : `${prefix}/${path}`);
  const rebaseId = (id: string): string => {
    const at = id.indexOf(':') + 1;
    return id.slice(0, at) + join(id.slice(at));
  };
  const item = <T extends { id: string; file: string }>(value: T): T => ({
    ...value,
    id: rebaseId(value.id),
    file: join(value.file),
  });
  const inv = source.inventory;
  return {
    ...source,
    pathBase: prefix,
    findings: source.findings.map((f) => ({ ...f, path: join(f.path) })),
    ...(inv === undefined
      ? {}
      : {
          inventory: {
            mcpServers: inv.mcpServers.map(item),
            hooks: inv.hooks.map((h) => ({
              ...item(h),
              ...(h.script === undefined ? {} : { script: join(h.script) }),
            })),
            permissions: inv.permissions.map(item),
            env: inv.env.map(item),
            incomplete: inv.incomplete.map((entry) =>
              entry.startsWith('invalid-json:')
                ? `invalid-json:${join(entry.slice('invalid-json:'.length))}`
                : join(entry),
            ),
          },
        }),
    ...(source.context === undefined
      ? {}
      : {
          context: {
            ...source.context,
            plans: source.context.plans.map((p) => ({
              ...p,
              cwd: join(p.cwd),
              entries: p.entries.map((e) => ({
                ...e,
                id: rebaseId(e.id),
                path: join(e.path),
                realPath: join(e.realPath),
              })),
              skipped: p.skipped.map((s) => ({ ...s, id: rebaseId(s.id), path: join(s.path) })),
              limits: p.limits.map((l) => ({ ...l, subject: join(l.subject) })),
            })),
          },
        }),
  };
}

function expectNoChanges(result: ReturnType<typeof compare>): void {
  const { diff, findings } = result;
  expect(diff.findings.new).toBe(0);
  expect(diff.findings.resolved).toEqual([]);
  expect(diff.inventory).toEqual({ added: [], removed: [], changed: [] });
  for (const delta of diff.context) {
    expect(delta.entries).toEqual({ added: [], removed: [], changed: [] });
    expect(delta.skipped).toEqual({ added: [], removed: [], changed: [] });
    expect(delta.startupTokens.before).toBe(delta.startupTokens.after);
    for (const limit of delta.limits) expect(limit.before).toBe(limit.after);
  }
  expect(diff.gate.hits).toEqual([]);
  expect(findings.every((f) => f.baseline === 'unchanged')).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// --gate
// ---------------------------------------------------------------------------------------------

describe('parseGateClasses', () => {
  it('reads a list, sorted and without duplicates', () => {
    expect(parseGateClasses('mcp,hooks, mcp ,env')).toEqual({
      ok: true,
      classes: ['env', 'hooks', 'mcp'],
    });
  });

  it('expands security to every class but models, and reads none as no class', () => {
    const security = ['env', 'hooks', 'mcp', 'mcp-unpinned', 'permissions', 'unicode'];
    expect(parseGateClasses('security')).toEqual({ ok: true, classes: security });
    expect(parseGateClasses('security,mcp')).toEqual({ ok: true, classes: security });
    expect(parseGateClasses('security,models')).toEqual({
      ok: true,
      classes: [...security, 'models'].sort(),
    });
    expect(parseGateClasses('none')).toEqual({ ok: true, classes: [] });
    expect([...GATE_CLASSES].sort()).toEqual([...security, 'models'].sort());
  });

  it.each([
    ['MCP', 'Unknown gate class "MCP"'],
    ['mcp,', 'Empty gate class'],
    ['', 'Empty gate class'],
    ['none,mcp', '"none" cannot be combined'],
    ['none,security', '"none" cannot be combined'],
    ['__proto__', 'Unknown gate class "__proto__"'],
    ['constructor', 'Unknown gate class "constructor"'],
  ])('rejects %j', (input, message) => {
    const result = parseGateClasses(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(message);
      expect(result.message).toContain('security');
    }
  });

  it('quotes an unknown class safely and cuts it short', () => {
    const result = parseGateClasses(`\u001b[31m${'x'.repeat(200)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('\u001b');
      expect(result.message).toContain('…');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

describe('findings', () => {
  it('marks findings new or unchanged, in order, without changing the input', () => {
    const before = report({ findings: [finding('a/x', 'AGENTS.md', 'f1:1')] });
    const current = [finding('b/y', 'CLAUDE.md', 'f2:1'), finding('a/x', 'AGENTS.md', 'f1:1')];
    const after = report({ findings: current });
    const result = compare(before, after);
    expect(result.findings.map((f) => [f.fingerprint, f.baseline])).toEqual([
      ['f2:1', 'new'],
      ['f1:1', 'unchanged'],
    ]);
    expect(result.diff.findings).toEqual({ new: 1, unchanged: 1, resolved: [] });
    expect(current.every((f) => f.baseline === undefined)).toBe(true);
  });

  it('matches duplicate fingerprints as a multiset', () => {
    const a = finding('a/x', 'AGENTS.md', 'dup:1');
    const before = report({ findings: [a, a, finding('b/y', 'AGENTS.md', 'gone:1')] });
    const after = report({ findings: [a, a, a, finding('c/z', 'AGENTS.md', 'fresh:1')] });
    const result = compare(before, after);
    expect(result.findings.map((f) => f.baseline)).toEqual([
      'unchanged',
      'unchanged',
      'new',
      'new',
    ]);
    expect(result.diff.findings.new).toBe(2);
    expect(result.diff.findings.unchanged).toBe(2);
    expect(result.diff.findings.resolved).toEqual([
      { ruleId: 'b/y', path: 'AGENTS.md', fingerprint: 'gone:1' },
    ]);

    const fewer = compare(report({ findings: [a, a, a] }), report({ findings: [a] }));
    expect(fewer.diff.findings.resolved).toHaveLength(2);
    expect(fewer.diff.findings.unchanged).toBe(1);
  });

  it('lists resolved findings by path, rule and fingerprint, without the pathBase', () => {
    const before = report({
      pathBase: 'packages/api',
      findings: [
        finding('z/z', 'packages/api/b.md', 'f3:1'),
        finding('b/b', 'packages/api/a.md', 'f2:1'),
        finding('a/a', 'packages/api/a.md', 'f1:1'),
      ],
    });
    expect(compare(before, report()).diff.findings.resolved).toEqual([
      { ruleId: 'a/a', path: 'a.md', fingerprint: 'f1:1' },
      { ruleId: 'b/b', path: 'a.md', fingerprint: 'f2:1' },
      { ruleId: 'z/z', path: 'b.md', fingerprint: 'f3:1' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Gate classes, one fixture pair each
// ---------------------------------------------------------------------------------------------

describe('gate: mcp and mcp-unpinned', () => {
  it('reports a new unpinned server under both classes', () => {
    expect(hits(report(), report({ inventory: { mcpServers: [mcp('browser')] } }))).toEqual([
      {
        class: 'mcp',
        id: 'mcp:.mcp.json#browser',
        change: 'added',
        summary: 'New MCP server browser (stdio, npx -y @acme/browser-mcp, not pinned)',
      },
      {
        class: 'mcp-unpinned',
        id: 'mcp:.mcp.json#browser',
        change: 'added',
        summary: 'New MCP server browser is not pinned (npx @acme/browser-mcp, no version)',
      },
    ]);
  });

  it('reports a changed pinned server under mcp only', () => {
    const pinned = (version: string, digest: string): McpServerItem =>
      mcp('github', {
        digest,
        args: ['-y', `@acme/github-mcp@${version}`],
        package: { launcher: 'npx', name: '@acme/github-mcp', version, pin: 'exact' },
      });
    const before = report({ inventory: { mcpServers: [pinned('1.4.0', 'a')] } });
    const after = report({ inventory: { mcpServers: [pinned('1.5.0', 'b')] } });
    expect(hits(before, after)).toEqual([
      {
        class: 'mcp',
        id: 'mcp:.mcp.json#github',
        change: 'changed',
        summary: 'Changed MCP server github (stdio, npx -y @acme/github-mcp@1.5.0, pinned)',
      },
    ]);
    expect(compare(before, after).diff.inventory.changed).toEqual([
      { id: 'mcp:.mcp.json#github', fields: ['args', 'package'] },
    ]);
    // Same digest: nothing changed.
    expect(hits(before, before)).toEqual([]);
  });

  it.each([
    ['exact', false],
    ['digest', false],
    ['local', false],
    ['range', true],
    ['tag', true],
    ['none', true],
    ['unknown', true],
  ] as const)('pin %s trips mcp-unpinned: %s', (pin, trips) => {
    const after = report({
      inventory: { mcpServers: [mcp('x', { package: { launcher: 'npx', pin } })] },
    });
    const classes = hits(report(), after).map((hit) => hit.class);
    expect(classes).toEqual(trips ? ['mcp', 'mcp-unpinned'] : ['mcp']);
  });

  it('describes why a server is not pinned', () => {
    const summary = (server: McpServerItem): string | undefined =>
      hits(report(), report({ inventory: { mcpServers: [server] } }), ['mcp-unpinned'])[0]?.summary;
    expect(
      summary(
        mcp('x', {
          package: { launcher: 'npx', name: '@acme/x-mcp', version: '^1.2.0', pin: 'range' },
        }),
      ),
    ).toBe('New MCP server x is not pinned (npx @acme/x-mcp ^1.2.0, a version range)');
    expect(
      summary(
        mcp('x', {
          command: 'docker',
          args: ['run', '-i', '--rm', 'ghcr.io/acme/x:latest'],
          package: { launcher: 'docker', name: 'ghcr.io/acme/x', version: 'latest', pin: 'tag' },
        }),
      ),
    ).toBe('New MCP server x is not pinned (docker ghcr.io/acme/x latest, a moving tag)');
    expect(
      summary(
        mcp('x', {
          command: 'my-server',
          args: [],
          package: { launcher: 'unknown', pin: 'unknown' },
        }),
      ),
    ).toBe('New MCP server x is not pinned (cannot tell which version of my-server runs)');
  });

  it('does not call a remote server unpinned, but a local one without a package spec is', () => {
    const { command: _command, args: _args, package: _package, ...base } = mcp('docs');
    const remote: McpServerItem = {
      ...base,
      transport: 'http',
      url: { origin: 'https://docs.example.com', tls: true, loopback: false },
    };
    expect(hits(report(), report({ inventory: { mcpServers: [remote] } }))).toEqual([
      {
        class: 'mcp',
        id: 'mcp:.mcp.json#docs',
        change: 'added',
        summary: 'New MCP server docs (http, https://docs.example.com)',
      },
    ]);
    const plain: McpServerItem = {
      ...remote,
      transport: 'sse',
      url: { origin: 'http://mcp.example.com', tls: false, loopback: false },
    };
    expect(hits(report(), report({ inventory: { mcpServers: [plain] } }))[0]?.summary).toBe(
      'New MCP server docs (sse, http://mcp.example.com, no TLS)',
    );
    const local: McpServerItem = { ...base, command: 'python', args: ['server.py'] };
    expect(
      hits(report(), report({ inventory: { mcpServers: [local] } })).map((hit) => hit.summary),
    ).toEqual([
      'New MCP server docs (stdio, python server.py, pin unknown)',
      'New MCP server docs is not pinned (cannot tell which version of python runs)',
    ]);
  });

  it('reports a new MCP config file that could not be analyzed', () => {
    const before = report({ inventory: { incomplete: ['.codex/config.toml'] } });
    const after = report({
      inventory: {
        incomplete: [
          '.codex/config.toml',
          'invalid-json:.cursor/mcp.json',
          'invalid-json:.claude/settings.json',
          '.vscode/mcp.json',
          '.github/hooks/*.json',
        ],
      },
    });
    expect(hits(before, after)).toEqual([
      {
        class: 'hooks',
        id: '.github/hooks/*.json',
        change: 'added',
        summary:
          'New hooks config .github/hooks/*.json is not analyzed, so its hooks cannot be checked',
      },
      {
        class: 'mcp',
        id: '.vscode/mcp.json',
        change: 'added',
        summary:
          'New MCP config .vscode/mcp.json is not analyzed, so its servers cannot be checked',
      },
      {
        class: 'mcp',
        id: 'invalid-json:.cursor/mcp.json',
        change: 'added',
        summary:
          'New MCP config .cursor/mcp.json is not valid JSON, so its servers cannot be checked',
      },
    ]);
    // A Codex config declares hooks too, so one it could not read trips both classes.
    const codex = report({ inventory: { incomplete: ['packages/x/.codex/config.toml'] } });
    expect(hits(report(), codex).map((hit) => [hit.class, hit.id])).toEqual([
      ['hooks', 'packages/x/.codex/config.toml'],
      ['mcp', 'packages/x/.codex/config.toml'],
    ]);
    const gemini = report({ inventory: { incomplete: ['invalid-json:.gemini/settings.json'] } });
    expect(hits(report(), gemini)).toHaveLength(1);
  });

  it('reports a new Codex config that is not valid TOML', () => {
    const after = report({ inventory: { incomplete: ['invalid-toml:.codex/config.toml'] } });
    expect(hits(report(), after)).toEqual([
      {
        class: 'hooks',
        id: 'invalid-toml:.codex/config.toml',
        change: 'added',
        summary:
          'New hooks config .codex/config.toml is not valid TOML, so its hooks cannot be checked',
      },
      {
        class: 'mcp',
        id: 'invalid-toml:.codex/config.toml',
        change: 'added',
        summary:
          'New MCP config .codex/config.toml is not valid TOML, so its servers cannot be checked',
      },
    ]);
    expect(hits(after, after)).toEqual([]);
    expect(hits(report(), after, ['mcp']).map((hit) => hit.class)).toEqual(['mcp']);
  });

  it('reports the invalid JSON of every MCP config the inventory reads', () => {
    for (const path of [
      '.devin/mcp_config.json',
      '.devin/config.json',
      '.github/mcp.json',
      '.vscode/mcp.json',
    ]) {
      const after = report({ inventory: { incomplete: [`invalid-json:${path}`] } });
      // .devin/config.json declares hooks next to MCP servers, so it trips both classes.
      const classes = path === '.devin/config.json' ? ['hooks', 'mcp'] : ['mcp'];
      expect(
        hits(report(), after).map((hit) => [hit.class, hit.id]),
        path,
      ).toEqual(classes.map((name) => [name, `invalid-json:${path}`]));
    }
  });

  it('reports hook files the inventory cannot list as hooks changes', () => {
    const after = report({
      inventory: {
        incomplete: [
          '.clinerules/hooks/PreToolUse',
          '.cline/hooks/pre.sh',
          '.cline/plugins/guard.js',
          '.devin/hooks.json',
          // Hook files that did not parse: an agent may read them anyway (VS Code reads
          // .github/hooks as JSONC), so their hooks cannot be ruled out.
          'invalid-json:.devin/hooks.v1.json',
          'invalid-json:.github/hooks/guard.json',
          'invalid-json:.github/copilot/settings.json',
          // Claude Code skips a settings file that does not parse, so its hooks never run.
          'invalid-json:.claude/settings.json',
          // Not a hook file: a rule.
          '.clinerules/style.md',
        ],
      },
    });
    expect(hits(report(), after).map((hit) => [hit.class, hit.id])).toEqual([
      ['hooks', '.cline/hooks/pre.sh'],
      ['hooks', '.cline/plugins/guard.js'],
      ['hooks', '.clinerules/hooks/PreToolUse'],
      ['hooks', '.devin/hooks.json'],
      ['hooks', 'invalid-json:.devin/hooks.v1.json'],
      ['hooks', 'invalid-json:.github/copilot/settings.json'],
      ['hooks', 'invalid-json:.github/hooks/guard.json'],
    ]);
    expect(hits(report(), after).find((hit) => hit.id === '.devin/hooks.json')?.summary).toBe(
      'New hooks config .devin/hooks.json is not analyzed, so its hooks cannot be checked',
    );
  });

  it('never shows credential values from server arguments', () => {
    const server = mcp('db', {
      args: ['--api-key', 'sk-live-123', 'TOKEN=hunter2', '@acme/db-mcp', '--password', 'p4ss'],
    });
    const [hit] = hits(report(), report({ inventory: { mcpServers: [server] } }), ['mcp']);
    expect(hit?.summary).toBe(
      'New MCP server db (stdio, npx --api-key … TOKEN=… @acme/db-mcp …, not pinned)',
    );
    for (const secret of ['sk-live-123', 'hunter2', 'p4ss'])
      expect(hit?.summary).not.toContain(secret);
  });
});

describe('gate: permissions', () => {
  const after = (...permissions: PermissionItem[]): Report =>
    report({ inventory: { permissions } });

  it('reports a narrow entry added to an allow list', () => {
    expect(hits(report(), after(permission('permissions.allow', 'Bash(curl:*)')))).toEqual([
      {
        class: 'permissions',
        id: 'perm:.claude/settings.json#permissions.allow=Bash(curl:*)',
        change: 'added',
        summary: 'permissions.allow adds Bash(curl:*)',
      },
    ]);
  });

  it('reports every entry that lets the agent do more, and marks the broad ones', () => {
    const skill = '.claude/skills/release/SKILL.md';
    expect(
      hits(
        report(),
        after(
          permission('permissions.allow', 'Bash(npm test)'),
          permission('permissions.allow', 'Bash', { broad: true }),
          permission('permissions.allow', 'Write', { broad: true }),
          permission('permissions.additionalDirectories', '../shared'),
          permission('permissions.additionalDirectories', '~', { broad: true }),
          permission('allowed-tools', 'Bash(git status:*)', { file: skill }),
          permission('allowed-tools', 'Edit', { file: skill, broad: true, effective: false }),
        ),
      ).map((hit) => hit.summary),
    ).toEqual([
      'permissions.additionalDirectories adds ../shared',
      'permissions.additionalDirectories adds ~ (broad: the file system root or home directory)',
      'permissions.allow adds Bash (broad: runs any shell command)',
      'permissions.allow adds Bash(npm test)',
      'permissions.allow adds Write (broad: writes any file)',
      'allowed-tools adds Bash(git status:*)',
      'allowed-tools adds Edit (broad: edits any file) (ignored where set)',
    ]);
  });

  it('ignores entries that only restrict, auto-approval turned off, and removals', () => {
    expect(
      hits(
        report(),
        after(
          permission('permissions.deny', 'Bash', { broad: true }),
          permission('permissions.ask', 'Bash', { broad: true }),
          permission('enableAllProjectMcpServers', 'false'),
          permission('mcpServers.x.trust', 'false'),
        ),
      ),
    ).toEqual([]);
    const before = after(
      permission('permissions.allow', 'Bash(curl:*)'),
      permission('enableAllProjectMcpServers', 'true'),
    );
    expect(hits(before, report())).toEqual([]);
    // Turning auto-approval off replaces the `true` entry with a `false` one: no hit.
    expect(hits(before, after(permission('enableAllProjectMcpServers', 'false')))).toEqual([]);
  });

  it('reports auto-approval', () => {
    expect(
      hits(
        report(),
        after(
          permission('enableAllProjectMcpServers', 'true'),
          permission('enabledMcpjsonServers', 'github'),
          permission('mcpServers.x.trust', 'true', { file: '.gemini/settings.json' }),
        ),
      ).map((hit) => hit.summary),
    ).toEqual([
      'enableAllProjectMcpServers set to true: every project MCP server starts without asking',
      'enabledMcpjsonServers adds github: the server starts without asking',
      'mcpServers.x.trust set to true: tool calls skip confirmation',
    ]);
  });

  it('reports a changed defaultMode with its previous value', () => {
    const before = after(permission('permissions.defaultMode', 'acceptEdits'));
    const mode = permission('permissions.defaultMode', 'bypassPermissions', { effective: false });
    expect(hits(before, after(mode))).toEqual([
      {
        class: 'permissions',
        id: 'perm:.claude/settings.json#permissions.defaultMode=bypassPermissions',
        change: 'added',
        summary:
          'permissions.defaultMode set to bypassPermissions (was acceptEdits; ignored where set)',
        kind: 'mode',
      },
    ]);
    expect(hits(report(), after(permission('permissions.defaultMode', 'plan')))[0]?.summary).toBe(
      'permissions.defaultMode set to plan (was not set)',
    );
    const changed = permission('permissions.defaultMode', 'acceptEdits', { digest: 'other' });
    expect(hits(before, after(changed))[0]).toMatchObject({
      change: 'changed',
      summary: 'permissions.defaultMode acceptEdits changed',
    });
  });

  describe('an entry replaced by narrower ones', () => {
    const skill = '.claude/skills/release/SKILL.md';
    const tools = (value: string, overrides: Partial<PermissionItem> = {}) =>
      permission('allowed-tools', value, { file: skill, ...overrides });
    const allow = (value: string, overrides: Partial<PermissionItem> = {}) =>
      permission('permissions.allow', value, overrides);
    const summaries = (before: Report, now: Report) => hits(before, now).map((hit) => hit.summary);

    it('does not trip when the removed entry covers each added one', () => {
      expect(
        hits(after(tools('Bash', { broad: true })), after(tools('Bash(git status *)'))),
      ).toEqual([]);
      expect(
        hits(
          after(tools('Bash(*)', { broad: true }), tools('Read')),
          after(tools('Read'), tools('Bash(git status *)'), tools('Bash(npm test)')),
        ),
      ).toEqual([]);
      expect(hits(after(allow('Bash(git *)')), after(allow('Bash(git push *)')))).toEqual([]);
      expect(hits(after(allow('Write', { broad: true })), after(allow('Write(docs/**)')))).toEqual(
        [],
      );
    });

    it('trips when the removed entry does not cover the added one', () => {
      expect(summaries(after(allow('Bash(git status *)')), after(allow('Bash(git *)')))).toEqual([
        'permissions.allow adds Bash(git *)',
      ]);
      expect(
        summaries(after(allow('Bash(npm test)')), after(allow('Bash(npm test; curl x)'))),
      ).toEqual(['permissions.allow adds Bash(npm test; curl x)']);
      expect(
        summaries(
          after(tools('Bash', { broad: true })),
          after(tools('Bash(git status *)'), tools('Write', { broad: true })),
        ),
      ).toEqual(['allowed-tools adds Write (broad: writes any file)']);
      expect(summaries(after(tools('Bash(git *)')), after(tools('Bash(curl *)')))).toEqual([
        'allowed-tools adds Bash(curl *)',
      ]);
    });

    it('trips for an entry added in another file or under another key', () => {
      const other = '.claude/skills/deploy/SKILL.md';
      expect(
        summaries(
          after(tools('Bash', { broad: true })),
          after(permission('allowed-tools', 'Bash(git status *)', { file: other })),
        ),
      ).toEqual(['allowed-tools adds Bash(git status *)']);
      expect(
        summaries(
          after(allow('Bash', { broad: true })),
          after(allow('Bash(git status *)', { file: '.claude/settings.local.json' })),
        ),
      ).toEqual(['permissions.allow adds Bash(git status *)']);
      expect(
        summaries(
          after(tools('Bash', { broad: true, file: '.claude/settings.json' })),
          after(allow('Bash(git status *)')),
        ),
      ).toEqual(['permissions.allow adds Bash(git status *)']);
    });

    it('trips when the covering entry stays, took no effect, or holds a masked value', () => {
      const broad = tools('Bash', { broad: true });
      expect(summaries(after(broad), after(broad, tools('Bash(git status *)')))).toEqual([
        'allowed-tools adds Bash(git status *)',
      ]);
      expect(
        summaries(
          after(tools('Bash', { broad: true, effective: false })),
          after(tools('Bash(make)')),
        ),
      ).toEqual(['allowed-tools adds Bash(make)']);
      expect(
        summaries(
          after(allow('Bash(deploy --token=… *)')),
          after(allow('Bash(deploy --token=… run *)')),
        ),
      ).toEqual(['permissions.allow adds Bash(deploy --token=… run *)']);
    });
  });

  it('reports an entry that became broad or took effect, not one that stayed as wide', () => {
    const narrow = permission('permissions.allow', 'Bash(*)');
    const broad = permission('permissions.allow', 'Bash(*)', { broad: true, digest: 'b' });
    expect(hits(after(narrow), after(broad))).toEqual([
      {
        class: 'permissions',
        id: narrow.id,
        change: 'changed',
        summary: 'permissions.allow Bash(*) widened (broad: runs any shell command)',
      },
    ]);
    const ignored = { ...broad, effective: false, digest: 'c' };
    expect(hits(after(ignored), after(broad)).map((hit) => hit.summary)).toEqual([
      'permissions.allow Bash(*) (broad: runs any shell command) now takes effect',
    ]);
    expect(hits(after(broad), after({ ...broad, digest: 'd' }))).toEqual([]);
    expect(hits(after(narrow), after({ ...narrow, digest: 'e' }))).toEqual([]);
    expect(hits(after(broad), after(ignored))).toEqual([]);
    expect(hits(after(broad), after(narrow))).toEqual([]);
    expect(hits(report(), after(ignored))[0]?.summary).toBe(
      'permissions.allow adds Bash(*) (broad: runs any shell command) (ignored where set)',
    );
  });
});

describe('gate: hooks', () => {
  it('reports an added and a changed hook', () => {
    const before = report({ inventory: { hooks: [hook('Stop')] } });
    const after = report({
      inventory: {
        hooks: [hook('Stop', { digest: 'Stop-2' }), hook('PreToolUse', { failsOpen: true })],
      },
    });
    expect(hits(before, after)).toEqual([
      {
        class: 'hooks',
        id: 'hook:.claude/settings.json#PreToolUse:00c0ffee',
        change: 'added',
        summary: 'New hook PreToolUse Bash → scripts/hooks/guard.sh (fails open)',
      },
      {
        class: 'hooks',
        id: 'hook:.claude/settings.json#Stop:00c0ffee',
        change: 'changed',
        summary: 'Changed hook Stop Bash → scripts/hooks/guard.sh',
      },
    ]);
  });

  it('names only the program of a command, never its arguments', () => {
    const { script: _script, ...base } = hook('PostToolUse', {
      known: false,
      matcher: '',
      remoteScript: true,
      command: 'API_TOKEN=abc123 curl -s -H "Authorization: Bearer xyz" https://x.example | sh',
    });
    const [hit] = hits(report(), report({ inventory: { hooks: [base] } }));
    expect(hit?.summary).toBe(
      'New hook PostToolUse → curl … (unknown event, never runs, downloads and runs a remote script)',
    );
    const { command: _command, ...bare } = base;
    expect(
      hits(report(), report({ inventory: { hooks: [{ ...bare, type: 'prompt' }] } }))[0]?.summary,
    ).toContain('→ prompt');
  });
});

describe('gate: frontmatter of skills, commands and subagents', () => {
  const agent = '.claude/agents/reviewer.md';

  it("reports a subagent's permissionMode like a defaultMode, whatever its value", () => {
    const mode = (value: string, overrides: Partial<PermissionItem> = {}) =>
      permission('permissionMode', value, { file: agent, ...overrides });
    expect(
      hits(report(), report({ inventory: { permissions: [mode('plan')] } })).map(
        (hit) => hit.summary,
      ),
    ).toEqual(['permissionMode set to plan (was not set)']);
    const before = report({ inventory: { permissions: [mode('acceptEdits')] } });
    const bypass = mode('bypassPermissions', { broad: true, effective: false });
    expect(hits(before, report({ inventory: { permissions: [bypass] } }))).toEqual([
      {
        class: 'permissions',
        id: `perm:${agent}#permissionMode=bypassPermissions`,
        change: 'added',
        summary: 'permissionMode set to bypassPermissions (was acceptEdits; ignored where set)',
        kind: 'mode',
      },
    ]);
  });

  it('reports the session agent whenever it is set or changes', () => {
    const agent = (value: string, overrides: Partial<PermissionItem> = {}) =>
      permission('agent', value, overrides);
    const before = report({ inventory: { permissions: [agent('reviewer')] } });
    expect(hits(before, report({ inventory: { permissions: [agent('auditor')] } }))).toEqual([
      {
        class: 'permissions',
        id: 'perm:.claude/settings.json#agent=auditor',
        change: 'added',
        summary:
          'agent set to auditor (was reviewer): every session starts as this subagent, with its prompt, tools, model, hooks and MCP servers',
        kind: 'agent',
      },
    ]);
    expect(hits(before, before)).toEqual([]);
  });

  it('says when a hook from frontmatter runs', () => {
    const after = report({
      inventory: {
        hooks: [
          hook('PreToolUse', { file: agent, scope: 'subagent', failsOpen: true }),
          hook('PostToolUse', { file: '.claude/skills/deploy/SKILL.md', scope: 'skill' }),
        ],
      },
    });
    expect(hits(report(), after).map((hit) => hit.summary)).toEqual([
      'New hook PreToolUse Bash → scripts/hooks/guard.sh (while the subagent runs, fails open)',
      'New hook PostToolUse Bash → scripts/hooks/guard.sh (once the skill or command is invoked)',
    ]);
  });

  it("says that a subagent's server connects only while it runs", () => {
    const server = mcp('playwright', { file: agent, scope: 'subagent' });
    expect(hits(report(), report({ inventory: { mcpServers: [server] } }))).toEqual([
      {
        class: 'mcp',
        id: `mcp:${agent}#playwright`,
        change: 'added',
        summary:
          'New MCP server playwright (stdio, npx -y @acme/playwright-mcp, not pinned, while the subagent runs)',
      },
      {
        class: 'mcp-unpinned',
        id: `mcp:${agent}#playwright`,
        change: 'added',
        summary: 'New MCP server playwright is not pinned (npx @acme/playwright-mcp, no version)',
      },
    ]);
  });

  it('fails closed on frontmatter the inventory could not read', () => {
    const after = report({
      inventory: {
        incomplete: [
          '.claude/agents/big.md',
          '.claude/commands/big.md',
          '.claude/skills/big/SKILL.md',
          // An instruction file declares neither hooks nor servers.
          'AGENTS.md',
        ],
      },
    });
    expect(hits(report(), after).map((hit) => [hit.class, hit.id])).toEqual([
      ['hooks', '.claude/agents/big.md'],
      ['hooks', '.claude/commands/big.md'],
      ['hooks', '.claude/skills/big/SKILL.md'],
      ['mcp', '.claude/agents/big.md'],
    ]);
  });

  it('lists a changed scope as a changed field', () => {
    const before = report({ inventory: { hooks: [hook('Stop', { file: agent })] } });
    const after = report({
      inventory: { hooks: [hook('Stop', { file: agent, scope: 'subagent', digest: 'Stop-2' })] },
    });
    expect(compare(before, after).diff.inventory.changed).toEqual([
      { id: `hook:${agent}#Stop:00c0ffee`, fields: ['scope'] },
    ]);
  });
});

describe('gate: models', () => {
  function definition(
    model: string | undefined,
    overrides: Partial<AgentDefinition> = {},
  ): AgentDefinition {
    return {
      id: 'agent:.claude/agents/reviewer.md@claude-code',
      file: '.claude/agents/reviewer.md',
      line: 2,
      agent: 'claude-code',
      name: 'reviewer',
      status: 'loads',
      ...(model === undefined ? {} : { model: { value: model, form: 'alias', line: 4 } }),
      effective:
        model === undefined ? { source: 'not-visible' } : { value: model, source: 'definition' },
      tools: 'inherited',
      certainty: 'documented',
      evidence: ['claudeSubagents'],
      digest: `d-${model ?? 'none'}`,
      ...overrides,
    };
  }
  function setting(value: string, overrides: Partial<ModelSetting> = {}): ModelSetting {
    return {
      id: 'model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
      agent: 'claude-code',
      file: '.claude/settings.json',
      line: 3,
      key: 'env.CLAUDE_CODE_SUBAGENT_MODEL',
      value,
      applies: 'subagents',
      digest: `s-${value}`,
      ...overrides,
    };
  }
  const agents = (definitions: AgentDefinition[], settings: ModelSetting[] = []): AgentsReport => ({
    definitions,
    settings,
  });

  it('reports a new definition, a changed model and a model setting', () => {
    const before = report({ agents: agents([definition('haiku')], [setting('haiku')]) });
    const after = report({
      agents: agents(
        [
          definition('opus', { effort: { value: 'high', line: 5 } }),
          definition('sonnet', {
            id: 'agent:.claude/agents/new.md@claude-code',
            file: '.claude/agents/new.md',
            name: 'new',
          }),
        ],
        [setting('sonnet')],
      ),
    });
    expect(hits(before, after)).toEqual([
      {
        class: 'models',
        id: 'agent:.claude/agents/new.md@claude-code',
        change: 'added',
        summary: 'new for Claude Code (model sonnet)',
      },
      {
        class: 'models',
        id: 'agent:.claude/agents/reviewer.md@claude-code',
        change: 'changed',
        summary: 'reviewer for Claude Code (model haiku → opus, effort not set → high)',
      },
      {
        class: 'models',
        id: 'model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
        change: 'changed',
        summary: 'env.CLAUDE_CODE_SUBAGENT_MODEL set to sonnet for Claude Code (was haiku)',
        kind: 'model-setting',
      },
    ]);
    // Not a security class.
    expect(
      compareWithBaseline(after, before, { gate: SECURITY_GATE_CLASSES }).diff.gate.hits,
    ).toEqual([]);
  });

  it('says what changed when no field it lists did, and that a model is not known', () => {
    const before = report({ agents: agents([definition('opus')]) });
    const reclassified = report({
      agents: agents([
        definition('opus', {
          model: { value: 'opus', form: 'not-documented', line: 4 },
          digest: 'd-opus-not-documented',
        }),
      ]),
    });
    const text = report({ agents: agents([definition('opus', { digest: 'd-text' })]) });
    const opaque = report({
      agents: agents([
        definition('opus'),
        definition(undefined, {
          id: 'agent:.cursor/agents/m.md@cursor',
          file: '.cursor/agents/m.md',
          agent: 'cursor',
          name: 'm',
          status: 'unknown',
          reason: 'the frontmatter uses a << merge key',
        }),
      ]),
    });
    expect(hits(before, reclassified).map(({ summary }) => summary)).toEqual([
      'reviewer for Claude Code (model opus now not documented)',
    ]);
    expect(hits(before, text).map(({ summary }) => summary)).toEqual([
      'reviewer for Claude Code (details changed)',
    ]);
    expect(hits(before, opaque).map(({ summary }) => summary)).toEqual([
      'm for Cursor (model not known, may not load)',
    ]);
  });

  it('trips for a removed setting, not for a removed definition or a line that moved', () => {
    const before = report({ agents: agents([definition('opus')], [setting('haiku')]) });
    const moved = report({
      agents: agents([
        definition('opus', { line: 9, model: { value: 'opus', form: 'alias', line: 11 } }),
      ]),
    });
    // Removing a setting changes what runs: the subagents go back to their own models.
    expect(hits(before, moved)).toEqual([
      {
        class: 'models',
        id: 'model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
        change: 'changed',
        summary: 'env.CLAUDE_CODE_SUBAGENT_MODEL removed for Claude Code (was haiku)',
        kind: 'model-setting',
      },
    ]);
    expect(
      hits(report({ agents: agents([definition('opus')]) }), report({ agents: agents([]) })),
    ).toEqual([]);
    expect(compare(before, moved).diff.agents).toEqual({
      added: [],
      removed: ['model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL'],
      changed: [],
    });
    const skipped = report({
      agents: agents([definition('opus', { status: 'skipped', reason: 'no name', digest: 'x' })]),
    });
    expect(compare(before, skipped).diff.agents?.changed).toEqual([
      { id: 'agent:.claude/agents/reviewer.md@claude-code', fields: ['reason', 'status'] },
    ]);
  });

  it('matches definitions and settings across working directories', () => {
    const shadowed = definition('opus', {
      status: 'shadowed',
      reason: 'another definition has the same name',
      shadowedBy: '.cursor/agents/reviewer.md',
      effective: {
        value: 'haiku',
        source: 'setting',
        file: '.claude/settings.json',
        overridden: { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE', file: '.claude/settings.json' },
      },
    });
    const root = report({ agents: agents([shadowed], [setting('haiku')]) });
    const prefixed = (path: string) => `packages/api/${path}`;
    const elsewhere = report({
      pathBase: 'packages/api',
      agents: agents(
        [
          {
            ...shadowed,
            id: 'agent:packages/api/.claude/agents/reviewer.md@claude-code',
            file: prefixed(shadowed.file),
            shadowedBy: prefixed('.cursor/agents/reviewer.md'),
            effective: {
              ...shadowed.effective,
              file: prefixed('.claude/settings.json'),
              overridden: {
                key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
                file: prefixed('.claude/settings.json'),
              },
            },
          },
        ],
        [
          setting('haiku', {
            id: 'model:packages/api/.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
            file: prefixed('.claude/settings.json'),
          }),
        ],
      ),
    });
    for (const [before, after] of [
      [elsewhere, root],
      [root, elsewhere],
    ] as const) {
      const { diff } = compare(before, after);
      expect(diff.gate.hits).toEqual([]);
      expect(diff.agents).toEqual({ added: [], removed: [], changed: [] });
    }
    // A changed digest lists the fields that differ, never a path that only moved with the base.
    const changed = report({
      pathBase: 'packages/api',
      agents: agents([{ ...elsewhere.agents!.definitions[0]!, reason: 'x', digest: 'other' }]),
    });
    expect(compare(root, changed).diff.agents?.changed).toEqual([
      { id: 'agent:.claude/agents/reviewer.md@claude-code', fields: ['reason'] },
    ]);
  });

  it('fails closed against a baseline made before agent definitions were listed', () => {
    const after = report({ agents: agents([definition('opus')]) });
    expect(hits(report(), after).map((hit) => [hit.class, hit.change])).toEqual([
      ['models', 'added'],
    ]);
  });

  it('reads agents from a JSON baseline, and leaves out agents it does not model', () => {
    const full = report({
      agents: agents([definition('opus')], [setting('haiku', { forced: true })]),
    });
    const json = parse(JSON.stringify(full)) as Record<string, unknown>;
    const result = validateBaseline(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.agents).toEqual(full.agents);
    const value = parse(JSON.stringify(full)) as {
      agents: { definitions: Record<string, unknown>[] };
    };
    const [first] = value.agents.definitions;
    if (first === undefined) throw new Error('expected a definition');
    first['agent'] = 'a-future-agent';
    const later = validateBaseline(value);
    expect(later.ok && later.baseline.agents?.definitions).toEqual([]);
    // A status a later version writes leaves the definition out; a malformed one is an error.
    first['agent'] = 'claude-code';
    first['status'] = 'maybe';
    const future = validateBaseline(value);
    expect(future.ok && future.baseline.agents?.definitions).toEqual([]);
    first['status'] = 3;
    expect(validateBaseline(value).ok).toBe(false);
  });

  it('trips when a definition runs on another model because a setting changed', () => {
    const forced = definition('opus', {
      effective: {
        value: 'haiku',
        source: 'setting',
        file: '.claude/settings.json',
        overridden: { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE', file: '.claude/settings.json' },
      },
    });
    const before = report({ agents: agents([forced]) });
    const after = report({ agents: agents([definition('opus')]) });
    expect(hits(before, after)).toEqual([
      {
        class: 'models',
        id: 'agent:.claude/agents/reviewer.md@claude-code',
        change: 'changed',
        summary: 'reviewer for Claude Code (runs on opus, was haiku, its own ignored)',
      },
    ]);
  });
});

describe('gate: env', () => {
  it('reports overrides of every class except other', () => {
    const after = report({
      inventory: {
        env: [
          env('ANTHROPIC_BASE_URL', 'endpoint', { shown: 'https://llm-proxy.example.net' }),
          // A value in `shown` outside the endpoint class is never displayed.
          env('ANTHROPIC_AUTH_TOKEN', 'credential', { shown: 'sk-ant-secret' }),
          env('NODE_TLS_REJECT_UNAUTHORIZED', 'tls'),
          env('apiKeyHelper', 'code-exec'),
          env('EDITOR', 'other'),
        ],
      },
    });
    const summaries = hits(report(), after).map((hit) => hit.summary);
    expect(summaries).toEqual([
      'Env override ANTHROPIC_AUTH_TOKEN sets a credential (value not shown)',
      'Env override ANTHROPIC_BASE_URL → https://llm-proxy.example.net',
      'Env override NODE_TLS_REJECT_UNAUTHORIZED changes TLS certificate checks',
      'Env override apiKeyHelper can run code',
    ]);
    expect(summaries.join('\n')).not.toContain('sk-ant-secret');
  });

  it('shows a TLS switch that turns certificate checks off', () => {
    const before = report({
      inventory: { env: [env('NODE_TLS_REJECT_UNAUTHORIZED', 'tls', { shown: '1' })] },
    });
    const after = report({
      inventory: {
        env: [env('NODE_TLS_REJECT_UNAUTHORIZED', 'tls', { shown: '0', digest: 'changed' })],
      },
    });
    expect(hits(before, after).map((hit) => [hit.change, hit.summary])).toEqual([
      [
        'changed',
        'Changed env override NODE_TLS_REJECT_UNAUTHORIZED → 0 changes TLS certificate checks',
      ],
    ]);
  });

  it('reports a changed endpoint', () => {
    const before = report({ inventory: { env: [env('HTTPS_PROXY', 'endpoint')] } });
    const after = report({
      inventory: { env: [env('HTTPS_PROXY', 'endpoint', { digest: 'x' })] },
    });
    expect(hits(before, after)[0]).toMatchObject({
      change: 'changed',
      summary: 'Changed env override HTTPS_PROXY → another endpoint',
    });
  });
});

describe('gate: unicode', () => {
  const hidden = (fingerprint: string, overrides: Partial<Finding> = {}): Finding =>
    finding('risk/hidden-unicode', 'AGENTS.md', fingerprint, overrides);

  it('reports a new hidden-unicode finding only', () => {
    const before = report({ findings: [hidden('old:1')] });
    const after = report({
      findings: [
        hidden('old:1'),
        hidden('new:1', {
          range: { start: { line: 12, column: 4 }, end: { line: 12, column: 5 } },
        }),
        hidden('quiet:1', { suppressed: { kind: 'inline', reason: 'documented example' } }),
        finding('risk/remote-script', 'AGENTS.md', 'other:1'),
      ],
    });
    expect(hits(before, after)).toEqual([
      {
        class: 'unicode',
        id: 'new:1',
        change: 'added',
        summary: 'Hidden Unicode in AGENTS.md, line 12',
      },
    ]);
  });
});

describe('removals', () => {
  it('never trip the gate', () => {
    const before = report({
      findings: [finding('risk/hidden-unicode', 'AGENTS.md', 'u:1')],
      inventory: {
        mcpServers: [mcp('browser')],
        hooks: [hook('PreToolUse')],
        permissions: [
          permission('permissions.allow', 'Bash', { broad: true }),
          permission('permissions.defaultMode', 'acceptEdits'),
        ],
        env: [env('ANTHROPIC_BASE_URL', 'endpoint')],
        incomplete: ['invalid-json:.mcp.json'],
      },
    });
    const { diff } = compare(before, report());
    expect(diff.gate.hits).toEqual([]);
    expect(diff.inventory.removed).toEqual([
      'env:.claude/settings.json#ANTHROPIC_BASE_URL',
      'hook:.claude/settings.json#PreToolUse:00c0ffee',
      'mcp:.mcp.json#browser',
      'perm:.claude/settings.json#permissions.allow=Bash',
      'perm:.claude/settings.json#permissions.defaultMode=acceptEdits',
    ]);
    expect(diff.findings.resolved).toHaveLength(1);
  });
});

describe('gate selection', () => {
  const after = report({ inventory: { mcpServers: [mcp('x')], hooks: [hook('Stop')] } });

  it('keeps hits of the selected classes only', () => {
    const { gate } = compare(report(), after, ['hooks', 'env']).diff;
    expect(gate.classes).toEqual(['env', 'hooks']);
    expect(gate.hits.map((hit) => hit.class)).toEqual(['hooks']);
  });

  it('trips nothing without classes', () => {
    expect(compareWithBaseline(after, report()).diff.gate).toEqual({ classes: [], hits: [] });
    expect(compare(report(), after, []).diff.inventory.added).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

describe('inventory diff', () => {
  it('lists changed fields, ignoring position, and digest when nothing visible differs', () => {
    const before = report({
      inventory: { mcpServers: [mcp('a'), mcp('b'), mcp('c')], env: [env('X', 'tls')] },
    });
    const after = report({
      inventory: {
        mcpServers: [
          mcp('a', { line: 40 }),
          mcp('b', { digest: 'b-2', line: 40 }),
          mcp('c', { digest: 'c-2', status: { 'claude-code': 'loads' }, envKeys: ['TOKEN'] }),
        ],
        env: [env('X', 'credential', { digest: 'x-2' })],
      },
    });
    expect(compare(before, after).diff.inventory).toEqual({
      added: [],
      removed: [],
      changed: [
        { id: 'env:.claude/settings.json#X', fields: ['class'] },
        { id: 'mcp:.mcp.json#b', fields: ['digest'] },
        { id: 'mcp:.mcp.json#c', fields: ['envKeys', 'status'] },
      ],
    });
  });

  it('keeps the first item when an id repeats', () => {
    const before = report({ inventory: { hooks: [hook('Stop'), hook('Stop', { digest: 'z' })] } });
    const after = report({ inventory: { hooks: [hook('Stop')] } });
    expect(compare(before, after).diff.inventory).toEqual({ added: [], removed: [], changed: [] });
  });

  it('treats a baseline without an inventory as empty, so the gate fails closed', () => {
    const before = report({ inventory: null });
    const after = report({
      inventory: {
        mcpServers: [mcp('x')],
        hooks: [hook('Stop')],
        permissions: [permission('permissions.allow', 'Bash', { broad: true })],
        env: [env('NODE_OPTIONS', 'code-exec')],
      },
    });
    const { diff } = compare(before, after);
    expect(diff.inventory.added).toHaveLength(4);
    expect([...new Set(diff.gate.hits.map((hit) => hit.class))]).toEqual([
      'env',
      'hooks',
      'mcp',
      'mcp-unpinned',
      'permissions',
    ]);
    expectNoChanges(compare(report({ inventory: null }), report({ inventory: null })));
  });
});

// ---------------------------------------------------------------------------------------------
// pathBase
// ---------------------------------------------------------------------------------------------

describe('pathBase', () => {
  const scan = report({
    findings: [finding('a/x', 'AGENTS.md', 'f1:1')],
    inventory: {
      mcpServers: [mcp('x')],
      hooks: [hook('Stop')],
      permissions: [permission('permissions.allow', 'Bash', { broad: true })],
      env: [env('HTTPS_PROXY', 'endpoint')],
      incomplete: ['invalid-json:.cursor/mcp.json', '.codex/config.toml'],
    },
    plans: [
      plan('claude-code', '', {
        entries: [entry('CLAUDE.md')],
        skipped: [skip('AGENTS.md')],
        limits: [
          {
            key: 'claude-code.skill_listing_budget',
            unit: 'chars',
            limit: null,
            used: 40,
            subject: '',
            label: 'skills listing',
            effect: 'shortens',
            evidence: [],
          },
          {
            key: 'k',
            unit: 'chars',
            limit: 10,
            used: 5,
            subject: '.claude/skills',
            effect: 'advice',
            evidence: [],
          },
        ],
      }),
      plan('codex', 'sub', { entries: [entry('sub/AGENTS.md')] }),
    ],
  });

  it('removes each report pathBase before comparing', () => {
    expectNoChanges(compare(rebased(scan, 'packages/api'), scan));
    expectNoChanges(compare(scan, rebased(scan, 'packages/api')));
    expectNoChanges(compare(rebased(scan, 'a'), rebased(scan, 'b/c')));
  });

  it('accepts a trailing slash or "." as pathBase', () => {
    expectNoChanges(compare({ ...rebased(scan, 'packages/api'), pathBase: 'packages/api/' }, scan));
    expectNoChanges(compare({ ...scan, pathBase: '.' }, scan));
  });

  it('reports root-relative ids and paths', () => {
    const { diff } = compare(rebased(report(), 'packages/api'), rebased(scan, 'packages/api'));
    expect(diff.inventory.added).toContain('mcp:.mcp.json#x');
    expect(diff.gate.hits.map((hit) => hit.id)).toContain('invalid-json:.cursor/mcp.json');
    expect(
      diff.gate.hits.find((hit) => hit.class === 'hooks' && hit.id.startsWith('hook:'))?.summary,
    ).toBe('New hook Stop Bash → scripts/hooks/guard.sh');
  });

  it('matches ids that a rebase left as they were', () => {
    const fileOnly = rebased(scan, 'packages/api');
    const inv = scan.inventory!;
    const keepIds: Report = {
      ...fileOnly,
      inventory: {
        ...fileOnly.inventory!,
        mcpServers: inv.mcpServers.map((s) => ({ ...s, file: `packages/api/${s.file}` })),
      },
    };
    expectNoChanges(compare(keepIds, scan));
  });

  it('leaves paths outside the pathBase alone', () => {
    const outside = report({ pathBase: 'packages/api', inventory: { mcpServers: [mcp('x')] } });
    expectNoChanges(compare(outside, report({ inventory: { mcpServers: [mcp('x')] } })));
  });
});

// ---------------------------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------------------------

describe('rule sets', () => {
  const rules = [rule('a/old', '2026.10'), rule('b/new', '2026.11'), rule('c/newer', '2027.1')];

  it('compares against the baseline version and rule set', () => {
    const result = compare(report({ ruleset: '2026.10' }), report({ ruleset: '2027.1', rules }));
    expect(result.diff.against).toEqual({
      version: '0.1.0',
      ruleset: '2026.10',
      sameRuleset: false,
      newRules: ['b/new', 'c/newer'],
    });
    expect(result.newRules).toEqual(['b/new', 'c/newer']);
  });

  it('has no new rules within one rule set', () => {
    const result = compare(report(), report({ rules }));
    expect(result.diff.against.sameRuleset).toBe(true);
    expect(result.diff.against.newRules).toEqual([]);
    expect(result.newRules).toEqual([]);
  });

  it('orders calendar versions numerically and skips what it cannot order', () => {
    const against = (ruleset: string) => ({ version: '1.0.0', ruleset, sameRuleset: false });
    expect(newRuleIds([rule('x', '2026.10')], against('2026.9'))).toEqual(['x']);
    expect(newRuleIds([rule('x', '2026.10')], against('2026.10.0'))).toEqual([]);
    expect(newRuleIds([rule('x', '2026.10')], against('2027'))).toEqual([]);
    expect(newRuleIds([rule('x', '2026.10')], against('dev'))).toEqual([]);
    expect(newRuleIds([rule('x', 'next')], against('2026.9'))).toEqual([]);
    expect(newRuleIds([rule('x', '2026..1')], against('2026.9'))).toEqual([]);
    expect(newRuleIds([rule('x', '1'.repeat(40))], against('2026.9'))).toEqual([]);
    expect(newRuleIds([rule('x', '2027'), rule('x', '2027')], against('2026'))).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------------------------
// Load plans
// ---------------------------------------------------------------------------------------------

describe('context', () => {
  it('lists the subagents whose own context changed, and how', () => {
    const call = (path: string, name: string, tokens: number): LoadEntry =>
      entry(path, {
        id: `subagent:${path}`,
        role: 'subagent',
        name,
        size: size(40),
        ownContext: {
          size: { bytes: tokens * 4, chars: tokens * 4, tokens },
          parts: [],
          notVisible: [],
        },
      });
    const before = report({
      plans: [
        plan('claude-code', '', {
          entries: [
            call('.claude/agents/reviewer.md', 'reviewer', 100),
            call('.claude/agents/old.md', 'old', 50),
            call('.claude/agents/same.md', 'same', 30),
            entry('CLAUDE.md'),
          ],
        }),
      ],
    });
    const after = report({
      plans: [
        plan('claude-code', '', {
          entries: [
            call('.claude/agents/reviewer.md', 'reviewer', 250),
            call('.claude/agents/tester.md', 'tester', 40),
            call('.claude/agents/same.md', 'same', 30),
            entry('CLAUDE.md', { size: size(800) }),
          ],
        }),
      ],
    });
    const expected = [
      { id: 'subagent:.claude/agents/old.md', name: 'old', before: 50, after: null },
      { id: 'subagent:.claude/agents/reviewer.md', name: 'reviewer', before: 100, after: 250 },
      { id: 'subagent:.claude/agents/tester.md', name: 'tester', before: null, after: 40 },
    ];
    expect(compare(before, after).diff.context[0]?.calls).toEqual(expected);
    // The same through a baseline file, which keeps only what the comparison reads.
    const read = validateBaseline(parse(JSON.stringify(before)));
    if (!read.ok) throw new Error(read.message);
    expect(
      compareWithBaseline(after, read.baseline, { gate: GATE_CLASSES }).diff.context[0]?.calls,
    ).toEqual(expected);
    // A baseline made before subagents had their own context: every call is new.
    const older = report({
      plans: [
        plan('claude-code', '', {
          entries: [
            entry('.claude/agents/reviewer.md', {
              id: 'subagent:.claude/agents/reviewer.md',
              role: 'subagent',
            }),
          ],
        }),
      ],
    });
    expect(compare(older, after).diff.context[0]?.calls.map((item) => item.before)).toEqual([
      null,
      null,
      null,
    ]);
    // Still listed, but no longer measurable, as when the file stops parsing: not removed.
    const unreadable = report({
      plans: [
        plan('claude-code', '', {
          entries: [
            entry('.claude/agents/reviewer.md', {
              id: 'subagent:.claude/agents/reviewer.md',
              role: 'subagent',
              name: 'reviewer',
            }),
          ],
        }),
      ],
    });
    expect(
      compare(before, unreadable).diff.context[0]?.calls.find((item) => item.name === 'reviewer'),
    ).toEqual({
      id: 'subagent:.claude/agents/reviewer.md',
      name: 'reviewer',
      before: 100,
      after: null,
      unmeasured: true,
    });
  });

  it('compares only plans present in both reports', () => {
    const before = report({ plans: [plan('claude-code', '')] });
    const after = report({ plans: [plan('codex', ''), plan('claude-code', '')] });
    expect(compare(before, after).diff.context.map((d) => [d.agent, d.cwd])).toEqual([
      ['claude-code', ''],
    ]);
    expect(compare(report(), after).diff.context).toEqual([]);
  });

  it('reports entries, skips, startup tokens and limits', () => {
    // The chain is identified by its working directory; the label is display text only.
    const limit = (used: number, subject = 'pkg', label?: string) => ({
      key: 'codex.project_doc_max_bytes',
      unit: 'bytes' as const,
      limit: 32768,
      used,
      subject,
      ...(label === undefined ? {} : { label }),
      effect: 'truncates' as const,
      evidence: [],
    });
    const before = report({
      plans: [
        plan('codex', 'pkg', {
          entries: [
            entry('AGENTS.md'),
            entry('pkg/AGENTS.md', { position: 2 }),
            entry('a.md'),
            entry('b.md'),
            entry('c.md'),
            entry('gone.md'),
          ],
          skipped: [skip('x.md'), skip('y.md')],
          limits: [
            limit(31204, 'pkg', 'chain, before'),
            { ...limit(10, 'old', 'old label'), key: 'a.old' },
          ],
          totals: { startup: size(10_788), onDemand: size(0) },
        }),
        plan('codex', ''),
      ],
    });
    const after = report({
      plans: [
        plan('codex', 'pkg', {
          entries: [
            entry('AGENTS.md', { trigger: 'on-path' }),
            entry('pkg/AGENTS.md', { position: 3 }),
            entry('a.md', { size: size(900) }),
            entry('b.md', { truncated: { atByte: 32768, line: 700 } }),
            entry('c.md', { certainty: 'unverified' }),
            entry('new.md'),
          ],
          skipped: [skip('x.md', { code: 'blank-file', ruleId: 'instr/empty-file' }), skip('z.md')],
          limits: [limit(33010, 'pkg', 'AGENTS.md chain'), { ...limit(5, 'new'), limit: null }],
          totals: { startup: size(17_640), onDemand: size(0) },
        }),
        plan('codex', ''),
      ],
    });
    const { context } = compare(before, after).diff;
    expect(context).toEqual([
      {
        agent: 'codex',
        cwd: '',
        entries: { added: [], removed: [], changed: [] },
        skipped: { added: [], removed: [], changed: [] },
        startupTokens: { before: 0, after: 0 },
        calls: [],
        limits: [],
      },
      {
        agent: 'codex',
        cwd: 'pkg',
        entries: {
          added: ['instructions:new.md'],
          removed: ['instructions:gone.md'],
          changed: [
            { id: 'instructions:AGENTS.md', fields: ['trigger'] },
            { id: 'instructions:a.md', fields: ['size.chars'] },
            { id: 'instructions:b.md', fields: ['truncated'] },
            { id: 'instructions:c.md', fields: ['certainty'] },
          ],
        },
        skipped: {
          added: ['instructions:z.md'],
          removed: ['instructions:y.md'],
          changed: [{ id: 'instructions:x.md', fields: ['code', 'ruleId'] }],
        },
        startupTokens: { before: 2697, after: 4410 },
        calls: [],
        limits: [
          {
            key: 'a.old',
            subject: 'old',
            label: 'old label',
            before: 10,
            after: null,
            limit: 32768,
          },
          {
            key: 'codex.project_doc_max_bytes',
            subject: 'new',
            before: null,
            after: 5,
            limit: null,
          },
          {
            key: 'codex.project_doc_max_bytes',
            subject: 'pkg',
            label: 'AGENTS.md chain',
            before: 31204,
            after: 33010,
            limit: 32768,
          },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------

describe('determinism', () => {
  it('gives the same diff for inputs in any order', () => {
    const items = {
      mcpServers: [mcp('b'), mcp('a', { file: '.cursor/mcp.json' })],
      hooks: [hook('Stop'), hook('PreToolUse')],
      permissions: [
        permission('permissions.allow', 'Bash', { broad: true }),
        permission('enableAllProjectMcpServers', 'true'),
      ],
      env: [env('B', 'tls'), env('A', 'credential')],
      incomplete: ['invalid-json:.mcp.json', '.vscode/mcp.json'],
    };
    const reverse = <T>(list: readonly T[]): T[] => [...list].reverse();
    const findings = [
      finding('a/x', 'b.md', 'f1:1'),
      finding('risk/hidden-unicode', 'a.md', 'f2:1'),
      finding('risk/hidden-unicode', 'a.md', 'f3:1'),
    ];
    const plans = [plan('cursor', ''), plan('claude-code', 'x'), plan('claude-code', '')];
    const forward = compare(
      report({ findings, plans }),
      report({ inventory: items, plans, findings: [] }),
    ).diff;
    const backward = compare(
      report({ findings: reverse(findings), plans: reverse(plans) }),
      report({
        plans: reverse(plans),
        inventory: {
          mcpServers: reverse(items.mcpServers),
          hooks: reverse(items.hooks),
          permissions: reverse(items.permissions),
          env: reverse(items.env),
          incomplete: reverse(items.incomplete),
        },
      }),
    ).diff;
    expect(backward).toEqual(forward);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(forward.context.map((d) => `${d.agent}:${d.cwd}`)).toEqual([
      'claude-code:',
      'claude-code:x',
      'cursor:',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

describe('validateBaseline', () => {
  const { ruleId: _ruleId, ...notRead } = skip('x.md', { code: 'not-read' });
  const full = report({
    pathBase: 'packages/api',
    findings: [finding('a/x', 'packages/api/AGENTS.md', 'f1:1')],
    inventory: {
      mcpServers: [
        mcp('x', {
          declaredType: 'stdio',
          url: { origin: 'https://x.example', tls: true, loopback: false },
          status: { 'claude-code': 'needs-approval', cursor: 'loads' },
        }),
        mcp('y', { file: '.claude/agents/y.md', scope: 'subagent' }),
      ],
      hooks: [
        hook('Stop', { type: 'command' }),
        hook('Stop', { file: '.claude/skills/x/SKILL.md', scope: 'skill' }),
      ],
      permissions: [permission('permissions.allow', 'Bash')],
      env: [env('ANTHROPIC_BASE_URL', 'endpoint', { shown: 'https://x.example' })],
      incomplete: ['.codex/config.toml'],
    },
    plans: [
      plan('claude-code', '', {
        entries: [entry('CLAUDE.md', { truncated: { atByte: 10, line: 2 } })],
        skipped: [skip('AGENTS.md'), notRead],
        limits: [
          {
            key: 'k',
            unit: 'chars',
            limit: null,
            used: 1.5,
            subject: 's',
            effect: 'advice',
            evidence: [],
          },
        ],
      }),
    ],
  });
  const json = (value: unknown): unknown => parse(JSON.stringify(value));
  const withoutVersion = (): Record<string, unknown> => {
    const { schemaVersion: _version, ...rest } = json(full) as Record<string, unknown>;
    return rest;
  };

  function invalid(value: unknown): { reason: string; message: string } {
    const result = validateBaseline(value);
    if (result.ok) throw new Error('expected the baseline to be rejected');
    return { reason: result.reason, message: result.message };
  }

  it('reads a JSON report into the same comparison as the scan itself', () => {
    const result = validateBaseline(json(full));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(compareWithBaseline(full, result.baseline, { gate: GATE_CLASSES })).toEqual(
      compareWithBaseline(full, full, { gate: GATE_CLASSES }),
    );
    expect(result.baseline.inventory?.mcpServers[0]?.status).toEqual({
      'claude-code': 'needs-approval',
      cursor: 'loads',
    });
    expect(result.baseline.inventory?.mcpServers.map((server) => server.scope)).toEqual([
      undefined,
      'subagent',
    ]);
    expect(result.baseline.inventory?.hooks.map((item) => item.scope)).toEqual([
      undefined,
      'skill',
    ]);
    expect(Object.keys(result.baseline)).toEqual([
      'schemaVersion',
      'tool',
      'ruleset',
      'fingerprintVersion',
      'pathBase',
      'findings',
      'inventory',
      'context',
    ]);
  });

  it('reads a scope it does not know as none, so a newer baseline still reads', () => {
    const report = json(full) as { inventory: { hooks: Record<string, unknown>[] } };
    const [first] = report.inventory.hooks;
    if (first === undefined) throw new Error('expected a hook');
    first['scope'] = 'session';
    const result = validateBaseline(report);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.inventory?.hooks.map((hook) => hook.scope)).toEqual([
      undefined,
      'skill',
    ]);
    first['scope'] = 7;
    expect(invalid(report).reason).toBe('invalid');
  });

  it('accepts a report without pathBase, inventory or context', () => {
    const minimal = json({
      schemaVersion: 1,
      tool: { name: 'agentcheckup', version: '0.1.0' },
      ruleset: '2026.10',
      fingerprintVersion: FINGERPRINT_VERSION,
      findings: [],
    });
    const result = validateBaseline(minimal);
    expect(result).toEqual({
      ok: true,
      baseline: {
        schemaVersion: 1,
        tool: { name: 'agentcheckup', version: '0.1.0' },
        ruleset: '2026.10',
        fingerprintVersion: FINGERPRINT_VERSION,
        findings: [],
      },
    });
  });

  it('refuses a baseline whose fingerprints come from another scheme', () => {
    // Reports written before the field existed hashed the line text in JSON files too.
    const { fingerprintVersion: _version, ...old } = json(full) as Record<string, unknown>;
    expect(invalid(old)).toEqual({
      reason: 'unsupported-schema',
      message: `Baseline report: its finding fingerprints have version 1, and this agentcheckup computes version ${String(FINGERPRINT_VERSION)}, so no finding could be matched. Create the baseline again with this agentcheckup version.`,
    });
    expect(invalid({ ...(json(full) as object), fingerprintVersion: 3 }).reason).toBe(
      'unsupported-schema',
    );
    expect(invalid({ ...(json(full) as object), fingerprintVersion: '2' })).toEqual({
      reason: 'invalid',
      message: 'Baseline report: fingerprintVersion must be a number, not a string.',
    });
    expect(validateBaseline(json(full)).ok).toBe(true);
  });

  it('tells an unsupported schema version apart from a malformed report', () => {
    expect(invalid({ ...(json(full) as object), schemaVersion: 2 })).toEqual({
      reason: 'unsupported-schema',
      message:
        'Baseline report: schema version 2 is not supported; this agentcheckup reads version 1. Create the baseline with the same agentcheckup version.',
    });
    expect(invalid(withoutVersion())).toEqual({
      reason: 'invalid',
      message:
        'Baseline report: schemaVersion is missing; expected a JSON report from agentcheckup --format json.',
    });
    expect(invalid({ ...(json(full) as object), schemaVersion: '1' }).reason).toBe('invalid');
  });

  it.each([
    [null, 'not null'],
    [[], 'not an array'],
    ['report', 'not a string'],
    [42, 'not a number'],
  ])('rejects %j as a report', (value, message) => {
    const result = invalid(value);
    expect(result.reason).toBe('invalid');
    expect(result.message).toContain(message);
  });

  it.each([
    [
      'tool',
      (r: Record<string, unknown>) => delete r['tool'],
      'tool is missing; expected an object',
    ],
    [
      'tool.version',
      (r: Record<string, unknown>) => {
        r['tool'] = { name: 'x', version: 1 };
      },
      'tool.version must be a string, not a number',
    ],
    [
      'ruleset',
      (r: Record<string, unknown>) => {
        r['ruleset'] = null;
      },
      'ruleset must be a string, not null',
    ],
    [
      'pathBase',
      (r: Record<string, unknown>) => {
        r['pathBase'] = ['x'];
      },
      'pathBase must be a string, not an array',
    ],
    [
      'findings',
      (r: Record<string, unknown>) => delete r['findings'],
      'findings is missing; expected an array',
    ],
    [
      'findings[1]',
      (r: Record<string, unknown>) => {
        r['findings'] = [{ ruleId: 'a', path: 'b', fingerprint: 'c' }, 'x'];
      },
      'findings[1] must be an object, not a string',
    ],
    [
      'fingerprint',
      (r: Record<string, unknown>) => {
        r['findings'] = [{ ruleId: 'a', path: 'b', fingerprint: 7 }];
      },
      'findings[0].fingerprint must be a string, not a number',
    ],
    [
      'inventory',
      (r: Record<string, unknown>) => {
        r['inventory'] = null;
      },
      'inventory must be an object, not null',
    ],
  ])('names the bad field: %s', (_name, mutate, message) => {
    const value = json(full) as Record<string, unknown>;
    mutate(value);
    expect(invalid(value)).toEqual({ reason: 'invalid', message: `Baseline report: ${message}.` });
  });

  it('checks inventory items field by field', () => {
    const withServer = (patch: Record<string, unknown>): unknown => {
      const value = json(full) as { inventory: { mcpServers: Record<string, unknown>[] } };
      Object.assign(value.inventory.mcpServers[0]!, patch);
      return value;
    };
    expect(
      invalid(withServer({ package: { launcher: 'npx', pin: '\u001b[31mbogus' } })).message,
    ).toBe(
      'Baseline report: inventory.mcpServers[0].package.pin must be one of exact, digest, range, tag, none, local, unknown, not a string.',
    );
    expect(invalid(withServer({ platforms: ['claude-code', 'emacs'] })).message).toContain(
      'inventory.mcpServers[0].platforms[1] must be one of claude-code',
    );
    expect(invalid(withServer({ line: -1 })).message).toContain(
      'inventory.mcpServers[0].line must be a non-negative integer',
    );
    expect(invalid(withServer({ line: JSON.parse('1e400') as number })).message).toContain(
      'not a number out of range',
    );
    expect(
      invalid(withServer({ url: { origin: 'x', tls: 'yes', loopback: false } })).message,
    ).toContain('inventory.mcpServers[0].url.tls must be true or false, not a string');
    expect(invalid(withServer({ declaredType: null })).message).toContain(
      'inventory.mcpServers[0].declaredType must be a string, not null',
    );
    expect(invalid(withServer({ status: { cursor: 'maybe' } })).message).toContain(
      'inventory.mcpServers[0].status.cursor must be one of loads',
    );
    const hookless = json(full) as { inventory: { hooks: Record<string, unknown>[] } };
    hookless.inventory.hooks[0]!['failsOpen'] = 'no';
    expect(invalid(hookless).message).toContain(
      'inventory.hooks[0].failsOpen must be true or false',
    );
    const envless = json(full) as { inventory: { env: Record<string, unknown>[] } };
    envless.inventory.env[0]!['class'] = 'secret';
    expect(invalid(envless).message).toContain('inventory.env[0].class must be one of endpoint');
    const incomplete = json(full) as { inventory: Record<string, unknown> };
    incomplete.inventory['incomplete'] = [1];
    expect(invalid(incomplete).message).toContain('inventory.incomplete[0] must be a string');
  });

  it('checks plan fields and drops plans of agents it does not model', () => {
    const value = json(full) as { context: { plans: Record<string, unknown>[] } };
    value.context.plans.push({ agent: 'copilot', cwd: '', anything: 1 });
    const result = validateBaseline(value);
    expect(result.ok && result.baseline.context?.plans.map((p) => p.agent)).toEqual([
      'claude-code',
    ]);

    const withPlan = (patch: Record<string, unknown>): unknown => {
      const copy = json(full) as { context: { plans: Record<string, unknown>[] } };
      Object.assign(copy.context.plans[0]!, patch);
      return copy;
    };
    expect(invalid(withPlan({ agent: 3 })).message).toContain(
      'context.plans[0].agent must be a string',
    );
    expect(invalid(withPlan({ totals: { startup: {} } })).message).toContain(
      'context.plans[0].totals.startup.tokens is missing',
    );
    expect(
      invalid(withPlan({ entries: [{ id: 'a', path: 'a', trigger: 'startup' }] })).message,
    ).toContain('context.plans[0].entries[0].certainty is missing');
    expect(
      invalid(
        withPlan({
          entries: [{ id: 'a', path: 'a', trigger: 'x', certainty: 'x', size: { chars: '1' } }],
        }),
      ).message,
    ).toContain('context.plans[0].entries[0].size.chars must be a non-negative integer');
    expect(
      invalid(
        withPlan({
          entries: [{ id: 'a', path: 'a', trigger: 'x', certainty: 'x', truncated: { atByte: 1 } }],
        }),
      ).message,
    ).toContain('context.plans[0].entries[0].truncated.line is missing');
    expect(
      invalid(withPlan({ skipped: [{ id: 'a', path: 'a', code: 'x', ruleId: 1, certainty: 'x' }] }))
        .message,
    ).toContain('context.plans[0].skipped[0].ruleId must be a string');
    expect(
      invalid(withPlan({ limits: [{ key: 'k', subject: 's', used: 1, limit: 'none' }] })).message,
    ).toContain('context.plans[0].limits[0].limit must be a number');
    expect(
      invalid(withPlan({ limits: [{ key: 'k', subject: '', label: 7, used: 1, limit: null }] }))
        .message,
    ).toContain('context.plans[0].limits[0].label must be a string');
    expect(invalid({ ...(json(full) as object), context: { plans: {} } }).message).toContain(
      'context.plans must be an array, not an object',
    );
  });

  describe('hostile input', () => {
    it('reads own properties only and never pollutes prototypes', () => {
      // Insert hostile keys right after the opening brace of the top-level object.
      const text =
        '{"__proto__":{"polluted":true,"schemaVersion":2},"constructor":{"prototype":{"polluted":true}},' +
        JSON.stringify(json(full)).slice(1);
      const parsed = parse(text);
      const result = validateBaseline(parsed);
      expect(result.ok).toBe(true);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      if (result.ok) {
        expect(Object.getPrototypeOf(result.baseline)).toBe(Object.prototype);
        expect((result.baseline as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
      }

      // Plain JSON.parse too: `__proto__` is an own key there, and inherited values never count.
      expect(validateBaseline(JSON.parse(text) as unknown).ok).toBe(true);
      const inherited = Object.create(json(full) as object) as object;
      expect(invalid(inherited).message).toContain('schemaVersion is missing');
    });

    it('rejects a platform id it does not know as a status key, including __proto__', () => {
      const value = json(full) as { inventory: { mcpServers: Record<string, unknown>[] } };
      value.inventory.mcpServers[0]!['status'] = parse('{"__proto__":"loads"}');
      expect(invalid(value).message).toBe(
        'Baseline report: a key of inventory.mcpServers[0].status must be one of claude-code, codex, cursor, copilot, gemini, windsurf, cline, not a string.',
      );
      expect(({} as Record<string, unknown>)['loads']).toBeUndefined();
    });

    it('never echoes input text in errors', () => {
      const evil = `\u001b]8;;https://evil.example\u0007${'x'.repeat(10_000)}`;
      const value = json(full) as Record<string, unknown>;
      value['findings'] = [{ ruleId: evil, path: evil, fingerprint: { evil } }];
      const { message } = invalid(value);
      expect(message).not.toContain('\u001b');
      expect(message).not.toContain('evil');
      expect(message.length).toBeLessThan(200);
    });

    it('does not follow attacker-controlled depth', () => {
      const depth = 50_000;
      // Arrays only, so plain JSON.parse; a reviver would walk the nesting itself.
      const deep = JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`) as unknown;
      const value = json(full) as Record<string, unknown>;
      value['findings'] = deep;
      expect(invalid(value).message).toBe(
        'Baseline report: findings[0] must be an object, not an array.',
      );
      // Unused fields are never visited, however deep.
      const ignored = json(full) as { findings: Record<string, unknown>[] };
      ignored.findings[0]!['related'] = deep;
      expect(validateBaseline(ignored).ok).toBe(true);
    });

    it('handles many findings in linear time', () => {
      const many = Array.from({ length: 100_000 }, (_, i) => ({
        ruleId: 'a/x',
        path: 'A.md',
        fingerprint: `f:${i % 1000}`,
      }));
      const value = json({ ...(json(full) as object), findings: many });
      const result = validateBaseline(value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const current = report({
        findings: many.slice(0, 500).map((f) => finding(f.ruleId, f.path, f.fingerprint)),
      });
      const { diff } = compareWithBaseline(current, result.baseline);
      expect(diff.findings.unchanged).toBe(500);
      expect(diff.findings.resolved).toHaveLength(99_500);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

const fileArb = fc.constantFrom('.mcp.json', '.cursor/mcp.json', 'pkg/.claude/settings.json');
const nameArb = fc.constantFrom('a', 'b', '__proto__', 'constructor', 'name with space');

const serverArb = fc
  .record({
    file: fileArb,
    name: nameArb,
    digest: fc.constantFrom('1', '2'),
    pin: fc.constantFrom('exact', 'digest', 'range', 'tag', 'none', 'local', 'unknown'),
    remote: fc.boolean(),
  })
  .map(({ file, name, digest, pin, remote }) =>
    remote
      ? mcp(name, {
          file,
          id: `mcp:${file}#${name}`,
          digest,
          transport: 'http',
          url: { origin: 'https://x.example', tls: true, loopback: false },
        })
      : mcp(name, { file, id: `mcp:${file}#${name}`, digest, package: { launcher: 'npx', pin } }),
  );

const hookArb = fc
  .record({
    file: fileArb,
    event: fc.constantFrom('Stop', 'PreToolUse'),
    digest: fc.constantFrom('1', '2'),
    failsOpen: fc.boolean(),
  })
  .map(({ file, event, digest, failsOpen }) =>
    hook(event, { file, id: `hook:${file}#${event}:00c0ffee`, digest, failsOpen }),
  );

const permissionArb = fc
  .record({
    file: fileArb,
    key: fc.constantFrom(
      'permissions.allow',
      'permissions.deny',
      'permissions.defaultMode',
      'enableAllProjectMcpServers',
    ),
    value: fc.constantFrom('Bash', 'true', 'bypassPermissions'),
    broad: fc.boolean(),
    effective: fc.boolean(),
    digest: fc.constantFrom('1', '2'),
  })
  .map(({ file, key, value, ...rest }) =>
    permission(key, value, { file, id: `perm:${file}#${key}=${value}`, ...rest }),
  );

const envArb = fc
  .record({
    file: fileArb,
    key: fc.constantFrom('ANTHROPIC_BASE_URL', 'NODE_OPTIONS', 'EDITOR'),
    cls: fc.constantFrom('endpoint', 'credential', 'tls', 'code-exec', 'other'),
    digest: fc.constantFrom('1', '2'),
  })
  .map(({ file, key, cls, digest }) => env(key, cls, { file, id: `env:${file}#${key}`, digest }));

const findingArb = fc
  .record({
    ruleId: fc.constantFrom('risk/hidden-unicode', 'a/x'),
    path: fc.constantFrom('AGENTS.md', 'sub/CLAUDE.md'),
    fingerprint: fc.constantFrom('f1:1', 'f1:2', 'f2:1'),
    suppressed: fc.boolean(),
  })
  .map(({ ruleId, path, fingerprint, suppressed }) =>
    finding(
      ruleId,
      path,
      fingerprint,
      suppressed ? { suppressed: { kind: 'inline', reason: 'r' } } : {},
    ),
  );

const entryArb = fc
  .record({
    path: fc.constantFrom('AGENTS.md', 'sub/AGENTS.md', '.mcp.json'),
    trigger: fc.constantFrom('startup', 'on-path', 'on-approval'),
    chars: fc.nat(100),
    cut: fc.boolean(),
    sized: fc.boolean(),
  })
  .map(({ path, trigger, chars, cut, sized }) => {
    const { size: _size, ...base } = entry(path, { trigger });
    return {
      ...base,
      ...(sized ? { size: size(chars) } : {}),
      ...(cut ? { truncated: { atByte: chars, line: 1 } } : {}),
    } satisfies LoadEntry;
  });

const planArb = fc
  .record({
    agent: fc.constantFrom<ContextAgent>('claude-code', 'codex', 'cursor'),
    cwd: fc.constantFrom('', 'sub'),
    entries: fc.array(entryArb, { maxLength: 4 }),
    skipped: fc.array(
      fc.constantFrom('AGENTS.md', 'x.md').map((path) => skip(path)),
      { maxLength: 2 },
    ),
    used: fc.nat(1000),
    tokens: fc.nat(1000),
  })
  .map(({ agent, cwd, entries, skipped, used, tokens }) =>
    plan(agent, cwd, {
      entries,
      skipped,
      limits: [
        {
          key: 'k',
          unit: 'bytes',
          limit: 500,
          used,
          subject: '.claude/skills',
          effect: 'advice',
          evidence: [],
        },
      ],
      totals: { startup: { bytes: 0, chars: 0, tokens }, onDemand: size(0) },
    }),
  );

const reportArb = fc
  .record({
    findings: fc.array(findingArb, { maxLength: 6 }),
    mcpServers: fc.array(serverArb, { maxLength: 4 }),
    hooks: fc.array(hookArb, { maxLength: 3 }),
    permissions: fc.array(permissionArb, { maxLength: 4 }),
    env: fc.array(envArb, { maxLength: 3 }),
    incomplete: fc.subarray([
      'invalid-json:.mcp.json',
      '.codex/config.toml',
      '.github/hooks/*.json',
    ]),
    plans: fc.array(planArb, { maxLength: 3 }),
    pathBase: fc.option(fc.constantFrom('', '.', 'packages/api', 'packages/api/'), {
      nil: undefined,
    }),
    withInventory: fc.boolean(),
  })
  .map(({ findings, plans, pathBase, withInventory, ...items }) =>
    report({
      findings,
      plans,
      inventory: withInventory ? items : null,
      ...(pathBase === undefined ? {} : { pathBase }),
    }),
  );

describe('properties', () => {
  it('a report compared with itself has no new findings, gate hits or item changes', () => {
    fc.assert(
      fc.property(reportArb, (scan) => {
        const result = compare(scan, scan);
        expectNoChanges(result);
        expect(result.diff.findings.unchanged).toBe(scan.findings.length);

        const parsed = validateBaseline(parse(JSON.stringify(scan)));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(compareWithBaseline(scan, parsed.baseline, { gate: GATE_CLASSES })).toEqual(
            result,
          );
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('a rebased copy of a report matches the report', () => {
    fc.assert(
      fc.property(reportArb, fc.constantFrom('packages/api', 'a/b/c'), (scan, prefix) => {
        const plain = { ...scan, pathBase: '' };
        expectNoChanges(compare(rebased(plain, prefix), plain));
        expectNoChanges(compare(plain, rebased(plain, prefix)));
      }),
      { numRuns: RUNS },
    );
  });

  it('every hit is for a selected class and an added or changed item', () => {
    fc.assert(
      fc.property(reportArb, reportArb, fc.subarray([...GATE_CLASSES]), (before, after, gate) => {
        const { diff } = compare(before, after, gate);
        const changed = new Set([
          ...diff.inventory.added,
          ...diff.inventory.changed.map((c) => c.id),
        ]);
        const fresh = new Set(
          compareWithBaseline(after, before)
            .findings.filter((f) => f.baseline === 'new')
            .map((f) => f.fingerprint),
        );
        for (const hit of diff.gate.hits) {
          expect(gate).toContain(hit.class);
          const known =
            changed.has(hit.id) ||
            (hit.class === 'unicode' && fresh.has(hit.id)) ||
            ((hit.class === 'mcp' || hit.class === 'hooks') &&
              hit.change === 'added' &&
              after.inventory?.incomplete.includes(hit.id));
          expect(known).toBe(true);
        }
        expect(diff.gate.classes).toEqual([...gate].sort());
      }),
      { numRuns: RUNS },
    );
  });
});
