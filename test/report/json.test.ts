import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { GateClass } from '../../src/core/baseline-types.js';
import type { ScanResult } from '../../src/core/engine.js';
import {
  ARTIFACT_KINDS,
  CATEGORIES,
  PLATFORM_IDS,
  SEVERITIES,
  type SkipReason,
  type SymlinkProblem,
} from '../../src/core/types.js';
import type { HookItem, McpServerItem } from '../../src/inventory/types.js';
import {
  ALL_CONTEXT_AGENTS,
  type Certainty,
  type LimitUsage,
  type LoadRole,
  type LoadTrigger,
  type MatrixCell,
  type SkipCode,
} from '../../src/platforms/load/types.js';
import {
  formatJson,
  toJsonBaseline,
  toJsonContext,
  toJsonInventory,
  toJsonReport,
} from '../../src/report/json.js';
import {
  baselineDiff,
  contextReport,
  entry,
  plan,
  planDelta,
  sampleBaseline,
  sampleContext,
  sampleInventory,
  shuffleReport,
  size,
  skip,
  withContext,
  withHostileContext,
} from '../helpers/context.js';
import { cleanResult, emptyResult, richResult } from './fixtures.js';
import { hostileResult } from './hostile.js';
import { unsafeCodePoints } from './safety.js';

/** `true` when `Listed` covers every member of `All`. */
type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;

interface SchemaDocument {
  readonly $defs: Record<
    string,
    { enum?: unknown[]; properties?: Record<string, { enum?: unknown[] }> }
  >;
}

const schema = JSON.parse(
  readFileSync(new URL('../../schemas/report.schema.json', import.meta.url), 'utf8'),
) as SchemaDocument;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

const contextResult: ScanResult = { ...withContext(richResult), pathBase: 'packages/app' };
const hostileContextResult: ScanResult = withHostileContext(hostileResult);

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
  ['context', contextResult],
];

function expectValid(value: unknown): void {
  const valid = validate(value);
  expect(valid, ajv.errorsText(validate.errors)).toBe(true);
}

describe('formatJson', () => {
  it.each(FIXTURES)('%s validates against schemas/report.schema.json', (_, result) => {
    expectValid(JSON.parse(formatJson(result)));
  });

  it.each(FIXTURES)('%s round-trips losslessly', (_, result) => {
    expect(JSON.parse(formatJson(result))).toEqual(result);
  });

  it('pretty-prints with two spaces and a trailing newline', () => {
    const output = formatJson(cleanResult);
    expect(
      output.startsWith('{\n  "schemaVersion": 1,\n  "tool": {\n    "name": "agentcheckup",'),
    ).toBe(true);
    expect(output.endsWith('}\n')).toBe(true);
  });

  it('is stable: key order and stray properties do not depend on the input objects', () => {
    const reordered = Object.fromEntries(
      Object.entries({ ...richResult, extra: 'runtime only' }).reverse(),
    ) as unknown as ScanResult;
    const findings = richResult.findings.map(
      (finding) =>
        Object.fromEntries(
          Object.entries({ ...finding, debug: true }).reverse(),
        ) as unknown as typeof finding,
    );
    expect(formatJson({ ...reordered, findings })).toBe(formatJson(richResult));
    expect(toJsonReport(richResult)).toEqual(richResult);
  });

  it('writes display-dangerous characters as escapes', () => {
    const output = formatJson(hostileResult);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    expect(output).toContain('docs/AGENTS\\u202edm.md');
    expect(output).toContain('copy\\u001b]52;c;');
  });

  it('matches the snapshot', async () => {
    await expect(formatJson(richResult)).toMatchFileSnapshot('__snapshots__/json.rich.txt');
  });

  it('matches the snapshot with inventory, context and baseline', async () => {
    await expect(formatJson(contextResult)).toMatchFileSnapshot('__snapshots__/json.context.txt');
  });
});

