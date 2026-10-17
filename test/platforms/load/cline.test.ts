import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/compare.js';
import { analyze, type Analysis, type RuleResult, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { walk } from '../../../src/io/walk.js';
import { loadCline } from '../../../src/platforms/load/cline.js';
import { citedSourceKeys, loadPlan, sourcesOf } from '../../../src/platforms/load/index.js';
import type { LoadEntry, LoadPlan } from '../../../src/platforms/load/types.js';
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
  return { plan: loadCline(analysis, { cwd, config: analysis.config }), result, analysis };
}

function build(files: FileMap, extras: SnapshotExtras = {}, cwd = ''): Built {
  return buildFrom(snapshotFrom(files, extras), cwd);
}

async function fixture(name: string): Promise<Built> {
  return buildFrom(
    await walk(fileURLToPath(new URL(`../../fixtures/cline/${name}`, import.meta.url))),
  );
}

function entry(plan: LoadPlan, id: string): LoadEntry | undefined {
  return plan.entries.find((candidate) => candidate.id === id);
}

/** `position id trigger certainty` for each entry, in plan order. */
function summary(plan: LoadPlan): string[] {
  return plan.entries.map(
    (e) =>
      `${e.position === undefined ? '-' : String(e.position)} ${e.id} ${e.trigger} ${e.certainty}`,
  );
}

/** `path code ruleId certainty` for each skip. */
function skips(plan: LoadPlan): string[] {
  return plan.skipped.map((s) => `${s.path} ${s.code} ${s.ruleId ?? '-'} ${s.certainty}`);
}

/** Every path the plan mentions in any list. */
function mentioned(plan: LoadPlan): string[] {
  return [
    ...plan.entries.map((item) => item.path),
    ...plan.skipped.map((item) => item.path),
    ...plan.outOfScope.map((item) => item.path),
    ...plan.incomplete.map((item) => item.slice(item.indexOf(':') + 1)),
  ];
}

