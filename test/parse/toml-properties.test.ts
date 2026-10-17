import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { jsonAnchor } from '../../src/core/fingerprint.js';
import type { Span } from '../../src/core/types.js';
import { keySpanOf } from '../../src/parse/json-access.js';
import {
  MAX_TOML_DEPTH,
  MAX_TOML_NODES,
  parseToml,
  TOML_ISSUE,
  TomlDatetime,
} from '../../src/parse/toml.js';
import type { JsonPathSegment, TomlDatetimeKind, TomlDocument } from '../../src/parse/types.js';

/** Override for deeper local fuzzing, e.g. `PARSE_PROPERTY_RUNS=20000 vitest run test/parse`. */
const RUNS = Number(process.env['PARSE_PROPERTY_RUNS'] ?? 300);

type Parsed = Extract<TomlDocument, { ok: true }>;
type Choose = (count: number) => number;

const slice = (text: string, span: Span | undefined): string | undefined =>
  span === undefined ? undefined : text.slice(span.offset, span.offset + span.length);

function parsed(text: string): Parsed {
  const doc = parseToml(text);
  if (!doc.ok) throw new Error(`${JSON.stringify(doc.errors)}\n${text}`);
  return doc;
}

// ---------------------------------------------------------------------------------------------
// A model of TOML values, and text that spells it
// ---------------------------------------------------------------------------------------------

/** A date-time as written, and the kind and text the parser must give. */
class Datetime {
  readonly written: string;
  readonly kind: TomlDatetimeKind;
  readonly text: string;

  constructor(written: string, kind: TomlDatetimeKind, text: string) {
    this.written = written;
    this.kind = kind;
    this.text = text;
  }
}

/** Integers are bigints, so they can be written exactly; tables are null-prototype objects. */
type Model = string | bigint | number | boolean | Datetime | Model[] | Table;
interface Table {
  [key: string]: Model;
}

const isTable = (model: Model): model is Table =>
  typeof model === 'object' && !Array.isArray(model) && !(model instanceof Datetime);

function table(entries: readonly (readonly [string, Model])[]): Table {
  const out = Object.create(null) as Table;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const pad = (value: number, length: number): string => String(value).padStart(length, '0');

const datetimeArb: fc.Arbitrary<Datetime> = fc
  .record({
    kind: fc.constantFrom<TomlDatetimeKind>(
      'offset-datetime',
      'local-datetime',
      'local-date',
      'local-time',
    ),
    year: fc.integer({ min: 0, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 60 }),
    fraction: fc.stringMatching(/^(?:\.\d{1,12})?$/),
    delimiter: fc.constantFrom('T', 't', ' '),
    offset: fc.oneof(
      fc.constantFrom('Z', 'z'),
      fc
        .tuple(
          fc.constantFrom('+', '-'),
          fc.integer({ min: 0, max: 23 }),
          fc.integer({ min: 0, max: 59 }),
        )
        .map(([sign, h, m]) => `${sign}${pad(h, 2)}:${pad(m, 2)}`),
    ),
  })
  .map((parts) => {
    const leap = parts.year % 4 === 0 && (parts.year % 100 !== 0 || parts.year % 400 === 0);
    const days =
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][parts.month - 1] ?? 28;
    const date = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(Math.min(parts.day, days), 2)}`;
    const time = `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`;
    let fraction = parts.fraction.slice(1, 10).padEnd(9, '0');
    while (fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    const normalTime = time + (fraction === '' ? '' : `.${fraction}`);
    const offset =
      parts.offset === 'Z' || parts.offset === 'z'
        ? 'Z'
        : parts.offset.slice(1) === '00:00'
          ? '+00:00'
          : parts.offset;
    switch (parts.kind) {
      case 'local-date':
        return new Datetime(date, parts.kind, date);
      case 'local-time':
        return new Datetime(time + parts.fraction, parts.kind, normalTime);
      case 'local-datetime':
        return new Datetime(
          date + parts.delimiter + time + parts.fraction,
          parts.kind,
          `${date}T${normalTime}`,
        );
      case 'offset-datetime':
        return new Datetime(
          date + parts.delimiter + time + parts.fraction + parts.offset,
          parts.kind,
          `${date}T${normalTime}${offset}`,
        );
    }
  });

const textArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
  fc.constantFrom('', '"', "'", '\\', '"""', "'''", '\n', '\r\n', '\t', '\u2028', '#', '=', '[x]'),
);
const stringArb = textArb.filter(wellFormed);
const keyArb = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[\w-]{1,8}$/) },
  fc.constantFrom(
    '__proto__',
    'constructor',
    'toString',
    'prototype',
    'hasOwnProperty',
    '0',
    '1.5',
  ),
  stringArb,
);

const scalarArb: fc.Arbitrary<Model> = fc.oneof(
  stringArb,
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
  fc.bigInt({ min: -1000n, max: 1000n }),
  fc.double(),
  fc.boolean(),
  datetimeArb,
);

const modelArb = fc.letrec<{ value: Model; table: Table }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    { weight: 4, arbitrary: scalarArb },
    fc.array(tie('value'), { maxLength: 4 }),
    tie('table'),
  ),
  table: fc
    .uniqueArray(fc.tuple(keyArb, tie('value')), { maxLength: 5, selector: ([key]) => key })
    .map(table),
}));

/** Characters a basic string must escape, by code. */
const ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

function escaped(text: string, choose: Choose, keepNewlines: boolean): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (keepNewlines && code === 0x0a) out += '\n';
    else if (ESCAPES[code] !== undefined && (code !== 0x09 || choose(2) === 0))
      out += ESCAPES[code];
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code > 0x7f && choose(3) === 0) {
      out +=
        code > 0xffff
          ? `\\U${code.toString(16).padStart(8, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return out;
}

/** Text that only a literal string can hold: no apostrophes, controls (but tab) or breaks. */
const literalSafe = (text: string): boolean => {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x27 || (code < 0x20 && code !== 0x09) || code === 0x7f) return false;
  }
  return true;
};

