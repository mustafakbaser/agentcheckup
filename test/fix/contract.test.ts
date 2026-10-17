/**
 * The fix contract (ADR 0008): the types rules, the planner and reports share, the JSON shape of
 * `agentcheckup fix --format json`, and how the engine carries a rule's fix and guidance into
 * findings and reports.
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type ScanResult, scanSnapshot, scanWithContext } from '../../src/core/engine.js';
import type {
  AwaitingInput,
  Conflict,
  FixEffect,
  FixPlan,
  FixReport,
  FixSelection,
  FixSkipReason,
  FixStatus,
  FixVerification,
  ManualStep,
  PlannedFix,
} from '../../src/fix/index.js';
import {
  GATE_CLASSES,
  SEVERITIES,
  type DecodedText,
  type FileChange,
  type Finding,
  type Fix,
  type FixClass,
  type FixInput,
  type GateClass,
  type ReportDescriptor,
  type RuleMeta,
  type SkippedLoad,
  type Size,
  type Snapshot,
  type SourceFile,
  type SourceIdentity,
  type TextEdit,
} from '../../src/index.js';
import type { FileIdentity } from '../../src/io/safe-read.js';
import { ALL_CONTEXT_AGENTS } from '../../src/platforms/load/types.js';
import { FORMATS, format, formatJson } from '../../src/report/index.js';
import { defineRule } from '../../src/rules/define.js';
import { builtinRules } from '../../src/rules/index.js';
import { snapshotFrom } from '../helpers/lint.js';

/** `true` when `Listed` covers every member of `All`. */
type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;

type Json = Record<string, unknown>;

interface SchemaDocument {
  readonly $defs: Record<
    string,
    {
      enum?: unknown[];
      oneOf?: { properties: Record<string, { const?: unknown; enum?: unknown[] }> }[];
      properties?: Record<string, { enum?: unknown[] }>;
    }
  >;
}

