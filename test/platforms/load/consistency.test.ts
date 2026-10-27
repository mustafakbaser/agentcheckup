/**
 * Load plans agree with findings (src/platforms/load/consistency.ts): every skip a plan
 * attributes to a rule has that rule's finding, and every finding that means a skip has its skip.
 * Runs on the fixtures and on generated snapshots, in untrusted mode with default severities, on
 * the plans of `--matrix` (every agent at the root, Codex in each AGENTS.md directory). Each
 * allowance has a test that shows the mismatch it accounts for.
 */
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Analysis, analyze, type RuleResult, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { buildInventory } from '../../../src/inventory/build.js';
import { walk } from '../../../src/io/walk.js';
import {
  ALLOWANCES,
  type AllowanceName,
  checkConsistency,
  type ConsistencyReport,
  LOADS_ANYWAY,
  type Mismatch,
  mismatchesByRule,
  SKIP_RULES,
} from '../../../src/platforms/load/consistency.js';
import { loadPlans } from '../../../src/platforms/load/index.js';
import { matrixPlans } from '../../../src/platforms/load/matrix.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type ContextAgent,
  type LoadPlan,
  type SkipCode,
} from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

interface Checked {
  readonly analysis: Analysis;
  readonly result: RuleResult;
  readonly plans: readonly LoadPlan[];
  readonly report: ConsistencyReport;
}

/** Rules first, then the matrix plans over the same analysis, then both directions. */
function checkSnapshot(snapshot: Snapshot, without: readonly AllowanceName[] = []): Checked {
  const analysis = analyze(snapshot, { targets: PLATFORM_IDS });
  const result = runRules(analysis, { rules: builtinRules, trustDirectives: false });
  expect(result.ruleFailures).toEqual([]);
  const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
  const report = checkConsistency(
    { findings: result.findings, plans, view: analysis },
    { without },
  );
  return { analysis, result, plans, report };
}

function check(
  files: FileMap,
  extras: SnapshotExtras = {},
  without: readonly AllowanceName[] = [],
): Checked {
  return checkSnapshot(
    snapshotFrom(files, { ...extras, paths: ['.git/HEAD', ...(extras.paths ?? [])] }),
    without,
  );
}

/** `kind rule agent path` of each mismatch, to compare compactly. */
function brief(mismatches: readonly Mismatch[]): string[] {
  return mismatches.map((m) => `${m.kind} ${m.ruleId || '-'} ${m.agent} ${m.path}`);
}

/** Every plan entry with an `inventoryId` names an item of the inventory. */
function expectInventoryIdsResolve({ analysis, plans }: Checked): void {
  const inventory = buildInventory(analysis);
  const ids = new Set([...inventory.mcpServers, ...inventory.hooks].map((item) => item.id));
  for (const plan of plans) {
    for (const entry of plan.entries) {
      if (entry.inventoryId !== undefined) {
        expect(ids, `${plan.agent} ${entry.id}`).toContain(entry.inventoryId);
      }
    }
  }
}

async function fixture(name: string, gitRoot: boolean): Promise<Snapshot> {
  const walked = await walk(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)));
  return gitRoot
    ? {
        ...walked,
        paths: new Set([...walked.paths, '.git/']),
        opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
      }
    : walked;
}

