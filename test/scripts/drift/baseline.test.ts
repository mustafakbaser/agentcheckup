import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  type CompareInput,
  compareWithBaseline,
  needsAttention,
  parseBaseline,
  serializeBaseline,
  updateBaseline,
} from '../../../scripts/drift/baseline.js';
import type { Outcome } from '../../../scripts/drift/fetch.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const A = 'https://a.example/';
const B = 'https://b.example/';
const C = 'https://c.example/';
const D = 'https://d.example/';
const OLD = 'https://old.example/';
const OWN = 'https://github.com/mustafakbaser/agentcheckup/blob/main/docs/x.md';

function input(
  outcomes: Record<string, Outcome>,
  baseline: Record<string, string>,
  complete = true,
): CompareInput {
  const watched = new Map(Object.keys(outcomes).map((url) => [url, [`rule/${url.charAt(8)}`]]));
  return {
    watched,
    own: new Map([[OWN, ['analysis/partial']]]),
    outcomes: new Map(Object.entries(outcomes)),
    baseline: new Map(Object.entries(baseline)),
    complete,
  };
}

describe('parseBaseline and serializeBaseline', () => {
  it('round-trips with sorted keys and a trailing newline', () => {
    const baseline: Baseline = new Map([
      [B, H2],
      [A, H1],
    ]);
    const text = serializeBaseline(baseline);
    expect(text).toBe(`{\n  "${A}": "${H1}",\n  "${B}": "${H2}"\n}\n`);
    expect([...parseBaseline(text)]).toEqual([
      [A, H1],
      [B, H2],
    ]);
  });

  it('serializes an empty baseline', () => {
    expect(serializeBaseline(new Map())).toBe('{}\n');
  });

  it('lists every problem', () => {
    expect(() =>
      parseBaseline(JSON.stringify({ 'http://a.example/': H1, [B]: 'abc', [C]: 1 })),
    ).toThrow(
      [
        'not an https URL: http://a.example/',
        `not a SHA-256 hex digest for ${B}`,
        `not a SHA-256 hex digest for ${C}`,
      ].join('\n'),
    );
  });

  it.each([['[]'], ['null'], ['"text"']])('rejects %s', (text) => {
    expect(() => parseBaseline(text)).toThrow('the baseline must be a JSON object');
  });

  it('accepts the committed baseline, which is serialized canonically', () => {
    const text = readFileSync(
      new URL('../../../scripts/drift/baseline.json', import.meta.url),
      'utf8',
    );
    const baseline = parseBaseline(text);
    expect(baseline.size).toBeGreaterThan(0);
    expect(serializeBaseline(baseline)).toBe(text);
  });
});

describe('compareWithBaseline', () => {
  it('reports nothing when every hash matches', () => {
    const report = compareWithBaseline(
      input({ [A]: { ok: true, hash: H1, text: '' } }, { [A]: H1 }),
    );
    expect(report).toEqual({
      version: 2,
      checked: 1,
      changed: [],
      moved: [],
      unreachable: [],
      unchanged: 1,
      uncited: [],
      skipped: [{ url: OWN, rules: ['analysis/partial'] }],
    });
    expect(needsAttention(report)).toBe(false);
  });

  it('reports changed, new, unreachable and no longer cited sources', () => {
    const report = compareWithBaseline(
      input(
        {
          [A]: { ok: true, hash: H1, text: '' },
          [B]: { ok: true, hash: H3, text: '' },
          [C]: { ok: true, hash: H2, text: '' },
          [D]: { ok: false, reason: 'HTTP 404' },
        },
        { [A]: H1, [B]: H2, [D]: H1, [OLD]: H1 },
      ),
    );
    expect(report.changed).toEqual([
      { url: B, rules: ['rule/b'], previous: H2, current: H3 },
      { url: C, rules: ['rule/c'], previous: null, current: H2 },
    ]);
    expect(report.unreachable).toEqual([{ url: D, rules: ['rule/d'], reason: 'HTTP 404' }]);
    expect(report.unchanged).toBe(1);
    expect(report.checked).toBe(4);
    expect(report.uncited).toEqual([OLD]);
    expect(needsAttention(report)).toBe(true);
  });

  it('reports a source that redirects elsewhere as moved, not as changed or unchanged', () => {
    const report = compareWithBaseline(
      input(
        {
          [A]: { ok: true, hash: H1, text: '', location: 'https://a.example/new' },
          [B]: { ok: true, hash: H3, text: '', location: 'https://b.example/new' },
          [C]: { ok: true, hash: H2, text: '' },
        },
        { [A]: H1, [B]: H2, [C]: H2 },
      ),
    );
    expect(report.moved).toEqual([
      { url: A, rules: ['rule/a'], location: 'https://a.example/new', previous: H1, current: H1 },
      { url: B, rules: ['rule/b'], location: 'https://b.example/new', previous: H2, current: H3 },
    ]);
    expect(report.changed).toEqual([]);
    expect(report.unchanged).toBe(1);
    expect(needsAttention(report)).toBe(true);
  });

  it('records the hash of a moved source on update, like any other', () => {
    const result = updateBaseline(
      input(
        { [A]: { ok: true, hash: H2, text: '', location: 'https://a.example/new' } },
        {
          [A]: H1,
        },
      ),
    );
    expect([...result.baseline]).toEqual([[A, H2]]);
  });

  it('counts an unreachable source as needing attention on its own', () => {
    const report = compareWithBaseline(input({ [A]: { ok: false, reason: 'HTTP 500' } }, {}));
    expect(report.changed).toEqual([]);
    expect(needsAttention(report)).toBe(true);
  });

  it('treats a URL without an outcome as unreachable', () => {
    const base = input({ [A]: { ok: true, hash: H1, text: '' } }, { [A]: H1 });
    const report = compareWithBaseline({ ...base, outcomes: new Map() });
    expect(report.unreachable).toEqual([{ url: A, rules: ['rule/a'], reason: 'not fetched' }]);
  });

  it('does not report uncited entries for a partial check', () => {
    const report = compareWithBaseline(
      input({ [A]: { ok: true, hash: H1, text: '' } }, { [A]: H1, [B]: H2 }, false),
    );
    expect(report.uncited).toEqual([]);
  });
});

describe('updateBaseline', () => {
  it('records current hashes, keeps unreachable ones and drops uncited entries', () => {
    const result = updateBaseline(
      input(
        {
          [A]: { ok: true, hash: H1, text: '' },
          [B]: { ok: true, hash: H3, text: '' },
          [C]: { ok: false, reason: 'HTTP 503' },
          [D]: { ok: false, reason: 'HTTP 404' },
        },
        { [A]: H1, [B]: H2, [C]: H2, [OLD]: H1 },
      ),
    );
    expect([...result.baseline].sort()).toEqual([
      [A, H1],
      [B, H3],
      [C, H2],
    ]);
    expect(result.updated).toEqual([B]);
    expect(result.kept).toEqual([C]);
    expect(result.missing).toEqual([D]);
    expect(result.removed).toEqual([OLD]);
  });

  it('leaves every other entry alone in a partial update', () => {
    const result = updateBaseline(
      input({ [B]: { ok: true, hash: H3, text: '' } }, { [A]: H1, [B]: H2, [OLD]: H1 }, false),
    );
    expect([...result.baseline].sort()).toEqual([
      [A, H1],
      [B, H3],
      [OLD, H1],
    ]);
    expect(result.removed).toEqual([]);
  });
});