function stringText(value: string, choose: Choose): string {
  switch (choose(4)) {
    case 0:
      if (literalSafe(value)) return `'${value}'`;
      break;
    case 1:
      return `"""\n${escaped(value, choose, true)}"""`;
    case 2:
      if (!value.includes("'''") && literalSafe(value.replaceAll("'", '').replaceAll('\n', ''))) {
        return `'''\n${value}'''`;
      }
      break;
    default:
      break;
  }
  return `"${escaped(value, choose, false)}"`;
}

function keyText(key: string, choose: Choose): string {
  if (/^[\w-]+$/.test(key) && choose(3) !== 0) return key;
  if (literalSafe(key) && choose(2) === 0) return `'${key}'`;
  return `"${escaped(key, choose, false)}"`;
}

/** Digits with underscores between some of them. */
function underscored(digits: string, choose: Choose): string {
  let out = digits.charAt(0);
  for (let i = 1; i < digits.length; i++) out += (choose(4) === 0 ? '_' : '') + digits.charAt(i);
  return out;
}

function integerText(value: bigint, choose: Choose): string {
  const way = value >= 0n ? choose(5) : 0;
  if (way === 1) return `0x${'0'.repeat(choose(3))}${underscored(value.toString(16), choose)}`;
  if (way === 2) return `0o${underscored(value.toString(8), choose)}`;
  if (way === 3) return `0b${underscored(value.toString(2), choose)}`;
  const sign = value >= 0n && choose(3) === 0 ? '+' : '';
  return (
    sign + (value < 0n ? '-' : '') + underscored((value < 0n ? -value : value).toString(), choose)
  );
}

