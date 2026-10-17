/**
 * Assembly of plans into a context report (src/platforms/load/index.ts) and the file-by-agent
 * matrix (src/platforms/load/matrix.ts).
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../src/core/config.js';
import { analyze, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS } from '../../../src/core/types.js';
import {
  buildContextReport,
  citedSourceKeys,
  contextAgentsOf,
  isContextAgent,
  loadPlan,
  loadPlans,
  orderedAgents,
  sortedPlan,
  sourcesOf,
  withoutIgnored,
} from '../../../src/platforms/load/index.js';
import {
  buildMatrix,
  codexStartDirectories,
  matrixPlans,
} from '../../../src/platforms/load/matrix.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_AGENTS,
  LOADER_ENABLED,
  type LoadPlan,
} from '../../../src/platforms/load/types.js';
import { SOURCES } from '../../../src/platforms/sources.js';
import { builtinRules } from '../../../src/rules/index.js';
import { entry, plan, size } from '../../helpers/context.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

function analysisOf(files: FileMap, extras: SnapshotExtras = {}) {
  const analysis = analyze(
    snapshotFrom(files, { ...extras, paths: ['.git/HEAD', ...(extras.paths ?? [])] }),
    { targets: PLATFORM_IDS },
  );
  runRules(analysis, { rules: builtinRules, trustDirectives: false });
  return analysis;
}

/** `path cell cell cell` for each row, cells in CONTEXT_AGENTS order. */
function matrixOf(files: FileMap, extras: SnapshotExtras = {}): string[] {
  const analysis = analysisOf(files, extras);
  const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
  return buildMatrix(analysis, plans, CONTEXT_AGENTS).rows.map((row) =>
    [row.path, row.kind, ...row.cells].join(' '),
  );
}

describe('loadPlans', () => {
  const analysis = analysisOf({ 'AGENTS.md': 'Rules.\n', 'pkg/AGENTS.md': 'Pkg.\n' });

  it('plans each agent once, in PLATFORM_IDS order', () => {
    const plans = loadPlans(analysis, {
      agents: ['cursor', 'claude-code', 'cursor'],
      cwd: 'pkg',
      config: analysis.config,
    });
    expect(plans.map((p) => `${p.agent}@${p.cwd}`)).toEqual(['claude-code@pkg', 'cursor@pkg']);
    expect(loadPlan(analysis, 'codex', { cwd: '', config: analysis.config }).agent).toBe('codex');
  });

  it('rejects unmodeled agents, bad working directories and context windows', () => {
    const base = { config: analysis.config, cwd: '', agents: ['codex'] } as const;
    expect(() => loadPlans(analysis, { ...base, agents: ['gemini'] })).toThrow(
      'No load model for "gemini".',
    );
    expect(() => loadPlans(analysis, { ...base, cwd: './pkg' })).toThrow('normalized');
    expect(() => loadPlans(analysis, { ...base, contextWindow: -1 })).toThrow('positive');
    expect(orderedAgents(['cursor', 'codex'])).toEqual(['codex', 'cursor']);
    expect(contextAgentsOf(['gemini', 'cursor', 'claude-code'])).toEqual(['claude-code', 'cursor']);
  });

  it('plans no agent that is turned off, whether named or targeted', () => {
    const off = ALL_CONTEXT_AGENTS.filter((agent) => !LOADER_ENABLED[agent]);
    expect(off).toEqual(['copilot-cli', 'copilot-vscode', 'copilot-cloud', 'gemini', 'windsurf']);
    for (const agent of off) {
      expect(isContextAgent(agent)).toBe(false);
      expect(() => orderedAgents([agent])).toThrow(`No load model for "${agent}".`);
      expect(() =>
        loadPlans(analysis, { agents: [agent], cwd: '', config: analysis.config }),
      ).toThrow('No load model');
    }
    expect(contextAgentsOf(['copilot', 'gemini', 'windsurf'])).toEqual([]);
    expect(contextAgentsOf(PLATFORM_IDS)).toEqual(['claude-code', 'codex', 'cursor', 'cline']);
    expect(isContextAgent('copilot')).toBe(false);
    expect(isContextAgent('codex')).toBe(true);
  });
});

