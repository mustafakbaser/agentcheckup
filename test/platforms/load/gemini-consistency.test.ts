/**
 * The Gemini CLI mappings and allowances of src/platforms/load/consistency.ts: each allowance is
 * shown on a fixture, with the mismatch it accounts for when it is turned off.
 */
import { describe, expect, it } from 'vitest';
import { analyze, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS } from '../../../src/core/types.js';
import {
  ALLOWANCES,
  type AllowanceName,
  checkConsistency,
  type ConsistencyReport,
} from '../../../src/platforms/load/consistency.js';
import { loadPlans } from '../../../src/platforms/load/index.js';
import { matrixPlans } from '../../../src/platforms/load/matrix.js';
import { CONTEXT_AGENTS, type LoadPlan } from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

interface Checked {
  readonly report: ConsistencyReport;
  readonly gemini: LoadPlan | undefined;
}

/**
 * Rules, then the plans over the same analysis: the matrix plans, or the Gemini CLI plan of a
 * session started in `cwd`. Then both directions of the check.
 */
function check(
  files: FileMap,
  options: {
    readonly extras?: SnapshotExtras;
    readonly cwd?: string;
    readonly without?: readonly AllowanceName[];
  } = {},
): Checked {
  const extras = options.extras ?? {};
  const analysis = analyze(
    snapshotFrom(files, { ...extras, paths: ['.git/HEAD', ...(extras.paths ?? [])] }),
    { targets: PLATFORM_IDS },
  );
  const result = runRules(analysis, { rules: builtinRules, trustDirectives: false });
  expect(result.ruleFailures).toEqual([]);
  const { config } = analysis;
  const plans =
    options.cwd === undefined
      ? matrixPlans(analysis, { agents: CONTEXT_AGENTS, config })
      : loadPlans(analysis, { agents: ['gemini'], cwd: options.cwd, config });
  const report = checkConsistency(
    { findings: result.findings, plans, view: analysis },
    { without: options.without ?? [] },
  );
  return { report, gemini: plans.find((plan) => plan.agent === 'gemini') };
}

/** `kind rule agent path` of each mismatch. */
function brief(report: ConsistencyReport): string[] {
  return report.mismatches.map((m) => `${m.kind} ${m.ruleId || '-'} ${m.agent} ${m.path}`);
}

function geminiSkips(checked: Checked): string[] {
  return (checked.gemini?.skipped ?? []).map((s) => `${s.path} ${s.code} ${s.ruleId ?? '-'}`);
}

describe('Gemini CLI mappings', () => {
  it('takes only import-depth findings of warn or error as a skip: a cycle loads nothing new', () => {
    const files = { 'GEMINI.md': '@a.md\n', 'a.md': '@GEMINI.md\n' };
    const checked = check(files, { extras: { imported: ['a.md'] } });
    expect(checked.report.mismatches).toEqual([]);
    expect(checked.gemini?.entries.map((e) => e.path)).toEqual(['GEMINI.md', 'a.md']);
  });

  it('maps skill/frontmatter-invalid and skill/name-missing (error) to skips', () => {
    const checked = check({
      '.gemini/skills/toml/SKILL.md': '+++\nname = "toml"\n+++\n',
      '.gemini/skills/noname/SKILL.md': '---\ndescription: No name.\n---\n',
      '.gemini/skills/empty/SKILL.md': '---\nname: ""\ndescription: Empty name.\n---\n',
    });
    expect(checked.report.mismatches).toEqual([]);
    expect(geminiSkips(checked)).toEqual([
      '.gemini/skills/noname/SKILL.md invalid-frontmatter skill/name-missing',
      '.gemini/skills/toml/SKILL.md invalid-frontmatter skill/frontmatter-invalid',
    ]);
    // An empty name is a warning: Gemini CLI lists the skill.
    expect(checked.gemini?.entries.map((e) => e.path)).toEqual(['.gemini/skills/empty/SKILL.md']);
  });
});

describe('Gemini CLI allowances', () => {
  it('skip-without-rule: an import too deep in a chain through a file agentcheckup did not read', () => {
    const name = (i: number): string => `d${String(i)}.md`;
    const files: Record<string, string> = { 'GEMINI.md': `@README.md\n@${name(1)}\n` };
    for (let i = 1; i <= 6; i++) files[name(i)] = `@${name(i + 1)}\n`;
    files[name(7)] = 'End.\n';
    const extras = { paths: ['README.md'], imported: Object.keys(files).slice(1) };
    const allowed = check(files, { extras });
    expect(allowed.report.mismatches).toEqual([]);
    expect(geminiSkips(allowed)).toEqual(['d5.md import-too-deep -']);
    expect(brief(check(files, { extras, without: ['skip-without-rule'] }).report)).toEqual([
      'skip-without-rule - gemini d5.md',
    ]);
  });

  it('skip-without-rule: a blank file that only the working directory settings name', () => {
    const files = {
      'pkg/.gemini/settings.json': '{ "context": { "fileName": "AGENTS.md" } }',
      'AGENTS.md': '  \n',
      'pkg/AGENTS.md': 'Package.\n',
    };
    const allowed = check(files, { cwd: 'pkg' });
    expect(allowed.report.mismatches).toEqual([]);
    expect(geminiSkips(allowed)).toEqual(['AGENTS.md blank-file -']);
    expect(brief(check(files, { cwd: 'pkg', without: ['skip-without-rule'] }).report)).toEqual([
      'skip-without-rule - gemini AGENTS.md',
    ]);
  });

  it('skip-without-rule: YAML without name and description lines, which no rule reports for Gemini CLI', () => {
    const files = { '.gemini/skills/s/SKILL.md': '---\ntitle: [unclosed\n---\n' };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(geminiSkips(allowed)).toEqual(['.gemini/skills/s/SKILL.md invalid-frontmatter -']);
    expect(brief(check(files, { without: ['skip-without-rule'] }).report)).toEqual([
      'skip-without-rule - gemini .gemini/skills/s/SKILL.md',
    ]);
  });

  it(`${ALLOWANCES.emptySkillDescription}: Gemini CLI lists a skill with an empty description`, () => {
    const files = { '.gemini/skills/s/SKILL.md': '---\nname: s\ndescription: ""\n---\nBody.\n' };
    const allowed = check(files);
    expect(allowed.report.mismatches).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.emptySkillDescription]).toBe(1);
    expect(allowed.gemini?.entries.map((e) => e.path)).toEqual(['.gemini/skills/s/SKILL.md']);
    expect(brief(check(files, { without: [ALLOWANCES.emptySkillDescription] }).report)).toEqual([
      'finding-without-skip skill/description-missing gemini .gemini/skills/s/SKILL.md',
    ]);
    // A missing description is a skip, not an allowance.
    const missing = check({ '.gemini/skills/s/SKILL.md': '---\nname: s\n---\nBody.\n' });
    expect(missing.report).toEqual({ mismatches: [], allowed: {} });
  });
});
