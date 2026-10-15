/**
 * Builders and sample objects for load plans, the security inventory and baseline diffs.
 * Independent of the loaders, the inventory builder and the baseline engine: report tests must
 * only change when a report changes. Other units can reuse the builders for their own inputs.
 *
 * The samples follow the output mockups of the context design (a Claude Code plan in
 * packages/api, a Codex plan cut by its byte budget, a Cursor plan at the root) and are built in
 * canonical order, so `toJsonContext(sampleContext)` equals `sampleContext`.
 */
import type { BaselineDiff, GateHit, ItemDiff, PlanDelta } from '../../src/core/baseline-types.js';
import type { ScanResult } from '../../src/core/engine.js';
import type { Finding, RuleSource } from '../../src/core/types.js';
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PermissionItem,
} from '../../src/inventory/types.js';
import {
  CONTEXT_AGENTS,
  type ContextAgent,
  type ContextReport,
  type LoadEntry,
  type LoadPlan,
  type LoadRole,
  type Size,
  type SkipCode,
  type SkippedLoad,
} from '../../src/platforms/load/types.js';
import { HOSTILE, HOSTILE_ALL } from '../report/hostile.js';

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

/** A size with `tokens = ceil(chars / 4)`; `chars` defaults to `bytes`. */
export function size(bytes: number, chars = bytes): Size {
  return { bytes, chars, tokens: Math.ceil(chars / 4) };
}

const ZERO: Size = { bytes: 0, chars: 0, tokens: 0 };

function add(a: Size, b: Size | undefined): Size {
  if (b === undefined) return a;
  return { bytes: a.bytes + b.bytes, chars: a.chars + b.chars, tokens: a.tokens + b.tokens };
}

/** A load entry with id `<role>:<path>` (plus `#<name>` when named) and documented evidence. */
export function entry(role: LoadRole, path: string, overrides: Partial<LoadEntry> = {}): LoadEntry {
  const name = overrides.name;
  return {
    id: name === undefined ? `${role}:${path}` : `${role}:${path}#${name}`,
    role,
    trigger: 'startup',
    path,
    realPath: path,
    certainty: 'documented',
    evidence: ['claudeMemory'],
    ...overrides,
  };
}

export function skip(
  role: LoadRole,
  path: string,
  code: SkipCode,
  overrides: Partial<SkippedLoad> = {},
): SkippedLoad {
  const name = overrides.name;
  return {
    id: name === undefined ? `${role}:${path}` : `${role}:${path}#${name}`,
    role,
    path,
    code,
    certainty: 'documented',
    evidence: ['claudeMemory'],
    ...overrides,
  };
}

/**
 * Totals the way loaders compute them: startup entries plus skill listings at startup; the
 * rest, and skill bodies, on demand.
 */
export function totalsOf(entries: readonly LoadEntry[]): LoadPlan['totals'] {
  let startup = ZERO;
  let onDemand = ZERO;
  for (const item of entries) {
    if (item.role === 'mcp-server' || item.role === 'hook') continue;
    const listed =
      item.role === 'skill' && (item.trigger === 'startup' || item.trigger === 'model-selected');
    if (item.trigger === 'startup' || listed) startup = add(startup, item.size);
    else onDemand = add(onDemand, item.size);
    onDemand = add(onDemand, item.deferred);
  }
  return { startup, onDemand };
}

export function plan(agent: ContextAgent, overrides: Partial<LoadPlan> = {}): LoadPlan {
  const entries = overrides.entries ?? [];
  return {
    agent,
    cwd: '',
    entries,
    skipped: [],
    outOfScope: [],
    assumptions: [],
    hidden: [],
    limits: [],
    totals: totalsOf(entries),
    incomplete: [],
    ...overrides,
  };
}

const CHECKED = '2026-10-15';
const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

export const SAMPLE_SOURCES: Readonly<Record<string, RuleSource>> = {
  claudeHooks: verified('Claude Code: Hooks', 'https://code.claude.com/docs/en/hooks'),
  claudeMcp: verified('Claude Code: MCP', 'https://code.claude.com/docs/en/mcp'),
  claudeMemory: verified(
    'Claude Code: Memory (CLAUDE.md)',
    'https://code.claude.com/docs/en/memory',
  ),
  codexAgentsMd: verified(
    'Codex: AGENTS.md',
    'https://developers.openai.com/codex/guides/agents-md',
  ),
  cursorRules: verified('Cursor: Rules', 'https://cursor.com/docs/context/rules'),
};

