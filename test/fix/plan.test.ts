import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyze, runRules } from '../../src/core/engine.js';
import type {
  AnyRule,
  Artifact,
  FileChange,
  Fix,
  FixClass,
  Severity,
  Snapshot,
} from '../../src/core/types.js';
import { insertLine } from '../../src/fix/edits.js';
import type { FixPlan, FixSelection } from '../../src/fix/index.js';
import { LITERAL_SECRET_RULE, MAX_FIXES, type PlanOptions, planFixes } from '../../src/fix/plan.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../helpers/lint.js';
import { ALL_CLASSES, SAFE_ONLY, testRule } from './helpers.js';

interface Spec {
  readonly id: string;
  readonly severity?: Severity;
  readonly cls?: FixClass;
  readonly changes?: (artifact: Artifact) => readonly FileChange[];
  readonly guidance?: string;
  /** Report at this offset, one character long. */
  readonly at?: number;
}

/** A rule reporting every AGENTS.md once, with the fix built from `changes`. */
function rule(spec: Spec): AnyRule {
  return testRule({
    id: spec.id,
    ...(spec.severity === undefined ? {} : { severity: spec.severity }),
    check(context, artifact) {
      const changes = spec.changes?.(artifact);
      const fix: Fix | undefined =
        changes === undefined
          ? undefined
          : { id: `${spec.id}#fix`, class: spec.cls ?? 'safe', title: spec.id, changes };
      context.report({
        artifact,
        message: `${spec.id} saw it.`,
        ...(spec.at === undefined ? {} : { span: { offset: spec.at, length: 1 } }),
        ...(fix === undefined ? {} : { fix }),
        ...(spec.guidance === undefined ? {} : { guidance: spec.guidance }),
      });
    },
  });
}

const edit = (offset: number, length: number, text: string, path = 'AGENTS.md'): FileChange => ({
  kind: 'edit',
  path,
  edits: [{ offset, length, text }],
});

function plan(
  rules: readonly AnyRule[],
  files: FileMap = { 'AGENTS.md': '0123456789\n' },
  selection: FixSelection = ALL_CLASSES,
  extras: SnapshotExtras = {},
  options: PlanOptions = {},
): FixPlan & { snapshot: Snapshot } {
  const snapshot = snapshotFrom(files, extras);
  const analysis = analyze(snapshot);
  const result = runRules(analysis, { rules });
  expect(result.ruleFailures).toEqual([]);
  return { ...planFixes(analysis, result, selection, options), snapshot };
}

/** `ruleId:status[:reason]` per fix, in plan order. */
function statuses(result: FixPlan): string[] {
  return result.fixes.map((fix) =>
    [fix.ruleId, fix.status, ...(fix.status === 'skipped' ? [fix.reason] : [])].join(':'),
  );
}