function floatText(value: number, choose: Choose): string {
  const sign = ['', '+', '-'][choose(3)] ?? '';
  if (Number.isNaN(value)) return `${sign}nan`;
  if (value === Infinity) return `${sign === '-' ? '' : sign}inf`;
  if (value === -Infinity) return '-inf';
  const text = Object.is(value, -0) ? '-0' : String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/** The gap between array items: spaces, line breaks, comments. */
function gap(choose: Choose): string {
  return ['', ' ', '\n', ' # note\n  ', '\r\n\t'][choose(5)] ?? '';
}

function valueText(value: Model, choose: Choose): string {
  if (typeof value === 'string') return stringText(value, choose);
  if (typeof value === 'bigint') return integerText(value, choose);
  if (typeof value === 'number') return floatText(value, choose);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Datetime) return value.written;
  if (Array.isArray(value)) {
    const items = value.map((item) => gap(choose) + valueText(item, choose) + gap(choose));
    return `[${items.join(',')}${items.length > 0 && choose(2) === 0 ? ',' : ''}${gap(choose)}]`;
  }
  const pairs = Object.keys(value).map(
    (key) => `${keyText(key, choose)} = ${valueText(value[key] ?? '', choose)}`,
  );
  return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
}

/**
 * TOML text for a table: each sub-table written as a `[header]`, as dotted keys or inline, and
 * arrays of tables as `[[headers]]` or inline. Pairs come before the headers that follow them.
 */
function documentText(root: Table, choose: Choose): string {
  const out: string[] = [];
  const pairs = (
    value: Table,
    prefix: string,
    lines: string[],
    sections: (() => void)[],
    path: string,
  ): void => {
    for (const key of Object.keys(value)) {
      const child = value[key] ?? '';
      const name = prefix + keyText(key, choose);
      const childPath = path === '' ? keyText(key, choose) : `${path}.${keyText(key, choose)}`;
      if (isTable(child) && Object.keys(child).length > 0) {
        const way = choose(3);
        if (way === 0 && path !== '\u0000') {
          sections.push(() => {
            section(child, childPath, false);
          });
          continue;
        }
        if (way === 1) {
          pairs(child, `${name}.`, lines, sections, '\u0000');
          continue;
        }
      }
      if (
        Array.isArray(child) &&
        child.length > 0 &&
        child.every((item) => isTable(item)) &&
        path !== '\u0000' &&
        choose(2) === 0
      ) {
        for (const item of child) {
          sections.push(() => {
            if (isTable(item)) section(item, childPath, true);
          });
        }
        continue;
      }
      lines.push(`${name} = ${valueText(child, choose)}`);
    }
  };
  const section = (value: Table, path: string, element: boolean): void => {
    const lines: string[] = [];
    const sections: (() => void)[] = [];
    pairs(value, '', lines, sections, path);
    // A table with no pairs of its own may stay implicit when a header below it creates it.
    if (element || lines.length > 0 || sections.length === 0 || choose(2) === 0) {
      out.push(element ? `[[${path}]]` : `[${path}]`);
    }
    out.push(...lines);
    for (const next of sections) next();
  };
  const lines: string[] = [];
  const sections: (() => void)[] = [];
  pairs(root, '', lines, sections, '');
  out.push(...lines);
  for (const next of sections) next();
  return `${out.join(choose(2) === 0 ? '\n' : '\r\n')}\n`;
}

/** The value the parser must give for `model`, with date-times as `[kind, text]`. */
function expected(model: Model): unknown {
  if (typeof model === 'bigint') return Number(model);
  if (model instanceof Datetime) return [model.kind, model.text];
  if (Array.isArray(model)) return model.map(expected);
  if (isTable(model)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(model)) out[key] = expected(model[key] ?? '');
    return out;
  }
  return model;
}

/** A parsed value with date-times as `[kind, text]`. */
function comparable(value: unknown): unknown {
  if (value instanceof TomlDatetime) return [value.kind, value.text];
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value === 'object' && value !== null) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value))
      out[key] = comparable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

const chooser =
  (g: fc.GeneratorValue): Choose =>
  (count) =>
    count <= 1 ? 0 : g(fc.nat, { max: count - 1 });

