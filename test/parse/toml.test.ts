import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jsonAnchor } from '../../src/core/fingerprint.js';
import { decode } from '../../src/core/text.js';
import type { Span } from '../../src/core/types.js';
import {
  collectStrings,
  issueKind,
  keySpanOf,
  own,
  type ParsedJson,
} from '../../src/parse/json-access.js';
import {
  MAX_TOML_DEPTH,
  MAX_TOML_LENGTH,
  MAX_TOML_NODES,
  parseToml,
  TOML_ISSUE,
  TomlDatetime,
  type TomlSource,
} from '../../src/parse/toml.js';
import type { JsonPathSegment, ParseIssue, TomlDocument } from '../../src/parse/types.js';
import { hookHandlers } from '../../src/platforms/hooks.js';

type ParsedToml = Extract<TomlDocument, { ok: true }>;

const slice = (text: string, span: Span | undefined): string | undefined =>
  span === undefined ? undefined : text.slice(span.offset, span.offset + span.length);

function ok(text: string, source?: TomlSource): ParsedToml {
  const doc = parseToml(text, source);
  if (!doc.ok) throw new Error(`expected ok, got ${JSON.stringify(doc.errors)}`);
  return doc;
}

function failed(text: string, source?: TomlSource): ParseIssue {
  const doc = parseToml(text, source);
  if (doc.ok) throw new Error('expected a failure');
  expect(doc.errors).toHaveLength(1);
  const [issue] = doc.errors;
  if (issue === undefined) throw new Error('no issue');
  return issue;
}

/** `[code, the text the span covers]`. */
const issue = (text: string): [string, string | undefined] => {
  const found = failed(text);
  return [found.code, slice(text, found.span)];
};