function readSchema(name: string): SchemaDocument {
  return JSON.parse(
    readFileSync(new URL(`../../schemas/${name}`, import.meta.url), 'utf8'),
  ) as SchemaDocument;
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const fixSchema = readSchema('fix.schema.json');
const reportSchema = readSchema('report.schema.json');
const validateFix = ajv.compile<FixReport>(fixSchema);
const validateReport = ajv.compile(reportSchema);

const FINGERPRINT = '1a2b3c4d5e6f70:1';
const SHA_BEFORE = 'a'.repeat(64);
const SHA_AFTER = '0123456789abcdef'.repeat(4);

const importFix = {
  id: 'instr/agents-md-ignored-by-claude#import',
  class: 'safe',
  title: 'Add "@AGENTS.md" as line 1 of CLAUDE.md',
  changes: [
    { kind: 'edit', path: 'CLAUDE.md', edits: [{ offset: 0, length: 0, text: '@AGENTS.md\n\n' }] },
  ],
} as const satisfies Fix;

/** One of each change kind, with every optional field. */
const everyChange = {
  id: 'cursor/md-file-ignored#rename',
  class: 'review',
  title: 'Rename .cursor/rules/style.md to style.mdc',
  changes: [
    { kind: 'rename', from: '.cursor/rules/style.md', to: '.cursor/rules/style.mdc' },
    {
      kind: 'edit',
      path: '.cursor/rules/style.mdc',
      edits: [{ offset: 0, length: 0, text: '---\nalwaysApply: true\n---\n' }],
    },
    { kind: 'create', path: 'packages/api/CLAUDE.md', text: '@AGENTS.md\n' },
    { kind: 'encoding', path: 'AGENTS.md', to: 'utf-8', bom: false },
  ],
  notes: ['Cursor session start ≈304 → ≈614 tokens'],
  warning: 'Revoke and rotate this credential now.',
  alternatives: [importFix],
} as const satisfies Fix;

/** A dry run with a planned, a skipped and a gate-demoted fix. */
const dryRun = {
  schemaVersion: 1,
  tool: { name: 'agentcheckup', version: '1.4.0' },
  ruleset: '2026.10',
  mode: 'dry-run',
  fixes: [
    {
      id: importFix.id,
      ruleId: 'instr/agents-md-ignored-by-claude',
      class: 'safe',
      title: importFix.title,
      effects: [{ kind: 'tokens', agent: 'claude-code', cwd: '', before: 50, after: 247 }],
      findings: [FINGERPRINT],
      status: 'planned',
    },
    {
      id: 'mcp/url-without-type#type',
      ruleId: 'mcp/url-without-type',
      class: 'review',
      title: 'Add "type": "http" to MCP server docs',
      effects: [
        {
          kind: 'gate',
          class: 'mcp',
          id: 'mcp:.mcp.json#docs',
          change: 'changed',
          summary: 'MCP server docs → https://docs.example.com',
        },
      ],
      findings: ['2b3c4d5e6f7081:1', '2b3c4d5e6f7081:2'],
      notes: ['Claude Code will offer to start it; `claude -p` starts it without asking.'],
      status: 'skipped',
      reason: 'conflict',
    },
  ],
  files: [
    {
      path: 'CLAUDE.md',
      op: 'edit',
      before: { sha256: SHA_BEFORE, encoding: 'utf-8', bom: false, lineEnding: 'crlf' },
      after: { sha256: SHA_AFTER, encoding: 'utf-8', bom: false, lineEnding: 'crlf' },
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 4,
          lines: ['+@AGENTS.md', '+', ' # Acme API', ' ', '\\ No newline at end of file'],
        },
      ],
    },
    {
      path: '.cursor/rules/style.mdc',
      op: 'rename',
      from: '.cursor/rules/style.md',
      before: { sha256: SHA_BEFORE, encoding: 'utf-16le', bom: true, lineEnding: 'mixed' },
      after: { sha256: SHA_AFTER, encoding: 'utf-8', bom: false, lineEnding: 'mixed' },
      hunks: [],
    },
    {
      path: 'packages/api/CLAUDE.md',
      op: 'create',
      after: { sha256: SHA_AFTER, encoding: 'utf-8', bom: false, lineEnding: 'none' },
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+@AGENTS.md'] }],
    },
  ],
  manual: [
    {
      ruleId: 'instr/import-unresolved',
      path: 'CLAUDE.md',
      line: 3,
      guidance: 'create docs/setup.md or correct the path',
    },
  ],
  verification: {
    resolved: 4,
    remaining: 1,
    introduced: [
      {
        ruleId: 'skill/description-quality',
        severity: 'info',
        path: '.agents/skills/release-notes/SKILL.md',
        line: 2,
        message: 'The description does not say when to use the skill.',
      },
    ],
  },
} as const satisfies FixReport;

const written = {
  ...dryRun,
  mode: 'write',
  pathBase: 'packages/app',
  fixes: [{ ...dryRun.fixes[0], status: 'applied' }],
  manual: [],
  verification: { resolved: 1, remaining: 0, introduced: [] },
} as const satisfies FixReport;

const empty = {
  ...dryRun,
  mode: 'interactive',
  fixes: [],
  files: [],
  manual: [],
  verification: { resolved: 0, remaining: 0, introduced: [] },
} as const satisfies FixReport;

function copy(value: FixReport): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function at(value: unknown, ...keys: (string | number)[]): Json {
  return keys.reduce<unknown>((node, key) => (node as Json)[key], value) as Json;
}

function expectValidFix(value: unknown): void {
  const valid = validateFix(value);
  expect(valid, ajv.errorsText(validateFix.errors)).toBe(true);
}

