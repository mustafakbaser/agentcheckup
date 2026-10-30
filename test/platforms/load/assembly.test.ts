/**
 * Assembly of plans into a context report (src/platforms/load/index.ts) and the file-by-agent
 * matrix (src/platforms/load/matrix.ts).
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../src/core/config.js';
import {
  analyze,
  analyzeWithIgnored,
  runRules,
  scanWithContext,
} from '../../../src/core/engine.js';
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
  type ContextAgent,
  LOADER_ENABLED,
  type LoadPlan,
} from '../../../src/platforms/load/types.js';
import { SOURCES } from '../../../src/platforms/sources.js';
import { builtinRules } from '../../../src/rules/index.js';
import { entry, plan, size, skip } from '../../helpers/context.js';
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
    expect(() => loadPlans(analysis, { ...base, agents: ['vim' as ContextAgent] })).toThrow(
      'No load model for "vim".',
    );
    expect(() => loadPlans(analysis, { ...base, cwd: './pkg' })).toThrow('normalized');
    expect(() => loadPlans(analysis, { ...base, contextWindow: -1 })).toThrow('positive');
    expect(orderedAgents(['cursor', 'codex'])).toEqual(['codex', 'cursor']);
    expect(contextAgentsOf(['windsurf', 'cursor', 'claude-code'])).toEqual([
      'claude-code',
      'cursor',
      'windsurf',
    ]);
  });

  it('turns every agent on, and maps each platform to its agents', () => {
    expect(ALL_CONTEXT_AGENTS.filter((agent) => !LOADER_ENABLED[agent])).toEqual([]);
    for (const agent of ALL_CONTEXT_AGENTS) expect(isContextAgent(agent)).toBe(true);
    expect(isContextAgent('vim')).toBe(false);
    expect(() => orderedAgents(['vim'])).toThrow('No load model for "vim".');
    expect(contextAgentsOf(['gemini'])).toEqual(['gemini']);
    // Copilot's platform id stands for its three surfaces.
    expect(contextAgentsOf(['copilot'])).toEqual([
      'copilot-cli',
      'copilot-vscode',
      'copilot-cloud',
    ]);
    expect(contextAgentsOf(PLATFORM_IDS)).toEqual(ALL_CONTEXT_AGENTS);
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
      '.agents/skills/notes skill not-read skipped listed listed listed listed skipped listed listed',
      '.claude/rules/api.md claude-rule on-path not-read not-read on-path on-path not-read not-read not-read not-read',
      '.claude/skills/deploy skill listed not-read listed listed listed listed not-read listed listed',
      '.cursor/rules/always.mdc cursor-rule not-read not-read startup not-read not-read not-read not-read startup not-read',
      '.cursor/rules/broken.mdc cursor-rule not-read not-read unknown not-read not-read not-read not-read unknown not-read',
      '.cursor/rules/manual.mdc cursor-rule not-read not-read manual not-read not-read not-read not-read manual not-read',
      '.cursor/rules/picked.mdc cursor-rule not-read not-read model-selected not-read not-read not-read not-read model-selected not-read',
      // Devin Local reads the .md files in .cursor/rules that Cursor ignores.
      '.cursor/rules/style.md cursor-rule-md not-read not-read skipped not-read not-read not-read not-read manual not-read',
      '.mcp.json mcp-json skipped not-read not-read startup startup not-read not-read startup not-read',
      'AGENTS.md agents-md skipped startup startup startup startup startup not-read startup startup',
      'CLAUDE.md claude-md startup not-read startup startup startup startup not-read startup not-read',
      'other/.mcp.json mcp-json start-dir not-read not-read start-dir not-read not-read not-read start-dir not-read',
      'pkg/AGENTS.md agents-md skipped partial on-path on-path not-read on-path not-read on-path not-read',
      'pkg/CLAUDE.md claude-md on-path not-read start-dir on-path not-read not-read not-read on-path not-read',
    ]);
  });

  it('gives subagents no row, at the root or below it', () => {
    const rows = matrixOf({
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews.\n---\nR.\n',
      'pkg/.claude/agents/linter.md': '---\nname: linter\ndescription: Lints.\n---\nL.\n',
      'pkg/.cursor/agents/planner.md': '---\nname: planner\ndescription: Plans.\n---\nP.\n',
      'CLAUDE.md': 'Claude.\n',
    });
    expect(rows).toEqual([
      'CLAUDE.md claude-md startup not-read startup startup startup startup not-read startup not-read',
    ]);
  });

  it('gives commands no row, though the Copilot CLI lists them as skills', () => {
    const rows = matrixOf({
      '.claude/commands/review.md': '---\ndescription: Review the change.\n---\nReview.\n',
      '.claude/commands/git/commit.md': '---\ndescription: Commit.\n---\nCommit.\n',
      'pkg/.claude/commands/lint.md': '---\ndescription: Lint.\n---\nLint.\n',
      '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship.\n---\nSteps.\n',
      'CLAUDE.md': 'Claude.\n',
    });
    expect(rows).toEqual([
      // A skill next to them keeps its row.
      '.claude/skills/deploy skill listed not-read listed listed listed listed not-read listed listed',
      'CLAUDE.md claude-md startup not-read startup startup startup startup not-read startup not-read',
    ]);
  });

  it('keeps a file that one agent loads while skipping some of its items', () => {
    expect(
      matrixOf({ '.mcp.json': '{"mcpServers":{"docs":{"url":"https://x"},"a":{"command":"a"}}}' }),
    ).toEqual([
      '.mcp.json mcp-json startup not-read not-read startup startup not-read not-read startup not-read',
    ]);
  });

  it('marks a file a plan could not analyze as unknown', () => {
    // Listed but not read: Cursor's and Devin Local's plans say so; the others do not reach it.
    expect(matrixOf({ 'AGENTS.md': 'Root.\n' }, { paths: ['a/AGENTS.md'] })).toEqual([
      'AGENTS.md agents-md startup startup startup startup startup startup not-read startup startup',
      'a/AGENTS.md agents-md not-read not-read unknown unknown not-read unknown not-read unknown not-read',
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

  /**
   * As a scan with `agentcheckup.config.json` (`ignore`) or with `--untrusted` (none), with the
   * plans' count of what `ignore` leaves out as `scanWithContext` makes it.
   */
  function scan(ignore: readonly string[] | undefined) {
    const options = {
      targets: PLATFORM_IDS,
      ...(ignore === undefined ? {} : { config: resolveConfig({ ignore }) }),
    };
    const analysis = analyze(snapshotFrom(FILES, { paths: ['.git/HEAD'] }), options);
    const { findings } = runRules(analysis, { rules: builtinRules, trustDirectives: false });
    const withIgnored = analyzeWithIgnored(analysis, options);
    const plans = matrixPlans(analysis, {
      agents: CONTEXT_AGENTS,
      config: analysis.config,
      ...(withIgnored === undefined ? {} : { withIgnored }),
    });
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
    // What each agent may load of them, as its plan would show it without the configuration.
    // Claude Code: the import of fixtures/guide.md; it leaves the instruction files of a fixtures
    // folder to their own sessions. Codex at the root does not read the files below it. Cursor:
    // the nested AGENTS.md and the skill, which it reads anywhere in the workspace, and the .md
    // file in .cursor/rules, which no source says it skips. Devin Local does not load the skill
    // from the root, although its loader finds the file unread. Copilot in VS Code and Cline do
    // not read a nested AGENTS.md.
    expect(plans.map((item) => `${item.agent} ${String(item.ignored)}`)).toEqual([
      'claude-code 1',
      'codex undefined',
      'cursor 3',
      'copilot-cli 3',
      'copilot-vscode undefined',
      'copilot-cloud 1',
      'gemini undefined',
      'windsurf 3',
      'cline undefined',
    ]);
    // The rules never saw them either.
    expect(findings.filter((finding) => finding.path.startsWith('fixtures/'))).toEqual([]);
  });

  it('counts the ignored files that each plan, without the configuration, says its agent may load', () => {
    const mayLoad = (item: LoadPlan): string[] => [
      ...item.entries.map((each) => each.path),
      ...item.skipped.filter((each) => each.certainty === 'unverified').map((each) => each.path),
      ...item.incomplete
        .filter((each) => each.startsWith('unread:'))
        .map((each) => each.slice('unread:'.length)),
    ];
    const counted = scan(['fixtures/**']).plans;
    const listed = scan(undefined).plans.filter((item) => item.cwd === '');
    expect(counted.map((item) => [item.agent, item.ignored ?? 0])).toEqual(
      listed.map((item) => [
        item.agent,
        new Set(mayLoad(item).filter((path) => path.startsWith('fixtures/'))).size,
      ]),
    );
  });

  /** Each agent's count at the root, as a scan with `ignore` makes it. */
  function countsOf(
    files: FileMap,
    ignore: readonly string[],
    extras: SnapshotExtras = {},
  ): Partial<Record<ContextAgent, number>> {
    const options = { targets: PLATFORM_IDS, config: resolveConfig({ ignore }) };
    const snapshot = snapshotFrom(files, {
      ...extras,
      paths: ['.git/HEAD', ...(extras.paths ?? [])],
    });
    const analysis = analyze(snapshot, options);
    const withIgnored = analyzeWithIgnored(analysis, options);
    const plans = loadPlans(analysis, {
      agents: CONTEXT_AGENTS,
      cwd: '',
      config: analysis.config,
      ...(withIgnored === undefined ? {} : { withIgnored }),
    });
    return Object.fromEntries(plans.map((item) => [item.agent, item.ignored]));
  }

  it('does not count a file the agent skips for a documented reason', () => {
    // Gemini CLI reads GEMINI.md, not AGENTS.md; the others read the root AGENTS.md.
    const counts = countsOf({ 'AGENTS.md': 'Rules.\n', 'GEMINI.md': 'Gemini.\n' }, ['AGENTS.md']);
    expect(counts.gemini).toBeUndefined();
    expect([counts['claude-code'], counts.codex, counts.cline]).toEqual([1, 1, 1]);
  });

  it('counts a file the agent reaches only through an ignored one', () => {
    const skill = '---\nname: s\ndescription: Does s.\n---\nBody.\n';
    const counts = countsOf(
      {
        'CLAUDE.md': 'Root.\n',
        'vendor/skills/s/SKILL.md': skill,
        '.claude/skills/s/SKILL.md': skill,
      },
      ['vendor/**'],
      { symlinks: { '.claude/skills/s/SKILL.md': 'vendor/skills/s/SKILL.md' } },
    );
    expect(counts['claude-code']).toBe(1);
  });

  it('changes nothing in a plan but the count, even when the Markdown budget runs out', () => {
    // A budget the scan's own files fit in and the vendored file does not: counting over the
    // scan's own parses would cut Gemini CLI's GEMINI.md short.
    const snapshot = snapshotFrom(
      {
        'CLAUDE.md': 'Root.\n',
        'GEMINI.md': 'Gemini.\n',
        'vendor/pkg/CLAUDE.md': `${'Vendored text. '.repeat(40)}\n`,
      },
      { paths: ['.git/HEAD'] },
    );
    const options = {
      targets: PLATFORM_IDS,
      config: resolveConfig({ ignore: ['vendor/**'] }),
      markdownBudget: 40,
    };
    const plansOf = (counted: boolean): LoadPlan[] => {
      const analysis = analyze(snapshot, options);
      const withIgnored = counted ? analyzeWithIgnored(analysis, options) : undefined;
      return loadPlans(analysis, {
        agents: CONTEXT_AGENTS,
        cwd: '',
        config: analysis.config,
        ...(withIgnored === undefined ? {} : { withIgnored }),
      });
    };
    const counted = plansOf(true);
    const uncounted = plansOf(false);
    const uncountedPart = (plans: readonly LoadPlan[]) =>
      plans.map((item) => ({ ...item, ignored: undefined }));
    expect(uncountedPart(counted)).toEqual(uncountedPart(uncounted));
    // Claude Code finds the nested CLAUDE.md only by reading it.
    expect(uncounted.find((item) => item.agent === 'claude-code')?.ignored).toBeUndefined();
    expect(counted.find((item) => item.agent === 'claude-code')?.ignored).toBe(1);
    expect(counted.find((item) => item.agent === 'gemini')?.incomplete).toEqual([]);
  });

  it('falls back to what the plan finds when planning over the ignored files fails', () => {
    const options = { targets: PLATFORM_IDS, config: resolveConfig({ ignore: ['vendor/**'] }) };
    const snapshot = snapshotFrom(
      { 'CLAUDE.md': 'Root.\n', 'vendor/pkg/CLAUDE.md': 'Vendored.\n' },
      { paths: ['.git/HEAD'] },
    );
    const analysis = analyze(snapshot, options);
    const all = analyzeWithIgnored(analysis, options);
    if (all === undefined) throw new Error('Nothing is ignored.');
    const failing = {
      ...all,
      get artifacts(): never {
        throw new Error('A loader failed.');
      },
    };
    const shared = { agents: CONTEXT_AGENTS, cwd: '', config: analysis.config };
    expect(loadPlans(analysis, { ...shared, withIgnored: failing })).toEqual(
      loadPlans(analysis, shared),
    );
  });

  it('plans only the root over the ignored files in the matrix', () => {
    const skill = '---\nname: s\ndescription: Does s.\n---\nBody.\n';
    const files: FileMap = { 'AGENTS.md': 'Root.\n', 'pkg/AGENTS.md': 'Package.\n' };
    const options = {
      targets: PLATFORM_IDS,
      config: resolveConfig({ ignore: ['pkg/.agents/**'] }),
    };
    const analysis = analyze(snapshotFrom(files, { paths: ['.git/HEAD'] }), options);
    // A view with an ignored skill the scan itself never saw, so only a plan over it counts it.
    const withIgnored = analyzeWithIgnored(
      analyze(
        snapshotFrom(
          { ...files, 'pkg/.agents/skills/s/SKILL.md': skill },
          { paths: ['.git/HEAD'] },
        ),
        options,
      ),
      options,
    );
    if (withIgnored === undefined) throw new Error('Nothing is ignored.');
    const shared = { agents: ['codex'] as const, config: analysis.config, withIgnored };
    expect(loadPlans(analysis, { ...shared, cwd: 'pkg' })[0]?.ignored).toBe(1);
    expect(
      matrixPlans(analysis, shared).map((item) => `${item.cwd} ${String(item.ignored)}`),
    ).toEqual([' undefined', 'pkg undefined']);
  });

  it('counts only what the loaders find when the scan turns the count off', () => {
    const snapshot = snapshotFrom(
      { 'CLAUDE.md': 'Root.\n', 'vendor/pkg/CLAUDE.md': 'Vendored.\n' },
      { paths: ['.git/HEAD'] },
    );
    const options = {
      rules: builtinRules,
      targets: PLATFORM_IDS,
      config: resolveConfig({ ignore: ['vendor/**'] }),
    };
    const claudeCount = (countIgnored: boolean | undefined): number | undefined =>
      scanWithContext(snapshot, {
        ...options,
        ...(countIgnored === undefined ? {} : { countIgnored }),
      }).context.plans.find((item) => item.agent === 'claude-code')?.ignored;
    // Claude Code finds the nested CLAUDE.md only by reading it.
    expect(claudeCount(undefined)).toBe(1);
    expect(claudeCount(true)).toBe(1);
    expect(claudeCount(false)).toBeUndefined();
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

  it('counts what the plan over the ignored files says the agent may load, each file once', () => {
    const config = resolveConfig({ ignore: ['vendor/**'] });
    const original = plan('claude-code', {
      entries: [entry('instructions', 'CLAUDE.md', { position: 1, size: size(10) })],
      incomplete: [
        'unread:vendor/a.md',
        'unread:vendor/b.md',
        'unread:vendor/settings.json',
        'unread:vendor/dir/',
      ],
    });
    const unignored = plan('claude-code', {
      entries: [
        entry('instructions', 'CLAUDE.md', { position: 1, size: size(10) }),
        entry('import', 'vendor/a.md', { position: 2, size: size(4) }),
        entry('instructions', 'vendor/x/CLAUDE.md', { trigger: 'on-path' }),
        entry('skill', '.claude/skills/s/SKILL.md', { trigger: 'model-selected' }),
      ],
      skipped: [
        skip('instructions', 'vendor/AGENTS.md', 'shadowed-by-claude-md'),
        skip('instructions', 'vendor/Agents.md', 'case-mismatch', { certainty: 'unverified' }),
      ],
      outOfScope: [
        { path: 'vendor/b.md', because: 'below-start-dir' },
        { path: 'vendor/y/.mcp.json', because: 'below-start-dir' },
      ],
    });
    const filtered = withoutIgnored(original, config, unignored);
    // vendor/a.md, which both plans list; vendor/x/CLAUDE.md; the skill, which is not ignored but
    // which this plan does not show; vendor/Agents.md, whose skip no source confirms; and
    // vendor/settings.json, which only this plan lists. Not CLAUDE.md, which it shows; not the
    // documented skip or the files out of scope, vendor/b.md included; not the directory.
    expect(filtered.ignored).toBe(5);
    expect(filtered.entries).toEqual(original.entries);
    expect(filtered.incomplete).toEqual([]);
    expect(filtered.totals).toBe(original.totals);
    // Nothing ignored in either plan: the plan stays as it is.
    const clean = plan('codex', {
      entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
    });
    expect(withoutIgnored(clean, config, clean)).toBe(clean);
    // Files left out that the agent does not load: no count.
    const skippedOnly = plan('cline', {
      skipped: [skip('instructions', 'vendor/AGENTS.md', 'not-read')],
    });
    const left = withoutIgnored(skippedOnly, config, skippedOnly);
    expect(left.skipped).toEqual([]);
    expect(left.ignored).toBeUndefined();
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
    // vendor/a.md and vendor/rules/r.md, which Claude Code loads. Not the documented skip of
    // vendor/AGENTS.md, vendor/x/CLAUDE.md out of scope, or the directory vendor/deep/.
    expect(filtered.ignored).toBe(2);
    // The totals stay: the loader computed them, and an unread file has no size.
    expect(filtered.totals).toBe(original.totals);
  });
});