/** Every value in a parsed document with its path, depth first. */
function walk(value: unknown, path: JsonPathSegment[] = []): [JsonPathSegment[], unknown][] {
  const out: [JsonPathSegment[], unknown][] = [[path, value]];
  if (Array.isArray(value)) {
    value.forEach((item, i) => out.push(...walk(item, [...path, i])));
  } else if (typeof value === 'object' && value !== null && !(value instanceof TomlDatetime)) {
    for (const key of Object.keys(value)) {
      out.push(...walk((value as Record<string, unknown>)[key], [...path, key]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe('TOML properties', () => {
  it('parses any spelling of a document into its model', () => {
    fc.assert(
      fc.property(modelArb.table, fc.gen(), (model, g) => {
        const text = documentText(model, chooser(g));
        const doc = parsed(text);
        expect(comparable(doc.value)).toEqual(expected(model));
      }),
      { numRuns: RUNS },
    );
  });

  it('gives the same value and fingerprints for every spelling of an MCP server', () => {
    const serverArb = fc.record({
      name: keyArb,
      command: stringArb,
      args: fc.array(stringArb, { maxLength: 3 }),
      env: fc.uniqueArray(fc.tuple(keyArb, stringArb), { maxLength: 3, selector: ([key]) => key }),
      timeout: fc.bigInt({ min: 0n, max: 600n }),
    });
    fc.assert(
      fc.property(serverArb, fc.gen(), (server, g) => {
        const choose = chooser(g);
        const name = keyText(server.name, choose);
        const quoted = `"${escaped(server.name, choose, false)}"`;
        const value = (model: Model): string => valueText(model, choose);
        const env = table(server.env);
        const args = value(server.args);
        const inlineEnv = value(env);
        const envPairs = server.env.map(
          ([key, text]) => `${keyText(key, choose)} = ${value(text)}`,
        );
        const spellings = [
          [
            `[mcp_servers.${name}]`,
            `command = ${value(server.command)}`,
            `args = ${args}`,
            `startup_timeout_sec = ${String(server.timeout)}`,
            `[mcp_servers.${name}.env]`,
            ...envPairs,
          ],
          [
            `[mcp_servers.${quoted}]`,
            `command = ${value(server.command)}`,
            `args = ${args}`,
            `env = ${inlineEnv}`,
            `startup_timeout_sec = 0x${server.timeout.toString(16)}`,
          ],
          [
            `mcp_servers.${name}.command = ${value(server.command)}`,
            `mcp_servers.${name}.args = ${args}`,
            `mcp_servers.${name}.startup_timeout_sec = ${String(server.timeout)}`,
            ...(server.env.length === 0
              ? [`mcp_servers.${name}.env = {}`]
              : envPairs.map((pair) => `mcp_servers.${name}.env.${pair}`)),
          ],
          [
            `mcp_servers = { ${name} = { command = ${value(server.command)}, args = ${args}, env = ${inlineEnv}, startup_timeout_sec = ${String(server.timeout)} } }`,
          ],
          [
            '[mcp_servers]',
            `${name}.command = ${value(server.command)}`,
            `${name}.args = ${args}`,
            `${name}.env = ${inlineEnv}`,
            `${name}.startup_timeout_sec = ${String(server.timeout)}`,
          ],
        ].map((lines) => lines.join('\n'));
        const want = expected(
          table([
            [
              'mcp_servers',
              table([
                [
                  server.name,
                  table([
                    ['command', server.command],
                    ['args', server.args],
                    ['startup_timeout_sec', server.timeout],
                    ['env', env],
                  ]),
                ],
              ]),
            ],
          ]),
        );
        // Fingerprint anchors by path; key order differs between spellings.
        const anchors = (doc: Parsed): string[] =>
          walk(doc.value)
            .map(([path]) => {
              const location = doc.locate(keySpanOf(doc, path) ?? { offset: -1, length: 0 });
              if (location === undefined) throw new Error(`not located: ${JSON.stringify(path)}`);
              expect(location.path).toEqual(path);
              return `${JSON.stringify(path)} ${jsonAnchor(location)}`;
            })
            .sort();
        const docs = spellings.map(parsed);
        const first = anchors(docs[0] ?? parsed(''));
        for (const doc of docs) {
          expect(comparable(doc.value)).toEqual(want);
          expect(anchors(doc)).toEqual(first);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('never throws on arbitrary or mutated text, stays bounded, and reports one issue in the text', () => {
    const fragments = fc.constantFrom(
      '[',
      ']',
      '[[',
      ']]',
      '{',
      '}',
      '=',
      '.',
      ',',
      '"',
      "'",
      '"""',
      "'''",
      '\\',
      '\\u',
      '\\U0001',
      '\\e',
      '\\x41',
      '#',
      '\n',
      '\r\n',
      '\r',
      ' ',
      '\t',
      'a',
      'é',
      '🚀',
      '\ud800',
      '\u0000',
      '\u2028',
      '\ufeff',
      '0',
      '1_0',
      '0x1F',
      '-',
      '+',
      'inf',
      'nan',
      'true',
      '1979-05-27',
      'T07:32:00',
      'Z',
      '07:32',
      '__proto__',
      'constructor',
      '1e400',
      '99999999999999999999',
    );
    const soup = fc.array(fragments, { maxLength: 60 }).map((parts) => parts.join(''));
    const mutated = fc
      .tuple(
        modelArb.table,
        fc.gen(),
        fc.array(fc.tuple(fc.nat(), fc.nat({ max: 8 }), fragments), { maxLength: 4 }),
      )
      .map(([model, g, edits]) => {
        let text = documentText(model, chooser(g));
        for (const [at, remove, insert] of edits) {
          const position = text.length === 0 ? 0 : at % text.length;
          text = text.slice(0, position) + insert + text.slice(position + remove);
        }
        return text;
      });
    const anyText = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.string({ unit: 'binary', maxLength: 100 }),
      fc.string({
        unit: fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code)),
        maxLength: 100,
      }),
      soup,
      mutated,
    );
    const codes = new Set<string>(Object.values(TOML_ISSUE));
    fc.assert(
      fc.property(anyText, (text) => {
        const doc = parseToml(text);
        if (doc.ok) {
          const values = walk(doc.value);
          expect(values.length).toBeLessThanOrEqual(MAX_TOML_NODES + 1);
          for (const [path] of values) expect(path.length).toBeLessThanOrEqual(MAX_TOML_DEPTH);
          expect(Object.getPrototypeOf(doc.value)).toBeNull();
          return;
        }
        expect(doc.errors).toHaveLength(1);
        const [issue] = doc.errors;
        expect(codes.has(issue?.code ?? '')).toBe(true);
        expect(issue?.span.offset).toBeGreaterThanOrEqual(0);
        expect(issue?.span.length).toBeGreaterThanOrEqual(0);
        expect((issue?.span.offset ?? 0) + (issue?.span.length ?? 0)).toBeLessThanOrEqual(
          text.length,
        );
      }),
      { numRuns: RUNS * 3 },
    );
  });

  it('gives spans that slice back to their keys and values', () => {
    fc.assert(
      fc.property(modelArb.table, fc.gen(), (model, g) => {
        const text = documentText(model, chooser(g));
        const doc = parsed(text);
        for (const [path, value] of walk(doc.value)) {
          const span = doc.valueSpan(path);
          const covered = slice(text, span) ?? '';
          const location = doc.locate(span ?? { offset: -1, length: 0 });
          expect(location?.path).toEqual(path);
          const last = path[path.length - 1];
          const key = slice(text, doc.keySpan(path));
          if (typeof last === 'string') {
            // The key, as written, names the segment.
            const keyed = parsed(`${key ?? ''} = 1`).value as Record<string, unknown>;
            expect(Object.keys(keyed)).toEqual([last]);
            expect(doc.locate(doc.keySpan(path) ?? { offset: -1, length: 0 })?.path).toEqual(path);
          } else {
            expect(key).toBeUndefined();
          }
          if (path.length === 0) {
            expect(covered).toBe(text);
          } else if (location?.tomlType === 'table' && covered.startsWith('[')) {
            // A table defined by a [header] or [[header]]: its header comes first.
            expect(covered.startsWith(location.inArray ? '[[' : '[')).toBe(true);
          } else if (
            (location?.tomlType === 'table' && !covered.startsWith('{')) ||
            (location?.tomlType === 'array' && !covered.startsWith('['))
          ) {
            // Created by a key: the span is that key.
            expect(covered).toBe(key);
          } else {
            // Scalars, arrays and inline tables read back the same.
            const reread = parsed(`v = ${covered}`).value as Record<string, unknown>;
            expect(comparable(reread['v'])).toEqual(comparable(value));
          }
        }
      }),
      { numRuns: RUNS },
    );
  });
});