describe('the public fix contract', () => {
  it('replaces the old Fix shape', () => {
    expectTypeOf<FixClass>().toEqualTypeOf<'safe' | 'review'>();
    expectTypeOf<'manual'>().not.toExtend<FixClass>();
    expectTypeOf<Fix['class']>().toEqualTypeOf<FixClass>();
    expectTypeOf<Fix['changes']>().toEqualTypeOf<readonly FileChange[]>();
    expectTypeOf<Fix['alternatives']>().toEqualTypeOf<readonly Fix[] | undefined>();
    expectTypeOf<Fix['input']>().toEqualTypeOf<FixInput | undefined>();
    expectTypeOf<FixInput['target']['kind']>().toEqualTypeOf<'frontmatter' | 'directive'>();
    expectTypeOf<AwaitingInput['fix']['input']>().toEqualTypeOf<FixInput>();
    expectTypeOf<FixPlan['awaitingInput']>().toEqualTypeOf<readonly AwaitingInput[]>();
    expectTypeOf<Fix>().not.toHaveProperty('safety');
    expectTypeOf<Fix>().not.toHaveProperty('edits');
    expectTypeOf<FileChange['kind']>().toEqualTypeOf<'edit' | 'create' | 'rename' | 'encoding'>();
    expectTypeOf<Extract<FileChange, { kind: 'edit' }>['edits']>().toEqualTypeOf<
      readonly TextEdit[]
    >();
    expectTypeOf<Extract<FileChange, { kind: 'encoding' }>['bom']>().toEqualTypeOf<false>();
    expect(everyChange.changes.map((change) => change.kind)).toEqual([
      'rename',
      'edit',
      'create',
      'encoding',
    ]);
  });

  it('lets rules declare fixes and guidance, and findings carry them', () => {
    expectTypeOf<RuleMeta['fix']>().toEqualTypeOf<
      | {
          readonly classes: readonly FixClass[];
          readonly summary: string;
          readonly input?: 'all' | 'some';
        }
      | undefined
    >();
    expectTypeOf<RuleMeta>().not.toHaveProperty('fixable');
    expectTypeOf<ReportDescriptor['fix']>().toEqualTypeOf<Fix | undefined>();
    expectTypeOf<ReportDescriptor['guidance']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Finding['fix']>().toEqualTypeOf<Fix | undefined>();
    expectTypeOf<Finding['guidance']>().toEqualTypeOf<string | undefined>();
  });

  it('adds a size and a fix class to skipped loads', () => {
    expectTypeOf<SkippedLoad['size']>().toEqualTypeOf<Size | undefined>();
    expectTypeOf<SkippedLoad['fix']>().toEqualTypeOf<FixClass | undefined>();
  });

  it('gives source files an identity that src/io can compare', () => {
    expectTypeOf<SourceFile['identity']>().toEqualTypeOf<SourceIdentity | undefined>();
    expectTypeOf<SourceIdentity>().toEqualTypeOf<{
      readonly dev: bigint;
      readonly ino: bigint;
      readonly sha256: string;
    }>();
    expectTypeOf<SourceIdentity>().toExtend<FileIdentity>();
  });
});

describe('the planner types', () => {
  it('select by class and rule, with literal secrets opted in separately', () => {
    const selection: FixSelection = {
      classes: new Set<FixClass>(['safe']),
      ruleIds: new Set(['mcp/literal-secret']),
      literalSecret: true,
    };
    expect(selection.classes.has('review')).toBe(false);
    expectTypeOf<FixSelection['ruleIds']>().toEqualTypeOf<ReadonlySet<string> | undefined>();
  });

  it('require a reason exactly for skipped fixes', () => {
    const decision = { fix: importFix, ruleId: 'r/x', findings: [FINGERPRINT], effects: [] };
    const planned: PlannedFix = { ...decision, status: 'planned' };
    const skipped: PlannedFix = { ...decision, status: 'skipped', reason: 'changed-since-scan' };
    const conflict: Conflict = {
      kind: 'overlapping-edits',
      path: 'CLAUDE.md',
      winner: planned,
      loser: skipped,
    };
    const manual: ManualStep = dryRun.manual[0];
    const plan: FixPlan = {
      fixes: [planned, skipped],
      conflicts: [conflict],
      manual: [manual],
      awaitingInput: [],
    };
    expect(plan.fixes.map((item) => item.status)).toEqual(['planned', 'skipped']);
    expectTypeOf<PlannedFix['status']>().toEqualTypeOf<FixStatus>();
    expectTypeOf({ ...decision, status: 'skipped' as const }).not.toExtend<PlannedFix>();
    expectTypeOf({
      ...decision,
      status: 'planned' as const,
      reason: 'conflict' as const,
    }).not.toExtend<PlannedFix>();
    expectTypeOf<FixVerification['introduced']>().toEqualTypeOf<readonly Finding[]>();
  });

  it('describe effects as a token delta per agent or a gate hit', () => {
    expectTypeOf<FixEffect['kind']>().toEqualTypeOf<'tokens' | 'gate'>();
    expectTypeOf<Extract<FixEffect, { kind: 'gate' }>['class']>().toEqualTypeOf<GateClass>();
    expect(dryRun.fixes.flatMap((item) => item.effects.map((effect) => effect.kind))).toEqual([
      'tokens',
      'gate',
    ]);
  });
});