describe('the conflict matrix', () => {
  const pair = (a: FileChange[], b: FileChange[], files?: FileMap) =>
    plan(
      [rule({ id: 'test/a', changes: () => a }), rule({ id: 'test/b', changes: () => b })],
      files,
    );

  it.each([
    ['overlapping edits', [edit(0, 5, 'x')], [edit(3, 5, 'y')], 'overlapping-edits'],
    [
      'an insertion inside a replacement',
      [edit(0, 5, 'x')],
      [edit(2, 0, 'y')],
      'overlapping-edits',
    ],
    ['inserts at one offset', [edit(0, 0, 'x')], [edit(0, 0, 'y')], 'same-offset-inserts'],
    [
      'two creates of one path',
      [{ kind: 'create', path: 'NEW.md', text: 'a\n' }],
      [{ kind: 'create', path: 'NEW.md', text: 'b\n' }],
      'same-target',
    ],
    [
      'creates differing only in case',
      [{ kind: 'create', path: 'NEW.md', text: 'a\n' }],
      [{ kind: 'create', path: 'new.md', text: 'a\n' }],
      'same-target',
    ],
    [
      'a create where a rename lands',
      [{ kind: 'create', path: 'NEW.md', text: 'a\n' }],
      [{ kind: 'rename', from: 'AGENTS.md', to: 'NEW.md' }],
      'same-target',
    ],
    [
      'an edit of a file another fix renames',
      [{ kind: 'rename', from: 'AGENTS.md', to: 'MOVED.md' }],
      [edit(0, 0, 'x')],
      'renamed-source',
    ],
    [
      'an encoding change of a file another fix renames',
      [{ kind: 'rename', from: 'AGENTS.md', to: 'MOVED.md' }],
      [{ kind: 'encoding', path: 'AGENTS.md', to: 'utf-8', bom: false }],
      'renamed-source',
    ],
    [
      'two renames of one file',
      [{ kind: 'rename', from: 'AGENTS.md', to: 'A.md' }],
      [{ kind: 'rename', from: 'AGENTS.md', to: 'B.md' }],
      'renamed-source',
    ],
  ] as const)('%s conflict', (_, a, b, kind) => {
    const result = pair([...a], [...b]);
    expect(statuses(result)).toEqual(['test/a:planned', 'test/b:skipped:conflict']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind,
      winner: { ruleId: 'test/a', status: 'planned' },
      loser: { ruleId: 'test/b', status: 'skipped', reason: 'conflict' },
    });
    expect(result.conflicts[0]?.winner).toBe(result.fixes[0]);
    expect(result.conflicts[0]?.loser).toBe(result.fixes[1]);
  });

  it.each([
    ['identical edits', [edit(0, 0, 'x')], [edit(0, 0, 'x')]],
    ['touching edits', [edit(0, 2, 'x')], [edit(2, 0, 'y')]],
    ['an insertion before a replacement', [edit(2, 0, 'x')], [edit(2, 3, 'y')]],
    ['edits of different files', [edit(0, 0, 'x')], [edit(0, 0, 'x', 'CLAUDE.md')]],
    [
      'identical creates',
      [{ kind: 'create', path: 'NEW.md', text: 'a\n' }],
      [{ kind: 'create', path: 'NEW.md', text: 'a\n' }],
    ],
    [
      'identical renames with edits',
      [{ kind: 'rename', from: 'AGENTS.md', to: 'A.md' }, edit(0, 0, 'x', 'A.md')],
      [{ kind: 'rename', from: 'AGENTS.md', to: 'A.md' }, edit(4, 0, 'y', 'A.md')],
    ],
    [
      'an encoding change and an edit',
      [{ kind: 'encoding', path: 'AGENTS.md', to: 'utf-8', bom: false }],
      [edit(0, 0, 'x')],
    ],
  ] as const)('%s do not conflict', (_, a, b) => {
    const result = pair([...a], [...b], { 'AGENTS.md': '0123456789\n', 'CLAUDE.md': 'c\n' });
    expect(statuses(result)).toEqual(['test/a:planned', 'test/b:planned']);
    expect(result.conflicts).toEqual([]);
  });

  it('lets safe beat review, then severity, then rule id, then position', () => {
    const overlapping = (text: string) => () => [edit(0, 5, text)];
    const winner = (...rules: AnyRule[]) =>
      plan(rules).fixes.find((fix) => fix.status === 'planned')?.ruleId;
    expect(
      winner(
        rule({ id: 'test/a', severity: 'error', cls: 'review', changes: overlapping('a') }),
        rule({ id: 'test/b', severity: 'info', cls: 'safe', changes: overlapping('b') }),
      ),
    ).toBe('test/b');
    expect(
      winner(
        rule({ id: 'test/a', severity: 'warn', changes: overlapping('a') }),
        rule({ id: 'test/b', severity: 'error', changes: overlapping('b') }),
      ),
    ).toBe('test/b');
    expect(
      winner(
        rule({ id: 'test/b', changes: overlapping('b') }),
        rule({ id: 'test/a', changes: () => [edit(1, 5, 'y')] }),
      ),
    ).toBe('test/a');
    // One rule, two findings with different fixes: the earlier position wins.
    const twice = testRule({
      id: 'test/twice',
      check(context, artifact) {
        for (const at of [6, 2]) {
          context.report({
            artifact,
            message: 'Twice.',
            span: { offset: at, length: 1 },
            fix: {
              id: `test/twice#${at}`,
              class: 'safe',
              title: 't',
              changes: [edit(0, 8, `${at}`)],
            },
          });
        }
      },
    });
    const result = plan([twice]);
    expect(result.fixes.map((fix) => [fix.fix.id, fix.status])).toEqual([
      ['test/twice#2', 'planned'],
      ['test/twice#6', 'skipped'],
    ]);
  });
});