/**
 * Every skip that names a rule has an unsuppressed finding of that rule on the same file that
 * lists Cline. A skip on a symlink alias is reported on the real file.
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
        finding.platforms.includes('cline'),
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
  // Every cited source exists.
  expect(() => sourcesOf(citedSourceKeys([plan]))).not.toThrow();
  for (const item of [...plan.entries, ...plan.skipped]) {
    expect(item.evidence.length, item.id).toBeGreaterThan(0);
  }
}

const FRONTMATTER = (fields: string, body = 'Body.\n'): string => `---\n${fields}\n---\n${body}`;

describe('loadCline: the workspace fixture', () => {
  it('loads in source order and covers every trigger and skip', async () => {
    const built = await fixture('workspace');
    const { plan } = built;
    expect(summary(plan)).toEqual([
      '1 instructions:AGENTS.md startup documented',
      // Invalid YAML: the docs say Cline fails open, the SDK drops the rule.
      '2 rule:.clinerules/broken.md startup unverified',
      // A subfolder: the SDK reads only the folder itself.
      '3 rule:.clinerules/frontend/react.md startup unverified',
      '4 rule:.clinerules/general.md startup documented',
      '5 rule:.cline/rules/db.md startup documented',
      '6 instructions:.cursorrules startup documented',
      '7 instructions:.windsurfrules startup documented',
      // The skills listing; a skill without a description is listed by the SDK, not the docs.
      '8 skill:.agents/skills/notes/SKILL.md startup unverified',
      '9 skill:.claude/skills/deploy/SKILL.md startup source-code',
      '10 skill:.cline/skills/review/SKILL.md startup documented',
      '11 skill:.clinerules/skills/lint/SKILL.md startup source-code',
      '- rule:.clinerules/testing.md on-path documented',
      '- command:.cline/workflows/hotfix.md manual source-code',
      '- command:.clinerules/workflows/deploy.md manual source-code',
      '- command:.clinerules/workflows/release.md manual source-code',
      '- rule:.clinerules/string-paths.md unknown unverified',
    ]);
    expect(entry(plan, 'rule:.clinerules/testing.md')?.patterns).toEqual(['**/*.test.ts']);
    expect(
      plan.entries.filter((e) => e.role === 'command').map((e) => `${e.path} /${e.name ?? ''}`),
    ).toEqual([
      '.cline/workflows/hotfix.md /hotfix',
      '.clinerules/workflows/deploy.md /deploy',
      '.clinerules/workflows/release.md /ship',
    ]);
    expect(skips(plan)).toEqual([
      '.agents/skills/team/deep/SKILL.md not-read - source-code',
      '.cline/skills/broken/SKILL.md invalid-frontmatter - source-code',
      '.clinerules/blank.md blank-file instr/empty-file source-code',
      '.clinerules/never.md never-active - documented',
      'packages/api/AGENTS.md not-read - source-code',
    ]);
    expect(plan.outOfScope).toEqual([
      { path: 'sdk/.cline/rules/nested.md', because: 'below-start-dir' },
    ]);
    // Hooks and plugins have no documented format; .txt and .markdown rules are not read.
    expect(plan.incomplete).toEqual([
      'unparsed:.cline/hooks/notify.js',
      'unparsed:.cline/plugins/guard.ts',
      'unparsed:.clinerules/hooks/README.md',
      'unparsed:.clinerules/hooks/pre-tool.sh',
      'unread:.clinerules/notes.txt',
      'unread:.clinerules/style.markdown',
    ]);
    expectSkipsReported(built);
    expectSorted(plan);
  });

  it('never mentions a file Cline does not read', async () => {
    const { plan } = await fixture('workspace');
    const paths = mentioned(plan);
    for (const path of [
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/style.mdc',
      '.clinerules/settings.json',
    ]) {
      expect(paths, path).not.toContain(path);
    }
    // No MCP server or hook is loaded from the repository.
    expect(plan.entries.some((e) => e.role === 'mcp-server' || e.role === 'hook')).toBe(false);
  });

  it('reads the legacy single-file .clinerules, which the scan does not read', async () => {
    const built = await fixture('legacy');
    expect(built.plan.entries).toEqual([]);
    expect(skips(built.plan)).toEqual([
      '.windsurfrules blank-file instr/empty-file unverified',
      'Agents.md case-mismatch instr/filename-case source-code',
    ]);
    expect(built.plan.incomplete).toEqual(['unread:.clinerules']);
    expectSkipsReported(built);
  });

  it('states its assumptions and the scopes it cannot see', async () => {
    const { plan } = await fixture('workspace');
    expect(plan.assumptions.map((a) => `${a.key}=${String(a.value)} ${a.origin}`)).toEqual([
      'cline.ruleToggles=all on default',
      'cline.surface=vscode default',
    ]);
    const hidden = plan.hidden.flatMap((scope) => scope.locations);
    expect(hidden).toEqual(
      expect.arrayContaining([
        '~/Documents/Cline/Rules',
        '~/.cline/rules',
        '~/.cline/skills',
        '~/.cline/hooks',
        '~/.cline/workflows',
        '~/Cline/Rules',
        '~/.agents/AGENTS.md',
        '~/.agents/skills',
        '~/.cline/data/settings/cline_mcp_settings.json',
      ]),
    );
    expect(plan.hidden.every((scope) => scope.scope === 'user')).toBe(true);
  });
});

