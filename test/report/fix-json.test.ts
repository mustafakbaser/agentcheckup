import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { RULESET_VERSION, TOOL_NAME } from '../../src/core/meta.js';
import { VERSION } from '../../src/core/version.js';
import type { FixReport } from '../../src/fix/index.js';
import type { FixRun } from '../../src/report/fix-diff.js';
import { formatFixJson, toFixReport, UnsafeReportPathError } from '../../src/report/fix-json.js';
import {
  created,
  edited,
  GITHUB_TOKEN,
  hostileRun,
  OPENAI_KEY,
  sampleRun,
  secretRun,
  writtenRun,
} from './fix-fixtures.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const schema = JSON.parse(
  readFileSync(new URL('../../schemas/fix.schema.json', import.meta.url), 'utf8'),
) as object;
const validate = ajv.compile<FixReport>(schema);

function expectValid(value: unknown): void {
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

const RUNS: readonly [string, FixRun][] = [
  ['sample', sampleRun],
  ['written', writtenRun],
  ['secret', secretRun],
  ['hostile', hostileRun],
  ['pathBase', { ...sampleRun, pathBase: 'packages/web' }],
  ['empty', { ...sampleRun, fixes: [], files: [], manual: [] }],
];

describe('toFixReport', () => {
  it.each(RUNS)('%s validates against schemas/fix.schema.json', (_, run) => {
    expectValid(toFixReport(run));
    expectValid(JSON.parse(formatFixJson(run)));
  });

  it('matches the snapshot', async () => {
    await expect(
      formatFixJson(sampleRun, { tool: { name: TOOL_NAME, version: '1.4.0' } }),
    ).toMatchFileSnapshot('__snapshots__/fix-json.sample.txt');
  });

  it('fills tool and rule set', () => {
    const report = toFixReport(sampleRun);
    expect(report.tool).toEqual({ name: TOOL_NAME, version: VERSION });
    expect(report.ruleset).toBe(RULESET_VERSION);
    expect(toFixReport(sampleRun, { ruleset: '2027.01' }).ruleset).toBe('2027.01');
    expect(report.mode).toBe('dry-run');
    expect(report).not.toHaveProperty('pathBase');
  });

  it('writes keys in schema order', () => {
    const report = toFixReport({ ...writtenRun, pathBase: 'sub' });
    expect(Object.keys(report)).toEqual([
      'schemaVersion',
      'tool',
      'ruleset',
      'mode',
      'pathBase',
      'fixes',
      'files',
      'manual',
      'verification',
    ]);
    expect(Object.keys(report.fixes[1]!)).toEqual([
      'id',
      'ruleId',
      'class',
      'title',
      'effects',
      'findings',
      'notes',
      'status',
    ]);
    const skipped = report.fixes.find((fix) => fix.status === 'skipped')!;
    expect(Object.keys(skipped)).toEqual([
      'id',
      'ruleId',
      'class',
      'title',
      'effects',
      'findings',
      'status',
      'reason',
    ]);
    const rename = report.files.find((file) => file.op === 'rename')!;
    expect(Object.keys(rename)).toEqual(['path', 'op', 'from', 'before', 'after', 'hunks']);
    expect(Object.keys(rename.after)).toEqual(['sha256', 'encoding', 'bom', 'lineEnding']);
    const create = report.files.find((file) => file.op === 'create')!;
    expect(Object.keys(create)).toEqual(['path', 'op', 'after', 'hunks']);
    expect(Object.keys(report.verification.introduced[0]!)).toEqual([
      'ruleId',
      'severity',
      'path',
      'line',
      'message',
    ]);
  });

  it('copies only the documented properties', () => {
    const extra = {
      ...sampleRun,
      fixes: sampleRun.fixes.map((fix) => ({ ...fix, internal: 'x' })),
      files: sampleRun.files.map((file) => ({ ...file, identity: 1n })),
    } as unknown as FixRun;
    expect(() => formatFixJson(extra)).not.toThrow();
    expect(formatFixJson(extra)).not.toContain('internal');
  });

  it('sorts files by path and keeps the plan order of fixes and manual steps', () => {
    const report = toFixReport(sampleRun);
    expect(report.files.map((file) => file.path)).toEqual([
      '.agents/skills/release-notes/SKILL.md',
      '.cursor/rules/style.mdc',
      '.mcp.json',
      'CLAUDE.md',
      'packages/api/CLAUDE.md',
    ]);
    expect(report.fixes.map((fix) => fix.id)).toEqual(sampleRun.fixes.map((fix) => fix.fix.id));
  });

  it('is deterministic whatever order files, effects and findings come in', () => {
    const shuffled: FixRun = {
      ...writtenRun,
      files: [...writtenRun.files].reverse(),
      fixes: writtenRun.fixes.map((fix) => ({
        ...fix,
        effects: [...fix.effects].reverse(),
        findings: [...fix.findings, ...fix.findings].reverse(),
      })),
    };
    expect(formatFixJson(shuffled)).toBe(formatFixJson(writtenRun));
    expect(formatFixJson(hostileRun)).toBe(formatFixJson(hostileRun));
  });

  it('reports hunks with 3 lines of context and the no-newline marker', () => {
    const report = toFixReport(sampleRun);
    const claude = report.files.find((file) => file.path === 'CLAUDE.md')!;
    expect(claude.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 5,
        lines: ['+@AGENTS.md', '+', ' # Acme API', ' ', ' Use pnpm.'],
      },
    ]);
    const style = report.files.find((file) => file.op === 'rename')!;
    expect(style.from).toBe('.cursor/rules/style.md');
    expect(style.hunks[0]?.lines.at(-1)).toBe(' Use tabs.');
    const run: FixRun = {
      ...sampleRun,
      files: [edited('a.md', 'x\r\ny', 'x\r\ny\r\n'), created('b.md', 'one')],
    };
    const files = toFixReport(run).files;
    expect(files[0]!.hunks[0]!.lines).toEqual([' x', '-y', '\\ No newline at end of file', '+y']);
    expect(files[0]!.before?.lineEnding).toBe('crlf');
    expect(files[1]!.hunks[0]!.lines).toEqual(['+one', '\\ No newline at end of file']);
  });

  it('redacts credentials in hunks, notes and guidance', () => {
    const json = formatFixJson(secretRun);
    expect(json).not.toContain(GITHUB_TOKEN);
    expect(json).not.toContain(OPENAI_KEY);
    expect(json).toContain('"-        \\"GITHUB_TOKEN\\": \\"ghp_…(40 chars)\\""');
    expect(json).toContain('"warning": "Revoke and rotate this credential now.');
    const report = toFixReport(secretRun);
    expect(report.fixes[0]!.notes).toEqual(['replaces ghp_…(40 chars)']);
    expect(report.manual[0]!.guidance).toBe('move ghp_…(40 chars) into your shell environment');
  });

  it('escapes display-dangerous characters and keeps the data lossless otherwise', () => {
    const json = formatFixJson(hostileRun);
    expect(json).not.toContain('\u001b');
    expect(json).not.toContain('\u202e');
    expect(json).toContain('\\u001b');
    const parsed = JSON.parse(json) as FixReport;
    expect(parsed.files[0]!.path).toBe(hostileRun.files[0]!.path);
    expect(parsed.files[0]!.hunks[0]!.lines).toContain(' ::stop-commands::x');
  });

  it('puts pathBase in front of paths, working directories and item ids', () => {
    const run: FixRun = { ...writtenRun, pathBase: 'packages/web/' };
    const report = toFixReport(run);
    expect(report.pathBase).toBe('packages/web');
    expect(report.files.map((file) => file.path)).toContain('packages/web/CLAUDE.md');
    expect(report.files.find((file) => file.op === 'rename')?.from).toBe(
      'packages/web/.cursor/rules/style.md',
    );
    expect(report.manual[0]!.path).toBe('packages/web/CLAUDE.md');
    expect(report.verification.introduced[0]!.path).toBe(
      'packages/web/.agents/skills/release-notes/SKILL.md',
    );
    const effects = report.fixes.flatMap((fix) => fix.effects);
    expect(effects).toContainEqual({
      kind: 'tokens',
      agent: 'claude-code',
      cwd: 'packages/web',
      before: 50,
      after: 247,
    });
    expect(effects).toContainEqual({
      kind: 'tokens',
      agent: 'claude-code',
      cwd: 'packages/web/packages/api',
      before: 120,
      after: 410,
    });
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: 'gate', id: 'mcp:packages/web/.mcp.json#docs' }),
    );
    expect(toFixReport({ ...run, pathBase: '.' })).not.toHaveProperty('pathBase');
  });

  it('keeps unicode gate ids, which are fingerprints', () => {
    const fix = sampleRun.fixes[0]!;
    const run: FixRun = {
      ...sampleRun,
      pathBase: 'sub',
      fixes: [
        {
          ...fix,
          effects: [
            { kind: 'gate', class: 'unicode', id: 'abc:1', change: 'added', summary: 's' },
            { kind: 'gate', class: 'env', id: 'plain', change: 'added', summary: 's' },
          ],
        },
      ],
    };
    expect(
      toFixReport(run).fixes[0]!.effects.map((effect) => effect.kind === 'gate' && effect.id),
    ).toEqual(['plain', 'abc:1']);
  });

  it('refuses absolute and escaping paths', () => {
    const bad = ['/etc/passwd', '\\\\server\\share', 'C:/Users/x', '../outside', 'a/../../b', ''];
    for (const path of bad) {
      expect(() => toFixReport({ ...sampleRun, files: [created(path, 'x\n')] })).toThrow(
        UnsafeReportPathError,
      );
    }
    expect(() =>
      toFixReport({
        ...sampleRun,
        manual: [{ ruleId: 'a/b', path: '/abs', line: 1, guidance: 'g' }],
      }),
    ).toThrow(UnsafeReportPathError);
    expect(() => toFixReport({ ...sampleRun, pathBase: '/home/user' })).toThrow(
      UnsafeReportPathError,
    );
    expect(() => toFixReport({ ...sampleRun, pathBase: '..' })).toThrow(UnsafeReportPathError);
  });
});