describe('schemas/fix.schema.json', () => {
  it.each([
    ['a dry run', dryRun],
    ['a write', written],
    ['an empty run', empty],
  ] as const)('accepts %s', (_, report) => {
    expectValidFix(copy(report));
  });

  it('rejects malformed output', () => {
    const cases: ((value: Json) => void)[] = [
      (value) => (value['extra'] = 1),
      (value) => (value['schemaVersion'] = 2),
      (value) => (value['mode'] = 'apply'),
      (value) => delete value['verification'],
      (value) => (at(value, 'fixes', 0)['class'] = 'manual'),
      (value) => (at(value, 'fixes', 0)['status'] = 'deferred'),
      (value) => (at(value, 'fixes', 0)['reason'] = 'conflict'),
      (value) => delete at(value, 'fixes', 1)['reason'],
      (value) => (at(value, 'fixes', 1)['reason'] = 'gone'),
      (value) => (at(value, 'fixes', 0)['findings'] = []),
      (value) => (at(value, 'fixes', 0, 'findings')[0] = 'not-a-fingerprint'),
      (value) => (at(value, 'fixes', 0, 'effects', 0)['kind'] = 'size'),
      (value) => (at(value, 'fixes', 0, 'effects', 0)['agent'] = 'copilot'),
      (value) => (at(value, 'fixes', 1, 'effects', 0)['class'] = 'security'),
      (value) => (at(value, 'fixes', 1, 'effects', 0)['change'] = 'removed'),
      (value) => (at(value, 'files', 0)['op'] = 'delete'),
      (value) => (at(value, 'files', 0)['from'] = 'OLD.md'),
      (value) => delete at(value, 'files', 0)['before'],
      (value) => delete at(value, 'files', 1)['from'],
      (value) => (at(value, 'files', 2)['before'] = at(value, 'files', 0)['before']),
      (value) => (at(value, 'files', 0, 'before')['sha256'] = 'A'.repeat(64)),
      (value) => (at(value, 'files', 0, 'before')['sha256'] = 'abc'),
      (value) => (at(value, 'files', 0, 'after')['encoding'] = 'latin1'),
      (value) => (at(value, 'files', 0, 'after')['lineEnding'] = 'cr'),
      (value) => (at(value, 'files', 0, 'hunks', 0, 'lines')[0] = 'no prefix'),
      (value) => (at(value, 'files', 0, 'hunks', 0)['oldStart'] = -1),
      (value) => (at(value, 'manual', 0)['line'] = 0),
      (value) => (at(value, 'manual', 0)['guidance'] = ''),
      (value) => (at(value, 'verification', 'introduced', 0)['severity'] = 'warning'),
    ];
    expectValidFix(copy(dryRun));
    for (const mutate of cases) {
      const value = copy(dryRun);
      mutate(value);
      expect(validateFix(value), mutate.toString()).toBe(false);
    }
  });

  it('rejects absolute paths and parent segments', () => {
    const paths = [
      '/etc/passwd',
      '\\\\server\\share',
      'C:/Users/x',
      'c:x',
      '../x',
      'a/../b',
      '..',
      '',
    ];
    for (const path of paths) {
      for (const set of [
        (value: Json) => (at(value, 'files', 0)['path'] = path),
        (value: Json) => (at(value, 'files', 1)['from'] = path),
        (value: Json) => (at(value, 'manual', 0)['path'] = path),
        (value: Json) => (at(value, 'verification', 'introduced', 0)['path'] = path),
      ]) {
        const value = copy(dryRun);
        set(value);
        expect(validateFix(value), path).toBe(false);
      }
    }
    for (const path of ['..hidden/x', 'a/..b', 'a..', '.claude/CLAUDE.md']) {
      const value = copy(dryRun);
      at(value, 'files', 0)['path'] = path;
      expectValidFix(value);
    }
  });

  it('enumerations mirror the TypeScript types', () => {
    const REASONS = [
      'conflict',
      'changed-since-scan',
      'refused-path',
      'verification-failed',
      'limit',
      'write-failed',
      'declined',
    ] as const satisfies readonly FixSkipReason[];
    const MODES = [
      'dry-run',
      'write',
      'interactive',
    ] as const satisfies readonly FixReport['mode'][];
    const CLASSES = ['safe', 'review'] as const satisfies readonly FixClass[];
    const STATUSES = ['planned', 'applied', 'skipped'] as const satisfies readonly FixStatus[];
    const ENCODINGS = [
      'utf-8',
      'utf-16le',
      'utf-16be',
    ] as const satisfies readonly DecodedText['encoding'][];
    const LINE_ENDINGS = [
      'lf',
      'crlf',
      'mixed',
      'none',
    ] as const satisfies readonly DecodedText['lineEnding'][];
    const CHANGE_KINDS = [
      'edit',
      'create',
      'rename',
      'encoding',
    ] as const satisfies readonly FileChange['kind'][];
    const FIELDS = [
      'skill-description',
      'skill-when-clause',
      'allowed-tools',
      'cursor-globs',
      'suppression-reason',
    ] as const satisfies readonly FixInput['field'][];
    const exhaustive: true[] = [
      true satisfies Exhaustive<FixInput['field'], (typeof FIELDS)[number]>,
      true satisfies Exhaustive<FixSkipReason, (typeof REASONS)[number]>,
      true satisfies Exhaustive<FixReport['mode'], (typeof MODES)[number]>,
      true satisfies Exhaustive<FixClass, (typeof CLASSES)[number]>,
      true satisfies Exhaustive<FixStatus, (typeof STATUSES)[number]>,
      true satisfies Exhaustive<DecodedText['encoding'], (typeof ENCODINGS)[number]>,
      true satisfies Exhaustive<DecodedText['lineEnding'], (typeof LINE_ENDINGS)[number]>,
      true satisfies Exhaustive<FileChange['kind'], (typeof CHANGE_KINDS)[number]>,
    ];
    expect(exhaustive).toHaveLength(8);
    const fieldsOf = (schema: SchemaDocument) =>
      (schema.$defs['fixInput']?.properties?.['field'] as { enum?: unknown[] } | undefined)?.enum;
    expect(fieldsOf(fixSchema)).toEqual([...FIELDS]);
    expect(fieldsOf(reportSchema)).toEqual([...FIELDS]);

    const defs = fixSchema.$defs;
    expect(defs['fix']?.properties?.['reason']?.enum).toEqual([...REASONS]);
    expect(defs['fix']?.properties?.['status']?.enum).toEqual([...STATUSES]);
    expect(defs['fixClass']?.enum).toEqual([...CLASSES]);
    expect(reportSchema.$defs['fixClass']?.enum).toEqual([...CLASSES]);
    expect(defs['severity']?.enum).toEqual([...SEVERITIES]);
    expect(defs['fileState']?.properties?.['encoding']?.enum).toEqual([...ENCODINGS]);
    expect(defs['fileState']?.properties?.['lineEnding']?.enum).toEqual([...LINE_ENDINGS]);
    const [tokens, gate] = defs['effect']?.oneOf ?? [];
    expect(tokens?.properties['agent']?.enum).toEqual([...ALL_CONTEXT_AGENTS]);
    expect(gate?.properties['class']?.enum).toEqual([...GATE_CLASSES]);
    expect(
      (reportSchema.$defs['fileChange']?.oneOf ?? []).map(
        (entry) => entry.properties['kind']?.const,
      ),
    ).toEqual([...CHANGE_KINDS]);
    const modes = (fixSchema as unknown as { properties: Record<string, { enum?: unknown[] }> })
      .properties['mode']?.enum;
    expect(modes).toEqual([...MODES]);
  });
});

