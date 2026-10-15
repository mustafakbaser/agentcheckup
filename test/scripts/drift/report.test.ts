import { describe, expect, it } from 'vitest';
import type { DriftReport } from '../../../scripts/drift/baseline.js';
import { formatJson, formatText, parseReport } from '../../../scripts/drift/report.js';
import { HOSTILE_ALL } from '../../report/hostile.js';
import { unsafeCodePoints } from '../../report/safety.js';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

const REPORT: DriftReport = {
  version: 1,
  checked: 5,
  changed: [
    {
      url: 'https://code.claude.com/docs/en/memory',
      rules: ['instr/import-depth', 'instr/claude-md-too-long'],
      previous: H1,
      current: H2,
    },
    { url: 'https://cursor.com/docs/rules', rules: ['cursor/glob'], previous: null, current: H1 },
  ],
  unreachable: [
    { url: 'https://docs.example/gone', rules: ['mcp/x'], reason: 'HTTP 404' },
    { url: 'https://docs.example/evil', rules: ['mcp/y'], reason: HOSTILE_ALL },
  ],
  unchanged: 1,
  uncited: ['https://old.example/'],
  skipped: [
    { url: 'https://github.com/mustafakbaser/agentcheckup/blob/main/x.md', rules: ['a/b'] },
  ],
};

const CLEAN: DriftReport = {
  version: 1,
  checked: 3,
  changed: [],
  unreachable: [],
  unchanged: 3,
  uncited: [],
  skipped: [],
};

describe('formatText', () => {
  it('lists changed and unreachable URLs with their rules, and unchanged ones as a count', () => {
    const text = formatText({ ...REPORT, unreachable: REPORT.unreachable.slice(0, 1) });
    expect(text).toBe(
      [
        'Source drift: 5 cited URLs checked.',
        '',
        'Changed (2):',
        '  https://code.claude.com/docs/en/memory',
        '    rules: instr/import-depth, instr/claude-md-too-long',
        '    hash: aaaaaaaaaaaa -> bbbbbbbbbbbb',
        '  https://cursor.com/docs/rules',
        '    rules: cursor/glob',
        '    hash: not in the baseline -> aaaaaaaaaaaa',
        '',
        'Unreachable (1):',
        '  https://docs.example/gone',
        '    reason: HTTP 404',
        '    rules: mcp/x',
        '',
        'Unchanged: 1',
        'No longer cited by any rule (--update removes them): 1',
        '  https://old.example/',
        'Not checked, in this repository: 1',
        '',
        'Re-read each changed source and update the rule or its `checked` date. Then run',
        '`pnpm drift:update --only <url>` and commit scripts/drift/baseline.json in the same pull request.',
        '',
      ].join('\n'),
    );
  });

  it('prints only the count when nothing changed', () => {
    expect(formatText(CLEAN)).toBe('Source drift: 3 cited URLs checked.\n\nUnchanged: 3\n');
    expect(formatText({ ...CLEAN, checked: 1, unchanged: 1 })).toContain('1 cited URL checked.');
  });

  it('neutralizes control and invisible characters from the network', () => {
    const text = formatText(REPORT);
    expect(unsafeCodePoints(text, { newline: true, tab: true })).toEqual([]);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\r');
  });
});

describe('formatJson and parseReport', () => {
  it('round-trips', () => {
    expect(parseReport(formatJson(REPORT))).toEqual(REPORT);
    expect(parseReport(formatJson(CLEAN))).toEqual(CLEAN);
  });

  it('escapes invisible characters in JSON output', () => {
    const json = formatJson(REPORT);
    expect(unsafeCodePoints(json, { newline: true })).toEqual([]);
    expect(json.endsWith('}\n')).toBe(true);
  });

  it.each([
    ['another version', { ...CLEAN, version: 2 }],
    ['a negative count', { ...CLEAN, unchanged: -1 }],
    ['a changed entry without a hash', { ...CLEAN, changed: [{ url: 'u', rules: [] }] }],
    ['an unreachable entry without a reason', { ...CLEAN, unreachable: [{ url: 'u', rules: [] }] }],
    ['rules that are not strings', { ...CLEAN, skipped: [{ url: 'u', rules: [1] }] }],
    ['an array', []],
  ])('rejects %s', (_, value) => {
    expect(() => parseReport(JSON.stringify(value))).toThrow('not a version 1 source drift report');
  });
});
