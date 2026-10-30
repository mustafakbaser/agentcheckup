/**
 * The Gemini CLI load plan (src/platforms/load/gemini.ts): context file names, the startup chain,
 * just-in-time files, imports, skills, MCP servers and hooks. Each test runs the rules first and
 * the loader over the same analysis, and checks that every skip naming a rule has its finding.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/compare.js';
import { analyze, type Analysis, type RuleResult, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { buildInventory } from '../../../src/inventory/build.js';
import { walk } from '../../../src/io/walk.js';
import { checkConsistency, UNREPORTED_CODES } from '../../../src/platforms/load/consistency.js';
import { loadGemini } from '../../../src/platforms/load/gemini.js';
import { matrixPlans } from '../../../src/platforms/load/matrix.js';
import { CONTEXT_AGENTS, type LoadPlan } from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

const SCAN = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;

interface Built {
  readonly plan: LoadPlan;
  readonly result: RuleResult;
  readonly analysis: Analysis;
}

/** Rules first, then the loader over the same analysis, as the engine runs them. */
function buildFrom(snapshot: Snapshot, cwd = ''): Built {
  const analysis = analyze(snapshot, SCAN);
  const result = runRules(analysis, SCAN);
  expect(result.ruleFailures).toEqual([]);
  const built = { plan: loadGemini(analysis, { cwd, config: analysis.config }), result, analysis };
  expectSkipsReported(built);
  expectSorted(built.plan);
  return built;
}

/** A repository with a `.git` at the root unless `git` is false. */
function build(files: FileMap, extras: SnapshotExtras = {}, cwd = '', git = true): Built {
  const paths = [...(git ? ['.git/HEAD'] : []), ...(extras.paths ?? [])];
  return buildFrom(snapshotFrom(files, { ...extras, paths }), cwd);
}

/** `id trigger position certainty` for each entry, in plan order. */
function entries(plan: LoadPlan): string[] {
  return plan.entries.map(
    (e) =>
      `${e.id} ${e.trigger} ${e.position === undefined ? '-' : String(e.position)} ${e.certainty}`,
  );
}

/** `id code rule certainty` for each skip. */
function skips(plan: LoadPlan): string[] {
  return plan.skipped.map((s) => `${s.id} ${s.code} ${s.ruleId ?? '-'} ${s.certainty}`);
}

function outOfScope(plan: LoadPlan): string[] {
  return plan.outOfScope.map((o) => `${o.path} ${o.because}`);
}

/**
 * Every skip that names a rule has an unsuppressed finding of that rule on the same file that
 * lists Gemini CLI. A skip on a symlink alias is reported on the real file.
 */
function expectSkipsReported({ plan, result, analysis }: Built): void {
  for (const skip of plan.skipped) {
    if (skip.ruleId === undefined) continue;
    const path = analysis.index.get(skip.path)?.path ?? skip.path;
    const found = result.findings.some(
      (finding) =>
        finding.ruleId === skip.ruleId &&
        finding.path === path &&
        finding.suppressed === undefined &&
        finding.platforms.includes('gemini'),
    );
    expect(found, `${skip.ruleId} on ${path}`).toBe(true);
  }
}

function expectSorted(plan: LoadPlan): void {
  const byPathId = (a: { path: string; id: string }, b: { path: string; id: string }): number =>
    compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
  expect([...plan.skipped].sort(byPathId)).toEqual(plan.skipped);
  expect([...plan.incomplete].sort(compareStrings)).toEqual(plan.incomplete);
  expect(new Set(plan.entries.map((e) => e.id)).size).toBe(plan.entries.length);
  const positions = plan.entries.flatMap((e) => (e.position === undefined ? [] : [e.position]));
  expect(positions).toEqual(positions.map((_, i) => i + 1));
}

/** The matrix plans of every modeled agent agree with the findings. */
function expectConsistent(files: FileMap, extras: SnapshotExtras = {}): void {
  const analysis = analyze(
    snapshotFrom(files, { ...extras, paths: ['.git/HEAD', ...(extras.paths ?? [])] }),
    SCAN,
  );
  const { findings } = runRules(analysis, SCAN);
  const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
  expect(checkConsistency({ findings, plans, view: analysis }).mismatches).toEqual([]);
}