/** The parsed value at `path`. */
function at(doc: ParsedToml, path: readonly JsonPathSegment[]): unknown {
  let value: unknown = doc.value;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// toml-test
// ---------------------------------------------------------------------------------------------

const SUITE = fileURLToPath(new URL('../fixtures/toml-test/', import.meta.url));

function cases(directory: string): string[] {
  return readdirSync(join(SUITE, directory), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.toml'))
    .map((path) => `${directory}/${path.split('\\').join('/')}`)
    .sort();
}

function parseFile(path: string): { text: string; doc: TomlDocument } {
  const decoded = decode(readFileSync(join(SUITE, path)));
  return { text: decoded.text, doc: parseToml(decoded.text, decoded) };
}

const DATETIME_TAGS: Readonly<Record<string, string>> = {
  'offset-datetime': 'datetime',
  'local-datetime': 'datetime-local',
  'local-date': 'date-local',
  'local-time': 'time-local',
};

/**
 * A date-time as toml_datetime displays it: `T` and `Z` upper case, a fraction cut to nine
 * digits without trailing zeros, `-00:00` as `+00:00`.
 */
function normalizeDatetime(value: string): string {
  let out = value;
  if (out.length > 10 && (out.charAt(10) === ' ' || out.charAt(10) === 't')) {
    out = `${out.slice(0, 10)}T${out.slice(11)}`;
  }
  if (out.endsWith('z')) out = `${out.slice(0, -1)}Z`;
  const dot = out.indexOf('.');
  if (dot !== -1) {
    let end = dot + 1;
    while (end < out.length && out.charCodeAt(end) >= 0x30 && out.charCodeAt(end) <= 0x39) end++;
    let fraction = out.slice(dot + 1, Math.min(end, dot + 10));
    while (fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    out = out.slice(0, dot) + (fraction === '' ? '' : `.${fraction}`) + out.slice(end);
  }
  if (out.endsWith('-00:00')) out = `${out.slice(0, -6)}+00:00`;
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A parsed value in toml-test's tagged JSON form, with floats as numbers. */
function tagged(doc: ParsedToml, value: unknown, path: JsonPathSegment[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => tagged(doc, item, [...path, i]));
  if (value instanceof TomlDatetime) {
    return { type: DATETIME_TAGS[value.kind], value: value.text };
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = tagged(doc, value[key], [...path, key]);
    return out;
  }
  const span = doc.valueSpan(path);
  const location = span === undefined ? undefined : doc.locate(span);
  const type = location?.tomlType;
  if (type === 'integer') return { type, value: location?.canonical() };
  if (type === 'boolean') return { type: 'bool', value: String(value) };
  return { type, value };
}

/** toml-test's expected JSON with integers in canonical form and floats as numbers. */
function expected(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expected);
  if (!isRecord(value)) return value;
  const { type, value: text } = value;
  if (Object.keys(value).length === 2 && typeof type === 'string' && typeof text === 'string') {
    if (type === 'integer') return { type, value: BigInt(text).toString() };
    if (type === 'float') {
      const number =
        text === 'nan'
          ? Number.NaN
          : text === 'inf'
            ? Infinity
            : text === '-inf'
              ? -Infinity
              : Number(text);
      return { type, value: number };
    }
    if (type.startsWith('date') || type.startsWith('time')) {
      return { type, value: normalizeDatetime(text) };
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = expected(value[key]);
  return out;
}

/** Encoding cases agentcheckup does not parse at all (see the fixture README). */
const UNREAD_ENCODINGS: Readonly<Record<string, string>> = {
  'invalid/encoding/utf16-bom.toml': TOML_ISSUE.utf16,
  'invalid/encoding/bom-not-at-start-02.toml': TOML_ISSUE.bom,
  'invalid/encoding/bom-not-at-start-03.toml': TOML_ISSUE.bom,
};

describe('toml-test (TOML 1.0)', () => {
  it('parses every valid case into its tagged JSON', () => {
    const paths = cases('valid');
    expect(paths.length).toBe(208);
    const failures: string[] = [];
    for (const path of paths) {
      const { doc } = parseFile(path);
      if (!doc.ok) {
        failures.push(`${path}: ${JSON.stringify(doc.errors)}`);
        continue;
      }
      const want = JSON.parse(
        readFileSync(join(SUITE, path.replace('.toml', '.json')), 'utf8'),
      ) as unknown;
      try {
        expect(tagged(doc, doc.value, [])).toEqual(expected(want));
      } catch {
        failures.push(path);
      }
    }
    expect(failures).toEqual([]);
  });

  it('gives exactly one syntax issue, inside the text, for every invalid case', () => {
    const paths = cases('invalid');
    expect(paths.length).toBe(484);
    const failures: string[] = [];
    for (const path of paths) {
      const { text, doc } = parseFile(path);
      const want = UNREAD_ENCODINGS[path];
      if (doc.ok) {
        failures.push(`${path}: parsed`);
      } else if (doc.errors.length !== 1) {
        failures.push(`${path}: ${doc.errors.length} issues`);
      } else {
        const [found] = doc.errors;
        const kind = found === undefined ? undefined : issueKind(found);
        if (want === undefined ? kind !== 'other' : found?.code !== want) {
          failures.push(`${path}: ${found?.code ?? ''}`);
        }
        const end = (found?.span.offset ?? 0) + (found?.span.length ?? 0);
        if (end > text.length) failures.push(`${path}: span outside the text`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('reports the TOML 1.1 cases as unsupported, not as values or syntax errors', () => {
    const paths = cases('toml-1.1');
    expect(paths.length).toBe(15);
    for (const path of paths) {
      const { doc } = parseFile(path);
      expect(doc.ok, path).toBe(false);
      if (doc.ok) continue;
      expect(
        doc.errors.map((found) => found.code),
        path,
      ).toEqual([TOML_ISSUE.unsupported]);
      expect(issueKind(doc.errors[0] ?? failed('=')), path).toBe('unsupported');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

describe('values', () => {
  it('builds frozen null-prototype tables and frozen arrays', () => {
    const doc = ok('a = 1\n[t]\nb = [1, {c = 2}]\n[[x]]\n[[x]]\nd = true\n');
    const root = doc.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.isFrozen(root)).toBe(true);
    const t = root['t'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(t)).toBeNull();
    const b = t['b'] as unknown[];
    expect(Array.isArray(b) && Object.isFrozen(b)).toBe(true);
    expect(Object.getPrototypeOf(b[1])).toBeNull();
    expect(Object.isFrozen(b[1])).toBe(true);
    expect(at(doc, ['x'])).toEqual([{}, { d: true }]);
    expect(Object.isFrozen(at(doc, ['x']))).toBe(true);
  });

  it('reads every string form and escape', () => {
    const doc = ok(
      [
        String.raw`basic = "tab\there \"q\" \\ \b\f\n\r \u00e9 \U0001F600"`,
        `literal = 'C:\\path\\no escapes'`,
        'ml = """',
        'line one',
        String.raw`  trimmed \   `,
        '',
        '    here"""',
        "mll = '''",
        "keep \\n as is ''two quotes''",
        "'''",
        'quotes = """""a"" b"""""',
        'empty = ""',
        'empty-ml = """"""',
        'crlf = """\r\na\r\nb"""',
      ].join('\n'),
    );
    expect(at(doc, ['basic'])).toBe('tab\there "q" \\ \b\f\n\r é 😀');
    expect(at(doc, ['literal'])).toBe('C:\\path\\no escapes');
    expect(at(doc, ['ml'])).toBe('line one\n  trimmed here');
    expect(at(doc, ['mll'])).toBe("keep \\n as is ''two quotes''\n");
    expect(at(doc, ['quotes'])).toBe('""a"" b""');
    expect(at(doc, ['empty'])).toBe('');
    expect(at(doc, ['empty-ml'])).toBe('');
    // Codex's crate keeps CRLF inside multi-line strings and trims only the first line break.
    expect(at(doc, ['crlf'])).toBe('a\r\nb');
  });

  it('reads integers in every base, exactly, and floats', () => {
    const text = [
      'dec = +1_000',
      'neg = -17',
      'zero = -0',
      'hex = 0xDEAD_beef',
      'oct = 0o755',
      'bin = 0b1101',
      'big = 9223372036854775807',
      'small = -9223372036854775808',
      'bighex = 0x7fffffffffffffff',
      'float = 6.626e-34',
      'exp = 1E+6',
      'negzero = -0.0',
      'pinf = +inf',
      'ninf = -inf',
      'nan = -nan',
    ].join('\n');
    const doc = ok(text);
    expect(doc.value).toMatchObject({
      dec: 1000,
      neg: -17,
      zero: 0,
      hex: 0xdeadbeef,
      oct: 0o755,
      bin: 13,
      float: 6.626e-34,
      exp: 1e6,
      pinf: Infinity,
      ninf: -Infinity,
    });
    expect(Object.is(at(doc, ['zero']), 0)).toBe(true);
    expect(Object.is(at(doc, ['negzero']), -0)).toBe(true);
    expect(at(doc, ['nan'])).toBeNaN();
    const canonical = (key: string): string | undefined =>
      doc.locate(doc.valueSpan([key]) ?? { offset: -1, length: 0 })?.canonical();
    expect(canonical('big')).toBe('9223372036854775807');
    expect(canonical('small')).toBe('-9223372036854775808');
    expect(canonical('bighex')).toBe('9223372036854775807');
    expect(canonical('zero')).toBe('0');
    expect(canonical('pinf')).toBe('inf');
    expect(canonical('ninf')).toBe('-inf');
    expect(canonical('nan')).toBe('nan');
    expect(canonical('float')).toBe('6.626e-34');
    const types = ['dec', 'float', 'nan'].map(
      (key) => doc.locate(doc.valueSpan([key]) ?? { offset: -1, length: 0 })?.tomlType,
    );
    expect(types).toEqual(['integer', 'float', 'float']);
  });

  it('keeps date-times opaque and validated', () => {
    const doc = ok(
      [
        'odt = 1979-05-27T07:32:00.999000Z',
        'space = 1979-05-27 00:32:00-07:00',
        'lower = 1979-05-27t07:32:00z',
        'minus-zero = 2000-01-01T00:00:00-00:00',
        'nanos = 2000-01-01T00:00:00.1234567891',
        'ldt = 1979-05-27T07:32:00',
        'ld = 1979-05-27',
        'lt = 07:32:00.5',
        'leap = 2024-02-29',
        'leap-second = 23:59:60',
      ].join('\n'),
    );
    const datetime = (key: string): [string, string] => {
      const value = at(doc, [key]);
      if (!(value instanceof TomlDatetime)) throw new Error(`${key} is not a date-time`);
      return [value.kind, value.text];
    };
    expect(datetime('odt')).toEqual(['offset-datetime', '1979-05-27T07:32:00.999Z']);
    expect(datetime('space')).toEqual(['offset-datetime', '1979-05-27T00:32:00-07:00']);
    expect(datetime('lower')).toEqual(['offset-datetime', '1979-05-27T07:32:00Z']);
    expect(datetime('minus-zero')).toEqual(['offset-datetime', '2000-01-01T00:00:00+00:00']);
    expect(datetime('nanos')).toEqual(['local-datetime', '2000-01-01T00:00:00.123456789']);
    expect(datetime('ldt')).toEqual(['local-datetime', '1979-05-27T07:32:00']);
    expect(datetime('ld')).toEqual(['local-date', '1979-05-27']);
    expect(datetime('lt')).toEqual(['local-time', '07:32:00.5']);
    expect(datetime('leap')).toEqual(['local-date', '2024-02-29']);
    expect(datetime('leap-second')).toEqual(['local-time', '23:59:60']);
    const value = at(doc, ['odt']);
    // Opaque to JSON helpers: no own properties, JSON text is the date-time.
    expect(Object.keys(value as object)).toEqual([]);
    expect(own(value as Record<string, unknown>, 'kind')).toBeUndefined();
    expect(JSON.stringify(value)).toBe('"1979-05-27T07:32:00.999Z"');
    expect(String(value)).toBe('1979-05-27T07:32:00.999Z');
    expect(Object.isFrozen(value)).toBe(true);
    const location = doc.locate(doc.valueSpan(['odt']) ?? { offset: -1, length: 0 });
    expect([location?.type, location?.tomlType, location?.canonical()]).toEqual([
      'string',
      'offset-datetime',
      '"1979-05-27T07:32:00.999Z"',
    ]);
  });

  it('reads bare, quoted and dotted keys, with whitespace around dots', () => {
    const doc = ok(
      [
        'bare_key-1 = 1',
        '"quoted \\u00e9" = 2',
        "'literal \\n' = 3",
        '"" = 4',
        'a . "b" . \'c\' = 5',
        '3.14159 = "pi"',
        '[ x . "y" ]',
        'z = 6',
        '[[ arr ]]',
      ].join('\n'),
    );
    expect(doc.value).toEqual({
      'bare_key-1': 1,
      'quoted é': 2,
      'literal \\n': 3,
      '': 4,
      a: { b: { c: 5 } },
      3: { 14159: 'pi' },
      x: { y: { z: 6 } },
      arr: [{}],
    });
  });

  it('allows comments, blank lines, CRLF and trailing commas in arrays', () => {
    const doc = ok(
      '# head\r\n\r\na = [ # open\r\n  1, # one\r\n\r\n  2,\r\n] # close\r\n[t] # table\r\nb = 1#x',
    );
    expect(doc.value).toEqual({ a: [1, 2], t: { b: 1 } });
    expect(ok('').value).toEqual({});
    expect(ok('# only a comment').value).toEqual({});
    expect(ok('\n\n  \t\n').value).toEqual({});
  });

  it('defines tables the way the toml crate does', () => {
    // [a.b] creates `a` implicitly; [a] may define it afterwards.
    expect(ok('[a.b]\nx = 1\n[a]\ny = 2').value).toEqual({ a: { b: { x: 1 }, y: 2 } });
    // A [table] header may add a sub-table to a table that dotted keys defined.
    expect(ok('[fruit]\napple.color = "red"\n[fruit.apple.texture]\nsmooth = true').value).toEqual({
      fruit: { apple: { color: 'red', texture: { smooth: true } } },
    });
    // Dotted keys may extend a table that dotted keys defined.
    expect(ok('a.b = 1\na.c = 2').value).toEqual({ a: { b: 1, c: 2 } });
    // [x.y] after [[x]] adds to the last element.
    expect(ok('[[x]]\nn = 1\n[[x]]\nn = 2\n[x.y]\nz = 3').value).toEqual({
      x: [{ n: 1 }, { n: 2, y: { z: 3 } }],
    });
    // The crate descends into the last element of an array of tables for a dotted key, and a
    // new dotted table below it may take keys.
    expect(ok('[[t.arr]]\n[t]\narr.x.y = 1').value).toEqual({ t: { arr: [{ x: { y: 1 } }] } });
    // Inline tables may use dotted keys inside their braces.
    expect(ok('a = { b.c = 1, b.d = 2 }').value).toEqual({ a: { b: { c: 1, d: 2 } } });
  });

  it('treats __proto__ and constructor as plain keys', () => {
    const doc = ok(
      '__proto__ = { polluted = true }\nconstructor.prototype.x = 1\n[toString]\n[[hasOwnProperty]]',
    );
    const root = doc.value as Record<string, unknown>;
    expect(Object.keys(root)).toEqual(['__proto__', 'constructor', 'toString', 'hasOwnProperty']);
    expect(Object.hasOwn(root, '__proto__')).toBe(true);
    expect(own(root, '__proto__')).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('x');
  });
});

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

describe('errors', () => {
  it.each([
    // Duplicate keys, in every form.
    ['a = 1\na = 2', TOML_ISSUE.duplicateKey, 'a'],
    ['a = 1\n"a" = 2', TOML_ISSUE.duplicateKey, '"a"'],
    ["a.b = 1\na.'b' = 2", TOML_ISSUE.duplicateKey, "'b'"],
    ['t = { x = 1, x = 2 }', TOML_ISSUE.duplicateKey, 'x'],
    ['a.b = 1\na = 2', TOML_ISSUE.duplicateKey, 'a'],
    ['a = 1\n[a]', TOML_ISSUE.duplicateKey, 'a'],
    ['a = 1\n[[a]]', TOML_ISSUE.duplicateKey, 'a'],
    // A table defined twice.
    ['[a]\n[a]', TOML_ISSUE.redefinedTable, 'a'],
    ['[a]\nb = 1\n[a]\nc = 2', TOML_ISSUE.redefinedTable, 'a'],
    ['[a.b]\n[a]\n[a]', TOML_ISSUE.redefinedTable, 'a'],
    ['[a]\n[[a]]', TOML_ISSUE.redefinedTable, 'a'],
    ['[[a]]\n[a]', TOML_ISSUE.redefinedTable, 'a'],
    ['[a.b.c]\nz = 9\n[a]\nb.c.t = 9', TOML_ISSUE.redefinedTable, 'c'],
    ['[a.b.c]\n[a]\nb.d = 1', TOML_ISSUE.redefinedTable, 'd'],
    // A [table] header after dotted keys defined the table.
    ['a.b = 1\n[a]', TOML_ISSUE.dottedTableRedefined, 'a'],
    ['[fruit]\napple.color = "red"\n[fruit.apple]', TOML_ISSUE.dottedTableRedefined, 'apple'],
    // [[x]] over a static array, and keys added to one.
    ['a = []\n[[a]]', TOML_ISSUE.staticArrayExtended, 'a'],
    ['a = [{}]\n[a.b]', TOML_ISSUE.staticArrayExtended, 'a'],
    ['a = [1]\na.b = 2', TOML_ISSUE.staticArrayExtended, 'a'],
    // Extending an inline table.
    ['a = {}\n[a]', TOML_ISSUE.inlineTableExtended, 'a'],
    ['a = {b = 1}\na.c = 2', TOML_ISSUE.inlineTableExtended, 'a'],
    ['a = {b = 1}\n[a.c]', TOML_ISSUE.inlineTableExtended, 'a'],
    ['a = {}\n[[a]]', TOML_ISSUE.inlineTableExtended, 'a'],
    ['t = { a = {}, a.b = 1 }', TOML_ISSUE.inlineTableExtended, 'a'],
    // A key used as a table where it holds a value.
    ['a = 1\na.b = 2', TOML_ISSUE.notATable, 'a'],
    ['a = "x"\n[a.b]', TOML_ISSUE.notATable, 'a'],
    // Escapes.
    [String.raw`a = "\q"`, TOML_ISSUE.invalidEscape, '\\q'],
    [String.raw`a = "\u12"`, TOML_ISSUE.invalidEscape, '\\u12'],
    [String.raw`a = "\U0000004"`, TOML_ISSUE.invalidEscape, '\\U0000004'],
    ['a = """\\  x"""', TOML_ISSUE.invalidEscape, '\\  '],
    [String.raw`a = "\uD800"`, TOML_ISSUE.invalidUnicodeEscape, '\\uD800'],
    [String.raw`a = "\uDFFF"`, TOML_ISSUE.invalidUnicodeEscape, '\\uDFFF'],
    [String.raw`a = "\U00110000"`, TOML_ISSUE.invalidUnicodeEscape, '\\U00110000'],
    [String.raw`"\uD83D" = 1`, TOML_ISSUE.invalidUnicodeEscape, '\\uD83D'],
    // Control characters and bare carriage returns.
    ['a = "x\u0000y"', TOML_ISSUE.controlCharacter, '\u0000'],
    ['a = "x\u001by"', TOML_ISSUE.controlCharacter, '\u001b'],
    ["a = 'x\u007fy'", TOML_ISSUE.controlCharacter, '\u007f'],
    ['a = """x\u0008y"""', TOML_ISSUE.controlCharacter, '\u0008'],
    ['# comment \u0001', TOML_ISSUE.controlCharacter, '\u0001'],
    ['a = 1\rb = 2', TOML_ISSUE.bareCarriageReturn, '\r'],
    ['# comment\r', TOML_ISSUE.bareCarriageReturn, '\r'],
    ['a = """x\ry"""', TOML_ISSUE.bareCarriageReturn, '\r'],
    ["a = '''x\ry'''", TOML_ISSUE.bareCarriageReturn, '\r'],
    ['a = """\r"""', TOML_ISSUE.bareCarriageReturn, '\r'],
    ['a = "x\\\r"', TOML_ISSUE.invalidEscape, '\\\r'],
    ['a = "\ud800"', TOML_ISSUE.invalidCharacter, '\ud800'],
    // Integers out of i64 range.
    ['a = 9223372036854775808', TOML_ISSUE.integerOverflow, '9223372036854775808'],
    ['a = -9223372036854775809', TOML_ISSUE.integerOverflow, '-9223372036854775809'],
    ['a = 99999999999999999999', TOML_ISSUE.integerOverflow, '99999999999999999999'],
    ['a = 0x8000000000000000', TOML_ISSUE.integerOverflow, '0x8000000000000000'],
    ['a = 0o1000000000000000000000', TOML_ISSUE.integerOverflow, '0o1000000000000000000000'],
    [`a = 0b1${'0'.repeat(63)}`, TOML_ISSUE.integerOverflow, `0b1${'0'.repeat(63)}`],
    ['a = 1e400', TOML_ISSUE.floatOverflow, '1e400'],
    // Leading zeros.
    ['a = 01', TOML_ISSUE.leadingZero, '01'],
    ['a = -00', TOML_ISSUE.leadingZero, '-00'],
    ['a = 03.14', TOML_ISSUE.leadingZero, '03.14'],
    // Other numbers, date-times and values.
    ['a = 1__0', TOML_ISSUE.invalidNumber, '1__0'],
    ['a = 0X10', TOML_ISSUE.invalidNumber, '0X10'],
    ['a = +0x10', TOML_ISSUE.invalidNumber, '+0x10'],
    ['a = 1.', TOML_ISSUE.invalidNumber, '1.'],
    ['a = 2023-02-29', TOML_ISSUE.invalidDatetime, '2023-02-29'],
    ['a = 1979-13-01', TOML_ISSUE.invalidDatetime, '1979-13-01'],
    ['a = 24:00:00', TOML_ISSUE.invalidDatetime, '24:00:00'],
    ['a = 07:32:00Z', TOML_ISSUE.invalidDatetime, '07:32:00Z'],
    ['a = 1979-05-27T07:32:00+24:00', TOML_ISSUE.invalidDatetime, '1979-05-27T07:32:00+24:00'],
    ['a = 1979-05-27X07:32:00', TOML_ISSUE.invalidDatetime, '1979-05-27X07:32:00'],
    ['a = True', TOML_ISSUE.invalidValue, 'True'],
    ['a = bare', TOML_ISSUE.invalidValue, 'bare'],
    // Structure.
    ['a = "open', TOML_ISSUE.unterminatedString, '"open'],
    ['a = """open', TOML_ISSUE.unterminatedString, '"""'],
    ['a = [1, 2', TOML_ISSUE.unterminatedArray, '['],
    ['a = {b = 1', TOML_ISSUE.unterminatedInlineTable, '{'],
    ['a = [1 2]', TOML_ISSUE.expectedComma, '2'],
    ['a = {b = 1 c = 2}', TOML_ISSUE.expectedComma, 'c'],
    ['= 1', TOML_ISSUE.expectedKey, '='],
    ['a.', TOML_ISSUE.expectedKey, ''],
    ['a 1', TOML_ISSUE.expectedEquals, '1'],
    ['a =', TOML_ISSUE.expectedValue, ''],
    ['a = # comment', TOML_ISSUE.expectedValue, ''],
    ['a = 1 b = 2', TOML_ISSUE.expectedNewline, 'b'],
    ['a = "x"y', TOML_ISSUE.expectedNewline, 'y'],
    ['[a] b = 1', TOML_ISSUE.expectedNewline, 'b'],
    ['[a', TOML_ISSUE.expectedBracket, ''],
    ['[[a]', TOML_ISSUE.expectedBracket, ']'],
    ['[[a] ]', TOML_ISSUE.expectedBracket, ']'],
    ['[]', TOML_ISSUE.expectedKey, ']'],
    ['"""a""" = 1', TOML_ISSUE.invalidKey, '"""'],
    ['x = 1\n\u2028 = 2', TOML_ISSUE.expectedKey, '\u2028'],
    ['a = 1 \u{1F600}', TOML_ISSUE.expectedNewline, '\u{1F600}'],
  ])('%j gives %s', (text, code, covered) => {
    expect(issue(text)).toEqual([code, covered]);
  });

  it('names the key in a readable, bounded message', () => {
    const name = `k\u0007${'x'.repeat(100)}`;
    const found = failed(
      `"k\\u0007${'x'.repeat(100)}" = 1\n"${name.replace('\u0007', '\\u0007')}" = 2`,
    );
    expect(found.code).toBe(TOML_ISSUE.duplicateKey);
    expect(found.message).not.toContain('\u0007');
    expect(found.message.length).toBeLessThan(120);
  });

  it('stops at the first problem in the text', () => {
    expect(issue('a = 1\na = 2\nb = ?')).toEqual([TOML_ISSUE.duplicateKey, 'a']);
    expect(issue('b = ?\na = 1\na = 2')).toEqual([TOML_ISSUE.expectedValue, '?']);
  });
});

describe('TOML 1.1 syntax', () => {
  it.each([
    ['t = {\n  a = 1\n}', '\n'],
    ['t = { a = 1, }', ','],
    ['t = { # note\n a = 1 }', '#'],
    [String.raw`a = "\e"`, '\\e'],
    [String.raw`a = "\x41"`, '\\x41'],
    [String.raw`"\x41" = 1`, '\\x41'],
    ['a = 07:32', '07:32'],
    ['a = 1979-05-27 07:32Z', '1979-05-27 07:32Z'],
  ])('%j is unsupported', (text, covered) => {
    expect(issue(text)).toEqual([TOML_ISSUE.unsupported, covered]);
    expect(issueKind(failed(text))).toBe('unsupported');
  });

  it('reports a syntax error instead when the text is invalid in TOML 1.1 too', () => {
    expect(issue('t = {\n  a = 1\n}\nb = ?')).toEqual([TOML_ISSUE.expectedValue, '?']);
    expect(issue('a = "\\e"\na = 2')).toEqual([TOML_ISSUE.duplicateKey, 'a']);
    expect(issue(String.raw`a = "\xZZ"`)).toEqual([TOML_ISSUE.invalidEscape, '\\x']);
    expect(issue('a = 07:32.5')).toEqual([TOML_ISSUE.invalidDatetime, '07:32.5']);
  });

  it('still reads arrays with line breaks inside an inline table as TOML 1.0', () => {
    expect(ok('t = { a = [\n1,\n2,\n], b = """\nx""" }').value).toEqual({
      t: { a: [1, 2], b: 'x' },
    });
  });
});

describe('limits and encodings', () => {
  it('rejects a text over the size limit without parsing it', () => {
    const found = failed(`a = "${'x'.repeat(MAX_TOML_LENGTH)}"`);
    expect([found.code, found.span]).toEqual([TOML_ISSUE.tooLarge, { offset: 0, length: 0 }]);
    expect(issueKind(found)).toBe('limit');
    expect(ok(`a = "${'x'.repeat(MAX_TOML_LENGTH - 6)}"`).ok).toBe(true);
  });

  it('bounds key and value nesting', () => {
    const keys = (count: number): string => Array.from({ length: count }, () => 'k').join('.');
    expect(ok(`${keys(MAX_TOML_DEPTH)} = 1`).ok).toBe(true);
    expect(issue(`${keys(MAX_TOML_DEPTH + 1)} = 1`)[0]).toBe(TOML_ISSUE.tooDeep);
    expect(ok(`[${keys(MAX_TOML_DEPTH)}]`).ok).toBe(true);
    expect(issue(`[${keys(MAX_TOML_DEPTH + 1)}]`)[0]).toBe(TOML_ISSUE.tooDeep);
    expect(issue(`[[${keys(MAX_TOML_DEPTH)}]]`)[0]).toBe(TOML_ISSUE.tooDeep);
    expect(issue(`[${keys(MAX_TOML_DEPTH - 1)}]\nx.y = 1`)[0]).toBe(TOML_ISSUE.tooDeep);
    const arrays = (count: number): string => `a = ${'['.repeat(count)}${']'.repeat(count)}`;
    // `a` is one level, so 64 arrays fit and the 65th is too deep.
    expect(ok(arrays(MAX_TOML_DEPTH)).ok).toBe(true);
    const deep = failed(arrays(MAX_TOML_DEPTH + 1));
    expect([deep.code, deep.span.offset]).toEqual([TOML_ISSUE.tooDeep, 4 + MAX_TOML_DEPTH]);
    expect(issueKind(deep)).toBe('limit');
    expect(issue(`a = ${'{b = '.repeat(MAX_TOML_DEPTH)}1${'}'.repeat(MAX_TOML_DEPTH)}`)[0]).toBe(
      TOML_ISSUE.tooDeep,
    );
  });

  it('bounds the number of values', () => {
    const found = failed(`a = [${'1,'.repeat(MAX_TOML_NODES)}]`);
    expect(found.code).toBe(TOML_ISSUE.tooManyNodes);
    expect(issueKind(found)).toBe('limit');
    expect(ok(`a = [${'1,'.repeat(MAX_TOML_NODES - 2)}]`).ok).toBe(true);
  });

  it('does not parse text with a byte order mark or UTF-16 text', () => {
    const bom = failed('a = 1', { encoding: 'utf-8', hasBom: true });
    expect([bom.code, bom.span]).toEqual([TOML_ISSUE.bom, { offset: 0, length: 0 }]);
    expect(issueKind(bom)).toBe('unsupported');
    expect(issue('\ufeffa = 1')).toEqual([TOML_ISSUE.bom, '\ufeff']);
    const utf16 = failed('a = 1', { encoding: 'utf-16le', hasBom: true });
    expect(utf16.code).toBe(TOML_ISSUE.utf16);
    expect(issueKind(utf16)).toBe('unsupported');
    expect(issue('a = 1\n\ufeffb = 2')).toEqual([TOML_ISSUE.expectedKey, '\ufeff']);
    expect(ok('a = 1', { encoding: 'utf-8', hasBom: false }).ok).toBe(true);
  });

  it('classifies every issue code', () => {
    const kinds = Object.values(TOML_ISSUE).map((code) => [
      code,
      issueKind({ code, message: '', span: { offset: 0, length: 0 } }),
    ]);
    expect(kinds.filter(([, kind]) => kind !== 'other')).toEqual([
      [TOML_ISSUE.tooLarge, 'limit'],
      [TOML_ISSUE.tooDeep, 'limit'],
      [TOML_ISSUE.tooManyNodes, 'limit'],
      [TOML_ISSUE.parseFailed, 'limit'],
      [TOML_ISSUE.unsupported, 'unsupported'],
      [TOML_ISSUE.bom, 'unsupported'],
      [TOML_ISSUE.utf16, 'unsupported'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Spans and locate
// ---------------------------------------------------------------------------------------------

const SPANS = [
  'top = "v" # comment',
  'mcp_servers.dotted.command = "npx"',
  '',
  '[mcp_servers."quoted"]',
  "args = ['-y', { pkg = 1 }]",
  'env = { KEY = "x" }',
  '',
  '[tables.sub]',
  '[[hooks.PreToolUse]]',
  'matcher = "*"',
  '[[hooks.PreToolUse.hooks]]',
  'command = "./run.sh"',
  '[[hooks.PreToolUse]]',
  '',
].join('\n');

describe('spans', () => {
  const doc = ok(SPANS);
  const value = (path: JsonPathSegment[]): string | undefined => slice(SPANS, doc.valueSpan(path));
  const key = (path: JsonPathSegment[]): string | undefined => slice(SPANS, doc.keySpan(path));

  it('slices scalars, arrays and inline tables back to their text', () => {
    expect(value(['top'])).toBe('"v"');
    expect(value(['mcp_servers', 'dotted', 'command'])).toBe('"npx"');
    expect(value(['mcp_servers', 'quoted', 'args'])).toBe("['-y', { pkg = 1 }]");
    expect(value(['mcp_servers', 'quoted', 'args', 0])).toBe("'-y'");
    expect(value(['mcp_servers', 'quoted', 'args', 1])).toBe('{ pkg = 1 }');
    expect(value(['mcp_servers', 'quoted', 'args', 1, 'pkg'])).toBe('1');
    expect(value(['mcp_servers', 'quoted', 'env'])).toBe('{ KEY = "x" }');
  });

  it('spans a header table over its header and pairs, and an implicit table over its key', () => {
    expect(value(['mcp_servers', 'quoted'])).toBe(
      '[mcp_servers."quoted"]\nargs = [\'-y\', { pkg = 1 }]\nenv = { KEY = "x" }',
    );
    expect(value(['tables', 'sub'])).toBe('[tables.sub]');
    expect(value(['hooks', 'PreToolUse', 0])).toBe('[[hooks.PreToolUse]]\nmatcher = "*"');
    expect(value(['hooks', 'PreToolUse', 0, 'hooks', 0])).toBe(
      '[[hooks.PreToolUse.hooks]]\ncommand = "./run.sh"',
    );
    expect(value(['hooks', 'PreToolUse', 1])).toBe('[[hooks.PreToolUse]]');
    // Created only by keys: the span is the key that created it.
    expect(value(['mcp_servers'])).toBe('mcp_servers');
    expect(doc.valueSpan(['mcp_servers'])?.offset).toBe(SPANS.indexOf('mcp_servers'));
    expect(value(['mcp_servers', 'dotted'])).toBe('dotted');
    expect(value(['hooks', 'PreToolUse'])).toBe('PreToolUse');
    expect(doc.valueSpan([])).toEqual({ offset: 0, length: SPANS.length });
  });

  it('gives the key as written, for pairs, headers and created tables', () => {
    expect(key(['top'])).toBe('top');
    expect(key(['mcp_servers', 'quoted'])).toBe('"quoted"');
    expect(key(['mcp_servers', 'dotted', 'command'])).toBe('command');
    expect(key(['mcp_servers', 'quoted', 'env', 'KEY'])).toBe('KEY');
    expect(key(['hooks', 'PreToolUse'])).toBe('PreToolUse');
    expect(doc.keySpan(['hooks', 'PreToolUse'])?.offset).toBe(SPANS.indexOf('PreToolUse'));
    expect(doc.keySpan([])).toBeUndefined();
    expect(doc.keySpan(['hooks', 'PreToolUse', 0])).toBeUndefined();
    expect(doc.valueSpan(['missing'])).toBeUndefined();
    expect(doc.valueSpan(['top', 'x'])).toBeUndefined();
    expect(doc.valueSpan(['mcp_servers', 'quoted', 'args', 9])).toBeUndefined();
    expect(doc.valueSpan(['mcp_servers', 'quoted', 'args', -1])).toBeUndefined();
    expect(doc.valueSpan(['top', 0])).toBeUndefined();
  });

  it('moves the span of an implicit table to the header that defines it', () => {
    const text = '[a.b]\n[a]\nx = 1';
    const later = ok(text);
    expect(slice(text, later.valueSpan(['a']))).toBe('[a]\nx = 1');
    expect(later.keySpan(['a'])?.offset).toBe(text.indexOf('[a]') + 1);
  });

  it('locates values from values, keys, pairs and table bodies', () => {
    const path = (offset: number, length = 0): readonly JsonPathSegment[] | undefined =>
      doc.locate({ offset, length })?.path;
    const of = (needle: string, nth = 0): number => {
      let index = -1;
      for (let i = 0; i <= nth; i++) index = SPANS.indexOf(needle, index + 1);
      return index;
    };
    expect(path(of('"npx"'), 5)).toEqual(['mcp_servers', 'dotted', 'command']);
    expect(path(of('command'), 7)).toEqual(['mcp_servers', 'dotted', 'command']);
    expect(path(of('dotted'), 6)).toEqual(['mcp_servers', 'dotted']);
    expect(path(of('mcp_servers'), 11)).toEqual(['mcp_servers']);
    expect(path(of('mcp_servers', 1), 11)).toEqual(['mcp_servers']);
    expect(path(of('mcp_servers.dotted.command = "npx"'), 34)).toEqual([
      'mcp_servers',
      'dotted',
      'command',
    ]);
    expect(path(of('{ pkg'), 11)).toEqual(['mcp_servers', 'quoted', 'args', 1]);
    expect(path(of('pkg'))).toEqual(['mcp_servers', 'quoted', 'args', 1, 'pkg']);
    expect(path(of('env'))).toEqual(['mcp_servers', 'quoted', 'env']);
    expect(path(of('PreToolUse', 1), 10)).toEqual(['hooks', 'PreToolUse']);
    expect(path(of('matcher'))).toEqual(['hooks', 'PreToolUse', 0, 'matcher']);
    expect(path(of('[[hooks.PreToolUse]]'), 1)).toEqual(['hooks', 'PreToolUse', 0]);
    expect(path(of('[[hooks.PreToolUse]]', 1), 20)).toEqual(['hooks', 'PreToolUse', 1]);
    expect(path(of('# comment'), 9)).toEqual([]);
    expect(path(0, SPANS.length)).toEqual([]);
    expect(path(SPANS.length)).toEqual([]);
    expect(doc.locate({ offset: SPANS.length, length: 1 })).toBeUndefined();
    expect(doc.locate({ offset: -1, length: 0 })).toBeUndefined();
  });

  it('describes located values for fingerprints', () => {
    const at = (path: JsonPathSegment[]) =>
      doc.locate(doc.valueSpan(path) ?? { offset: -1, length: 0 });
    const args = at(['mcp_servers', 'quoted', 'args']);
    expect([args?.type, args?.tomlType, args?.inArray]).toEqual(['array', 'array', false]);
    expect(args?.canonical()).toBe('["-y",{"pkg":1}]');
    const element = at(['hooks', 'PreToolUse', 0]);
    expect([element?.type, element?.tomlType, element?.inArray]).toEqual(['object', 'table', true]);
    expect(element?.canonical()).toBe('{"hooks":[{"command":"./run.sh"}],"matcher":"*"}');
    expect(at(['top'])?.canonical()).toBe('"v"');
    expect(at(['top'])).toBe(at(['top']));
    const big = ok(`a = [${'"xxxxxxxxxx",'.repeat(1000)}]`);
    expect(big.locate(big.valueSpan(['a']) ?? { offset: 0, length: 0 })?.canonical()).toHaveLength(
      4096,
    );
  });
});

describe('JSON helpers and fingerprints', () => {
  const spellings = [
    '[mcp_servers.x]\ncommand = "npx"\nargs = ["-y", "pkg"]\n',
    '[mcp_servers."x"]\ncommand = "npx"\nargs = ["-y", "pkg"]\n',
    "[mcp_servers]\nx.command = 'npx'\nx.args = ['-y', 'pkg']\n",
    'mcp_servers.x.command = "npx"\nmcp_servers.x.args = ["-y", "pkg"]\n',
    'mcp_servers = { x = { command = "npx", args = ["-y", "pkg"] } }\n',
  ];

  it('gives the same value and the same fingerprint anchors for every spelling', () => {
    const docs = spellings.map((text) => ok(text));
    const anchor = (doc: ParsedToml, path: JsonPathSegment[]): string => {
      const location = doc.locate(keySpanOf(doc, path) ?? { offset: -1, length: 0 });
      if (location === undefined) throw new Error('not located');
      return jsonAnchor(location);
    };
    for (const doc of docs) {
      expect(doc.value).toEqual(docs[0]?.value);
      for (const path of [
        ['mcp_servers', 'x'],
        ['mcp_servers', 'x', 'command'],
        ['mcp_servers', 'x', 'args', 1],
      ]) {
        expect(anchor(doc, path)).toBe(anchor(docs[0] ?? doc, path));
      }
    }
  });

  it('works with own, keySpanOf, collectStrings and hookHandlers', () => {
    const text = [
      '[[hooks.PreToolUse]]',
      'matcher = "Bash"',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "./check.sh"',
    ].join('\n');
    const doc: ParsedJson = ok(text);
    const handlers = hookHandlers(doc, 'codex');
    expect(handlers.map((handler) => [handler.event, handler.path, handler.type])).toEqual([
      ['PreToolUse', ['hooks', 'PreToolUse', 0, 'hooks', 0], 'command'],
    ]);
    expect(own(handlers[0]?.handler ?? {}, 'command')).toBe('./check.sh');
    expect(slice(text, keySpanOf(doc, ['hooks', 'PreToolUse', 0, 'hooks', 0, 'command']))).toBe(
      'command',
    );
    expect(slice(text, keySpanOf(doc, ['hooks', 'PreToolUse', 0, 'hooks', 0]))).toBe(
      '[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "./check.sh"',
    );
    expect(collectStrings(doc.value).map((found) => found.value)).toEqual([
      'Bash',
      'command',
      './check.sh',
    ]);
  });
});