describe('fixes and guidance in scan reports', () => {
  const SOURCE = {
    title: 'test',
    url: 'https://example.com',
    checked: '2026-10-16',
    status: 'verified',
  } as const;

  /** Reports every AGENTS.md: with a fix on the first line, with guidance only otherwise. */
  const fixing = defineRule({
    meta: {
      id: 'test/fixing',
      title: 'Every AGENTS.md is reported',
      rationale: 'Test rule.',
      category: 'correctness',
      severity: 'warn',
      appliesTo: ['agents-md'],
      platforms: ['codex'],
      sources: [SOURCE],
      since: '2026.10',
      fix: { classes: ['safe', 'review'], summary: 'Adds a heading.' },
    },
    defaultOptions: undefined,
    check(context) {
      for (const artifact of context.artifacts) {
        const fix: Fix = {
          id: 'test/fixing#heading',
          class: 'safe',
          title: `Add a heading to ${artifact.path}`,
          changes: [
            { kind: 'edit', path: artifact.path, edits: [{ offset: 0, length: 0, text: '# A\n' }] },
          ],
          alternatives: [{ ...everyChange, id: 'test/fixing#rename' }],
        };
        context.report({
          artifact,
          message: 'Saw it.',
          ...(artifact.path === 'AGENTS.md'
            ? { fix, guidance: 'or write a heading yourself' }
            : { guidance: 'write a heading' }),
        });
        context.report({ artifact, message: 'Saw it again.' });
      }
    },
  });

  const snapshot = snapshotFrom({ 'AGENTS.md': 'text\n', 'docs/AGENTS.md': 'more\n' });

  /** Indexes of the finding with a fix and of the rule's metadata in a report. */
  function indexes(result: ScanResult): { finding: number; rule: number } {
    return {
      finding: result.findings.findIndex((item) => item.fix !== undefined),
      rule: result.rules.findIndex((meta) => meta.id === 'test/fixing'),
    };
  }

  it('carries a rule fix and guidance into the finding, and only when given', () => {
    const result = scanSnapshot(snapshot, { rules: [fixing] });
    const find = (path: string, message: string) =>
      result.findings.find((item) => item.path === path && item.message === message);
    const withFix = find('AGENTS.md', 'Saw it.');
    const guidanceOnly = find('docs/AGENTS.md', 'Saw it.');
    const plain = [find('AGENTS.md', 'Saw it again.'), find('docs/AGENTS.md', 'Saw it again.')];
    expect(result.findings).toHaveLength(4);
    expect(withFix?.fix?.id).toBe('test/fixing#heading');
    expect(withFix?.fix?.alternatives?.[0]?.changes).toHaveLength(4);
    expect(withFix?.guidance).toBe('or write a heading yourself');
    expect(guidanceOnly).toMatchObject({ path: 'docs/AGENTS.md', guidance: 'write a heading' });
    expect(guidanceOnly).not.toHaveProperty('fix');
    for (const item of plain) {
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty('fix');
      expect(item).not.toHaveProperty('guidance');
    }
    expect(result.rules.find((meta) => meta.id === 'test/fixing')?.fix?.classes).toEqual([
      'safe',
      'review',
    ]);
  });

  it('writes them to valid JSON, key order fixed and runtime properties dropped', () => {
    const result = scanSnapshot(snapshot, { rules: [fixing] });
    const noisy = {
      ...result,
      findings: result.findings.map((item) =>
        item.fix ? { ...item, fix: { ...item.fix, debug: true } } : item,
      ),
    };
    const output = formatJson(noisy);
    expect(output).toBe(formatJson(result));
    const parsed = JSON.parse(output) as Json;
    const { finding, rule } = indexes(result);
    expect(validateReport(parsed), ajv.errorsText(validateReport.errors)).toBe(true);
    expect(Object.keys(at(parsed, 'findings', finding, 'fix'))).toEqual([
      'id',
      'class',
      'title',
      'changes',
      'alternatives',
    ]);
    expect(at(parsed, 'findings', finding)['guidance']).toBe('or write a heading yourself');
    expect(at(parsed, 'rules', rule)['fix']).toEqual({
      classes: ['safe', 'review'],
      summary: 'Adds a heading.',
    });
  });

  it('rejects malformed fixes in a report', () => {
    const result = scanSnapshot(snapshot, { rules: [fixing] });
    const { finding, rule } = indexes(result);
    const report = (): Json => JSON.parse(formatJson(result)) as Json;
    const fix = (value: Json, ...keys: (string | number)[]): Json =>
      at(value, 'findings', finding, 'fix', ...keys);
    const cases: ((value: Json) => void)[] = [
      (value) => (fix(value)['class'] = 'suggestion'),
      (value) => (fix(value)['safety'] = 'safe'),
      (value) => (fix(value)['changes'] = []),
      (value) => (fix(value, 'changes', 0)['kind'] = 'delete'),
      (value) => (fix(value, 'changes', 0)['edits'] = []),
      (value) => (fix(value, 'changes', 0)['path'] = ''),
      (value) => delete fix(value, 'alternatives', 0, 'changes', 0)['to'],
      (value) => (fix(value, 'alternatives', 0, 'changes', 3)['bom'] = true),
      (value) => (fix(value, 'alternatives', 0)['class'] = 'manual'),
      (value) => (at(value, 'findings', finding)['guidance'] = 3),
      (value) => (at(value, 'rules', rule, 'fix')['classes'] = []),
      (value) => (at(value, 'rules', rule, 'fix')['classes'] = ['safe', 'safe']),
      (value) => (at(value, 'rules', rule)['fixable'] = 'safe'),
    ];
    expect(validateReport(report())).toBe(true);
    for (const mutate of cases) {
      const value = report();
      mutate(value);
      expect(validateReport(value), mutate.toString()).toBe(false);
    }
  });

  it('writes a fix that needs input to valid JSON, and every format takes it', () => {
    const asking = defineRule({
      meta: { ...fixing.meta, id: 'test/asking' },
      defaultOptions: undefined,
      check(context) {
        for (const artifact of context.artifacts) {
          context.report({
            artifact,
            message: 'Why keep it?',
            fix: {
              id: 'test/asking#keep',
              class: 'review',
              title: 'Keep it',
              changes: [],
              input: {
                field: 'suppression-reason',
                question: 'Keep it and record why?',
                label: 'a reason to keep it',
                initial: 'because',
                target: { kind: 'directive', path: artifact.path, line: 1, ruleId: 'test/asking' },
              },
            },
          });
        }
      },
    });
    const result = scanSnapshot(snapshotFrom({ 'AGENTS.md': 'text\n' }), { rules: [asking] });
    const parsed = JSON.parse(formatJson(result)) as Json;
    expect(validateReport(parsed), ajv.errorsText(validateReport.errors)).toBe(true);
    const fix = at(parsed, 'findings', 0, 'fix');
    expect(Object.keys(fix)).toEqual(['id', 'class', 'title', 'changes', 'input']);
    expect(Object.keys(at(fix, 'input'))).toEqual([
      'field',
      'question',
      'label',
      'initial',
      'target',
    ]);
    const cases: ((value: Json) => void)[] = [
      (value) =>
        (at(value, 'findings', 0, 'fix')['changes'] = [{ kind: 'create', path: 'x', text: '' }]),
      (value) => (at(value, 'findings', 0, 'fix', 'input')['field'] = 'name'),
      (value) => (at(value, 'findings', 0, 'fix', 'input', 'target')['line'] = 0),
      (value) => (at(value, 'findings', 0, 'fix', 'input', 'target')['kind'] = 'frontmatter'),
      (value) => delete at(value, 'findings', 0, 'fix', 'input')['label'],
    ];
    for (const mutate of cases) {
      const value = JSON.parse(formatJson(result)) as Json;
      mutate(value);
      expect(validateReport(value), mutate.toString()).toBe(false);
    }
    for (const name of FORMATS) expect(() => format(result, name), name).not.toThrow();
  });

  it('never writes a source identity into any report', () => {
    const sha256 = 'f'.repeat(64);
    const files = snapshotFrom({
      'AGENTS.md': '# Rules\n\nUse pnpm.\n',
      'CLAUDE.md': '# Claude\n\n@docs/missing.md\n',
      '.cursor/rules/style.md': 'Use tabs.\n',
    });
    const identified: Snapshot = {
      ...files,
      files: files.files.map((file) => ({
        ...file,
        identity: { dev: 2n ** 63n, ino: 2n ** 64n - 1n, sha256 },
      })),
    };
    const result = scanWithContext(identified, { rules: builtinRules });
    expect(result.findings.length).toBeGreaterThan(2);
    expect(result.context.plans.some((plan) => plan.skipped.length > 0)).toBe(true);
    for (const name of FORMATS) {
      // A bigint that reached JSON.stringify would throw here.
      const output = format(result, name);
      expect(output).not.toContain(sha256);
      expect(output).not.toContain(String(2n ** 63n));
    }
  });
});