const SKILL = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

describe('loadGemini: context file names', () => {
  it('reads GEMINI.md without settings, and leaves AGENTS.md unread', () => {
    const { plan } = build({ 'GEMINI.md': 'Gemini.\n', 'AGENTS.md': 'Agents.\n' });
    expect(entries(plan)).toEqual(['instructions:GEMINI.md startup 1 documented']);
    expect(skips(plan)).toEqual(['instructions:AGENTS.md not-read - documented']);
    expect(plan.assumptions.find((a) => a.key === 'gemini.context.fileName')).toEqual({
      key: 'gemini.context.fileName',
      value: 'GEMINI.md',
      origin: 'default',
      evidence: ['geminiMd', 'geminiCliConfigSource', 'geminiMemoryToolSource'],
    });
  });

  it('adds a context.fileName string in front of GEMINI.md', () => {
    const { plan } = build({
      '.gemini/settings.json': '{ "context": { "fileName": "AGENTS.md" } }',
      'AGENTS.md': 'Agents.\n',
      'GEMINI.md': 'Gemini.\n',
    });
    expect(entries(plan)).toEqual([
      'instructions:AGENTS.md startup 1 documented',
      'instructions:GEMINI.md startup 2 documented',
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.assumptions.find((a) => a.key === 'gemini.context.fileName')).toMatchObject({
      value: 'AGENTS.md, GEMINI.md',
      origin: 'repository',
    });
  });

  it('reads every name of a context.fileName list, and lists a named file it did not read', () => {
    const { plan } = build(
      {
        '.gemini/settings.json': '{ "context": { "fileName": ["CONTEXT.md", "AGENTS.md"] } }',
        'AGENTS.md': 'Agents.\n',
        'pkg/AGENTS.md': 'Package.\n',
      },
      { paths: ['CONTEXT.md', 'pkg/CONTEXT.md'] },
    );
    expect(entries(plan)).toEqual([
      'instructions:AGENTS.md startup 1 documented',
      'instructions:pkg/AGENTS.md on-path - documented',
    ]);
    expect(plan.entries.find((e) => e.path === 'pkg/AGENTS.md')?.patterns).toEqual(['pkg/**']);
    expect(plan.incomplete).toEqual(['unread:CONTEXT.md', 'unread:pkg/CONTEXT.md']);
    expect(plan.assumptions.find((a) => a.key === 'gemini.context.fileName')?.value).toBe(
      'CONTEXT.md, AGENTS.md, GEMINI.md',
    );
  });

  it('ignores the legacy top-level contextFileName, which gemini/settings-key-ignored reports', () => {
    const { plan, result } = build({
      '.gemini/settings.json': '{ "contextFileName": "AGENTS.md" }',
      'AGENTS.md': 'Agents.\n',
    });
    expect(plan.entries).toEqual([]);
    expect(skips(plan)).toEqual(['instructions:AGENTS.md not-read - documented']);
    expect(result.findings.map((f) => f.ruleId)).toContain('gemini/settings-key-ignored');
  });

  it('leaves a file that deeper settings name to a session started there', () => {
    const files = {
      'pkg/.gemini/settings.json': '{ "context": { "fileName": "AGENTS.md" } }',
      'pkg/sub/AGENTS.md': '   \n',
      'AGENTS.md': 'Root.\n',
    };
    const { plan, result } = build(files);
    expect(outOfScope(plan)).toEqual([
      'pkg/.gemini/settings.json below-start-dir',
      'pkg/sub/AGENTS.md below-start-dir',
    ]);
    expect(skips(plan)).toEqual(['instructions:AGENTS.md not-read - documented']);
    // The rules count Gemini CLI as a reader of the blank file below the settings.
    const empty = result.findings.find((f) => f.ruleId === 'instr/empty-file');
    expect(empty?.platforms).toContain('gemini');
    expectConsistent(files);
    // A session started in pkg reads it, and finds it blank.
    expect(skips(build(files, {}, 'pkg').plan)).toContain(
      'instructions:pkg/sub/AGENTS.md blank-file instr/empty-file source-code',
    );
  });
});

describe('loadGemini: the startup chain and just-in-time files', () => {
  it('reads the names from the project root down to the working directory, sorted by path', () => {
    const files = {
      'GEMINI.md': 'Root.\n',
      'Api/GEMINI.md': 'Api.\n',
      'Api/v2/GEMINI.md': 'V2.\n',
      'web/GEMINI.md': 'Web.\n',
    };
    // The source sorts the paths it found: `Api/` sorts before `GEMINI.md`.
    expect(entries(build(files, {}, 'Api').plan)).toEqual([
      'instructions:Api/GEMINI.md startup 1 documented',
      'instructions:GEMINI.md startup 2 documented',
      'instructions:Api/v2/GEMINI.md on-path - documented',
    ]);
    // Files in other branches are not part of the session.
    expect(entries(build(files, {}, 'web').plan)).toEqual([
      'instructions:GEMINI.md startup 1 documented',
      'instructions:web/GEMINI.md startup 2 documented',
    ]);
  });

  it('stops at the nearest .git, and marks directories above the working directory unverified without one', () => {
    const files = { 'GEMINI.md': 'Root.\n', 'pkg/GEMINI.md': 'Pkg.\n' };
    expect(entries(build(files, { paths: ['pkg/.git'] }, 'pkg').plan)).toEqual([
      'instructions:pkg/GEMINI.md startup 1 documented',
    ]);
    expect(entries(build(files, {}, 'pkg', false).plan)).toEqual([
      'instructions:GEMINI.md startup 1 unverified',
      'instructions:pkg/GEMINI.md startup 2 documented',
    ]);
  });

  it('loads files below the working directory just in time, and leaves template folders out', () => {
    const { plan } = build({
      'GEMINI.md': 'Root.\n',
      'pkg/api/GEMINI.md': 'Api.\n',
      'templates/app/GEMINI.md': 'Template.\n',
    });
    expect(entries(plan)).toEqual([
      'instructions:GEMINI.md startup 1 documented',
      'instructions:pkg/api/GEMINI.md on-path - documented',
    ]);
    expect(plan.entries[1]?.patterns).toEqual(['pkg/api/**']);
    expect(outOfScope(plan)).toEqual(['templates/app/GEMINI.md payload-folder']);
    expect(plan.totals.startup.chars).toBe('Root.\n'.length);
  });

  it('skips blank files and case variants, with the rules that report them', () => {
    const { plan } = build({
      '.gemini/settings.json': '{ "context": { "fileName": ["AGENTS.md"] } }',
      'AGENTS.md': ' \n\t\n',
      'pkg/GEMINI.md': '',
      'Gemini.md': 'Mixed case.\n',
    });
    expect(plan.entries).toEqual([]);
    expect(skips(plan)).toEqual([
      'instructions:AGENTS.md blank-file instr/empty-file source-code',
      'instructions:Gemini.md case-mismatch instr/filename-case source-code',
      'instructions:pkg/GEMINI.md blank-file instr/empty-file source-code',
    ]);
  });

  it('reads a file reached through a symlink once, at its first path', () => {
    const { plan } = build(
      {
        '.gemini/settings.json': '{ "context": { "fileName": ["AGENTS.md"] } }',
        'AGENTS.md': 'Shared.\n',
        'GEMINI.md': 'Shared.\n',
      },
      { symlinks: { 'GEMINI.md': 'AGENTS.md' } },
    );
    expect(entries(plan)).toEqual(['instructions:AGENTS.md startup 1 documented']);
  });
});

describe('loadGemini: imports', () => {
  it('inlines imports after their file, and lists an import it did not read without a size', () => {
    const { plan } = build(
      {
        '.gemini/settings.json': '{ "context": { "fileName": ["AGENTS.md"] } }',
        'AGENTS.md': 'Agents.\n\n@docs/style.md\n',
        'docs/style.md': 'Style.\n\n@./more.md\n',
        'docs/more.md': 'More.\n',
        'GEMINI.md': '@README.md\n',
      },
      { imported: ['docs/style.md', 'docs/more.md'], paths: ['README.md'] },
    );
    expect(entries(plan)).toEqual([
      'instructions:AGENTS.md startup 1 documented',
      'import:docs/style.md startup 2 documented',
      'import:docs/more.md startup 3 documented',
      'instructions:GEMINI.md startup 4 documented',
      'import:README.md startup 5 documented',
    ]);
    expect(plan.entries.find((e) => e.path === 'docs/more.md')?.via).toEqual([
      'AGENTS.md',
      'docs/style.md',
    ]);
    expect(plan.entries.find((e) => e.path === 'README.md')?.size).toBeUndefined();
    expect(plan.incomplete).toEqual(['unread:README.md']);
  });

  it('follows imports five hops deep and skips the next one', () => {
    const files: Record<string, string> = { 'GEMINI.md': '@d1.md\n' };
    for (let i = 1; i <= 6; i++) files[`d${String(i)}.md`] = `@d${String(i + 1)}.md\n`;
    files['d7.md'] = 'End.\n';
    const imported = Object.keys(files).filter((path) => path !== 'GEMINI.md');
    const { plan, result } = build(files, { imported });
    expect(plan.entries.map((e) => e.path)).toEqual([
      'GEMINI.md',
      'd1.md',
      'd2.md',
      'd3.md',
      'd4.md',
      'd5.md',
    ]);
    expect(skips(plan)).toEqual([
      'import:d5.md#d6.md import-too-deep instr/import-depth documented',
    ]);
    expect(plan.limits).toEqual([
      {
        key: 'gemini.import_max_hops',
        unit: 'hops',
        limit: 5,
        used: 6,
        subject: 'd5.md',
        effect: 'skips',
        evidence: ['geminiImports', 'geminiImportSource'],
      },
    ]);
    const depth = result.findings.filter((f) => f.ruleId === 'instr/import-depth');
    expect(depth.map((f) => [f.path, f.platforms])).toEqual([['d5.md', ['gemini']]]);
  });

  it('skips imports that do not resolve or leave the project root', () => {
    const { plan } = build(
      {
        'pkg/GEMINI.md': '@missing.md\n@/etc/hosts\n@../shared.md\n@./here.md\n',
        'pkg/here.md': 'Here.\n',
        'shared.md': 'Shared.\n',
      },
      { paths: ['pkg/.git'], imported: ['pkg/here.md', 'shared.md'] },
      'pkg',
    );
    expect(entries(plan)).toEqual([
      'instructions:pkg/GEMINI.md startup 1 documented',
      'import:pkg/here.md startup 2 documented',
    ]);
    expect(skips(plan)).toEqual([
      'import:pkg/GEMINI.md#../shared.md import-outside-root instr/import-outside-root source-code',
      'import:pkg/GEMINI.md#/etc/hosts import-outside-root instr/import-outside-root source-code',
      'import:pkg/GEMINI.md#missing.md import-unresolved instr/import-unresolved documented',
    ]);
  });

  it('marks imports unverified when the scan shows no .git, so the project root is unknown', () => {
    const { plan } = build(
      { 'GEMINI.md': '@a.md\n', 'a.md': 'A.\n' },
      { imported: ['a.md'] },
      '',
      false,
    );
    expect(entries(plan)).toEqual([
      'instructions:GEMINI.md startup 1 documented',
      'import:a.md startup 2 unverified',
    ]);
  });

  it('follows the imports of an AGENTS.md that context.fileName names, as the import rules do', () => {
    const files = {
      '.gemini/settings.json': '{ "context": { "fileName": "AGENTS.md" } }',
      'AGENTS.md': '@./missing.md\n',
      'CLAUDE.md': 'Claude.\n',
    };
    const { plan, result } = build(files);
    expect(skips(plan)).toEqual([
      'import:AGENTS.md#./missing.md import-unresolved instr/import-unresolved documented',
    ]);
    // Claude Code reads CLAUDE.md instead, so only Gemini CLI follows the import.
    const unresolved = result.findings.filter((f) => f.ruleId === 'instr/import-unresolved');
    expect(unresolved.map((f) => f.platforms)).toEqual([['gemini']]);
    expectConsistent(files);
  });

  it('agrees with instr/import-depth on cycles, which load nothing new', () => {
    const files = { 'GEMINI.md': '@a.md\n', 'a.md': '@GEMINI.md\n' };
    const { plan, result } = build(files, { imported: ['a.md'] });
    expect(plan.skipped).toEqual([]);
    expect(result.findings.find((f) => f.ruleId === 'instr/import-depth')?.severity).toBe('info');
    expectConsistent(files, { imported: ['a.md'] });
  });
});

describe('loadGemini: skills', () => {
  it('lists the working directory skills folders; .agents/skills wins on a name', () => {
    const { plan } = build({
      '.gemini/skills/release/SKILL.md': SKILL('release', 'Ships a release.'),
      '.gemini/skills/notes/SKILL.md': SKILL('notes', 'Writes notes.'),
      '.agents/skills/release/SKILL.md': SKILL('release', 'Ships a release, the shared way.'),
      '.agents/skills/tools/lint/SKILL.md': SKILL('lint', 'Lints.'),
    });
    expect(entries(plan)).toEqual([
      'skill:.gemini/skills/notes/SKILL.md startup 1 documented',
      'skill:.agents/skills/release/SKILL.md startup 2 documented',
    ]);
    expect(skips(plan)).toEqual([
      'skill:.agents/skills/tools/lint/SKILL.md not-read - source-code',
      'skill:.gemini/skills/release/SKILL.md shadowed-by-preferred - documented',
    ]);
    const notes = plan.entries[0];
    expect(notes?.size?.chars).toBe('notes\nWrites notes.'.length);
    expect(notes?.deferred?.chars).toBe('\nSteps.\n'.length);
    // A SKILL.md in the skills folder itself is found too.
    const top = build({ '.gemini/skills/SKILL.md': SKILL('top', 'In the folder itself.') }).plan;
    expect(entries(top)).toEqual(['skill:.gemini/skills/SKILL.md startup 1 documented']);
  });

  it('skips skills for the reasons the skill rules report', () => {
    const { plan } = build({
      '.gemini/skills/none/SKILL.md': 'No frontmatter.\n',
      '.gemini/skills/toml/SKILL.md': '+++\nname = "toml"\n+++\n',
      '.gemini/skills/list/SKILL.md': '---\n- a\n- b\n---\n',
      '.gemini/skills/nodesc/SKILL.md': '---\nname: nodesc\n---\n',
      '.gemini/skills/noname/SKILL.md': '---\ndescription: No name.\n---\n',
      '.gemini/skills/bom/SKILL.md': '\uFEFF---\nname: bom\ndescription: Has a mark.\n---\n',
      '.gemini/skills/dashes/SKILL.md': '---\nname: dashes\ndescription: Four.\n----\nBody.\n',
      '.gemini/skills/lines/SKILL.md': '---\nname: lines\ndescription: a: b: c\n---\n',
      '.gemini/skills/nolines/SKILL.md': '---\ntitle: [unclosed\n---\n',
      '.gemini/skills/spaced/SKILL.md': '---\nname: spaced\ndescription: Blanks.\n--- \t\nBody.\n',
    });
    expect(skips(plan)).toEqual([
      // Gemini CLI closes the block only at a line that is `---` and optional spaces or tabs.
      'skill:.gemini/skills/dashes/SKILL.md no-frontmatter skill/frontmatter-missing source-code',
      'skill:.gemini/skills/list/SKILL.md invalid-frontmatter skill/frontmatter-invalid source-code',
      'skill:.gemini/skills/nodesc/SKILL.md no-description skill/description-missing source-code',
      'skill:.gemini/skills/nolines/SKILL.md invalid-frontmatter - source-code',
      'skill:.gemini/skills/noname/SKILL.md invalid-frontmatter skill/name-missing source-code',
      'skill:.gemini/skills/none/SKILL.md no-frontmatter skill/frontmatter-missing source-code',
      'skill:.gemini/skills/toml/SKILL.md invalid-frontmatter skill/frontmatter-invalid source-code',
    ]);
    // Gemini CLI removes a byte order mark; YAML that does not parse is read line by line.
    expect(entries(plan)).toEqual([
      'skill:.gemini/skills/bom/SKILL.md startup 1 documented',
      'skill:.gemini/skills/lines/SKILL.md startup 2 source-code',
      'skill:.gemini/skills/spaced/SKILL.md startup 3 documented',
    ]);
    expect(plan.entries.map((skill) => skill.name)).toEqual(['bom', 'lines', 'spaced']);
  });

  it('leaves skills of other directories to sessions started there', () => {
    const files = {
      '.gemini/skills/root/SKILL.md': SKILL('root', 'Root skill.'),
      'pkg/.agents/skills/pkg/SKILL.md': SKILL('pkg', 'Package skill.'),
      'pkg/.agents/skills/x/y/SKILL.md': SKILL('deep', 'Too deep.'),
    };
    const root = build(files).plan;
    expect(outOfScope(root)).toEqual(['pkg/.agents/skills/pkg/SKILL.md below-start-dir']);
    const pkg = build(files, {}, 'pkg').plan;
    expect(entries(pkg)).toEqual(['skill:pkg/.agents/skills/pkg/SKILL.md startup 1 documented']);
    expect(skips(pkg)).toEqual([
      'skill:.gemini/skills/root/SKILL.md not-read - source-code',
      'skill:pkg/.agents/skills/x/y/SKILL.md not-read - source-code',
    ]);
  });

  it('marks a case variant unverified and leaves a bundled skill out', () => {
    const { plan } = build({
      '.gemini/skills/a/skill.md': SKILL('a', 'Lower case.'),
      '.gemini/skills/b/SKILL.md': SKILL('b', 'Bundles another.'),
      '.gemini/skills/b/inner/SKILL.md': SKILL('inner', 'Bundled.'),
    });
    expect(entries(plan)).toEqual([
      'skill:.gemini/skills/a/skill.md startup 1 unverified',
      'skill:.gemini/skills/b/SKILL.md startup 2 documented',
    ]);
    expect(outOfScope(plan)).toEqual(['.gemini/skills/b/inner/SKILL.md payload-folder']);
  });
});

describe('loadGemini: settings', () => {
  const SETTINGS = `{
  // Gemini CLI strips comments from its settings.
  "mcpServers": {
    "docs": { "httpUrl": "https://docs.example.com/mcp" },
    "db": { "command": "npx", "args": ["-y", "@acme/db-mcp@1.2.3"] },
    "blocked": { "command": "x" }
  },
  "mcp": { "excluded": ["blocked"] },
  "hooks": {
    "BeforeTool": [
      { "matcher": "run_shell_command", "hooks": [{ "type": "command", "command": "./guard.sh" }] }
    ],
    "BeforeCommit": [{ "hooks": [{ "type": "command", "command": "echo" }] }]
  }
}
`;

  it('starts MCP servers at session start and runs hooks once accepted', () => {
    const { plan, analysis } = build(
      { '.gemini/settings.json': SETTINGS },
      { paths: ['guard.sh'] },
    );
    expect(entries(plan)).toEqual([
      'mcp-server:.gemini/settings.json#db startup - documented',
      'mcp-server:.gemini/settings.json#docs startup - documented',
      expect.stringMatching(
        /^hook:\.gemini\/settings\.json#BeforeTool:\w+ on-approval - documented$/,
      ),
    ]);
    expect(skips(plan)).toEqual([
      'hook:.gemini/settings.json#BeforeCommit unknown-event hooks/unknown-event documented',
      'mcp-server:.gemini/settings.json#blocked disabled - documented',
    ]);
    const inventory = buildInventory(analysis);
    const ids = new Set([...inventory.mcpServers, ...inventory.hooks].map((item) => item.id));
    for (const entry of plan.entries) expect(ids).toContain(entry.inventoryId);
  });

  it('turns servers off outside mcp.allowed, and hooks off with hooksConfig', () => {
    const settings = {
      mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
      mcp: { allowed: ['a'] },
      hooksConfig: { disabled: ['./named.sh'] },
      hooks: {
        BeforeTool: [{ hooks: [{ type: 'command', command: './named.sh' }] }],
        AfterTool: [{ hooks: [{ type: 'command', command: './other.sh' }] }],
      },
    };
    const listed = build({ '.gemini/settings.json': JSON.stringify(settings) }).plan;
    expect(skips(listed)).toEqual([
      expect.stringMatching(/^hook:\.gemini\/settings\.json#BeforeTool:\w+ disabled - unverified$/),
      'mcp-server:.gemini/settings.json#b disabled - documented',
    ]);
    const off = { ...settings, hooksConfig: { enabled: false } };
    const plan = build({ '.gemini/settings.json': JSON.stringify(off) }).plan;
    expect(plan.entries.filter((e) => e.role === 'hook')).toEqual([]);
    expect(plan.skipped.filter((s) => s.role === 'hook').map((s) => s.certainty)).toEqual([
      'documented',
      'documented',
    ]);
  });

  it('skips settings that do not parse, and reads only the working directory settings', () => {
    const broken = build({
      '.gemini/settings.json': '{ "mcpServers": { "a": { "command": "a" }, } ',
    });
    expect(skips(broken.plan)).toEqual([
      'mcp-server:.gemini/settings.json invalid-json json/invalid-syntax source-code',
    ]);
    const files = {
      '.gemini/settings.json': '{ "mcpServers": { "root": { "command": "r" } } }',
      'pkg/.gemini/settings.json': '{ "mcpServers": { "pkg": { "command": "p" } } }',
    };
    expect(outOfScope(build(files).plan)).toEqual(['pkg/.gemini/settings.json below-start-dir']);
    const pkg = build(files, {}, 'pkg').plan;
    expect(entries(pkg)).toEqual(['mcp-server:pkg/.gemini/settings.json#pkg startup - documented']);
    expect(skips(pkg)).toEqual(['mcp-server:.gemini/settings.json not-read - source-code']);
  });

  it('states its assumptions and the scopes it cannot see', () => {
    const { plan } = build({ 'GEMINI.md': 'Gemini.\n' });
    expect(plan.assumptions.map((a) => `${a.key}=${String(a.value)} (${a.origin})`)).toEqual([
      'gemini.access=paid API key or Gemini Code Assist license (default)',
      'gemini.context.fileName=GEMINI.md (default)',
      'gemini.folder_trust=false (default)',
    ]);
    expect(plan.hidden.map((h) => h.scope)).toEqual(['managed', 'plugin', 'user']);
    expect(plan.hidden.flatMap((h) => h.locations)).toContain('~/.gemini/settings.json');
  });
});

describe('loadGemini on a fixture repository', () => {
  it('agrees with the findings, and the walk reads the imports of a named AGENTS.md', async () => {
    const walked = await walk(fileURLToPath(new URL('../../fixtures/gemini', import.meta.url)));
    const snapshot: Snapshot = {
      ...walked,
      paths: new Set([...walked.paths, '.git/']),
      opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
    };
    const { plan, analysis, result } = buildFrom(snapshot);
    expect(entries(plan)).toEqual([
      'instructions:AGENTS.md startup 1 documented',
      'import:docs/style.md startup 2 documented',
      'instructions:GEMINI.md startup 3 documented',
      'skill:.agents/skills/release/SKILL.md startup 4 documented',
      'mcp-server:.gemini/settings.json#docs startup - documented',
      'instructions:packages/api/GEMINI.md on-path - documented',
      expect.stringMatching(
        /^hook:\.gemini\/settings\.json#BeforeTool:\w+ on-approval - documented$/,
      ),
    ]);
    expect(skips(plan)).toEqual([
      'skill:.agents/skills/tools/lint/SKILL.md not-read - source-code',
      'hook:.gemini/settings.json#BeforeCommit unknown-event hooks/unknown-event documented',
      'mcp-server:.gemini/settings.json#db disabled - documented',
      'skill:.gemini/skills/broken/SKILL.md no-frontmatter skill/frontmatter-missing source-code',
      'skill:.gemini/skills/release/SKILL.md shadowed-by-preferred - documented',
      'import:AGENTS.md#docs/missing.md import-unresolved instr/import-unresolved documented',
    ]);
    expect(outOfScope(plan)).toEqual(['packages/api/.gemini/settings.json below-start-dir']);
    // The walk read docs/style.md because the AGENTS.md that context.fileName names imports it.
    expect(plan.entries.find((e) => e.path === 'docs/style.md')?.size?.chars).toBeGreaterThan(0);
    expect(plan.incomplete).toEqual([]);
    const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
    expect(
      checkConsistency({ findings: result.findings, plans, view: analysis }).mismatches,
    ).toEqual([]);
    for (const item of plans) {
      for (const skip of item.skipped) {
        if (skip.ruleId === undefined) expect(UNREPORTED_CODES.has(skip.code)).toBe(true);
      }
    }
  });
});