describe('loadCline: rules', () => {
  it('maps paths to triggers: none, a list, an empty list, and other forms', () => {
    const built = build({
      '.clinerules/always.md': 'Always.\n',
      '.clinerules/no-paths.md': FRONTMATTER('description: x'),
      '.clinerules/null.md': FRONTMATTER('paths:'),
      '.clinerules/scoped.md': FRONTMATTER('paths:\n  - src/**\n  - " "\n  - test/**'),
      '.clinerules/never.md': FRONTMATTER('paths: []'),
      '.clinerules/blank-globs.md': FRONTMATTER('paths: [" "]'),
      '.clinerules/mixed.md': FRONTMATTER('paths: [src/**, 3]'),
      '.clinerules/unclosed.md': '---\npaths: []\nNo closing line.\n',
    });
    expect(summary(built.plan)).toEqual([
      '1 rule:.clinerules/always.md startup documented',
      '2 rule:.clinerules/no-paths.md startup documented',
      '3 rule:.clinerules/null.md startup documented',
      '4 rule:.clinerules/unclosed.md startup unverified',
      '- rule:.clinerules/scoped.md on-path documented',
      '- rule:.clinerules/mixed.md unknown unverified',
    ]);
    expect(entry(built.plan, 'rule:.clinerules/scoped.md')?.patterns).toEqual([
      'src/**',
      'test/**',
    ]);
    expect(skips(built.plan)).toEqual([
      '.clinerules/blank-globs.md never-active - unverified',
      '.clinerules/never.md never-active - documented',
    ]);
  });

  it('skips blank rules with the finding of instr/empty-file, before reading paths', () => {
    const built = build({
      '.clinerules/empty.md': '',
      '.clinerules/spaces.md': ' \n\t\n',
      '.clinerules/only-frontmatter.md': FRONTMATTER('paths: []', ''),
      '.cline/rules/blank.md': '\n',
      '.clinerules/kept.md': 'Kept.\n',
    });
    expect(skips(built.plan)).toEqual([
      '.cline/rules/blank.md blank-file instr/empty-file source-code',
      '.clinerules/empty.md blank-file instr/empty-file source-code',
      '.clinerules/only-frontmatter.md blank-file instr/empty-file source-code',
      '.clinerules/spaces.md blank-file instr/empty-file source-code',
    ]);
    expect(summary(built.plan)).toEqual(['1 rule:.clinerules/kept.md startup documented']);
    expectSkipsReported(built);
  });

  it('counts what Cline receives: the body after valid frontmatter, the whole file otherwise', () => {
    const scoped = FRONTMATTER('paths: [src/**]', 'Use strict mode.\n');
    const { plan } = build({
      '.clinerules/scoped.md': scoped,
      '.clinerules/broken.md': '---\npaths: [x\n---\nRaw.\n',
    });
    expect(entry(plan, 'rule:.clinerules/scoped.md')?.size).toEqual({
      bytes: scoped.length,
      chars: 'Use strict mode.\n'.length,
      tokens: 5,
    });
    const broken = '---\npaths: [x\n---\nRaw.\n';
    expect(entry(plan, 'rule:.clinerules/broken.md')?.size?.chars).toBe(broken.length);
    expect(plan.totals.startup.chars).toBe(broken.length);
    expect(plan.totals.onDemand.chars).toBe('Use strict mode.\n'.length);
  });

  it('keeps workflows, hooks and skills folders of .clinerules out of the rules', () => {
    const { plan } = build({
      '.clinerules/workflows/release.md': 'Release.\n',
      '.clinerules/workflows/nested/deep.md': 'Deep.\n',
      '.clinerules/hooks/README.md': '# Hooks\n',
      '.clinerules/skills/s/SKILL.md': FRONTMATTER('name: s\ndescription: Does s.'),
      '.clinerules/skills/s/notes.md': 'Skill resource.\n',
      '.cline/agents/helper.md': 'Not modeled.\n',
      '.cline/README.md': 'Documentation.\n',
    });
    expect(summary(plan)).toEqual([
      '1 skill:.clinerules/skills/s/SKILL.md startup source-code',
      '- command:.clinerules/workflows/nested/deep.md manual unverified',
      '- command:.clinerules/workflows/release.md manual source-code',
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.incomplete).toEqual(['unparsed:.clinerules/hooks/README.md']);
  });

  it('reads every Markdown file in a rules folder as a rule, whatever its name', () => {
    const built = build({
      '.clinerules/AGENTS.md': 'Rules named like AGENTS.md.\n',
      '.clinerules/CLAUDE.md': '',
      '.clinerules/SKILL.md': 'A rule, not a skill.\n',
      '.clinerules/README.md': 'A rule too.\n',
    });
    expect(summary(built.plan)).toEqual([
      '1 rule:.clinerules/AGENTS.md startup documented',
      '2 rule:.clinerules/README.md startup documented',
      '3 rule:.clinerules/SKILL.md startup documented',
    ]);
    // instr/empty-file judges .clinerules/CLAUDE.md as a CLAUDE.md, not for Cline.
    expect(skips(built.plan)).toEqual(['.clinerules/CLAUDE.md blank-file - source-code']);
    expectSkipsReported(built);
  });

  it('lists rule files the scan did not read: other extensions, too large, ignored', () => {
    const { plan } = build(
      { '.clinerules/a.md': 'A.\n' },
      {
        paths: [
          '.clinerules/b.txt',
          '.clinerules/c.markdown',
          '.clinerules/d.mdc',
          '.cline/rules/e.md',
        ],
        ignoredFiles: ['.clinerules/f.md'],
        opaqueDirectories: ['.cline/skills/', '.claude/worktrees/', '.cline/plugins/node_modules/'],
      },
    );
    expect(plan.incomplete).toEqual([
      'unread:.cline/rules/e.md',
      'unread:.cline/skills/',
      'unread:.clinerules/b.txt',
      'unread:.clinerules/c.markdown',
      'unread:.clinerules/f.md',
    ]);
  });
});

describe('loadCline: instructions', () => {
  it('reads only the workspace AGENTS.md; nested ones are not read', () => {
    const built = build({
      'AGENTS.md': 'Root.\n',
      'pkg/AGENTS.md': 'Nested.\n',
      'pkg/sub/AGENTS.md': '',
      '.github/AGENTS.md': 'Nested too.\n',
    });
    expect(summary(built.plan)).toEqual(['1 instructions:AGENTS.md startup documented']);
    expect(skips(built.plan)).toEqual([
      '.github/AGENTS.md not-read - source-code',
      'pkg/AGENTS.md not-read - source-code',
      'pkg/sub/AGENTS.md not-read - source-code',
    ]);
    // instr/empty-file lists Cline for the blank nested file; the plan's first reason is that
    // Cline never reads it (src/platforms/load/consistency.ts, first-skip-reason).
    const empty = built.result.findings.filter((f) => f.ruleId === 'instr/empty-file');
    expect(empty.map((f) => [f.path, f.platforms.includes('cline')])).toEqual([
      ['pkg/sub/AGENTS.md', true],
    ]);
  });

  it('skips a blank root AGENTS.md and one whose body after frontmatter is blank', () => {
    const blank = build({ 'AGENTS.md': ' \n' });
    expect(skips(blank.plan)).toEqual(['AGENTS.md blank-file instr/empty-file source-code']);
    expectSkipsReported(blank);
    // The SDK strips frontmatter from AGENTS.md too; instr/empty-file does not.
    const frontmatter = build({ 'AGENTS.md': FRONTMATTER('name: x', '') });
    expect(skips(frontmatter.plan)).toEqual(['AGENTS.md blank-file - source-code']);
  });

  it('reads .cursorrules and .windsurfrules at the workspace root only, by exact name', () => {
    const built = build({
      '.cursorrules': 'Cursor.\n',
      '.windsurfrules': 'Windsurf.\n',
      'pkg/.cursorrules': 'Nested.\n',
      '.CursorRules': 'Other case.\n',
    });
    expect(summary(built.plan)).toEqual([
      '1 instructions:.cursorrules startup documented',
      '2 instructions:.windsurfrules startup documented',
    ]);
    expect(skips(built.plan)).toEqual(['.CursorRules not-read - unverified']);
    expect(built.plan.outOfScope).toEqual([
      { path: 'pkg/.cursorrules', because: 'below-start-dir' },
    ]);
  });

  it('reads the files of a workspace opened in a subfolder, and nothing outside it', () => {
    const { plan } = build(
      {
        'AGENTS.md': 'Repository root.\n',
        '.clinerules/root.md': 'Root rule.\n',
        'apps/web/AGENTS.md': 'Web.\n',
        'apps/web/.clinerules/web.md': 'Web rule.\n',
        'apps/web/.cline/skills/s/SKILL.md': FRONTMATTER('name: s\ndescription: Does s.'),
        'apps/web/lib/.clinerules/deep.md': 'Deeper.\n',
      },
      {},
      'apps/web',
    );
    expect(summary(plan)).toEqual([
      '1 instructions:apps/web/AGENTS.md startup documented',
      '2 rule:apps/web/.clinerules/web.md startup documented',
      '3 skill:apps/web/.cline/skills/s/SKILL.md startup documented',
    ]);
    expect(plan.outOfScope).toEqual([
      { path: 'apps/web/lib/.clinerules/deep.md', because: 'below-start-dir' },
    ]);
    expect(mentioned(plan).filter((path) => !path.startsWith('apps/web/'))).toEqual([]);
  });

  it('follows a symlink by the name Cline sees', () => {
    const { plan } = build(
      { 'AGENTS.md': 'Shared.\n', '.clinerules/shared.md': 'Shared.\n' },
      { symlinks: { '.clinerules/shared.md': 'AGENTS.md' } },
    );
    const rule = entry(plan, 'rule:.clinerules/shared.md');
    expect(rule?.realPath).toBe('AGENTS.md');
    expect(rule?.trigger).toBe('startup');
  });
});

describe('loadCline: skills', () => {
  it('reads SKILL.md in one folder of a skills root, by exact name', () => {
    const { plan } = build({
      '.cline/skills/a/SKILL.md': FRONTMATTER('name: a\ndescription: Does a.'),
      '.cline/skills/team/b/SKILL.md': FRONTMATTER('name: b\ndescription: Too deep.'),
      '.cline/skills/c/skill.md': FRONTMATTER('name: c\ndescription: Wrong case.'),
      '.agents/skills/d/SKILL.md': FRONTMATTER('name: d\ndescription: Does d.'),
      'pkg/.agents/skills/e/SKILL.md': FRONTMATTER('name: e\ndescription: Nested.'),
      '.cursor/skills/f/SKILL.md': FRONTMATTER('name: f\ndescription: Cursor only.'),
      '.github/skills/g/SKILL.md': FRONTMATTER('name: g\ndescription: Copilot only.'),
    });
    expect(summary(plan)).toEqual([
      '1 skill:.agents/skills/d/SKILL.md startup source-code',
      '2 skill:.cline/skills/a/SKILL.md startup documented',
    ]);
    expect(skips(plan)).toEqual([
      '.cline/skills/c/skill.md not-read - source-code',
      '.cline/skills/team/b/SKILL.md not-read - source-code',
    ]);
    expect(plan.outOfScope).toEqual([
      { path: 'pkg/.agents/skills/e/SKILL.md', because: 'below-start-dir' },
    ]);
  });

  it('reads a SKILL.md in the skills root itself, next to the skills in its folders', () => {
    const { plan } = build({
      '.cline/skills/SKILL.md': FRONTMATTER('description: The root skill.'),
      '.cline/skills/a/SKILL.md': FRONTMATTER('name: a\ndescription: Does a.'),
    });
    // In the source, not the docs; it takes the name of its folder.
    expect(summary(plan)).toEqual([
      '1 skill:.cline/skills/SKILL.md startup source-code',
      '2 skill:.cline/skills/a/SKILL.md startup documented',
    ]);
    expect(entry(plan, 'skill:.cline/skills/SKILL.md')?.name).toBe('skills');
  });

  it('skips skills the SDK rejects: bad YAML, fields of the wrong type, no body', () => {
    const { plan } = build({
      '.cline/skills/yaml/SKILL.md': FRONTMATTER('name: [x'),
      '.cline/skills/name/SKILL.md': FRONTMATTER('name: [a, b]\ndescription: x'),
      '.cline/skills/desc/SKILL.md': FRONTMATTER('description: 3'),
      '.cline/skills/flag/SKILL.md': FRONTMATTER('description: x\ndisabled: "yes"'),
      '.cline/skills/empty/SKILL.md': FRONTMATTER('description: x', '\n'),
      '.cline/skills/list/SKILL.md': FRONTMATTER('- a\n- b'),
    });
    expect(skips(plan)).toEqual([
      '.cline/skills/desc/SKILL.md invalid-frontmatter - source-code',
      '.cline/skills/empty/SKILL.md blank-file - source-code',
      '.cline/skills/flag/SKILL.md invalid-frontmatter - source-code',
      '.cline/skills/name/SKILL.md invalid-frontmatter - source-code',
      '.cline/skills/yaml/SKILL.md invalid-frontmatter - source-code',
    ]);
    // YAML that is not a mapping gives the SDK no fields: the skill is named after its folder.
    expect(summary(plan)).toEqual(['1 skill:.cline/skills/list/SKILL.md startup unverified']);
    expect(entry(plan, 'skill:.cline/skills/list/SKILL.md')?.name).toBe('list');
  });

  it('lists name and description at startup, the body on demand, and the description limit', () => {
    const description = 'd'.repeat(1100);
    const { plan } = build({
      '.cline/skills/long/SKILL.md': FRONTMATTER(
        `name: long\ndescription: ${description}`,
        'Body.\n',
      ),
    });
    const skill = entry(plan, 'skill:.cline/skills/long/SKILL.md');
    expect(skill?.size?.chars).toBe('long\n'.length + description.length);
    expect(skill?.deferred?.chars).toBe('Body.\n'.length);
    expect(plan.totals.startup.chars).toBe(skill?.size?.chars);
    expect(plan.totals.onDemand.chars).toBe('Body.\n'.length);
    expect(plan.limits).toEqual([
      {
        key: 'cline.skill_description',
        unit: 'chars',
        limit: 1024,
        used: 1100,
        subject: '.cline/skills/long/SKILL.md',
        effect: 'advice',
        evidence: ['clineSkills'],
      },
    ]);
  });

  it('leaves a skill bundled deeper in another skill out', () => {
    const { plan } = build({
      '.cline/skills/outer/SKILL.md': FRONTMATTER('name: outer\ndescription: Outer.'),
      '.cline/skills/outer/assets/inner/SKILL.md': FRONTMATTER('name: inner\ndescription: x'),
    });
    expect(summary(plan)).toEqual(['1 skill:.cline/skills/outer/SKILL.md startup documented']);
    expect(plan.outOfScope).toEqual([
      { path: '.cline/skills/outer/assets/inner/SKILL.md', because: 'payload-folder' },
    ]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('loadCline: assembly', () => {
  it('is turned on and planned through loadPlans', () => {
    const analysis = analyze(snapshotFrom({ 'AGENTS.md': 'A.\n' }), SCAN);
    const plan = loadPlan(analysis, 'cline', { cwd: '', config: analysis.config });
    expect(plan.agent).toBe('cline');
    expect(summary(plan)).toEqual(['1 instructions:AGENTS.md startup documented']);
  });

  it('gives the same plan for the same files', async () => {
    const first = await fixture('workspace');
    const second = await fixture('workspace');
    expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
  });
});