describe('selection', () => {
  const rules = [
    rule({ id: 'test/safe', changes: () => [edit(0, 0, 'a')] }),
    rule({ id: 'test/review', cls: 'review', changes: () => [edit(1, 0, 'b')], guidance: 'do it' }),
    rule({ id: LITERAL_SECRET_RULE, cls: 'review', changes: () => [edit(2, 0, 'c')] }),
  ];

  it('filters by class, rule and the literal-secret opt-in', () => {
    expect(statuses(plan(rules)).sort()).toEqual(['test/review:planned', 'test/safe:planned']);
    expect(statuses(plan(rules, undefined, SAFE_ONLY))).toEqual(['test/safe:planned']);
    expect(
      statuses(plan(rules, undefined, { ...ALL_CLASSES, literalSecret: true })).sort(),
    ).toEqual(['mcp/literal-secret:planned', 'test/review:planned', 'test/safe:planned']);
    expect(
      statuses(plan(rules, undefined, { ...ALL_CLASSES, ruleIds: new Set(['test/review']) })),
    ).toEqual(['test/review:planned']);
  });

  it('lists a finding with guidance and no selected fix as a manual step', () => {
    const result = plan(
      [...rules, rule({ id: 'test/manual', guidance: 'create docs/setup.md', at: 3 })],
      undefined,
      SAFE_ONLY,
    );
    expect(result.manual).toEqual(
      [
        { ruleId: 'test/review', path: 'AGENTS.md', line: 1, guidance: 'do it' },
        { ruleId: 'test/manual', path: 'AGENTS.md', line: 1, guidance: 'create docs/setup.md' },
      ].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1)),
    );
    const filtered = plan(rules.concat(rule({ id: 'test/manual', guidance: 'x' })), undefined, {
      ...SAFE_ONLY,
      ruleIds: new Set(['test/safe']),
    });
    expect(filtered.manual).toEqual([]);
    // No guidance, no manual step.
    expect(plan([rule({ id: 'test/plain' })]).manual).toEqual([]);
  });

  it('never fixes a suppressed finding', () => {
    const files = {
      'AGENTS.md': '<!-- agentcheckup-disable-next-line test/safe -- on purpose -->\n0123456789\n',
    };
    const suppressed = plan(
      [rule({ id: 'test/safe', at: 70, changes: () => [edit(0, 0, 'a')], guidance: 'x' })],
      files,
    );
    expect(suppressed.fixes).toEqual([]);
    expect(suppressed.manual).toEqual([]);
  });

  it('merges findings that carry an identical fix', () => {
    const twice = testRule({
      id: 'test/twice',
      check(context, artifact) {
        for (const at of [1, 5]) {
          context.report({
            artifact,
            message: `At ${at}.`,
            span: { offset: at, length: 1 },
            fix: { id: 'test/twice#fix', class: 'safe', title: 't', changes: [edit(0, 0, 'x')] },
          });
        }
      },
    });
    const result = plan([twice]);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]?.findings).toHaveLength(2);
    expect([...(result.fixes[0]?.findings ?? [])]).toEqual(
      [...(result.fixes[0]?.findings ?? [])].sort(),
    );
  });

  it('leaves out excluded fixes, keeping their guidance', () => {
    const result = plan(
      rules,
      undefined,
      ALL_CLASSES,
      {},
      {
        exclude: (candidate) => candidate.ruleId === 'test/review',
      },
    );
    expect(statuses(result)).toEqual(['test/safe:planned']);
    expect(result.manual.map((step) => step.ruleId)).toEqual(['test/review']);
  });
});