/** A context report over `plans`; agents are the plans' agents in CONTEXT_AGENTS order. */
export function contextReport(
  plans: readonly LoadPlan[],
  overrides: Partial<ContextReport> = {},
): ContextReport {
  return {
    agents: CONTEXT_AGENTS.filter((agent) => plans.some((item) => item.agent === agent)),
    sources: SAMPLE_SOURCES,
    plans,
    ...overrides,
  };
}

function itemBase(id: string, file: string, line: number) {
  return { id, file, line, platforms: ['claude-code'] as const, digest: '0000000000002a' };
}

export function mcpServer(
  file: string,
  name: string,
  overrides: Partial<McpServerItem> = {},
): McpServerItem {
  return {
    ...itemBase(`mcp:${file}#${name}`, file, 2),
    name,
    transport: 'stdio',
    envKeys: [],
    headerKeys: [],
    status: { 'claude-code': 'needs-approval' },
    ...overrides,
  };
}

export function hookItem(file: string, event: string, overrides: Partial<HookItem> = {}): HookItem {
  return {
    ...itemBase(`hook:${file}#${event}:00000000000001`, file, 4),
    event,
    known: true,
    failsOpen: false,
    remoteScript: false,
    ...overrides,
  };
}

export function permission(
  file: string,
  key: string,
  value: string,
  overrides: Partial<PermissionItem> = {},
): PermissionItem {
  return {
    ...itemBase(`perm:${file}#${key}=${value}`, file, 6),
    key,
    value,
    broad: false,
    effective: true,
    ...overrides,
  };
}

export function envItem(file: string, key: string, overrides: Partial<EnvItem> = {}): EnvItem {
  return { ...itemBase(`env:${file}#${key}`, file, 8), key, class: 'other', ...overrides };
}

export function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return { mcpServers: [], hooks: [], permissions: [], env: [], incomplete: [], ...overrides };
}

export function itemDiff(overrides: Partial<ItemDiff> = {}): ItemDiff {
  return { added: [], removed: [], changed: [], ...overrides };
}

export function planDelta(
  agent: ContextAgent,
  before: number,
  after: number,
  overrides: Partial<PlanDelta> = {},
): PlanDelta {
  return {
    agent,
    cwd: '',
    entries: itemDiff(),
    skipped: itemDiff(),
    startupTokens: { before, after },
    limits: [],
    ...overrides,
  };
}

