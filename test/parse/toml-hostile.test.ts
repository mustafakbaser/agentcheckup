import { beforeAll, describe, expect, it } from 'vitest';
import { issueKind } from '../../src/parse/json-access.js';
import { MAX_TOML_LENGTH, parseToml, TOML_ISSUE, type TomlSource } from '../../src/parse/toml.js';
import type { TomlDocument } from '../../src/parse/types.js';

/**
 * Inputs built to hurt a TOML parser. Each must parse without throwing, end as the case says,
 * and take under 100 ms (the best of three runs, so one garbage collection pause does not
 * count).
 *
 * Coverage instrumentation and a loaded machine slow every parse, so as in performance.test.ts
 * the bound grows with a benign document of about 1 MiB parsed in the same process: a hostile
 * input may cost at most `MAX_RATIO` times that, and always passes under `BUDGET_MS`. On an
 * idle machine without coverage the benign document takes a fraction of the budget, so the
 * bound is 100 ms; super-linear behavior misses either bound by far.
 */
const BUDGET_MS = 100;
const MAX_RATIO = 4;
const MiB = 1024 * 1024;

const fill = (unit: string, length = MAX_TOML_LENGTH - 64): string =>
  unit.repeat(Math.floor(length / unit.length));

const lines = (count: number, line: (i: number) => string): string =>
  Array.from({ length: count }, (_, i) => line(i)).join('\n');

function timed(text: string, source?: TomlSource): { doc: TomlDocument; elapsed: number } {
  let best = Infinity;
  let doc: TomlDocument | undefined;
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    doc = parseToml(text, source);
    best = Math.min(best, performance.now() - started);
  }
  if (doc === undefined) throw new Error('not parsed');
  return { doc, elapsed: best };
}

/** A realistic `.codex/config.toml`, repeated to about 1 MiB. */
const BENIGN = lines(6000, (i) =>
  [
    `[mcp_servers.server-${i}]`,
    'command = "npx"',
    `args = ["-y", "@example/server-${i}@1.2.3"]`,
    `env = { API_URL = "https://example.com/${i}", DEBUG = "0" }`,
    'startup_timeout_sec = 20',
    '',
  ].join('\n'),
);

/** The issue code, or `ok`. */
const outcome = (doc: TomlDocument): string => (doc.ok ? 'ok' : (doc.errors[0]?.code ?? ''));

interface Case {
  readonly text: () => string;
  readonly source?: TomlSource;
  /** The issue code, or `ok`. */
  readonly expect: string;
}