describe('paths', () => {
  const refused = (
    changes: (artifact: Artifact) => readonly FileChange[],
    files: FileMap = { 'AGENTS.md': '# A\n' },
    extras: SnapshotExtras = {},
  ) => plan([rule({ id: 'test/fix', changes })], files, ALL_CLASSES, extras);

  it('turns a fix of a file reached through a symlink into a manual step', () => {
    const result = refused(
      () => [edit(0, 0, 'x', 'CLAUDE.md')],
      { 'AGENTS.md': '# A\n', 'CLAUDE.md': '# A\n' },
      {
        symlinks: { 'CLAUDE.md': 'AGENTS.md' },
      },
    );
    expect(statuses(result)).toEqual(['test/fix:skipped:refused-path']);
    expect(result.manual).toEqual([
      {
        ruleId: 'test/fix',
        path: 'AGENTS.md',
        line: 1,
        guidance: 'CLAUDE.md is reached through a symbolic link; edit AGENTS.md by hand',
      },
    ]);
  });

  it('keeps the rule guidance over the generated one', () => {
    const result = plan(
      [
        rule({
          id: 'test/fix',
          changes: () => [edit(0, 0, 'x', 'docs/missing.md')],
          guidance: 'edit it yourself',
        }),
      ],
      { 'AGENTS.md': '# A\n' },
    );
    expect(result.manual.map((step) => step.guidance)).toEqual(['edit it yourself']);
  });

  it.each([
    ['a file the scan did not read', [edit(0, 0, 'x', 'docs/guide.md')], /was not read/],
    ['a path with ..', [edit(0, 0, 'x', '../AGENTS.md')], /"\." or "\.\." segment/],
    ['an absolute path', [{ kind: 'create', path: '/etc/x', text: 'x' }], /absolute/],
    ['a reserved name', [{ kind: 'create', path: 'docs/aux.md', text: 'x' }], /reserves/],
    ['an existing target', [{ kind: 'create', path: 'AGENTS.md', text: 'x' }], /already exists/],
    [
      'a target differing in case',
      [{ kind: 'create', path: 'agents.md', text: 'x' }],
      /already exists/,
    ],
    ['an ignored target', [{ kind: 'create', path: 'secret.md', text: 'x' }], /already exists/],
    ['a target below a file', [{ kind: 'create', path: 'AGENTS.md/x.md', text: 'x' }], /is a file/],
    [
      'a target in an unlisted directory',
      [{ kind: 'create', path: 'node_modules/x.md', text: 'x' }],
      /already exists or may exist/,
    ],
    [
      'a target below a possible symlink',
      [{ kind: 'create', path: '.claude/skills/new/SKILL.md', text: 'x' }],
      /symbolic link/,
    ],
    [
      'a target below an unresolved symlink',
      [{ kind: 'create', path: 'linked/x.md', text: 'x' }],
      /symbolic link/,
    ],
    [
      'a case-only rename',
      [{ kind: 'rename', from: 'AGENTS.md', to: 'Agents.md' }],
      /only the case differs/,
    ],
    ['a file that does not decode', [edit(0, 0, 'x', 'BAD.md')], /does not decode/],
  ] as const)('refuses %s', (_, changes, guidance) => {
    const files: FileMap = {
      'AGENTS.md': '# A\n',
      'BAD.md': new Uint8Array([0x61, 0xff]),
      '.agents/skills/demo/SKILL.md': '---\nname: demo\n---\n',
      '.claude/skills/demo/SKILL.md': '---\nname: demo\n---\n',
    };
    const snapshot: Snapshot = {
      ...snapshotFrom(files, {
        paths: ['docs/guide.md'],
        ignoredFiles: ['secret.md'],
        opaqueDirectories: ['node_modules/'],
        symlinks: { '.claude/skills/demo/SKILL.md': '.agents/skills/demo/SKILL.md' },
      }),
      unresolvedSymlinks: [{ path: 'linked', target: '/etc', problem: 'outside-root' }],
    };
    const analysis = analyze(snapshot);
    const result = planFixes(
      analysis,
      runRules(analysis, { rules: [rule({ id: 'test/fix', changes: () => [...changes] })] }),
      ALL_CLASSES,
    );
    expect(statuses(result)).toEqual(['test/fix:skipped:refused-path']);
    expect(result.manual[0]?.guidance).toMatch(guidance);
  });

  it('allows a create next to a symlinked file', () => {
    const result = refused(
      () => [{ kind: 'create', path: '.claude/NEW.md', text: 'x' }],
      { 'AGENTS.md': '# A\n', '.claude/CLAUDE.md': '# A\n' },
      { symlinks: { '.claude/CLAUDE.md': 'AGENTS.md' } },
    );
    expect(statuses(result)).toEqual(['test/fix:planned']);
  });

  // Reduced from apache/airflow in the corpus: sdk/_shared/AGENTS.md is a symlink to
  // core/_shared/AGENTS.md, so sdk/ might be a link too, unless a file below it was read at its
  // own path, which a file below a symlinked directory never is.
  it('allows a create below a directory that holds a file read at its own path', () => {
    const files: FileMap = {
      'core/_shared/AGENTS.md': '# Shared\n',
      'sdk/_shared/AGENTS.md': '# Shared\n',
      'sdk/schema/AGENTS.md': '# Schema\n',
    };
    const extras: SnapshotExtras = {
      symlinks: { 'sdk/_shared/AGENTS.md': 'core/_shared/AGENTS.md' },
    };
    const allowed = refused(
      () => [{ kind: 'create', path: 'sdk/schema/CLAUDE.md', text: '@AGENTS.md\n' }],
      files,
      extras,
    );
    expect(statuses(allowed)).toEqual(['test/fix:planned']);
    const below = refused(
      () => [{ kind: 'create', path: 'sdk/_shared/CLAUDE.md', text: '@AGENTS.md\n' }],
      files,
      extras,
    );
    expect(statuses(below)).toEqual(['test/fix:skipped:refused-path']);
    expect(below.manual[0]?.guidance).toMatch(/sdk\/_shared\/ may be a symbolic link/);
  });

  it('skips a fix whose edits do not fit the file', () => {
    for (const changes of [
      [edit(99, 0, 'x')],
      [{ kind: 'rename', from: 'AGENTS.md', to: 'B.md' }, edit(0, 0, 'x')],
    ] as FileChange[][]) {
      const result = refused(() => changes);
      expect(statuses(result)).toEqual(['test/fix:skipped:verification-failed']);
      expect(result.manual).toEqual([]);
    }
  });
});