describe('buildContextReport', () => {
  const cursor = plan('cursor', {
    entries: [
      entry('rule', 'b.mdc', { trigger: 'manual', evidence: ['cursorRules'] }),
      entry('instructions', 'AGENTS.md', { position: 1, size: size(8), evidence: ['cursorRules'] }),
      entry('rule', 'a.mdc', { trigger: 'unknown', certainty: 'unverified', evidence: [] }),
    ],
    assumptions: [
      { key: 'z', value: 1, origin: 'default', evidence: ['cursorHooks'] },
      { key: 'a', value: 2, origin: 'default', evidence: [] },
    ],
  });
  const codex = plan('codex', { cwd: 'pkg' });
  const codexRoot = plan('codex', { cwd: '' });

  it('orders agents, plans and entries, and lists exactly the cited sources', () => {
    const report = buildContextReport({
      agents: ['cursor', 'codex'],
      plans: [cursor, codex, codexRoot],
    });
    expect(report.agents).toEqual(['codex', 'cursor']);
    expect(report.plans.map((p) => `${p.agent}@${p.cwd}`)).toEqual([
      'codex@',
      'codex@pkg',
      'cursor@',
    ]);
    expect(report.plans[2]?.entries.map((e) => e.id)).toEqual([
      'instructions:AGENTS.md',
      'rule:b.mdc',
      'rule:a.mdc',
    ]);
    expect(report.plans[2]?.assumptions.map((a) => a.key)).toEqual(['a', 'z']);
    expect(Object.keys(report.sources)).toEqual(['cursorHooks', 'cursorRules']);
    expect(report.sources['cursorRules']).toEqual(SOURCES.cursorRules);
    expect(report.matrix).toBeUndefined();
  });

  it('sorts matrix rows by path and refuses evidence that is not a known source', () => {
    const report = buildContextReport({
      agents: ['cursor'],
      plans: [],
      matrix: {
        rows: [
          { path: 'b', kind: 'agents-md', cells: ['startup'] },
          { path: 'a', kind: 'agents-md', cells: ['manual'] },
        ],
      },
    });
    expect(report.matrix?.rows.map((row) => row.path)).toEqual(['a', 'b']);
    const bad: LoadPlan = { ...cursor, limits: [{ ...limitOf(), evidence: ['nope'] }] };
    expect(citedSourceKeys([bad])).toContain('nope');
    expect(() => sourcesOf(['nope'])).toThrow('"nope", which is not a known source');
    expect(sortedPlan(bad).limits).toHaveLength(1);
  });
});

function limitOf(): LoadPlan['limits'][number] {
  return {
    key: 'k',
    unit: 'bytes',
    limit: 1,
    used: 2,
    subject: 's',
    effect: 'advice',
    evidence: [],
  };
}