describe('formatJson with inventory, context and baseline', () => {
  it('validates hostile content against the schema and canonicalizes it once', () => {
    const output = formatJson(hostileContextResult);
    expectValid(JSON.parse(output));
    expect(JSON.parse(output)).toEqual(toJsonReport(hostileContextResult));
    expect(formatJson(JSON.parse(output) as ScanResult)).toBe(output);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
  });

  it('keeps the samples as they are: they are already canonical', () => {
    expect(toJsonContext(sampleContext)).toEqual(sampleContext);
    expect(toJsonInventory(sampleInventory)).toEqual(sampleInventory);
    expect(toJsonBaseline(sampleBaseline)).toEqual(sampleBaseline);
  });

  it('gives byte-identical output whatever order the lists are in', () => {
    const expected = formatJson(contextResult);
    for (const seed of [1, 2, 3, 42, 1234]) {
      expect(formatJson(shuffleReport(contextResult, seed))).toBe(expected);
    }
    expect(formatJson(shuffleReport(hostileContextResult, 7))).toBe(
      formatJson(hostileContextResult),
    );
  });

  it('puts agents in platform order and moves matrix cells with them', () => {
    const context = toJsonContext({
      ...contextReport([plan('cursor'), plan('claude-code')]),
      agents: ['cursor', 'claude-code'],
      matrix: { rows: [{ path: 'CLAUDE.md', kind: 'claude-md', cells: ['startup', 'not-read'] }] },
    });
    expect(context.agents).toEqual(['claude-code', 'cursor']);
    expect(context.plans.map((item) => item.agent)).toEqual(['claude-code', 'cursor']);
    expect(context.matrix?.rows[0]?.cells).toEqual(['not-read', 'startup']);
  });

  it('keeps the Copilot surfaces together, between Cursor and Gemini CLI', () => {
    const context = toJsonContext({
      ...contextReport([plan('cline'), plan('copilot-cloud'), plan('gemini'), plan('copilot-cli')]),
      agents: ['cline', 'copilot-cloud', 'gemini', 'copilot-cli', 'cursor'],
      matrix: {
        rows: [
          {
            path: 'AGENTS.md',
            kind: 'agents-md',
            cells: ['manual', 'on-path', 'not-read', 'startup', 'skipped'],
          },
        ],
      },
    });
    expect(context.agents).toEqual(['cursor', 'copilot-cli', 'copilot-cloud', 'gemini', 'cline']);
    expect(context.plans.map((item) => item.agent)).toEqual([
      'copilot-cli',
      'copilot-cloud',
      'gemini',
      'cline',
    ]);
    expect(context.matrix?.rows[0]?.cells).toEqual([
      'skipped',
      'startup',
      'on-path',
      'not-read',
      'manual',
    ]);
  });

  it('breaks ties on every secondary key and sorts unknown values last', () => {
    const server = (name: string) =>
      entry('mcp-server', '.mcp.json', { trigger: 'on-approval', name });
    const context = toJsonContext({
      ...contextReport([
        plan('codex', { cwd: 'b' }),
        plan('codex', {
          cwd: 'a',
          entries: [server('b'), { ...server('z'), trigger: 'later' as LoadTrigger }, server('a')],
          skipped: [
            skip('rule', 'x.md', 'not-mdc', { id: 'rule:x.md#2' }),
            skip('rule', 'x.md', 'not-mdc'),
          ],
          outOfScope: [
            { path: 'x.md', because: 'payload-folder' },
            { path: 'x.md', because: 'documentation' },
            { path: 'x.md', because: 'documentation' },
          ],
          hidden: [
            { scope: 'user', locations: ['~/b'], roles: ['hook', 'instructions'] },
            { scope: 'user', locations: ['~/a'], roles: [] },
          ],
          limits: [
            {
              key: 'k',
              unit: 'bytes',
              limit: 1,
              used: 2,
              subject: 'b',
              effect: 'advice',
              evidence: [],
            },
            {
              key: 'k',
              unit: 'bytes',
              limit: 1,
              used: 2,
              subject: 'a',
              effect: 'advice',
              evidence: [],
            },
          ],
        }),
      ]),
      matrix: {
        rows: [
          { path: 'x', kind: 'skill', cells: [] },
          { path: 'x', kind: 'agents-md', cells: [] },
        ],
      },
    });
    const [first] = context.plans;
    expect(context.plans.map((item) => item.cwd)).toEqual(['a', 'b']);
    expect(first?.entries.map((item) => item.id)).toEqual([
      'mcp-server:.mcp.json#a',
      'mcp-server:.mcp.json#b',
      'mcp-server:.mcp.json#z',
    ]);
    expect(first?.skipped.map((item) => item.id)).toEqual(['rule:x.md', 'rule:x.md#2']);
    expect(first?.outOfScope.map((item) => item.because)).toEqual([
      'documentation',
      'documentation',
      'payload-folder',
    ]);
    expect(first?.hidden.map((item) => item.locations[0])).toEqual(['~/a', '~/b']);
    expect(first?.hidden[1]?.roles).toEqual(['instructions', 'hook']);
    expect(first?.limits.map((item) => item.subject)).toEqual(['a', 'b']);
    expect(context.matrix?.rows.map((row) => row.kind)).toEqual(['agents-md', 'skill']);

    const diff = toJsonBaseline(
      baselineDiff({
        findings: {
          new: 0,
          unchanged: 0,
          resolved: [
            { ruleId: 'b/b', path: 'p', fingerprint: '2:1' },
            { ruleId: 'a/a', path: 'p', fingerprint: '3:1' },
            { ruleId: 'a/a', path: 'p', fingerprint: '1:1' },
          ],
        },
        inventory: {
          added: [],
          removed: [],
          changed: [
            { id: 'b', fields: ['y', 'x'] },
            { id: 'a', fields: [] },
          ],
        },
        context: [
          planDelta('codex', 1, 1, { cwd: 'b' }),
          planDelta('codex', 1, 1, {
            cwd: 'a',
            limits: [
              { key: 'k', subject: 'b', before: null, after: 1, limit: null },
              { key: 'k', subject: 'a', before: null, after: 1, limit: null },
            ],
          }),
        ],
        gate: {
          classes: ['env', 'mcp'],
          hits: [
            { class: 'mcp', id: 'b', change: 'added', summary: 's' },
            { class: 'mcp', id: 'a', change: 'changed', summary: 's' },
            { class: 'mcp', id: 'a', change: 'added', summary: 't' },
            { class: 'mcp', id: 'a', change: 'added', summary: 's' },
          ],
        },
      }),
    );
    expect(diff.findings.resolved.map((item) => item.fingerprint)).toEqual(['1:1', '3:1', '2:1']);
    expect(diff.inventory.changed).toEqual([
      { id: 'a', fields: [] },
      { id: 'b', fields: ['x', 'y'] },
    ]);
    expect(diff.context.map((delta) => delta.cwd)).toEqual(['a', 'b']);
    expect(diff.context[0]?.limits.map((limit) => limit.subject)).toEqual(['a', 'b']);
    expect(diff.gate.classes).toEqual(['mcp', 'env']);
    expect(diff.gate.hits.map((hit) => `${hit.id} ${hit.change} ${hit.summary}`)).toEqual([
      'a added s',
      'a added t',
      'a changed s',
      'b added s',
    ]);
  });

  it('reads a missing matrix cell as unknown rather than shifting columns', () => {
    const context = toJsonContext({
      ...contextReport([plan('claude-code'), plan('codex')]),
      matrix: { rows: [{ path: 'AGENTS.md', kind: 'agents-md', cells: ['skipped'] }] },
    });
    expect(context.matrix?.rows[0]?.cells).toEqual(['skipped', 'unknown']);
  });

  it('keeps order that is data: import chains and command arguments', () => {
    const reversed = {
      ...sampleInventory,
      mcpServers: sampleInventory.mcpServers.map((server) => ({
        ...server,
        ...(server.args === undefined ? {} : { args: [...server.args].reverse() }),
      })),
    };
    const github = toJsonInventory(reversed).mcpServers.find((server) => server.name === 'github');
    expect(github?.args).toEqual(['@modelcontextprotocol/server-github@1.4.0', '-y']);
    const chain = toJsonContext(
      contextReport([
        plan('claude-code', {
          entries: [
            {
              ...sampleContext.plans[0]!.entries[1]!,
              via: ['z.md', 'CLAUDE.md'],
            },
          ],
        }),
      ]),
    );
    expect(chain.plans[0]?.entries[0]?.via).toEqual(['z.md', 'CLAUDE.md']);
  });

  it('writes the size and fix class of a skipped load', () => {
    const context = contextResult.context!;
    const sized: ScanResult = {
      ...contextResult,
      context: {
        ...context,
        plans: context.plans.map((item, index) =>
          index === 0
            ? {
                ...item,
                skipped: item.skipped.map((entry) => ({
                  ...entry,
                  size: size(788),
                  fix: 'review' as const,
                })),
              }
            : item,
        ),
      },
    };
    const output = formatJson(sized);
    const parsed = JSON.parse(output) as ScanResult;
    expectValid(parsed);
    expect(parsed).toEqual(sized);
    const skipped = parsed.context?.plans[0]?.skipped.find((entry) => entry.ruleId);
    expect(skipped && Object.keys(skipped)).toEqual([
      'id',
      'role',
      'path',
      'name',
      'code',
      'ruleId',
      'size',
      'fix',
      'certainty',
      'evidence',
    ]);
    for (const mutate of [
      (entry: Record<string, unknown>) => (entry['fix'] = 'manual'),
      (entry: Record<string, unknown>) => (entry['size'] = { bytes: 1 }),
    ]) {
      const value = JSON.parse(output) as Record<string, unknown>;
      mutate(
        (value as unknown as { context: { plans: { skipped: Record<string, unknown>[] }[] } })
          .context.plans[0]!.skipped[0]!,
      );
      expect(validate(value)).toBe(false);
    }
  });

  it('drops runtime-only properties from the new structures', () => {
    const noisy = {
      ...contextResult,
      context: { ...sampleContext, debug: true },
      inventory: { ...sampleInventory, cache: {} },
      baseline: { ...sampleBaseline, raw: 'x' },
    } as unknown as ScanResult;
    expect(formatJson(noisy)).toBe(formatJson(contextResult));
  });
});