export function baselineDiff(overrides: Partial<BaselineDiff> = {}): BaselineDiff {
  return {
    against: { version: '0.1.0', ruleset: '2026.10', sameRuleset: true },
    findings: { new: 0, unchanged: 0, resolved: [] },
    inventory: itemDiff(),
    context: [],
    gate: { classes: [], hits: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------------------------

const GITHUB = mcpServer('.mcp.json', 'github', {
  line: 3,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github@1.4.0'],
  package: {
    launcher: 'npx',
    ecosystem: 'npm',
    name: '@modelcontextprotocol/server-github',
    version: '1.4.0',
    pin: 'exact',
  },
  envKeys: ['GITHUB_TOKEN'],
});
const DOCS = mcpServer('.mcp.json', 'docs', {
  line: 11,
  transport: 'unknown',
  url: { origin: 'https://docs.example.com', tls: true, loopback: false },
  headerKeys: ['Authorization'],
  status: { 'claude-code': 'skipped' },
});
const BROWSER = mcpServer('.cursor/mcp.json', 'browser', {
  platforms: ['cursor'],
  command: 'npx',
  args: ['-y', '@acme/browser-mcp'],
  package: { launcher: 'npx', ecosystem: 'npm', name: '@acme/browser-mcp', pin: 'none' },
  status: { cursor: 'loads' },
});
const GUARD = hookItem('.claude/settings.json', 'PreToolUse', {
  matcher: 'Bash',
  type: 'command',
  command: 'bash scripts/hooks/guard.sh',
  script: 'scripts/hooks/guard.sh',
  failsOpen: true,
});
const NOTIFY = hookItem('.codex/hooks.json', 'Stop', {
  id: 'hook:.codex/hooks.json#Stop:00000000000002',
  platforms: ['codex'],
  type: 'command',
  command: 'node scripts/notify.js',
});
const CURL = permission('.claude/settings.json', 'permissions.allow', 'Bash(curl:*)', {
  broad: true,
});
const BASE_URL = envItem('.claude/settings.json', 'ANTHROPIC_BASE_URL', {
  class: 'endpoint',
  shown: 'https://llm-proxy.example.net',
});

export const sampleInventory: Inventory = inventory({
  mcpServers: [BROWSER, DOCS, GITHUB],
  hooks: [GUARD, NOTIFY],
  permissions: [CURL],
  env: [BASE_URL],
  incomplete: ['.codex/config.toml'],
});

const skill = (name: string, listing: number, body: number, position: number): LoadEntry =>
  entry('skill', `.claude/skills/${name}/SKILL.md`, {
    trigger: 'model-selected',
    position,
    name,
    size: size(listing),
    deferred: size(body),
    evidence: ['claudeMemory'],
  });

const claudeEntries: LoadEntry[] = [
  entry('instructions', 'CLAUDE.md', { position: 1, size: size(1204) }),
  entry('import', 'AGENTS.md', { position: 2, via: ['CLAUDE.md'], size: size(6880) }),
  entry('instructions', 'packages/api/CLAUDE.md', { position: 3, size: size(412) }),
  entry('rule', '.claude/rules/testing.md', {
    position: 4,
    size: size(980),
    certainty: 'unverified',
    evidence: [],
  }),
  skill('deploy', 400, 9402, 5),
  skill('docs', 300, 1200, 6),
  skill('lint', 300, 1500, 7),
  skill('release', 310, 2000, 8),
  entry('hook', '.claude/settings.json', {
    id: 'hook:.claude/settings.json#PreToolUse',
    name: 'PreToolUse',
    inventoryId: GUARD.id,
    evidence: ['claudeHooks'],
  }),
  entry('rule', '.claude/rules/api.md', {
    trigger: 'on-path',
    patterns: ['src/api/**'],
    size: size(900),
  }),
  entry('subagent', '.claude/agents/reviewer.md', {
    trigger: 'model-selected',
    name: 'reviewer',
    size: size(1500),
  }),
  entry('command', '.claude/commands/release.md', {
    trigger: 'manual',
    name: 'release',
    size: size(600),
  }),
  entry('mcp-server', '.mcp.json', {
    trigger: 'on-approval',
    name: 'github',
    inventoryId: GITHUB.id,
    evidence: ['claudeMcp'],
  }),
];

export const claudePlan: LoadPlan = plan('claude-code', {
  cwd: 'packages/api',
  entries: claudeEntries,
  skipped: [
    skip('rule', '.cursor/rules/api.mdc', 'not-read', { evidence: [] }),
    skip('mcp-server', '.mcp.json', 'url-without-type', {
      name: 'docs',
      ruleId: 'mcp/url-without-type',
      evidence: ['claudeMcp'],
    }),
    skip('instructions', 'packages/api/AGENTS.md', 'shadowed-by-claude-md', {
      ruleId: 'instr/agents-md-ignored-by-claude',
    }),
  ],
  outOfScope: [{ path: '.claude/skills/deploy/scripts/run.md', because: 'payload-folder' }],
  assumptions: [
    {
      key: 'claude.instructionsMode',
      value: 'claude-md-or-agents-md',
      origin: 'default',
      evidence: ['claudeMemory'],
    },
    { key: 'claude.session', value: 'interactive', origin: 'default', evidence: [] },
    { key: 'claude.version', value: '>=2.1.277', origin: 'default', evidence: [] },
  ],
  hidden: [
    { scope: 'managed', locations: ['managed CLAUDE.md'], roles: ['instructions'] },
    {
      scope: 'user',
      locations: ['~/.claude.json', '~/.claude/CLAUDE.md', '~/.claude/rules', '~/.claude/skills'],
      roles: ['instructions', 'rule', 'skill', 'mcp-server'],
    },
  ],
  limits: [
    {
      key: 'claude.skill_listing_chars',
      unit: 'chars',
      limit: 1536,
      used: 400,
      subject: '.claude/skills/deploy/SKILL.md',
      effect: 'shortens',
      evidence: ['claudeMemory'],
    },
  ],
});

export const codexPlan: LoadPlan = plan('codex', {
  cwd: 'packages/api',
  entries: [
    entry('instructions', 'AGENTS.md', {
      position: 1,
      size: size(6880),
      evidence: ['codexAgentsMd'],
    }),
    entry('instructions', 'packages/api/AGENTS.md', {
      position: 2,
      size: size(26130, 25888),
      truncated: { atByte: 25888, line: 812 },
      evidence: ['codexAgentsMd'],
    }),
    entry('skill', '.agents/skills/release-notes/SKILL.md', {
      trigger: 'model-selected',
      name: 'release-notes',
      size: size(240),
      deferred: size(3100),
      evidence: ['codexAgentsMd'],
    }),
    entry('hook', '.codex/hooks.json', {
      id: 'hook:.codex/hooks.json#Stop',
      trigger: 'on-approval',
      name: 'Stop',
      inventoryId: NOTIFY.id,
      evidence: ['codexAgentsMd'],
    }),
  ],
  skipped: [skip('instructions', 'CLAUDE.md', 'not-read', { evidence: [] })],
  assumptions: [
    {
      key: 'codex.project_doc_max_bytes',
      value: 32768,
      origin: 'rule-option',
      evidence: ['codexAgentsMd'],
    },
  ],
  hidden: [
    {
      scope: 'user',
      locations: ['$CODEX_HOME/AGENTS.md', '~/.agents/skills', '~/.codex/config.toml'],
      roles: ['instructions', 'skill', 'mcp-server'],
    },
  ],
  limits: [
    {
      key: 'codex.project_doc_max_bytes',
      unit: 'bytes',
      limit: 32768,
      used: 33010,
      subject: 'packages/api',
      effect: 'truncates',
      evidence: ['codexAgentsMd'],
    },
  ],
  incomplete: ['unparsed:.codex/config.toml'],
});

export const cursorPlan: LoadPlan = plan('cursor', {
  entries: [
    entry('instructions', 'AGENTS.md', {
      position: 1,
      size: size(6880),
      evidence: ['cursorRules'],
    }),
    entry('instructions', 'CLAUDE.md', {
      position: 2,
      size: size(1204),
      evidence: ['cursorRules'],
    }),
    entry('mcp-server', '.cursor/mcp.json', {
      name: 'browser',
      inventoryId: BROWSER.id,
      evidence: ['cursorRules'],
    }),
    entry('rule', '.cursor/rules/api.mdc', {
      trigger: 'on-path',
      patterns: ['src/api/**/*.ts', 'src/routes/**'],
      size: size(1100),
      evidence: ['cursorRules'],
    }),
  ],
  skipped: [
    skip('rule', '.cursor/rules/style.md', 'not-mdc', {
      ruleId: 'cursor/md-file-ignored',
      evidence: ['cursorRules'],
    }),
  ],
  outOfScope: [{ path: '.cursor/rules/README.md', because: 'documentation' }],
  assumptions: [
    { key: 'cursor.mode', value: 'agent', origin: 'default', evidence: ['cursorRules'] },
    { key: 'cursor.thirdPartyConfigs', value: true, origin: 'default', evidence: [] },
  ],
  hidden: [{ scope: 'team', locations: ['Team rules'], roles: ['rule'] }],
});

export const sampleMatrix: NonNullable<ContextReport['matrix']> = {
  rows: [
    {
      path: '.agents/skills/release-notes',
      kind: 'skill',
      cells: ['not-read', 'listed', 'listed'],
    },
    { path: '.claude/skills/deploy', kind: 'skill', cells: ['listed', 'not-read', 'listed'] },
    {
      path: '.cursor/rules/api.mdc',
      kind: 'cursor-rule',
      cells: ['not-read', 'not-read', 'on-path'],
    },
    {
      path: '.cursor/rules/style.md',
      kind: 'cursor-rule-md',
      cells: ['not-read', 'not-read', 'skipped'],
    },
    { path: '.mcp.json', kind: 'mcp-json', cells: ['skipped', 'not-read', 'not-read'] },
    { path: 'AGENTS.md', kind: 'agents-md', cells: ['skipped', 'startup', 'startup'] },
    { path: 'CLAUDE.md', kind: 'claude-md', cells: ['startup', 'not-read', 'startup'] },
    {
      path: 'packages/api/AGENTS.md',
      kind: 'agents-md',
      cells: ['skipped', 'start-dir', 'on-path'],
    },
    { path: 'packages/web/AGENTS.md', kind: 'agents-md', cells: ['skipped', 'partial', 'on-path'] },
  ],
};

export const sampleContext: ContextReport = contextReport([claudePlan, codexPlan, cursorPlan], {
  matrix: sampleMatrix,
});

const hits: GateHit[] = [
  {
    class: 'mcp',
    id: BROWSER.id,
    change: 'added',
    summary: 'stdio, npx -y @acme/browser-mcp, not pinned',
  },
  {
    class: 'mcp-unpinned',
    id: BROWSER.id,
    change: 'added',
    summary: 'stdio, npx -y @acme/browser-mcp, not pinned',
  },
  {
    class: 'permissions',
    id: CURL.id,
    change: 'added',
    summary: 'permissions.allow adds Bash(curl:*)',
  },
  {
    class: 'hooks',
    id: GUARD.id,
    change: 'changed',
    summary: 'PreToolUse Bash runs scripts/hooks/guard.sh, command changed',
  },
  {
    class: 'env',
    id: BASE_URL.id,
    change: 'added',
    summary: 'ANTHROPIC_BASE_URL → https://llm-proxy.example.net',
  },
  {
    class: 'unicode',
    id: '3c4d5e6f708192:1',
    change: 'added',
    summary: 'AGENTS.md:12 has 3 invisible Unicode tag characters',
  },
];

export const sampleBaseline: BaselineDiff = baselineDiff({
  findings: {
    new: 2,
    unchanged: 6,
    resolved: [
      { ruleId: 'instructions/broken-import', path: 'CLAUDE.md', fingerprint: '0a0b0c0d0e0f10:1' },
      { ruleId: 'budget/file-too-large', path: 'docs/old.md', fingerprint: '1a1b1c1d1e1f20:1' },
    ],
  },
  inventory: itemDiff({
    added: [BASE_URL.id, BROWSER.id, CURL.id],
    removed: ['mcp:.mcp.json#legacy'],
    changed: [{ id: GUARD.id, fields: ['command', 'digest'] }],
  }),
  context: [
    planDelta('claude-code', 1977, 2697, {
      cwd: 'packages/api',
      entries: itemDiff({ added: ['instructions:packages/api/CLAUDE.md'] }),
    }),
    planDelta('codex', 7801, 8253, {
      cwd: 'packages/api',
      entries: itemDiff({
        changed: [{ id: 'instructions:packages/api/AGENTS.md', fields: ['size'] }],
      }),
      limits: [
        {
          key: 'codex.project_doc_max_bytes',
          subject: 'packages/api',
          before: 31204,
          after: 33010,
          limit: 32768,
        },
      ],
    }),
    planDelta('cursor', 2021, 2021),
  ],
  gate: { classes: ['mcp', 'mcp-unpinned', 'permissions', 'hooks', 'env', 'unicode'], hits },
});

/** Fingerprints of the findings `withContext` marks as new. */
export const NEW_FINGERPRINTS: ReadonlySet<string> = new Set([
  '3c4d5e6f708192:1',
  '6f708192a3b4c5:1',
]);

/**
 * `result` with the sample inventory, context and baseline, and every finding marked `new` or
 * `unchanged` (new: those in NEW_FINGERPRINTS).
 */
export function withContext(result: ScanResult): ScanResult {
  return {
    ...result,
    findings: result.findings.map((item): Finding => ({
      ...item,
      baseline: NEW_FINGERPRINTS.has(item.fingerprint) ? 'new' : 'unchanged',
    })),
    inventory: sampleInventory,
    context: sampleContext,
    baseline: sampleBaseline,
  };
}

/**
 * `result` with one Codex plan that has every trigger for every role, every pin state, an
 * alias, entries without sizes or inventory items, and unusual assumptions and incomplete
 * entries: the less common paths through the context formatters.
 */
export function withEdgeCases(result: ScanResult): ScanResult {
  const servers = [
    mcpServer('.mcp.json', 'local', {
      command: './bin/server',
      package: { launcher: 'local', pin: 'local' },
    }),
    mcpServer('.mcp.json', 'odd', {
      command: 'run',
      package: { launcher: 'unknown', pin: 'unknown' },
    }),
    mcpServer('.mcp.json', 'loop', {
      transport: 'http',
      url: { origin: 'http://127.0.0.1:3000', tls: false, loopback: true },
    }),
    mcpServer('.mcp.json', 'bare', { transport: 'unknown' }),
  ];
  const hooks = [hookItem('.codex/hooks.json', 'Stop')];
  const hookEntry = (id: string, trigger: LoadEntry['trigger'], inventoryId?: string) =>
    entry('hook', '.codex/hooks.json', {
      id,
      name: 'Stop',
      trigger,
      ...(inventoryId === undefined ? {} : { inventoryId }),
    });
  const edge = plan('codex', {
    entries: [
      entry('instructions', 'AGENTS.md', { position: 1 }),
      entry('instructions', 'link.md', { position: 2, realPath: 'docs/real.md', size: size(4) }),
      entry('skill', '.agents/skills/a/SKILL.md', {
        trigger: 'startup',
        size: size(8),
        deferred: size(80),
      }),
      ...servers.map((server) =>
        entry('mcp-server', '.mcp.json', { name: server.name, inventoryId: server.id }),
      ),
      hookEntry('hook:1', 'on-path', hooks[0]!.id),
      hookEntry('hook:2', 'model-selected'),
      hookEntry('hook:3', 'manual'),
      entry('instructions', 'nested/AGENTS.md', { trigger: 'on-path' }),
      entry('rule', 'r.md', { trigger: 'manual', size: size(4) }),
      entry('rule', 'q.md', { trigger: 'on-approval', certainty: 'unverified' }),
      entry('skill', 'nested/.agents/skills/b/SKILL.md', {
        trigger: 'on-path',
        patterns: ['nested'],
        size: size(8),
        deferred: size(40),
      }),
      entry('skill', '.agents/skills/c/SKILL.md', { trigger: 'manual', size: size(12) }),
    ],
    assumptions: [
      { key: 'ratio', value: 0.5, origin: 'flag', evidence: [] },
      { key: 'repo', value: 'x', origin: 'repository', evidence: [] },
    ],
    incomplete: ['markdown-budget:big.md', 'mystery:thing'],
  });
  return {
    ...result,
    context: contextReport([edge]),
    inventory: inventory({ mcpServers: servers, hooks }),
  };
}

// ---------------------------------------------------------------------------------------------
// Shuffling, for determinism tests
// ---------------------------------------------------------------------------------------------

/** Deterministic pseudo-random order (mulberry32), so a failing seed can be replayed. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

function shuffledKeys<V>(record: Readonly<Record<string, V>>, seed: number): Record<string, V> {
  return Object.fromEntries(shuffle(Object.entries(record), seed));
}

function shuffleDiff(diff: ItemDiff, seed: number): ItemDiff {
  return {
    changed: shuffle(diff.changed, seed).map((item) => ({
      fields: shuffle(item.fields, seed + 1),
      id: item.id,
    })),
    removed: shuffle(diff.removed, seed + 2),
    added: shuffle(diff.added, seed + 3),
  };
}

/**
 * The same report with every list whose order carries no meaning shuffled, and agents
 * permuted together with the matrix cells. Order that is data (imports' `via`, MCP `args`)
 * is kept.
 */
export function shuffleReport(result: ScanResult, seed: number): ScanResult {
  const out: { -readonly [K in keyof ScanResult]: ScanResult[K] } = { ...result };
  if (result.context !== undefined) {
    const context = result.context;
    const order = shuffle(
      context.agents.map((_, index) => index),
      seed,
    );
    out.context = {
      plans: shuffle(context.plans, seed + 1).map((item, index) => ({
        ...item,
        entries: shuffle(item.entries, seed + index).map((value) => ({
          ...value,
          evidence: shuffle(value.evidence, seed),
          ...(value.patterns === undefined ? {} : { patterns: shuffle(value.patterns, seed) }),
        })),
        skipped: shuffle(item.skipped, seed + index + 1),
        outOfScope: shuffle(item.outOfScope, seed + index + 2),
        assumptions: shuffle(item.assumptions, seed + index + 3),
        hidden: shuffle(item.hidden, seed + index + 4).map((scope) => ({
          ...scope,
          locations: shuffle(scope.locations, seed),
          roles: shuffle(scope.roles, seed + 1),
        })),
        limits: shuffle(item.limits, seed + index + 5),
        incomplete: shuffle(item.incomplete, seed + index + 6),
      })),
      sources: shuffledKeys(context.sources, seed),
      agents: order.map((index) => context.agents[index]!),
      ...(context.matrix === undefined
        ? {}
        : {
            matrix: {
              rows: shuffle(context.matrix.rows, seed + 2).map((row) => ({
                cells: order.map((index) => row.cells[index] ?? 'unknown'),
                kind: row.kind,
                path: row.path,
              })),
            },
          }),
    };
  }
  if (result.inventory !== undefined) {
    const value = result.inventory;
    out.inventory = {
      incomplete: shuffle(value.incomplete, seed),
      env: shuffle(value.env, seed + 1),
      permissions: shuffle(value.permissions, seed + 2),
      hooks: shuffle(value.hooks, seed + 3),
      mcpServers: shuffle(value.mcpServers, seed + 4).map((item) => ({
        ...item,
        envKeys: shuffle(item.envKeys, seed),
        headerKeys: shuffle(item.headerKeys, seed + 1),
        status: shuffledKeys(item.status, seed),
      })),
    };
  }
  if (result.baseline !== undefined) {
    const value = result.baseline;
    out.baseline = {
      gate: {
        hits: shuffle(value.gate.hits, seed),
        classes: shuffle(value.gate.classes, seed + 1),
      },
      context: shuffle(value.context, seed + 2).map((delta) => ({
        ...delta,
        entries: shuffleDiff(delta.entries, seed),
        skipped: shuffleDiff(delta.skipped, seed + 1),
        limits: shuffle(delta.limits, seed),
      })),
      inventory: shuffleDiff(value.inventory, seed + 3),
      findings: { ...value.findings, resolved: shuffle(value.findings.resolved, seed + 4) },
      against: value.against,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hostile samples
// ---------------------------------------------------------------------------------------------

/** A path that is a workflow command when printed at the start of a line. */
export const COMMAND_PATH = '::error file=x::pwned/CLAUDE.md';

/**
 * Hostile text in every untrusted field of the context, the inventory and the baseline:
 * terminal escapes, workflow commands, Markdown and HTML injection, mentions, bidi controls.
 */
export function withHostileContext(result: ScanResult): ScanResult {
  const server = mcpServer('.mcp.json', HOSTILE.mentions, {
    command: '::error::cmd',
    args: [HOSTILE.osc52Clipboard, HOSTILE.html],
    url: { origin: HOSTILE.autolinks, tls: false, loopback: false },
    package: { launcher: 'npx', pin: 'tag' },
  });
  const hook = hookItem('.claude/settings.json', HOSTILE.issueRefs, {
    matcher: HOSTILE.tablePipes,
    script: HOSTILE.clearScreen,
    failsOpen: true,
    remoteScript: true,
  });
  const hostilePlan = plan('claude-code', {
    cwd: `::error::cwd${HOSTILE.clearScreen}`,
    entries: [
      entry('instructions', COMMAND_PATH, {
        position: 1,
        realPath: `real${HOSTILE.bidiOverride}.md`,
        size: size(10),
      }),
      entry('import', HOSTILE.html, {
        position: 2,
        via: [COMMAND_PATH, HOSTILE.osc52Clipboard],
        size: size(20),
      }),
      entry('instructions', HOSTILE.stopCommands, {
        position: 3,
        size: size(30),
        truncated: { atByte: 12, line: 2 },
      }),
      entry('skill', `.claude/skills/${HOSTILE.mentions}/SKILL.md`, {
        trigger: 'model-selected',
        position: 4,
        name: HOSTILE.mentions,
        size: size(40),
        deferred: size(400),
      }),
      entry('hook', '.claude/settings.json', { name: HOSTILE.issueRefs, inventoryId: hook.id }),
      entry('rule', HOSTILE.tablePipes, {
        trigger: 'on-path',
        patterns: ['::warning::glob', HOSTILE.links],
        size: size(50),
      }),
      entry('command', '.claude/commands/x.md', {
        trigger: 'manual',
        name: HOSTILE.markdownSyntax,
        size: size(60),
      }),
      entry('mcp-server', '.mcp.json', {
        trigger: 'on-approval',
        name: HOSTILE.mentions,
        inventoryId: server.id,
      }),
      entry('mcp-server', `${HOSTILE.osc8Link}.json`, {
        trigger: 'on-approval',
        name: HOSTILE.fakeError,
        inventoryId: 'mcp:missing#server',
      }),
    ],
    skipped: [
      skip('instructions', '::stop-commands::token', 'not-read'),
      skip('mcp-server', HOSTILE.bidiOverride, 'invalid-json', {
        name: HOSTILE.fakeError,
        ruleId: 'evil:rule,title=x',
        certainty: 'unverified',
      }),
    ],
    assumptions: [
      { key: HOSTILE.osc8Link, value: HOSTILE.addMask, origin: 'rule-option', evidence: [] },
    ],
    hidden: [{ scope: 'user', locations: [HOSTILE.zeroWidth], roles: ['instructions'] }],
    incomplete: [`unread:${HOSTILE.tags}`, HOSTILE.c1Csi],
  });
  const context = contextReport([hostilePlan], {
    matrix: {
      rows: [
        { path: '::error::matrix', kind: 'agents-md', cells: ['startup'] },
        { path: HOSTILE.carriageReturn, kind: 'claude-md', cells: ['not-read'] },
        { path: HOSTILE.html, kind: 'claude-md', cells: ['skipped'] },
      ],
    },
  });
  const baseline = baselineDiff({
    against: { version: HOSTILE.clearScreen, ruleset: HOSTILE.html, sameRuleset: false },
    findings: {
      new: 1,
      unchanged: 0,
      resolved: [{ ruleId: 'x/y', path: HOSTILE.osc8Link, fingerprint: '0a0b0c0d0e0f10:1' }],
    },
    context: [
      planDelta('claude-code', 100, 50, {
        cwd: HOSTILE.stopCommands,
        limits: [{ key: HOSTILE.links, subject: 'x', before: 10, after: 20, limit: 15 }],
      }),
    ],
    gate: {
      classes: ['mcp', 'hooks', 'unicode'],
      hits: [
        { class: 'mcp', id: server.id, change: 'added', summary: HOSTILE_ALL },
        { class: 'hooks', id: hook.id, change: 'added', summary: `${HOSTILE.html} ::error::x` },
        { class: 'unicode', id: 'ffffffffffffff:1', change: 'added', summary: HOSTILE.mentions },
        {
          class: 'mcp',
          id: `mcp:${HOSTILE.tablePipes}#${HOSTILE.links}`,
          change: 'changed',
          summary: HOSTILE.stopCommands,
        },
      ],
    },
  });
  return {
    ...result,
    findings: result.findings.map((item) => ({ ...item, baseline: 'new' as const })),
    pathBase: '',
    inventory: inventory({
      mcpServers: [server],
      hooks: [hook],
      permissions: [permission(HOSTILE.html, HOSTILE.links, HOSTILE.addMask)],
      env: [envItem('.claude/settings.json', HOSTILE.osc52Clipboard, { shown: HOSTILE.html })],
      incomplete: [`invalid-json:${HOSTILE.stopCommands}`],
    }),
    context,
    baseline,
  };
}