describe('limits and order', () => {
  it(`plans at most ${MAX_FIXES} fixes`, () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_FIXES; i++)
      files[`p${String(i).padStart(4, '0')}/AGENTS.md`] = '# A\n';
    const result = plan(
      [rule({ id: 'test/many', changes: (artifact) => [insertLine(artifact, 0, 'x')] })],
      files,
    );
    expect(result.fixes.filter((fix) => fix.status === 'planned')).toHaveLength(MAX_FIXES);
    expect(result.fixes.at(-1)).toMatchObject({ status: 'skipped', reason: 'limit' });
    const few = plan(
      [rule({ id: 'test/many', changes: (artifact) => [insertLine(artifact, 0, 'x')] })],
      files,
      ALL_CLASSES,
      {},
      { maxFixes: 2 },
    );
    expect(statuses(few).filter((status) => status.endsWith('planned'))).toHaveLength(2);
  });

  it('does not depend on the order of findings', () => {
    const rules = [
      rule({ id: 'test/a', changes: () => [edit(0, 5, 'x')], at: 4 }),
      rule({ id: 'test/b', changes: () => [edit(3, 5, 'y')], at: 1 }),
      rule({ id: 'test/c', changes: () => [edit(9, 0, 'z')], guidance: 'c', at: 2 }),
      rule({ id: 'test/d', cls: 'review', changes: () => [edit(9, 0, 'z')], at: 0 }),
      rule({ id: 'test/e', guidance: 'manual', at: 5 }),
      rule({ id: 'test/f', changes: () => [{ kind: 'create', path: 'N.md', text: 'n' }] }),
      rule({
        id: 'test/g',
        severity: 'error',
        changes: () => [{ kind: 'create', path: 'n.md', text: 'm' }],
      }),
    ];
    const snapshot = snapshotFrom({
      'AGENTS.md': '0123456789\n',
      'docs/AGENTS.md': 'abcdefghij\n',
    });
    const analysis = analyze(snapshot);
    const result = runRules(analysis, { rules });
    const expected = planFixes(analysis, result, ALL_CLASSES);
    expect(expected.conflicts.length).toBeGreaterThan(1);
    // Report order: the position of each fix's first finding.
    const positions = expected.fixes.map(
      (fix) =>
        result.findings
          .filter((item) => fix.findings.includes(item.fingerprint))
          .map((item) => `${item.path}:${String(item.range.start.column).padStart(3, '0')}`)
          .sort()[0],
    );
    expect(positions).toEqual([...positions].sort());
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...result.findings], { minLength: result.findings.length }),
        (shuffled) => {
          expect(planFixes(analysis, { findings: shuffled }, ALL_CLASSES)).toEqual(expected);
        },
      ),
    );
  });
});