const CASES: Record<string, Case> = {
  '100k nested arrays': { text: () => `a = ${'['.repeat(100_000)}`, expect: TOML_ISSUE.tooDeep },
  '100k nested inline tables': {
    text: () => `a = ${'{b='.repeat(100_000)}`,
    expect: TOML_ISSUE.tooDeep,
  },
  '100k nested arrays, closed': {
    text: () => `a = ${'['.repeat(100_000)}${']'.repeat(100_000)}`,
    expect: TOML_ISSUE.tooDeep,
  },
  '10^6 dotted segments': {
    text: () => `${'a.'.repeat(1_000_000)}a = 1`,
    expect: TOML_ISSUE.tooLarge,
  },
  'dotted segments up to 1 MiB': { text: () => `${fill('a.')}a = 1`, expect: TOML_ISSUE.tooDeep },
  'header segments up to 1 MiB': { text: () => `[${fill('a.')}a]`, expect: TOML_ISSUE.tooDeep },
  'quoted dotted segments': { text: () => `${fill('"".')}"" = 1`, expect: TOML_ISSUE.tooDeep },
  '1 MiB of escapes': { text: () => `a = "${fill('\\n')}"`, expect: 'ok' },
  '1 MiB of unicode escapes': { text: () => `a = "${fill('\\u00E9\\U0001F600')}"`, expect: 'ok' },
  '1 MiB of line-ending backslashes': { text: () => `a = """${fill('\\\n')}"""`, expect: 'ok' },
  'over 1 MiB of escapes': {
    text: () => `a = "${'\\n'.repeat(MiB)}"`,
    expect: TOML_ISSUE.tooLarge,
  },
  '1 MiB of quotes': { text: () => `a = """${fill('""a')}"""`, expect: 'ok' },
  'unterminated multi-line string': {
    text: () => `a = """${fill('x\n')}`,
    expect: TOML_ISSUE.unterminatedString,
  },
  '50k tables': { text: () => lines(50_000, (i) => `[t${i}]\nk = ${i}`), expect: 'ok' },
  '50k sub-tables of one table': { text: () => lines(50_000, (i) => `[t.s${i}]`), expect: 'ok' },
  '50k array-of-tables elements': { text: () => lines(50_000, () => '[[t]]'), expect: 'ok' },
  '50k dotted keys into one table': {
    text: () => lines(50_000, (i) => `t.k${i} = 1`),
    expect: 'ok',
  },
  'too many values': {
    text: () => fill('a=[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]\n'),
    expect: TOML_ISSUE.duplicateKey,
  },
  'too many array values': { text: () => `a = [${fill('1,')}]`, expect: TOML_ISSUE.tooManyNodes },
  'too many tables': { text: () => fill('[[t]]\n'), expect: TOML_ISSUE.tooManyNodes },
  'too many pairs': {
    text: () => lines(110_000, (i) => `${i.toString(36)}=1`),
    expect: TOML_ISSUE.tooManyNodes,
  },
  '__proto__ and constructor keys': {
    text: () =>
      [
        '__proto__.polluted = true',
        'constructor = { prototype = { polluted = true } }',
        lines(5000, (i) =>
          [
            `[__proto__.k${i}]`,
            `"__proto__" = { toString = ${i} }`,
            `constructor.prototype.polluted${i} = true`,
          ].join('\n'),
        ),
        '[[toString.valueOf]]',
      ].join('\n'),
    expect: 'ok',
  },
  'NUL in a string': {
    text: () => `a = "${fill('x')}\u0000"`,
    expect: TOML_ISSUE.controlCharacter,
  },
  'NUL in a comment': { text: () => `# ${fill('x')}\u0000`, expect: TOML_ISSUE.controlCharacter },
  'NUL bytes': { text: () => fill('\u0000'), expect: TOML_ISSUE.expectedKey },
  'bare CR line ends': { text: () => fill('a = 1\r'), expect: TOML_ISSUE.bareCarriageReturn },
  'CR runs': { text: () => fill('\r'), expect: TOML_ISSUE.bareCarriageReturn },
  'CRLF blank lines': { text: () => fill('\r\n'), expect: 'ok' },
  'U+2028 in strings and comments': {
    text: () => lines(60_000, (i) => `k${i} = "\u2028" # \u2028`),
    expect: 'ok',
  },
  'U+2028 as a line break': { text: () => `a = 1\u2028b = 2`, expect: TOML_ISSUE.expectedNewline },
  'BOM from the decoder': {
    text: () => lines(60_000, (i) => `k${i} = 1`),
    source: { hasBom: true },
    expect: 'ok',
  },
  'BOM in the text': {
    text: () => `\ufeff${lines(60_000, (i) => `k${i} = 1`)}`,
    expect: 'ok',
  },
  '1 MiB of BOMs': { text: () => fill('\ufeff'), expect: TOML_ISSUE.expectedKey },
  'BOMs after the decoder removed one': {
    text: () => fill('\ufeff'),
    source: { hasBom: true },
    expect: TOML_ISSUE.expectedKey,
  },
  'not UTF-8, 1 MiB of replacement characters': {
    text: () => fill('\ufffd'),
    source: { hadDecodeErrors: true },
    expect: TOML_ISSUE.invalidUtf8,
  },
  '1 MiB of inline table line breaks and comments': {
    text: () => `t = {${fill('\n# c\n')}a = 1}`,
    expect: 'ok',
  },
  '1 MiB of trailing commas': {
    text: () => lines(20_000, (i) => `t${i} = { a = 1, b = { c = 2, }, }`),
    expect: 'ok',
  },
  '1 MiB of hex escapes': { text: () => `a = "${fill('\\x41\\e')}"`, expect: 'ok' },
  'BOMs after the first line': {
    text: () => `a = 1\n${fill('\ufeff')}`,
    expect: TOML_ISSUE.expectedKey,
  },
  'UTF-16': {
    text: () => 'a = 1',
    source: { encoding: 'utf-16be', hasBom: true },
    expect: TOML_ISSUE.utf16,
  },
  'i64 overflow': { text: () => `a = ${fill('9')}`, expect: TOML_ISSUE.integerOverflow },
  'hex overflow': { text: () => `a = 0x${fill('f')}`, expect: TOML_ISSUE.integerOverflow },
  'float overflow': { text: () => `a = 1e${fill('9')}`, expect: TOML_ISSUE.floatOverflow },
  'i64 boundaries': {
    text: () =>
      lines(4000, (i) =>
        [
          `a${i} = 9223372036854775807`,
          `b${i} = -9223372036854775808`,
          `c${i} = 0x7FFF_FFFF_FFFF_FFFF`,
          `d${i} = 0o777777777777777777777`,
          `e${i} = 0b${'1'.repeat(63)}`,
        ].join('\n'),
      ),
    expect: 'ok',
  },
  'long underscored number': {
    text: () => `a = 1${fill('_0')}`,
    expect: TOML_ISSUE.integerOverflow,
  },
  'long fraction': { text: () => `a = 0.${fill('1')}`, expect: 'ok' },
  'long date-time fraction': { text: () => `a = 1979-05-27T07:32:00.${fill('9')}Z`, expect: 'ok' },
  '1 MiB of brackets': { text: () => fill('['), expect: TOML_ISSUE.expectedKey },
  '1 MiB of opening headers': {
    text: () => fill('[a]\n[[a]]\n'),
    expect: TOML_ISSUE.redefinedTable,
  },
  '1 MiB of equals signs': { text: () => fill('='), expect: TOML_ISSUE.expectedKey },
  '1 MiB of comments': { text: () => fill('#####\n'), expect: 'ok' },
  '1 MiB of whitespace': { text: () => fill(' \t'), expect: 'ok' },
  '1 MiB key': { text: () => `${fill('k')} = 1`, expect: 'ok' },
  'duplicate keys': { text: () => fill('a = 1\n'), expect: TOML_ISSUE.duplicateKey },
};