describe('matrix', () => {
  it('lists Codex start directories by exact name, through aliases too', () => {
    const analysis = analysisOf(
      {
        'AGENTS.md': 'Root.\n',
        'a/AGENTS.override.md': 'A.\n',
        'b/agents.md': 'Case.\n',
        'c/AGENTS.md': 'Real.\n',
        'd/AGENTS.md': 'Real.\n',
      },
      { symlinks: { 'd/AGENTS.md': 'c/AGENTS.md' } },
    );
    expect(codexStartDirectories(analysis)).toEqual(['a', 'c', 'd']);
  });

  it('shows each trigger, cut, skip and start directory', () => {
    expect(
      matrixOf({
        'AGENTS.md': `${'x'.repeat(30_000)}\n`,
        'pkg/AGENTS.md': `${'y'.repeat(5_000)}\n`,
        'CLAUDE.md': 'Claude.\n',
        'pkg/CLAUDE.md': 'Nested.\n',
        '.claude/rules/api.md': '---\npaths: src/**\n---\nAPI.\n',
        '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship.\n---\nSteps.\n',
        '.agents/skills/notes/SKILL.md': 'No frontmatter.\n',
        '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nA.\n',
        '.cursor/rules/picked.mdc': '---\ndescription: When asked.\n---\nP.\n',
        '.cursor/rules/manual.mdc': 'M.\n',
        '.cursor/rules/broken.mdc': '---\nglobs: *.ts\n---\nB.\n',
        '.cursor/rules/style.md': 'Tabs.\n',
        '.mcp.json': '{"mcpServers":{"docs":{"url":"https://x"}}}',
        'other/.mcp.json': '{"mcpServers":{"a":{"command":"a"}}}',
        'README.md': 'Not configuration.\n',
      }),
    ).toEqual([
      '.agents/skills/notes skill not-read skipped listed listed',
      '.claude/rules/api.md claude-rule on-path not-read not-read not-read',
      '.claude/skills/deploy skill listed not-read listed listed',
      '.cursor/rules/always.mdc cursor-rule not-read not-read startup not-read',
      '.cursor/rules/broken.mdc cursor-rule not-read not-read unknown not-read',
      '.cursor/rules/manual.mdc cursor-rule not-read not-read manual not-read',
      '.cursor/rules/picked.mdc cursor-rule not-read not-read model-selected not-read',
      '.cursor/rules/style.md cursor-rule-md not-read not-read skipped not-read',
      '.mcp.json mcp-json skipped not-read not-read not-read',
      'AGENTS.md agents-md skipped startup startup startup',
      'CLAUDE.md claude-md startup not-read startup not-read',
      'other/.mcp.json mcp-json start-dir not-read not-read not-read',
      'pkg/AGENTS.md agents-md skipped partial on-path not-read',
      'pkg/CLAUDE.md claude-md on-path not-read start-dir not-read',
    ]);
  });

  it('keeps a file that one agent loads while skipping some of its items', () => {
    expect(
      matrixOf({ '.mcp.json': '{"mcpServers":{"docs":{"url":"https://x"},"a":{"command":"a"}}}' }),
    ).toEqual(['.mcp.json mcp-json startup not-read not-read not-read']);
  });

  it('marks a file a plan could not analyze as unknown', () => {
    // Listed but not read: Cursor's plan says so; the other plans do not reach it.
    expect(matrixOf({ 'AGENTS.md': 'Root.\n' }, { paths: ['a/AGENTS.md'] })).toEqual([
      'AGENTS.md agents-md startup startup startup startup',
      'a/AGENTS.md agents-md not-read not-read unknown not-read',
    ]);
  });

  it('leaves out files no modeled agent reads, and columns of unplanned agents', () => {
    const analysis = analysisOf({ 'GEMINI.md': 'Gemini.\n', 'AGENTS.md': 'A.\n' });
    const plans = matrixPlans(analysis, { agents: ['codex'], config: analysis.config });
    expect(buildMatrix(analysis, plans, ['codex']).rows).toEqual([
      { path: 'AGENTS.md', kind: 'agents-md', cells: ['startup'] },
    ]);
    // A plan of an agent that is not a column adds no row.
    const cursor = loadPlans(analysis, { agents: ['cursor'], cwd: '', config: analysis.config });
    expect(buildMatrix(analysis, [...plans, ...cursor], ['codex']).rows).toHaveLength(1);
  });
});

