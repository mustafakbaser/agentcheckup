import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import {
  ARTIFACT_KINDS,
  CATEGORIES,
  PLATFORM_IDS,
  SEVERITIES,
  type SkipReason,
  type SymlinkProblem,
} from '../../src/core/types.js';
import { formatJson, toJsonReport } from '../../src/report/json.js';
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

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
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

  it('enumerations mirror the TypeScript constants', () => {
    const SKIP_REASONS = [
      'too-large',
      'binary',
      'special-file',
      'unreadable',
      'file-limit',
      'byte-limit',
      'depth-limit',
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
