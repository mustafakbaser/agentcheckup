/**
 * Cline's plans agree with the findings (src/platforms/load/consistency.ts), on the Cline
 * fixtures and on generated snapshots, and each allowance Cline needs has a case that shows the
 * mismatch it accounts for. Untrusted mode, default severities, the plans of `--matrix`.
 */
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyze, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { walk } from '../../../src/io/walk.js';
import {
  ALLOWANCES,
  type AllowanceName,
  checkConsistency,
  type ConsistencyReport,
  type Mismatch,
} from '../../../src/platforms/load/consistency.js';
import { matrixPlans } from '../../../src/platforms/load/matrix.js';
import { CONTEXT_AGENTS, type LoadPlan } from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';

interface Checked {
  readonly plans: readonly LoadPlan[];
  readonly report: ConsistencyReport;
}

function checkSnapshot(snapshot: Snapshot, without: readonly AllowanceName[] = []): Checked {
  const analysis = analyze(snapshot, { targets: PLATFORM_IDS });
  const result = runRules(analysis, { rules: builtinRules, trustDirectives: false });
  expect(result.ruleFailures).toEqual([]);
  const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
  const report = checkConsistency(
    { findings: result.findings, plans, view: analysis },
    { without },
  );
  return { plans, report };
}

function check(files: FileMap, without: readonly AllowanceName[] = []): Checked {
  return checkSnapshot(snapshotFrom(files, { paths: ['.git/HEAD'] }), without);
}

/** `kind rule agent path` of each mismatch. */
function brief(mismatches: readonly Mismatch[]): string[] {
  return mismatches.map((m) => `${m.kind} ${m.ruleId || '-'} ${m.agent} ${m.path}`);
}

function clinePlan(checked: Checked): LoadPlan | undefined {
  return checked.plans.find((plan) => plan.agent === 'cline');
}

describe('Cline consistency on the fixtures', () => {
  for (const name of ['workspace', 'legacy']) {
    it(`${name}: no mismatches`, async () => {
      const snapshot = await walk(
        fileURLToPath(new URL(`../../fixtures/cline/${name}`, import.meta.url)),
      );
      const checked = checkSnapshot(snapshot);
      expect(brief(checked.report.mismatches)).toEqual([]);
      // Both directions are exercised: a skip with a rule and one without.
      const cline = clinePlan(checked);
      expect(cline?.skipped.some((skip) => skip.ruleId !== undefined)).toBe(true);
    });
  }
});