describe('schemas/report.schema.json', () => {
  const valid = (): Record<string, unknown> =>
    JSON.parse(formatJson(richResult)) as Record<string, unknown>;

  it('rejects unknown properties, bad enums and out-of-range values', () => {
    const cases: ((report: Record<string, unknown>) => void)[] = [
      (report) => (report['extra'] = 1),
      (report) => (report['schemaVersion'] = 2),
      (report) => delete report['summary'],
      (report) => ((report['findings'] as Record<string, unknown>[])[0]!['severity'] = 'warning'),
      (report) => ((report['findings'] as Record<string, unknown>[])[0]!['fingerprint'] = 'x'),
      (report) => ((report['score'] as Record<string, unknown>)['score'] = 101),
      (report) => ((report['score'] as Record<string, unknown>)['grade'] = 'E'),
      (report) => ((report['rules'] as Record<string, unknown>[])[0]!['sources'] = []),
      (report) => ((report['skipped'] as Record<string, unknown>[])[0]!['reason'] = 'huge'),
    ];
    for (const mutate of cases) {
      const report = valid();
      mutate(report);
      expect(validate(report)).toBe(false);
    }
  });

  it('rejects bad inventory, context and baseline values', () => {
    type Json = Record<string, unknown>;
    const at = (value: unknown, ...keys: (string | number)[]): Json =>
      keys.reduce<unknown>((node, key) => (node as Json)[key], value) as Json;
    const report = (): Json => JSON.parse(formatJson(contextResult)) as Json;
    const cases: ((value: Json) => void)[] = [
      (value) => (at(value, 'findings', 0)['baseline'] = 'old'),
      (value) => (value['pathBase'] = 3),
      (value) => (at(value, 'context', 'plans', 0, 'entries', 0)['trigger'] = 'later'),
      (value) => (at(value, 'context', 'plans', 0, 'entries', 0)['extra'] = 1),
      (value) => (at(value, 'context', 'plans', 0, 'entries', 0)['position'] = 0),
      (value) => (at(value, 'context', 'plans', 0, 'skipped', 0)['code'] = 'gone'),
      (value) => (at(value, 'context', 'plans', 0)['agent'] = 'copilot'),
      (value) => (at(value, 'context', 'plans', 0, 'totals', 'startup')['tokens'] = -1),
      (value) => (at(value, 'context', 'matrix', 'rows', 0, 'cells')[0] = 'maybe'),
      (value) => (at(value, 'context', 'sources', 'claudeMcp')['url'] = 'file:///etc/passwd'),
      (value) => (at(value, 'inventory', 'env', 0)['class'] = 'secret'),
      (value) => (at(value, 'inventory', 'mcpServers', 0, 'status')['vim'] = 'loads'),
      (value) => (at(value, 'inventory', 'mcpServers', 0)['digest'] = 'XYZ'),
      (value) => (at(value, 'inventory', 'hooks', 0)['value'] = 'secret'),
      (value) => (at(value, 'inventory', 'hooks', 0)['scope'] = 'session'),
      (value) => (at(value, 'inventory', 'mcpServers', 0)['scope'] = 'skill'),
      (value) => (at(value, 'baseline', 'gate', 'classes')[0] = 'security'),
      (value) => (at(value, 'baseline', 'gate', 'hits', 0)['change'] = 'removed'),
      (value) => (at(value, 'baseline', 'gate', 'hits', 0)['kind'] = 'setting'),
      (value) => (at(value, 'baseline', 'findings', 'resolved', 0)['fingerprint'] = 'x'),
    ];
    expectValid(report());
    for (const kind of ['mode', 'agent']) {
      const value = report();
      at(value, 'baseline', 'gate', 'hits', 0)['kind'] = kind;
      expectValid(value);
    }
    for (const mutate of cases) {
      const value = report();
      mutate(value);
      expect(validate(value), mutate.toString()).toBe(false);
    }
  });

  it('accepts the scope of items declared in frontmatter, as the TypeScript types allow', () => {
    type Json = Record<string, unknown>;
    const value = JSON.parse(formatJson(contextResult)) as {
      inventory: { hooks: Json[]; mcpServers: Json[] };
    };
    const [hook] = value.inventory.hooks;
    const [server] = value.inventory.mcpServers;
    if (hook === undefined || server === undefined) throw new Error('expected inventory items');
    server['scope'] = 'subagent';
    for (const scope of ['subagent', 'skill']) {
      hook['scope'] = scope;
      expectValid(value);
    }

    const HOOK_SCOPES = ['subagent', 'skill'] as const satisfies readonly NonNullable<
      HookItem['scope']
    >[];
    const SERVER_SCOPES = ['subagent'] as const satisfies readonly NonNullable<
      McpServerItem['scope']
    >[];
    const exhaustive: true[] = [
      true satisfies Exhaustive<NonNullable<HookItem['scope']>, (typeof HOOK_SCOPES)[number]>,
      true satisfies Exhaustive<
        NonNullable<McpServerItem['scope']>,
        (typeof SERVER_SCOPES)[number]
      >,
    ];
    expect(exhaustive).toHaveLength(2);
    expect(schema.$defs['hookItem']?.properties?.['scope']?.enum).toEqual([...HOOK_SCOPES]);
    expect(schema.$defs['mcpServerItem']?.properties?.['scope']?.enum).toEqual([...SERVER_SCOPES]);
  });

  it('context, inventory and baseline enumerations mirror the TypeScript types', () => {
    const SKIP_CODES = [
      'shadowed-by-claude-md',
      'shadowed-by-override',
      'over-byte-budget',
      'empty-override',
      'blank-file',
      'not-mdc',
      'no-frontmatter',
      'invalid-frontmatter',
      'bom',
      'no-description',
      'invalid-subagent',
      'import-unresolved',
      'import-too-deep',
      'import-outside-root',
      'url-without-type',
      'unknown-event',
      'invalid-json',
      'not-utf8',
      'case-mismatch',
      'materialized-symlink',
      'wrong-location',
      'no-apply-to',
      'shadowed-by-preferred',
      'disabled',
      'never-active',
      'invalid-toml',
      'not-read',
    ] as const satisfies readonly SkipCode[];
    const MATRIX_CELLS = [
      'startup',
      'on-path',
      'start-dir',
      'listed',
      'model-selected',
      'manual',
      'partial',
      'skipped',
      'unknown',
      'not-read',
    ] as const satisfies readonly MatrixCell[];
    const LOAD_ROLES = [
      'instructions',
      'import',
      'rule',
      'skill',
      'subagent',
      'command',
      'mcp-server',
      'hook',
    ] as const satisfies readonly LoadRole[];
    const TRIGGERS = [
      'startup',
      'on-path',
      'model-selected',
      'manual',
      'on-approval',
      'unknown',
    ] as const satisfies readonly LoadTrigger[];
    const CERTAINTIES = [
      'documented',
      'source-code',
      'unverified',
    ] as const satisfies readonly Certainty[];
    const GATE_CLASSES = [
      'mcp',
      'mcp-unpinned',
      'permissions',
      'hooks',
      'env',
      'unicode',
    ] as const satisfies readonly GateClass[];
    const LIMIT_UNITS = [
      'bytes',
      'chars',
      'lines',
      'hops',
      'levels',
      'directories',
      'context-fraction',
    ] as const satisfies readonly LimitUsage['unit'][];
    // Compile-time exhaustiveness, as above.
    const exhaustive: true[] = [
      true satisfies Exhaustive<SkipCode, (typeof SKIP_CODES)[number]>,
      true satisfies Exhaustive<MatrixCell, (typeof MATRIX_CELLS)[number]>,
      true satisfies Exhaustive<LoadRole, (typeof LOAD_ROLES)[number]>,
      true satisfies Exhaustive<LoadTrigger, (typeof TRIGGERS)[number]>,
      true satisfies Exhaustive<Certainty, (typeof CERTAINTIES)[number]>,
      true satisfies Exhaustive<GateClass, (typeof GATE_CLASSES)[number]>,
      true satisfies Exhaustive<LimitUsage['unit'], (typeof LIMIT_UNITS)[number]>,
    ];
    expect(exhaustive).toHaveLength(7);

    const defs = schema.$defs;
    expect(defs['skipCode']?.enum).toEqual([...SKIP_CODES]);
    expect(defs['matrixCell']?.enum).toEqual([...MATRIX_CELLS]);
    expect(defs['loadRole']?.enum).toEqual([...LOAD_ROLES]);
    expect(defs['loadTrigger']?.enum).toEqual([...TRIGGERS]);
    expect(defs['certainty']?.enum).toEqual([...CERTAINTIES]);
    expect(defs['gateClass']?.enum).toEqual([...GATE_CLASSES]);
    expect(defs['limitUsage']?.properties?.['unit']?.enum).toEqual([...LIMIT_UNITS]);
    expect(defs['contextAgent']?.enum).toEqual([...ALL_CONTEXT_AGENTS]);
  });

  it('enumerations mirror the TypeScript constants', () => {
    const SKIP_REASONS = [
      'too-large',
      'binary',
      'special-file',
      'unreadable',
      'file-limit',
      'byte-limit',
      'depth-limit',
      'import-limit',
    ] as const satisfies readonly SkipReason[];
    const SYMLINK_PROBLEMS = [
      'outside-root',
      'broken',
      'not-a-regular-file',
    ] as const satisfies readonly SymlinkProblem[];
    // Compile-time exhaustiveness: adding a union member without updating a list fails here.
    const skipExhaustive: Exhaustive<SkipReason, (typeof SKIP_REASONS)[number]> = true;
    const symlinkExhaustive: Exhaustive<SymlinkProblem, (typeof SYMLINK_PROBLEMS)[number]> = true;
    expect([skipExhaustive, symlinkExhaustive]).toEqual([true, true]);

    const defs = schema.$defs;
    expect(defs['platformId']?.enum).toEqual([...PLATFORM_IDS]);
    expect(defs['severity']?.enum).toEqual([...SEVERITIES]);
    expect(defs['category']?.enum).toEqual([...CATEGORIES]);
    expect(defs['artifactKind']?.enum).toEqual([...ARTIFACT_KINDS]);
    expect(defs['skippedEntry']?.properties?.['reason']?.enum).toEqual([...SKIP_REASONS]);
    expect(defs['unresolvedSymlink']?.properties?.['problem']?.enum).toEqual([...SYMLINK_PROBLEMS]);
  });
});