describe('the mapping tables', () => {
  const rules = new Map(builtinRules.map((rule) => [rule.meta.id, rule.meta]));

  it('name built-in rules that report for the agent', () => {
    for (const mapping of SKIP_RULES) {
      expect(rules.get(mapping.ruleId)?.platforms, mapping.ruleId).toContain(
        CONTEXT_PLATFORM[mapping.agent],
      );
      expect(mapping.codes.length).toBeGreaterThan(0);
    }
    for (const item of LOADS_ANYWAY) {
      const meta = rules.get(item.ruleId);
      expect(meta?.category, item.ruleId).toBe('loading');
      for (const agent of item.agents) {
        expect(meta?.platforms, item.ruleId).toContain(CONTEXT_PLATFORM[agent]);
      }
    }
    for (const item of ALLOWANCES.skipWithoutRule) {
      if ('rule' in item) {
        expect(rules.get(item.rule)?.platforms, item.rule).toContain(CONTEXT_PLATFORM[item.agent]);
      }
    }
  });

  it('map each rule at most once per agent, also for agents not turned on yet', () => {
    for (const meta of rules.values()) {
      for (const agent of ALL_CONTEXT_AGENTS) {
        const skips = SKIP_RULES.filter((m) => m.ruleId === meta.id && m.agent === agent);
        const loads = LOADS_ANYWAY.filter(
          (item) => item.ruleId === meta.id && item.agents.includes(agent),
        );
        expect(skips.length + loads.length, `${meta.id} ${agent}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('cover every loading rule for every modeled agent, each pair once', () => {
    for (const meta of rules.values()) {
      for (const agent of CONTEXT_AGENTS) {
        const skips = SKIP_RULES.filter((m) => m.ruleId === meta.id && m.agent === agent);
        const loads = LOADS_ANYWAY.filter(
          (item) => item.ruleId === meta.id && item.agents.includes(agent),
        );
        expect(skips.length + loads.length, `${meta.id} ${agent}`).toBeLessThanOrEqual(1);
        if (meta.category === 'loading' && meta.platforms.includes(CONTEXT_PLATFORM[agent])) {
          expect(skips.length + loads.length, `${meta.id} ${agent}`).toBe(1);
        }
      }
    }
  });

  it('groups mismatches by rule', () => {
    const groups = mismatchesByRule([
      { kind: 'skip-without-rule', ruleId: '', agent: 'codex', path: 'b' },
      { kind: 'finding-without-skip', ruleId: 'x/y', agent: 'cursor', path: 'a' },
      { kind: 'finding-not-planned', ruleId: 'x/y', agent: 'codex', path: 'c' },
    ]);
    expect([...groups].map(([rule, list]) => [rule, list.map((m) => m.path)])).toEqual([
      ['', ['b']],
      ['x/y', ['c', 'a']],
    ]);
  });
});

describe('consistency on the fixtures', () => {
  it('context fixture: no mismatches, every inventory id resolves', async () => {
    const checked = checkSnapshot(await fixture('context', true));
    expect(checked.report.mismatches).toEqual([]);
    // The fixture exercises both directions.
    expect(checked.plans.some((plan) => plan.skipped.some((s) => s.ruleId !== undefined))).toBe(
      true,
    );
    expect(checked.plans.filter((plan) => plan.agent === 'codex').length).toBeGreaterThan(1);
    expectInventoryIdsResolve(checked);
  });

  it('copilot fixture: no mismatches, every inventory id resolves', async () => {
    const checked = checkSnapshot(await fixture('copilot', true));
    expect(checked.report.mismatches).toEqual([]);
    // Every Copilot surface skips something a rule reports.
    for (const agent of ['copilot-cli', 'copilot-vscode', 'copilot-cloud'] as const) {
      const plan = checked.plans.find((item) => item.agent === agent);
      expect(
        plan?.skipped.some((skip) => skip.ruleId !== undefined),
        agent,
      ).toBe(true);
    }
    expectInventoryIdsResolve(checked);
  });

  it('smoke fixture: no mismatches, every inventory id resolves', async () => {
    const checked = checkSnapshot(await fixture('smoke', false));
    expect(checked.report.mismatches).toEqual([]);
    expectInventoryIdsResolve(checked);
  });
});

describe('consistency on generated snapshots', () => {
  const FRONTMATTER = (body: string): string => `---\n${body}\n---\nBody text.\n`;
  const markdown = fc.oneof(
    fc.constantFrom(
      '',
      '  \n\t\n',
      '﻿',
      'Plain instructions.\n',
      '<!-- only a comment -->\n',
      '@docs/guide.md\n',
      '@missing.md\n',
      '@../outside.md\n',
      '@a.md\n',
      '﻿---\nname: x\ndescription: Y.\n---\n',
      '---\nunclosed: true\n',
      'No frontmatter, first line.\n',
    ),
    fc
      .array(
        fc.tuple(
          fc.constantFrom(
            'name',
            'description',
            'paths',
            'globs',
            'alwaysApply',
            'metadata',
            'applyTo',
            'excludeAgent',
          ),
          fc.constantFrom(
            'x',
            'Does x.',
            '"src/**"',
            'true',
            '[a, b]',
            '{a: 1}',
            '*.ts',
            '',
            'cloud-agent',
          ),
        ),
        { maxLength: 3 },
      )
      .map((fields) => FRONTMATTER(fields.map(([key, value]) => `${key}: ${value}`).join('\n'))),
  );
  const markdownPath = fc.constantFrom(
    'AGENTS.md',
    'AGENTS.override.md',
    'Agents.md',
    'pkg/AGENTS.md',
    'pkg/AGENTS.override.md',
    'pkg/sub/AGENTS.md',
    '.github/AGENTS.md',
    'CLAUDE.md',
    'claude.md',
    'pkg/Claude.md',
    'pkg/agents.md',
    'CLAUDE.local.md',
    '.claude/CLAUDE.md',
    'pkg/CLAUDE.md',
    'a.md',
    'docs/guide.md',
    '.claude/rules/r.md',
    '.claude/agents/helper.md',
    '.claude/commands/run.md',
    '.claude/skills/s/SKILL.md',
    '.agents/skills/s/SKILL.md',
    '.agents/skills/deep/x/SKILL.md',
    'pkg/.agents/skills/t/SKILL.md',
    '.codex/skills/c/SKILL.md',
    '.cursor/skills/k/SKILL.md',
    'collection/z/SKILL.md',
    '.cursor/rules/r.mdc',
    '.cursor/rules/r.md',
    '.cursor/rules/README.md',
    'pkg/.cursor/rules/n.mdc',
    '.cursorrules',
    '.windsurfrules',
    '.devin/rules/r.md',
    '.windsurf/rules/w.md',
    '.devin/skills/d/SKILL.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
    '.github/prompts/copilot-instructions.md',
    'pkg/.github/copilot-instructions.md',
    '.github/instructions/a.instructions.md',
    '.github/x/b.instructions.md',
    'docs/c.instructions.md',
    '.github/skills/g/SKILL.md',
    '.github/skills/G/SKILL.md',
  );
  const json = fc.constantFrom(
    '{',
    '{}',
    '{"mcpServers":{"a":{"command":"npx","args":["-y","pkg@1.0.0"]},"u":{"url":"https://x"}}}',
    '{"mcpServers":{"h":{"type":"http","url":"https://x"}}}',
    '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"./a.sh"},{"type":"command","command":"./a.sh"}]}],"Nope":[{"hooks":[{"type":"command","command":"x"}]}]}}',
    '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"n"}]}],"Stop":[{"hooks":[{"type":"http","url":"https://h/x"}]}]}}',
    '{"version":1,"hooks":{"beforeShellExecution":[{"command":"./g.sh"}],"PreToolUse":[{"command":"x"}]}}',
    '{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}',
    '{"read_config_from":{"agents_standard":false,"claude":false,"cursor":false}}',
    '{"version":1,"hooks":{"preToolUse":[{"bash":"./g.sh"}],"notification":[{"bash":"n"}],"nope":[]}}',
    '{"version":2,"hooks":{}}',
    '{"a":{"command":"npx","args":["-y","a@1.0.0"]}}',
    '{"servers":{"v":{"command":"v"}}}',
  );
  const jsonPath = fc.constantFrom(
    '.mcp.json',
    'pkg/.mcp.json',
    '.cursor/mcp.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.cursor/hooks.json',
    '.codex/hooks.json',
    'pkg/.codex/hooks.json',
    '.devin/config.json',
    '.devin/hooks.v1.json',
    '.devin/mcp_config.json',
    '.github/hooks/h.json',
    'pkg/.github/hooks/h.json',
    '.github/mcp.json',
    '.vscode/mcp.json',
    '.github/copilot/settings.json',
  );
  const files = fc
    .tuple(
      fc.dictionary(markdownPath, markdown, { maxKeys: 8 }),
      fc.dictionary(jsonPath, json, { maxKeys: 3 }),
    )
    .map(([a, b]) => ({ ...a, ...b }));

  it('finds no mismatch, and every inventory id resolves', () => {
    fc.assert(
      fc.property(files, fc.boolean(), (generated, git) => {
        const checked = checkSnapshot(snapshotFrom(generated, { paths: git ? ['.git/HEAD'] : [] }));
        expect(brief(checked.report.mismatches)).toEqual([]);
        expectInventoryIdsResolve(checked);
      }),
      { numRuns: 150 },
    );
  });
});

describe('allowances', () => {
  it('skip-without-rule: a CLAUDE.md over 4 MiB has no rule that reports it', () => {
    const snapshot: Snapshot = {
      ...snapshotFrom({ 'AGENTS.md': 'Rules.\n' }, { paths: ['.git/HEAD', 'CLAUDE.md'] }),
      skipped: [{ path: 'CLAUDE.md', reason: 'too-large', size: 5 * 1024 * 1024 }],
    };
    const allowed = checkSnapshot(snapshot);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed['skip-without-rule']).toBeGreaterThan(0);
    expect(brief(checkSnapshot(snapshot, ['skip-without-rule']).report.mismatches)).toEqual([
      'skip-without-rule - claude-code CLAUDE.md',
    ]);
  });

  it('skip-without-rule: custom agent files of agents other than Claude Code, which no rule judges', () => {
    const files = {
      // No description: Claude Code skips it, which instr/subagent-invalid reports, and so does
      // the Copilot CLI, which no rule judges. Gemini CLI needs a lowercase name.
      '.claude/agents/helper.md': '---\nname: helper\n---\nBody.\n',
      '.gemini/agents/Bad.md': '---\nname: Bad\ndescription: Upper case.\n---\nBody.\n',
      '.codex/agents/broken.toml': 'name = [\n',
    };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed['skip-without-rule']).toBeGreaterThan(0);
    expect(brief(check(files, {}, ['skip-without-rule']).report.mismatches).sort()).toEqual([
      'skip-without-rule - codex .codex/agents/broken.toml',
      'skip-without-rule - copilot-cli .claude/agents/helper.md',
      'skip-without-rule - gemini .gemini/agents/Bad.md',
    ]);
  });

  it('skip-without-rule: an AGENTS.md copied into CLAUDE.md, which the rule leaves alone', () => {
    const files = { 'CLAUDE.md': 'Same rules.\n', 'AGENTS.md': 'Same rules.\n' };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    const claude = allowed.plans.find((plan) => plan.agent === 'claude-code');
    expect(claude?.skipped.map((s) => [s.path, s.code, s.ruleId])).toEqual([
      ['AGENTS.md', 'shadowed-by-claude-md', undefined],
    ]);
    expect(brief(check(files, {}, ['skip-without-rule']).report.mismatches)).toEqual([
      'skip-without-rule - claude-code AGENTS.md',
    ]);
  });

  it('skip-without-rule: imports the rules do not judge', () => {
    // A chain through a file agentcheckup did not read (README.md may import more).
    const name = (i: number): string => `d${String(i)}.instructions.md`;
    const files: Record<string, string> = { 'CLAUDE.md': `@README.md\n@${name(1)}\n` };
    for (let i = 1; i <= 5; i++) files[name(i)] = `@${name(i + 1)}\n`;
    files[name(6)] = 'End.\n';
    const deep = check(files, { paths: ['README.md'] });
    expect(deep.report.mismatches).toEqual([]);
    expect(deep.report.allowed['skip-without-rule']).toBe(1);

    // A session started in a template folder: its imports resolve where it is copied to.
    const template = snapshotFrom(
      { 'templates/app/CLAUDE.md': '@docs/missing.md\n@../../../x.md\n' },
      { paths: ['.git/HEAD'] },
    );
    const analysis = analyze(template, { targets: PLATFORM_IDS });
    const { findings } = runRules(analysis, { rules: builtinRules, trustDirectives: false });
    const plans = loadPlans(analysis, {
      agents: ['claude-code'],
      cwd: 'templates/app',
      config: analysis.config,
    });
    expect(plans[0]?.skipped.map((s) => [s.code, s.ruleId])).toEqual([
      ['import-outside-root', undefined],
      ['import-unresolved', undefined],
    ]);
    const input = { findings, plans, view: analysis };
    expect(checkConsistency(input).mismatches).toEqual([]);
    expect(
      checkConsistency(input, { without: ['skip-without-rule'] }).mismatches.map((m) => m.code),
    ).toEqual(['import-outside-root', 'import-unresolved']);
  });

  it('cites hooks/unknown-event for a Devin Local hook under an event it does not fire', () => {
    const checked = check({
      'AGENTS.md': 'Rules.\n',
      '.devin/hooks.v1.json':
        '{"BeforeCommit":[{"hooks":[{"type":"command","command":"./x.sh"}]}],"stop":[]}',
      '.devin/config.json':
        '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"./s.sh"}]}]}}',
    });
    expect(checked.report.mismatches).toEqual([]);
    expect(checked.report.allowed['skip-without-rule']).toBeUndefined();
    const devin = checked.plans.find((plan) => plan.agent === 'windsurf');
    // An event without hooks is skipped too; one in another letter case is unverified.
    expect(devin?.skipped.map((s) => [s.path, s.name, s.ruleId, s.certainty])).toEqual([
      ['.devin/hooks.v1.json', 'BeforeCommit', 'hooks/unknown-event', 'documented'],
      ['.devin/hooks.v1.json', 'stop', 'hooks/unknown-event', 'unverified'],
    ]);
    expect(
      checked.result.findings
        .filter((f) => f.ruleId === 'hooks/unknown-event')
        .map((f) => [f.path, f.severity, f.platforms]),
    ).toEqual([
      ['.devin/hooks.v1.json', 'error', ['windsurf']],
      ['.devin/hooks.v1.json', 'info', ['windsurf']],
    ]);
  });

  it(`${ALLOWANCES.relatedCap}: instr/codex-size-budget lists at most 20 related files`, () => {
    const depth = 25;
    const files: Record<string, string> = { 'AGENTS.md': `${'x'.repeat(40_000)}\n` };
    let directory = '';
    for (let i = 0; i < depth; i++) {
      directory = `${directory}d${String(i)}/`;
      files[`${directory}AGENTS.md`] = 'Nested.\n';
    }
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.relatedCap]).toBeGreaterThan(0);
    const strict = check(files, {}, [ALLOWANCES.relatedCap]).report.mismatches;
    expect(strict.length).toBeGreaterThan(0);
    expect(new Set(strict.map((m) => `${m.kind} ${m.ruleId} ${m.code ?? ''}`))).toEqual(
      new Set(['skip-without-finding instr/codex-size-budget over-byte-budget']),
    );
  });

  it(`${ALLOWANCES.bomOnlyAgentsMd}: Codex reads an AGENTS.md that holds only a BOM`, () => {
    const files = { 'AGENTS.md': new Uint8Array([0xef, 0xbb, 0xbf]) };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.bomOnlyAgentsMd]).toBe(1);
    const codex = allowed.plans.find((plan) => plan.agent === 'codex' && plan.cwd === '');
    expect(codex?.entries.map((e) => e.path)).toEqual(['AGENTS.md']);
    expect(brief(check(files, {}, [ALLOWANCES.bomOnlyAgentsMd]).report.mismatches)).toEqual([
      'finding-without-skip instr/empty-file codex AGENTS.md',
    ]);
  });

  it(`${ALLOWANCES.firstSkipReason}: Codex stops at the first reason it skips a skill`, () => {
    // No description (checked first) and a name that is not text: two rules, one skip.
    const files = {
      'AGENTS.md': 'Rules.\n',
      '.agents/skills/s/SKILL.md': '---\nname: [a, b]\n---\n',
    };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.firstSkipReason]).toBe(1);
    const codex = allowed.plans.find((plan) => plan.agent === 'codex' && plan.cwd === '');
    expect(codex?.skipped.map((s) => [s.code, s.ruleId])).toEqual([
      ['no-description', 'skill/description-missing'],
    ]);
    expect(brief(check(files, {}, [ALLOWANCES.firstSkipReason]).report.mismatches)).toEqual([
      'finding-without-skip skill/name-format codex .agents/skills/s/SKILL.md',
    ]);
  });

  it(`${ALLOWANCES.excludeAgentValue}: an undocumented excludeAgent beside a valid applyTo`, () => {
    const path = '.github/instructions/ts.instructions.md';
    const files = { [path]: '---\napplyTo: "**/*.ts"\nexcludeAgent: "nobody"\n---\nStrict.\n' };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.excludeAgentValue]).toBe(1);
    const applyTo = allowed.result.findings.filter((f) => f.ruleId === 'copilot/apply-to');
    expect(applyTo.map((f) => f.severity)).toEqual(['warn']);
    const cloud = allowed.plans.find((plan) => plan.agent === 'copilot-cloud');
    expect(cloud?.entries.map((e) => `${e.path} ${e.trigger}`)).toEqual([`${path} on-path`]);
    expect(brief(check(files, {}, [ALLOWANCES.excludeAgentValue]).report.mismatches)).toEqual([
      `finding-without-skip copilot/apply-to copilot-cloud ${path}`,
    ]);
  });

  it(`${ALLOWANCES.firstSkipReason}: the cloud agent skips a misplaced file before reading applyTo`, () => {
    // Misplaced (copilot/instructions-misplaced) and without applyTo (copilot/apply-to).
    const files = { '.github/prompts/x.instructions.md': 'No frontmatter.\n' };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.firstSkipReason]).toBe(1);
    expect(brief(check(files, {}, [ALLOWANCES.firstSkipReason]).report.mismatches)).toEqual([
      'finding-without-skip copilot/apply-to copilot-cloud .github/prompts/x.instructions.md',
    ]);
  });

  it(`${ALLOWANCES.installedSkill}: a skill outside every skills directory loads once installed`, () => {
    const files = { 'AGENTS.md': 'Rules.\n', 'collection/z/SKILL.md': 'No frontmatter.\n' };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.installedSkill]).toBeGreaterThan(0);
    expect(brief(check(files, {}, [ALLOWANCES.installedSkill]).report.mismatches)).toEqual([
      'finding-not-planned skill/frontmatter-missing codex collection/z/SKILL.md',
      'finding-not-planned skill/frontmatter-missing gemini collection/z/SKILL.md',
    ]);
  });
});

describe('what the check reports', () => {
  const plan = (overrides: Partial<LoadPlan>): LoadPlan => ({
    agent: 'codex',
    cwd: '',
    entries: [],
    skipped: [],
    outOfScope: [],
    assumptions: [],
    hidden: [],
    limits: [],
    totals: {
      startup: { bytes: 0, chars: 0, tokens: 0 },
      onDemand: { bytes: 0, chars: 0, tokens: 0 },
    },
    incomplete: [],
    ...overrides,
  });
  const view = { index: new Map() };
  const skip = {
    id: 'instructions:AGENTS.md',
    role: 'instructions',
    path: 'AGENTS.md',
    certainty: 'documented',
    evidence: [],
  } as const;
  const { findings } = check({ 'AGENTS.md': '' }).result;

  it('a skip whose rule has no finding, and one the table does not map', () => {
    const report = checkConsistency({
      findings: [],
      view,
      plans: [
        plan({
          skipped: [
            { ...skip, code: 'blank-file', ruleId: 'instr/empty-file' },
            { ...skip, path: 'b.md', id: 'instructions:b.md', code: 'bom', ruleId: 'x/y' },
            { ...skip, path: 'c.md', id: 'instructions:c.md', code: 'case-mismatch' },
          ],
        }),
      ],
    });
    expect(brief(report.mismatches)).toEqual([
      'skip-without-rule - codex c.md',
      'skip-without-finding instr/empty-file codex AGENTS.md',
      'unmapped-skip x/y codex b.md',
    ]);
  });

  it('a finding without its skip, without any plan, and a loading rule in neither table', () => {
    const empty = findings.filter((f) => f.ruleId === 'instr/empty-file');
    expect(empty.length).toBe(1);
    const loaded = plan({
      entries: [
        {
          id: 'instructions:AGENTS.md',
          role: 'instructions',
          trigger: 'startup',
          path: 'AGENTS.md',
          realPath: 'AGENTS.md',
          certainty: 'documented',
          evidence: [],
        },
      ],
    });
    expect(brief(checkConsistency({ findings: empty, view, plans: [loaded] }).mismatches)).toEqual([
      'finding-without-skip instr/empty-file codex AGENTS.md',
    ]);
    expect(
      brief(checkConsistency({ findings: empty, view, plans: [plan({})] }).mismatches),
    ).toEqual(['finding-not-planned instr/empty-file codex AGENTS.md']);
    const unknown = { ...empty[0]!, ruleId: 'x/loading', platforms: ['codex' as const] };
    expect(
      brief(checkConsistency({ findings: [unknown], view, plans: [plan({})] }).mismatches),
    ).toEqual(['unmapped-finding x/loading codex AGENTS.md']);
    // Suppressed findings and agents without a plan are not checked.
    const suppressed = { ...empty[0]!, suppressed: { kind: 'inline' as const, reason: 'x' } };
    expect(
      checkConsistency({ findings: [suppressed], view, plans: [plan({})] }).mismatches,
    ).toEqual([]);
  });

  it('a skip without a rule id where the rule does report the file', () => {
    const shadowed = check({ 'CLAUDE.md': 'Claude.\n', 'AGENTS.md': 'Agents.\n' });
    const claude = shadowed.plans.find((p) => p.agent === 'claude-code')!;
    const without = {
      ...claude,
      skipped: claude.skipped.map(({ ruleId: _ruleId, ...rest }) => rest),
    };
    expect(
      brief(
        checkConsistency({
          findings: shadowed.result.findings,
          view: shadowed.analysis,
          plans: [without],
        }).mismatches,
      ),
    ).toEqual([
      'finding-without-skip instr/agents-md-ignored-by-claude claude-code AGENTS.md',
      'rule-not-cited instr/agents-md-ignored-by-claude claude-code AGENTS.md',
    ]);
  });
});

describe('agents that share a platform, severities and skips no rule reports', () => {
  const zero = { bytes: 0, chars: 0, tokens: 0 };
  const plan = (agent: ContextAgent, overrides: Partial<LoadPlan> = {}): LoadPlan => ({
    agent,
    cwd: '',
    entries: [],
    skipped: [],
    outOfScope: [],
    assumptions: [],
    hidden: [],
    limits: [],
    totals: { startup: zero, onDemand: zero },
    incomplete: [],
    ...overrides,
  });
  const skipOf = (path: string, code: SkipCode, ruleId?: string) => ({
    id: `instructions:${path}`,
    role: 'instructions' as const,
    path,
    code,
    ...(ruleId === undefined ? {} : { ruleId }),
    certainty: 'documented' as const,
    evidence: [],
  });
  const entryOf = (path: string) => ({
    id: `instructions:${path}`,
    role: 'instructions' as const,
    trigger: 'startup' as const,
    path,
    realPath: path,
    certainty: 'documented' as const,
    evidence: [],
  });
  const view = { index: new Map() };

  it('matches a Copilot finding with a skip in the plan of any Copilot surface', () => {
    const path = '.github/prompts/copilot-instructions.md';
    const { findings } = check({ [path]: 'Use strict mode.\n' }).result;
    const misplaced = findings.filter((f) => f.ruleId === 'copilot/instructions-misplaced');
    expect(misplaced.map((f) => f.platforms)).toEqual([['copilot']]);
    const cli = plan('copilot-cli', {
      skipped: [skipOf(path, 'wrong-location', 'copilot/instructions-misplaced')],
    });
    const others = [plan('copilot-vscode'), plan('copilot-cloud')];
    expect(checkConsistency({ findings, view, plans: [cli, ...others] }).mismatches).toEqual([]);
    // No surface skips it: the group has no plan that mentions the file.
    expect(brief(checkConsistency({ findings, view, plans: others }).mismatches)).toEqual([
      `finding-not-planned copilot/instructions-misplaced copilot-vscode ${path}`,
    ]);
    // A surface loads it and none skips it.
    const loaded = plan('copilot-vscode', { entries: [entryOf(path)] });
    expect(brief(checkConsistency({ findings, view, plans: [loaded] }).mismatches)).toEqual([
      `finding-without-skip copilot/instructions-misplaced copilot-vscode ${path}`,
    ]);
    // Each skip still needs a finding of its rule on its file.
    expect(brief(checkConsistency({ findings: [], view, plans: [cli] }).mismatches)).toEqual([
      `skip-without-finding copilot/instructions-misplaced copilot-cli ${path}`,
    ]);
  });

  it('takes only copilot/apply-to findings of warn or error as the cloud agent skipping a file', () => {
    const path = '.github/instructions/ts.instructions.md';
    const findingsOf = (text: string) =>
      check({ [path]: text }).result.findings.filter((f) => f.ruleId === 'copilot/apply-to');
    const described = findingsOf('---\ndescription: TypeScript\n---\nUse strict mode.\n');
    const missing = findingsOf('Use strict mode.\n');
    expect(described.map((f) => f.severity)).toEqual(['info']);
    expect(missing.map((f) => f.severity)).toEqual(['warn']);
    const vscode = plan('copilot-vscode', { entries: [entryOf(path)] });
    const cloud = plan('copilot-cloud', {
      skipped: [skipOf(path, 'no-apply-to', 'copilot/apply-to')],
    });
    // VS Code loads a description-only file; the info finding needs no skip, but matches one.
    expect(checkConsistency({ findings: described, view, plans: [vscode] }).mismatches).toEqual([]);
    expect(
      checkConsistency({ findings: described, view, plans: [vscode, cloud] }).mismatches,
    ).toEqual([]);
    // A warning means the cloud agent skips the file; a cloud plan that loads it disagrees.
    const loadedInCloud = plan('copilot-cloud', { entries: [entryOf(path)] });
    expect(
      checkConsistency({ findings: missing, view, plans: [vscode, cloud] }).mismatches,
    ).toEqual([]);
    expect(
      brief(
        checkConsistency({ findings: missing, view, plans: [vscode, loadedInCloud] }).mismatches,
      ),
    ).toEqual([`finding-without-skip copilot/apply-to copilot-cloud ${path}`]);
  });

  it('takes only Claude Code import-depth findings of warn or error as a skip: a cycle loads nothing new', () => {
    const cycle = check({ 'CLAUDE.md': '@a.md\n', 'a.md': '@CLAUDE.md\n' }, { imported: ['a.md'] });
    const depth = cycle.result.findings.filter((f) => f.ruleId === 'instr/import-depth');
    expect(depth.map((f) => `${f.severity} ${f.path} ${f.platforms.join()}`)).toEqual([
      'info a.md claude-code',
    ]);
    expect(cycle.report.mismatches).toEqual([]);
    const claude = cycle.plans.find((p) => p.agent === 'claude-code' && p.cwd === '');
    expect(claude?.entries.map((e) => e.path)).toEqual(['CLAUDE.md', 'a.md']);
    expect(claude?.skipped).toEqual([]);

    // Five hops: an error, and Claude Code skips the fifth file.
    const name = (i: number): string => `d${String(i)}.md`;
    const files: Record<string, string> = { 'CLAUDE.md': `@${name(1)}\n` };
    for (let i = 1; i <= 4; i++) files[name(i)] = `@${name(i + 1)}\n`;
    files[name(5)] = 'End.\n';
    const deep = check(files, { imported: Object.keys(files).slice(1) });
    expect(
      deep.result.findings
        .filter((f) => f.ruleId === 'instr/import-depth')
        .map((f) => `${f.severity} ${f.path}`),
    ).toEqual(['error d4.md']);
    expect(deep.report.mismatches).toEqual([]);
    expect(
      deep.plans
        .find((p) => p.agent === 'claude-code' && p.cwd === '')
        ?.skipped.map((s) => `${s.path} ${s.code} ${s.ruleId ?? '-'}`),
    ).toEqual(['d4.md import-too-deep instr/import-depth']);
  });

  it('accepts skips that no rule reports: disabled, shadowed-by-preferred, never-active', () => {
    const plans = [
      plan('windsurf', {
        skipped: [
          skipOf('.cursor/rules/a.mdc', 'disabled'),
          skipOf('.windsurf/global_rules.md', 'shadowed-by-preferred'),
        ],
      }),
      plan('cline', { skipped: [skipOf('.clinerules/never.md', 'never-active')] }),
    ];
    const report = checkConsistency({ findings: [], view, plans });
    expect(report).toEqual({ mismatches: [], allowed: {} });
    // Any other code needs its rule.
    expect(
      brief(
        checkConsistency({
          findings: [],
          view,
          plans: [plan('cline', { skipped: [skipOf('.clinerules/old.md', 'case-mismatch')] })],
        }).mismatches,
      ),
    ).toEqual(['skip-without-rule - cline .clinerules/old.md']);
  });

  it('skip-without-rule: Gemini CLI imports in a template folder, which the rules leave alone', () => {
    const path = 'templates/app/GEMINI.md';
    const skipped = [
      { ...skipOf(path, 'import-unresolved'), id: 'import:templates/app/docs/x.md' },
      { ...skipOf(path, 'import-outside-root'), id: 'import:x.md' },
    ];
    const gemini = plan('gemini', { cwd: 'templates/app', skipped });
    const allowed = checkConsistency({ findings: [], view, plans: [gemini] });
    expect(allowed.mismatches).toEqual([]);
    expect(allowed.allowed['skip-without-rule']).toBe(2);
    expect(
      checkConsistency(
        { findings: [], view, plans: [gemini] },
        { without: ['skip-without-rule'] },
      ).mismatches.map((m) => `${m.kind} ${m.agent} ${m.code ?? ''}`),
    ).toEqual([
      'skip-without-rule gemini import-outside-root',
      'skip-without-rule gemini import-unresolved',
    ]);
    // Where the rule does judge the file, the skip must cite it.
    const { findings } = check({ 'GEMINI.md': '@missing.md\n' }).result;
    const unresolved = findings.filter((f) => f.ruleId === 'instr/import-unresolved');
    expect(unresolved.map((f) => f.platforms)).toEqual([['gemini']]);
    const root = plan('gemini', { skipped: [skipOf('GEMINI.md', 'import-unresolved')] });
    expect(
      brief(checkConsistency({ findings: unresolved, view, plans: [root] }).mismatches),
    ).toEqual([
      'finding-without-skip instr/import-unresolved gemini GEMINI.md',
      'rule-not-cited instr/import-unresolved gemini GEMINI.md',
    ]);
  });
});
