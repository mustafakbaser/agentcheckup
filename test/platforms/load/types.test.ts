import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CONTEXT_AGENTS,
  PLATFORM_IDS,
  type BaselineDiff,
  type ContextAgent,
  type ContextReport,
  type Finding,
  type GateClass,
  type Inventory,
  type LoadPlan,
  type ScanResult,
  type Size,
} from '../../../src/index.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  LOADER_ENABLED,
} from '../../../src/platforms/load/types.js';

const size: Size = { bytes: 1204, chars: 1204, tokens: 301 };

const plan = {
  agent: 'claude-code',
  cwd: '',
  entries: [
    {
      id: 'instructions:CLAUDE.md',
      role: 'instructions',
      trigger: 'startup',
      position: 1,
      path: 'CLAUDE.md',
      realPath: 'CLAUDE.md',
      size,
      certainty: 'documented',
      evidence: ['claudeMemory'],
    },
    {
      id: 'mcp-server:.mcp.json#github',
      role: 'mcp-server',
      trigger: 'on-approval',
      path: '.mcp.json',
      realPath: '.mcp.json',
      name: 'github',
      inventoryId: 'mcp:.mcp.json#github',
      certainty: 'documented',
      evidence: ['claudeMcp'],
    },
  ],
  skipped: [
    {
      id: 'instructions:AGENTS.md',
      role: 'instructions',
      path: 'AGENTS.md',
      code: 'shadowed-by-claude-md',
      ruleId: 'instr/agents-md-ignored-by-claude',
      certainty: 'documented',
      evidence: ['claudeMemory'],
    },
  ],
  outOfScope: [{ path: '.cursor/rules/README.md', because: 'documentation' }],
  assumptions: [
    {
      key: 'claude.instructionsMode',
      value: 'claude-md-or-agents-md',
      origin: 'default',
      evidence: [],
    },
  ],
  hidden: [{ scope: 'user', locations: ['~/.claude/CLAUDE.md'], roles: ['instructions'] }],
  limits: [
    {
      key: 'claude.skill_listing',
      unit: 'context-fraction',
      limit: null,
      used: 1310,
      subject: '.claude/skills',
      effect: 'shortens',
      evidence: [],
    },
  ],
  totals: { startup: size, onDemand: { bytes: 0, chars: 0, tokens: 0 } },
  incomplete: ['unparsed:.codex/config.toml'],
} as const satisfies LoadPlan;

describe('load-plan contract', () => {
  it('names an agent per platform, and one per Copilot surface, in PLATFORM_IDS order', () => {
    expectTypeOf<ContextAgent>().toEqualTypeOf<
      | 'claude-code'
      | 'codex'
      | 'cursor'
      | 'copilot-cli'
      | 'copilot-vscode'
      | 'copilot-cloud'
      | 'gemini'
      | 'windsurf'
      | 'cline'
    >();
    expect(Object.keys(CONTEXT_PLATFORM)).toEqual([...ALL_CONTEXT_AGENTS]);
    const platforms = ALL_CONTEXT_AGENTS.map((agent) => CONTEXT_PLATFORM[agent]);
    // Every platform has an agent, and agents of one platform are next to each other.
    expect([...new Set(platforms)]).toEqual([...PLATFORM_IDS]);
    expect(ALL_CONTEXT_AGENTS.filter((agent) => CONTEXT_PLATFORM[agent] === 'copilot')).toEqual([
      'copilot-cli',
      'copilot-vscode',
      'copilot-cloud',
    ]);
    for (const agent of ALL_CONTEXT_AGENTS) {
      if (CONTEXT_PLATFORM[agent] !== 'copilot') expect(CONTEXT_PLATFORM[agent]).toBe(agent);
    }
  });

  it('turns on only the agents whose loader exists, in the same order', () => {
    expect(Object.keys(LOADER_ENABLED)).toEqual([...ALL_CONTEXT_AGENTS]);
    expect(CONTEXT_AGENTS).toEqual(ALL_CONTEXT_AGENTS.filter((agent) => LOADER_ENABLED[agent]));
    expect(CONTEXT_AGENTS).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot-cli',
      'copilot-vscode',
      'copilot-cloud',
      'gemini',
      'windsurf',
      'cline',
    ]);
  });

  it('accepts a complete plan inside a context report', () => {
    const report: ContextReport = {
      agents: ['claude-code'],
      sources: {
        claudeMemory: {
          title: 'Claude Code memory',
          url: 'https://code.claude.com/docs/en/memory',
          checked: '2026-10-15',
          status: 'verified',
        },
      },
      plans: [plan],
      matrix: { rows: [{ path: 'CLAUDE.md', kind: 'claude-md', cells: ['startup'] }] },
    };
    expect(report.plans[0]?.entries.map((entry) => entry.position)).toEqual([1, undefined]);
  });
});

describe('report additions', () => {
  it('keeps the new ScanResult fields optional, except the inventory every scan has', () => {
    expectTypeOf<ScanResult['pathBase']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ScanResult['inventory']>().toEqualTypeOf<Inventory>();
    expectTypeOf<ScanResult['context']>().toEqualTypeOf<ContextReport | undefined>();
    expectTypeOf<ScanResult['baseline']>().toEqualTypeOf<BaselineDiff | undefined>();
    expectTypeOf<Finding['baseline']>().toEqualTypeOf<'new' | 'unchanged' | undefined>();
  });

  it('accepts an inventory and a baseline diff', () => {
    const inventory: Inventory = {
      mcpServers: [
        {
          id: 'mcp:.mcp.json#github',
          file: '.mcp.json',
          line: 3,
          platforms: ['claude-code'],
          digest: '0000000000002a',
          name: 'github',
          transport: 'stdio',
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
          headerKeys: [],
          status: { 'claude-code': 'needs-approval' },
        },
      ],
      hooks: [],
      permissions: [],
      env: [
        {
          id: 'env:.claude/settings.json#ANTHROPIC_BASE_URL',
          file: '.claude/settings.json',
          line: 4,
          platforms: ['claude-code'],
          digest: '0000000000002b',
          key: 'ANTHROPIC_BASE_URL',
          class: 'endpoint',
          shown: 'https://llm-proxy.example.net',
        },
      ],
      incomplete: [],
    };
    const diff: BaselineDiff = {
      against: { version: '0.1.0', ruleset: '2026.10', sameRuleset: true, newRules: [] },
      findings: { new: 0, unchanged: 2, resolved: [] },
      inventory: { added: [inventory.env[0]!.id], removed: [], changed: [] },
      context: [],
      gate: {
        classes: ['env'],
        hits: [
          {
            class: 'env',
            id: inventory.env[0]!.id,
            change: 'added',
            summary: 'ANTHROPIC_BASE_URL → https://llm-proxy.example.net',
          },
        ],
      },
    };
    expect(diff.gate.hits).toHaveLength(1);
    expectTypeOf<'security'>().not.toExtend<GateClass>();
  });
});