describe('hostile TOML input', () => {
  let limit = BUDGET_MS;

  beforeAll(() => {
    // Warm up, so the first case does not pay for compilation, then measure the benign document.
    for (let i = 0; i < 3; i++) parseToml(BENIGN);
    const baseline = timed(BENIGN);
    expect(baseline.doc.ok).toBe(true);
    limit = Math.max(BUDGET_MS, MAX_RATIO * baseline.elapsed);
  });

  it('measures against a benign document of about 1 MiB', () => {
    expect(BENIGN.length).toBeGreaterThan(0.9 * MiB);
    expect(BENIGN.length).toBeLessThan(MAX_TOML_LENGTH);
  });

  it.each(Object.keys(CASES))('%s', (name) => {
    const hostile = CASES[name];
    if (hostile === undefined) throw new Error(name);
    const text = hostile.text();
    const { doc, elapsed } = timed(text, hostile.source);
    expect(outcome(doc)).toBe(hostile.expect);
    if (!doc.ok) {
      const [issue] = doc.errors;
      expect(doc.errors).toHaveLength(1);
      expect((issue?.span.offset ?? 0) + (issue?.span.length ?? 0)).toBeLessThanOrEqual(
        text.length,
      );
      expect(issue?.message.length).toBeLessThan(200);
    }
    expect(
      elapsed,
      `${name} took ${elapsed.toFixed(1)} ms (limit ${limit.toFixed(0)} ms)`,
    ).toBeLessThan(limit);
  });

  it('keeps Object.prototype untouched', () => {
    const doc = parseToml(CASES['__proto__ and constructor keys']?.text() ?? '');
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const root = doc.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.hasOwn(root, '__proto__')).toBe(true);
    expect(Object.hasOwn(root, 'constructor')).toBe(true);
    const proto = root['__proto__'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(proto)).toBeNull();
    expect(proto['polluted']).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.prototype).not.toHaveProperty('polluted0');
    expect(Object.prototype).not.toHaveProperty('k0');
  });

  it('reads 1 MiB of escapes into the right string', () => {
    const doc = parseToml(CASES['1 MiB of escapes']?.text() ?? '');
    if (!doc.ok) throw new Error('not parsed');
    const value = (doc.value as Record<string, unknown>)['a'];
    expect(typeof value === 'string' && value.length).toBe(Math.floor((MAX_TOML_LENGTH - 64) / 2));
    expect(typeof value === 'string' && /^\n+$/u.test(value)).toBe(true);
  });

  it('reports limits and unsupported input as such, not as syntax errors', () => {
    for (const name of ['100k nested arrays', 'too many tables', '10^6 dotted segments']) {
      const doc = parseToml(CASES[name]?.text() ?? '');
      expect(!doc.ok && doc.errors[0] !== undefined && issueKind(doc.errors[0])).toBe('limit');
    }
    const hostile = CASES['UTF-16'];
    const doc = parseToml(hostile?.text() ?? '', hostile?.source);
    expect(!doc.ok && doc.errors[0] !== undefined && issueKind(doc.errors[0])).toBe('unsupported');
  });

  it('locates spans in a large document quickly, and the same span twice gives one object', () => {
    const text = lines(50_000, (i) => `[t${i}]\nk = ${i}`);
    const doc = parseToml(text);
    if (!doc.ok) throw new Error('not parsed');
    const started = performance.now();
    for (let i = 0; i < 50_000; i += 997) {
      const span = doc.valueSpan([`t${i}`, 'k']);
      expect(span && doc.locate(span)?.path).toEqual([`t${i}`, 'k']);
    }
    expect(performance.now() - started).toBeLessThan(2000);
    const span = doc.valueSpan(['t1', 'k']) ?? { offset: 0, length: 0 };
    expect(doc.locate(span)).toBe(doc.locate(span));
  });
});