describe('Cline allowances', () => {
  it('skip-without-rule: Cline drops a skill without a body, which no rule reports', () => {
    const files = {
      'AGENTS.md': 'Rules.\n',
      '.clinerules/workflows/empty.md': '\n',
      '.clinerules/CLAUDE.md': '',
      '.clinerules/SKILL.md': '',
      '.cline/skills/s/SKILL.md': '---\nname: s\ndescription: Does s.\n---\n',
    };
    const allowed = check(files);
    expect(brief(allowed.report.mismatches)).toEqual([]);
    expect(allowed.report.allowed['skip-without-rule']).toBe(2);
    // instr/empty-file judges every kind of file in a rules or workflows folder but a skill.
    expect(clinePlan(allowed)?.skipped.map((s) => [s.path, s.code, s.ruleId])).toEqual([
      ['.cline/skills/s/SKILL.md', 'blank-file', undefined],
      ['.clinerules/CLAUDE.md', 'blank-file', 'instr/empty-file'],
      ['.clinerules/SKILL.md', 'blank-file', undefined],
      ['.clinerules/workflows/empty.md', 'blank-file', 'instr/empty-file'],
    ]);
    expect(brief(check(files, ['skip-without-rule']).report.mismatches)).toEqual([
      'skip-without-rule - cline .cline/skills/s/SKILL.md',
      'skip-without-rule - cline .clinerules/SKILL.md',
    ]);
  });

  it('skip-without-rule: Cline drops a workflow whose frontmatter it cannot read', () => {
    const files = {
      'AGENTS.md': 'Rules.\n',
      '.cline/skills/s/SKILL.md': '---\nname: [s\n---\nBody.\n',
      '.cline/skills/examples/SKILL.md': '---\nname: [s\n---\nBody.\n',
      '.cline/workflows/w.md': '---\nname: 3\n---\nSteps.\n',
    };
    const allowed = check(files);
    expect(brief(allowed.report.mismatches)).toEqual([]);
    expect(allowed.report.allowed['skip-without-rule']).toBe(2);
    // The skill rules report a skill's frontmatter, except in a template or example folder.
    expect(clinePlan(allowed)?.skipped.map((s) => [s.path, s.code, s.ruleId])).toEqual([
      ['.cline/skills/examples/SKILL.md', 'invalid-frontmatter', undefined],
      ['.cline/skills/s/SKILL.md', 'invalid-frontmatter', 'skill/frontmatter-invalid'],
      ['.cline/workflows/w.md', 'invalid-frontmatter', undefined],
    ]);
    expect(brief(check(files, ['skip-without-rule']).report.mismatches)).toEqual([
      'skip-without-rule - cline .cline/skills/examples/SKILL.md',
      'skip-without-rule - cline .cline/workflows/w.md',
    ]);
  });

  it('cites the skill rule of the first problem Cline meets in a skill', () => {
    const { plans, report } = check({
      'AGENTS.md': 'Rules.\n',
      '.claude/skills/a/SKILL.md': '---\nname: [a, b]\ndescription: [x]\n---\nBody.\n',
      '.claude/skills/b/SKILL.md': '---\ndescription: true\n---\nBody.\n',
      '.agents/skills/c/SKILL.md':
        '---\nname: c\ndescription: Does c.\nenabled: "no"\n---\nBody.\n',
      '.agents/skills/d/SKILL.md': '---\nname: [d]\ndescription: Does d.\n---\n',
    });
    expect(brief(report.mismatches)).toEqual([]);
    expect(report.allowed[ALLOWANCES.firstSkipReason]).toBeUndefined();
    expect(
      plans
        .find((plan) => plan.agent === 'cline')
        ?.skipped.map((s) => `${s.path} ${s.code} ${s.ruleId ?? '-'}`),
    ).toEqual([
      '.agents/skills/c/SKILL.md invalid-frontmatter skill/field-type',
      '.agents/skills/d/SKILL.md blank-file -',
      '.claude/skills/a/SKILL.md invalid-frontmatter skill/name-format',
      '.claude/skills/b/SKILL.md invalid-frontmatter skill/description-missing',
    ]);
  });

  it(`${ALLOWANCES.firstSkipReason}: Cline never reads a nested AGENTS.md, blank or misnamed`, () => {
    const files = {
      'AGENTS.md': 'Rules.\n',
      'pkg/AGENTS.md': '',
      'lib/Agents.md': 'Mixed case.\n',
    };
    const allowed = check(files);
    expect(brief(allowed.report.mismatches)).toEqual([]);
    expect(allowed.report.allowed[ALLOWANCES.firstSkipReason]).toBe(2);
    expect(clinePlan(allowed)?.skipped.map((s) => [s.path, s.code, s.ruleId])).toEqual([
      ['lib/Agents.md', 'not-read', undefined],
      ['pkg/AGENTS.md', 'not-read', undefined],
    ]);
    expect(brief(check(files, [ALLOWANCES.firstSkipReason]).report.mismatches)).toEqual([
      'finding-without-skip instr/empty-file cline pkg/AGENTS.md',
      'finding-without-skip instr/filename-case cline lib/Agents.md',
    ]);
  });

  it('cites instr/empty-file wherever it reports a blank file for Cline', () => {
    const { plans, report } = check({
      'AGENTS.md': '',
      '.cursorrules': ' \n',
      '.clinerules/rule.md': '---\npaths: [src/**]\n---\n',
    });
    expect(brief(report.mismatches)).toEqual([]);
    expect(report.allowed['skip-without-rule']).toBeUndefined();
    expect(
      plans
        .find((plan) => plan.agent === 'cline')
        ?.skipped.map((s) => `${s.path} ${s.code} ${s.ruleId ?? '-'}`),
    ).toEqual([
      '.clinerules/rule.md blank-file instr/empty-file',
      '.cursorrules blank-file instr/empty-file',
      'AGENTS.md blank-file instr/empty-file',
    ]);
  });
});

describe('Cline consistency on generated snapshots', () => {
  const FRONTMATTER = (body: string): string => `---\n${body}\n---\nBody text.\n`;
  const markdown = fc.oneof(
    fc.constantFrom(
      '',
      '  \n\t\n',
      '﻿',
      'Plain instructions.\n',
      '---\npaths: []\n---\nNever.\n',
      '---\npaths: [src/**]\n---\n',
      '---\nname: [x\n---\nBody.\n',
      '﻿---\nname: x\ndescription: Y.\n---\n',
      '---\nunclosed: true\n',
    ),
    fc
      .array(
        fc.tuple(
          fc.constantFrom('name', 'description', 'paths', 'disabled', 'enabled'),
          fc.constantFrom('x', 'Does x.', '[src/**]', '[]', 'true', '3', '{a: 1}', ''),
        ),
        { maxLength: 3 },
      )
      .map((fields) => FRONTMATTER(fields.map(([key, value]) => `${key}: ${value}`).join('\n'))),
  );
  const path = fc.constantFrom(
    'AGENTS.md',
    'Agents.md',
    'pkg/AGENTS.md',
    'pkg/sub/Agents.md',
    '.clinerules/a.md',
    '.clinerules/AGENTS.md',
    '.clinerules/CLAUDE.md',
    '.clinerules/sub/b.md',
    '.clinerules/workflows/w.md',
    '.clinerules/hooks/h.md',
    '.clinerules/skills/s/SKILL.md',
    '.cline/rules/r.md',
    '.cline/workflows/w.md',
    '.cline/skills/k/SKILL.md',
    '.cline/skills/SKILL.md',
    '.agents/skills/a/SKILL.md',
    '.agents/skills/deep/x/SKILL.md',
    '.claude/skills/c/SKILL.md',
    'pkg/.clinerules/n.md',
    '.cursorrules',
    '.windsurfrules',
    'pkg/.cursorrules',
  );

  it('finds no mismatch for Cline', () => {
    fc.assert(
      fc.property(fc.dictionary(path, markdown, { maxKeys: 8 }), (generated) => {
        const checked = checkSnapshot(snapshotFrom(generated, { paths: ['.git/HEAD'] }));
        expect(brief(checked.report.mismatches.filter((m) => m.agent === 'cline'))).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