describe('paths the configuration ignores', () => {
  const FILES: FileMap = {
    'AGENTS.md': 'Rules.\n',
    'CLAUDE.md': '# Claude\n\n@fixtures/guide.md\n\n@docs/setup.md\n',
    'docs/setup.md': 'Setup.\n',
    '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nStyle.\n',
    'fixtures/guide.md': 'Guide.\n',
    'fixtures/repo/AGENTS.md': 'Fixture.\n',
    'fixtures/repo/CLAUDE.md': 'Fixture.\n',
    'fixtures/repo/.cursor/rules/x.md': '# x\n',
    'fixtures/repo/.agents/skills/s/SKILL.md': '---\nname: s\ndescription: Does s.\n---\nBody.\n',
  };

  /** As a scan with `agentcheckup.config.json` (`ignore`) or with `--untrusted` (none). */
  function scan(ignore: readonly string[] | undefined) {
    const analysis = analyze(snapshotFrom(FILES, { paths: ['.git/HEAD'] }), {
      targets: PLATFORM_IDS,
      ...(ignore === undefined ? {} : { config: resolveConfig({ ignore }) }),
    });
    const { findings } = runRules(analysis, { rules: builtinRules, trustDirectives: false });
    const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
    return { findings, plans, matrix: buildMatrix(analysis, plans, CONTEXT_AGENTS) };
  }

  /** Every path a plan mentions. */
  function pathsOf(plan: LoadPlan): string[] {
    return [
      ...plan.entries.map((item) => item.path),
      ...plan.skipped.map((item) => item.path),
      ...plan.outOfScope.map((item) => item.path),
      ...plan.limits.map((item) => item.subject),
      ...plan.incomplete.map((item) => item.slice(item.indexOf(':') + 1)),
    ];
  }

  it('leaves them out of every plan and the matrix, and counts them per plan', () => {
    const { plans, matrix, findings } = scan(['fixtures/**']);
    for (const item of plans) {
      expect(pathsOf(item).filter((path) => path.startsWith('fixtures/'))).toEqual([]);
    }
    expect(matrix.rows.map((row) => row.path)).toEqual([
      '.cursor/rules/style.mdc',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    // What each plan would have listed as unread: Claude Code the import of fixtures/guide.md
    // (it leaves files in a fixtures folder to their own sessions), Cursor the nested files it
    // reads from anywhere in the workspace. Codex at the root does not reach them.
    expect(plans.map((item) => `${item.agent} ${String(item.ignored)}`)).toEqual([
      'claude-code 1',
      'codex undefined',
      'cursor 2',
      'cline undefined',
    ]);
    // The rules never saw them either.
    expect(findings.filter((finding) => finding.path.startsWith('fixtures/'))).toEqual([]);
  });

  it('numbers the session start again without the ignored import', () => {
    const claude = scan(['fixtures/**']).plans.find((plan) => plan.agent === 'claude-code');
    expect(
      claude?.entries
        .filter((entry) => entry.position !== undefined)
        .map((entry) => `${String(entry.position)} ${entry.path}`),
    ).toEqual(['1 CLAUDE.md', '2 docs/setup.md']);
  });

  it('lists them without a configuration, as with --untrusted', () => {
    const { plans, matrix } = scan(undefined);
    expect(plans.every((plan) => plan.ignored === undefined)).toBe(true);
    expect(matrix.rows.map((row) => row.path)).toContain('fixtures/repo/AGENTS.md');
    const claude = plans.find((plan) => plan.agent === 'claude-code');
    expect(claude && pathsOf(claude)).toContain('fixtures/guide.md');
  });

  it('keeps a plan that ignores nothing as it is', () => {
    const original = plan('cursor', {
      entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
      incomplete: ['unread:pkg/'],
    });
    expect(withoutIgnored(original, resolveConfig({ ignore: ['fixtures/**'] }))).toBe(original);
  });

  it('filters each list by its own path, including directories and limit subjects', () => {
    const config = resolveConfig({ ignore: ['vendor/**'] });
    const original = plan('claude-code', {
      entries: [
        entry('instructions', 'CLAUDE.md', { position: 1, size: size(10) }),
        entry('import', 'vendor/a.md', { position: 2 }),
        entry('import', 'docs/b.md', { position: 3, size: size(4) }),
        entry('rule', 'vendor/rules/r.md', { trigger: 'on-path' }),
      ],
      skipped: [
        {
          id: 'instructions:vendor/AGENTS.md',
          role: 'instructions',
          path: 'vendor/AGENTS.md',
          code: 'shadowed-by-claude-md',
          certainty: 'documented',
          evidence: [],
        },
      ],
      outOfScope: [{ path: 'vendor/x/CLAUDE.md', because: 'below-start-dir' }],
      limits: [
        {
          key: 'claude-code.import_max_hops',
          unit: 'hops',
          limit: 4,
          used: 1,
          subject: 'vendor/a.md',
          effect: 'skips',
          evidence: [],
        },
      ],
      incomplete: ['unread:vendor/a.md', 'unread:vendor/deep/', 'unread:docs/c.md'],
    });
    const filtered = withoutIgnored(original, config);
    expect(filtered.entries.map((item) => `${String(item.position)} ${item.path}`)).toEqual([
      '1 CLAUDE.md',
      '2 docs/b.md',
    ]);
    expect(filtered.skipped).toEqual([]);
    expect(filtered.outOfScope).toEqual([]);
    expect(filtered.limits).toEqual([]);
    expect(filtered.incomplete).toEqual(['unread:docs/c.md']);
    // vendor/a.md, vendor/rules/r.md, vendor/AGENTS.md, vendor/x/CLAUDE.md, vendor/deep.
    expect(filtered.ignored).toBe(5);
    // The totals stay: the loader computed them, and an unread file has no size.
    expect(filtered.totals).toBe(original.totals);
  });
});