describe('rule metadata', () => {
  it('declares each fix class at most once, with a summary', () => {
    for (const { meta } of builtinRules) {
      if (meta.fix === undefined) continue;
      expect(meta.fix.classes.length, meta.id).toBeGreaterThan(0);
      expect(new Set(meta.fix.classes).size, meta.id).toBe(meta.fix.classes.length);
      expect(meta.fix.summary.trim(), meta.id).not.toBe('');
    }
  });

  it("says which rules attach fixes that need the user's words", () => {
    const result = scanSnapshot(
      snapshotFrom({
        '.claude/skills/pdf/SKILL.md':
          '---\nname: pdf\ndescription: Extract text and tables from PDF files, fill forms and merge documents.\n---\n\nRun the script.\n',
        '.claude/skills/empty/SKILL.md': '---\nname: empty\n---\n',
        '.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\n\nDeploy the API.\n',
        '.cursor/rules/tabs.mdc': 'Use tabs.\n',
        '.cursor/rules/style.md': 'Use strict mode.\n',
      }),
      { rules: builtinRules },
    );
    const declared = new Map(builtinRules.map(({ meta }) => [meta.id, meta.fix?.input]));
    const withInput = new Set<string>();
    for (const finding of result.findings) {
      if (finding.fix === undefined) continue;
      if (finding.fix.input === undefined) {
        // A ready fix: the rule must not say that every fix needs words.
        expect(declared.get(finding.ruleId), finding.ruleId).not.toBe('all');
      } else {
        withInput.add(finding.ruleId);
        expect(declared.get(finding.ruleId), finding.ruleId).toBeDefined();
      }
    }
    expect([...withInput].sort()).toEqual([
      'cursor/rule-never-applied',
      'skill/description-missing',
      'skill/description-quality',
    ]);
    // The deploy skill's description is copied from its body: a ready fix, not one for words.
    expect(
      result.findings.some(
        (finding) =>
          finding.ruleId === 'skill/description-missing' &&
          finding.path === '.claude/skills/deploy/SKILL.md' &&
          finding.fix?.input === undefined,
      ),
    ).toBe(true);
  });
});
