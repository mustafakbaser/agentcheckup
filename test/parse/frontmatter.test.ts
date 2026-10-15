import { describe, expect, it } from 'vitest';
import type { Span } from '../../src/core/types.js';
import { MAX_FRONTMATTER_LENGTH, parseFrontmatter } from '../../src/parse/frontmatter.js';
import type { FrontmatterData, FrontmatterResult, ParseIssue } from '../../src/parse/types.js';

const slice = (text: string, span: Span | undefined): string | undefined =>
  span === undefined ? undefined : text.slice(span.offset, span.offset + span.length);

function valid(text: string): Extract<FrontmatterResult, { kind: 'valid' }> {
  const result = parseFrontmatter(text);
  if (result.kind !== 'valid') throw new Error(`expected valid, got ${JSON.stringify(result)}`);
  return result;
}

function invalid(text: string): Extract<FrontmatterResult, { kind: 'invalid' }> {
  const result = parseFrontmatter(text);
  if (result.kind !== 'invalid') throw new Error(`expected invalid, got ${result.kind}`);
  return result;
}

const codes = (issues: readonly ParseIssue[]): string[] => issues.map((issue) => issue.code);
const values = (data: FrontmatterData): Readonly<Record<string, unknown>> => data.values;

describe('delimiters', () => {
  it.each([
    ['empty text', ''],
    ['no frontmatter', '# Title\n'],
    ['delimiter not on the first line', '\n---\na: 1\n---\n'],
    ['indented delimiter', ' ---\na: 1\n---\n'],
    ['four dashes', '----\na: 1\n----\n'],
    ['space before a language', '--- js\nx\n---\n'],
    ['BOM not stripped by the caller', '﻿---\na: 1\n---\n'],
    ['lone CR after the delimiter', '---\ra: 1\r---\r'],
    ['dashes then text', '---a b\n'],
  ])('%s is absent', (_name, text) => {
    expect(parseFrontmatter(text)).toEqual({ kind: 'absent' });
  });

  it.each([
    ['delimiter only', '---', { offset: 0, length: 3 }],
    ['delimiter and newline', '---\n', { offset: 0, length: 3 }],
    ['no closing delimiter', '---\nname: x\n', { offset: 0, length: 3 }],
    ['trailing spaces kept in the span', '---  \r\nname: x\r\n', { offset: 0, length: 5 }],
    ['closing line with content', '---\nname: x\n--- y\n', { offset: 0, length: 3 }],
  ])('%s is unclosed', (_name, text, openSpan) => {
    expect(parseFrontmatter(text)).toEqual({ kind: 'unclosed', openSpan });
  });

  it.each([
    ['+++\ntitle = "x"\n+++\n', 'toml', '+++'],
    ['+++  \r\ntitle = "x"\r\n', 'toml', '+++  '],
    ['---js\nmodule.exports = {}\n---\n', 'js', '---js'],
    ['---javascript\n{}\n---\n', 'javascript', '---javascript'],
    ['---json\n{"a": 1}\n---\n', 'json', '---json'],
    ['---coffee\na: 1\n---\n', 'coffee', '---coffee'],
    ['---YAML\r\na: 1\r\n---\r\n', 'yaml', '---YAML'],
  ])('%j is unsupported %s', (text, syntax, spanText) => {
    const result = parseFrontmatter(text);
    expect(result).toMatchObject({ kind: 'unsupported', syntax });
    if (result.kind === 'unsupported') expect(slice(text, result.span)).toBe(spanText);
  });

  it('never evaluates ---js frontmatter', () => {
    const text = [
      '---js',
      '(globalThis.agentcheckPwned = true)',
      'module.exports = { name: (() => { globalThis.agentcheckPwned = true; return "x" })() }',
      '---',
      'body',
    ].join('\n');
    const result = parseFrontmatter(text);
    expect(result.kind).toBe('unsupported');
    expect((globalThis as Record<string, unknown>)['agentcheckPwned']).toBeUndefined();
  });

  it('accepts trailing whitespace on both delimiter lines', () => {
    const text = '--- \t\nname: x\n---\t \nbody';
    const result = valid(text);
    expect(slice(text, result.span)).toBe('--- \t\nname: x\n---\t ');
    expect(text.slice(result.bodyOffset)).toBe('body');
  });

  it('closes at the first --- line and reports the block span and body offset', () => {
    const text = '---\nname: x\n---\n# Title\n---\nnot frontmatter\n';
    const result = valid(text);
    expect(slice(text, result.span)).toBe('---\nname: x\n---');
    expect(text.slice(result.bodyOffset)).toBe('# Title\n---\nnot frontmatter\n');
  });

  it('handles a closing delimiter at the end of the text', () => {
    const text = '---\nname: x\n---';
    expect(valid(text).bodyOffset).toBe(text.length);
  });

  it.each([
    ['---\n---\nbody', 8],
    ['---\r\n---\r\nbody', 10],
    ['---\n# only a comment\n\n---\n', 26],
  ])('empty frontmatter %j is valid with no keys', (text, bodyOffset) => {
    const result = valid(text);
    expect(result.data.keys).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.bodyOffset).toBe(bodyOffset);
    expect(Object.keys(result.data.values)).toEqual([]);
  });
});

describe('values and spans', () => {
  it('reads keys in source order with key and value spans', () => {
    const text =
      '---\nname: my-skill\ndescription: "Does a thing"\nallowed-tools:\n  - Read\n  - Bash\n---\nbody\n';
    const { data } = valid(text);
    expect(data.keys).toEqual(['name', 'description', 'allowed-tools']);
    expect(values(data)).toEqual({
      name: 'my-skill',
      description: 'Does a thing',
      'allowed-tools': ['Read', 'Bash'],
    });
    expect(slice(text, data.keySpan('description'))).toBe('description');
    expect(slice(text, data.valueSpan('description'))).toBe('"Does a thing"');
    expect(slice(text, data.valueSpan('allowed-tools'))).toBe('- Read\n  - Bash');
    expect(data.keySpan('missing')).toBeUndefined();
    expect(data.valueSpan('missing')).toBeUndefined();
  });

  it('maps spans correctly with CRLF line endings', () => {
    const text =
      '---\r\nname: x\r\ndescription: >-\r\n  folded\r\n  text\r\nn: 1\r\n---\r\nbody\r\n';
    const { data, bodyOffset } = valid(text);
    expect(slice(text, data.keySpan('name'))).toBe('name');
    expect(slice(text, data.valueSpan('name'))).toBe('x');
    expect(slice(text, data.valueSpan('description'))).toBe('>-\r\n  folded\r\n  text');
    expect(values(data)['description']).toBe('folded text');
    expect(slice(text, data.keySpan('n'))).toBe('n');
    expect(text.slice(bodyOffset)).toBe('body\r\n');
  });

  it('gives an empty value a zero-length span and a missing value no span', () => {
    const text = '---\nempty:\n? explicit\n---\n';
    const { data } = valid(text);
    expect(data.valueSpan('empty')).toEqual({ offset: 10, length: 0 });
    expect(data.valueSpan('explicit')).toBeUndefined();
    expect(values(data)).toEqual({ empty: null, explicit: null });
  });

  it('converts keys to strings like a JavaScript YAML loader', () => {
    const text = '---\n1: a\ntrue: b\n~: c\n1.10: d\n? [x, y]\n: e\n---\n';
    const { data } = valid(text);
    expect(data.keys).toEqual(['1', 'true', '', '1.1', '[x, y]']);
    expect(slice(text, data.keySpan('[x, y]'))).toBe('[x, y]');
  });

  it('builds frozen null-prototype objects at every level', () => {
    const { data } = valid('---\nouter:\n  inner:\n    deep: [1, {a: b}]\n---\n');
    const outer = values(data)['outer'] as Record<string, unknown>;
    const inner = outer['inner'] as Record<string, unknown>;
    const deep = inner['deep'] as unknown[];
    for (const object of [data.values, outer, inner, deep[1]]) {
      expect(Object.getPrototypeOf(object)).toBeNull();
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(Object.isFrozen(deep)).toBe(true);
  });
});

describe('hostile YAML', () => {
  it('keeps __proto__, constructor and prototype as plain own keys', () => {
    const text =
      '---\n__proto__: {polluted: true}\nconstructor: {prototype: {polluted: true}}\nprototype: x\n---\n';
    const { data } = valid(text);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(data.keys).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.hasOwn(data.values, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(data.values)).toBeNull();
    const proto = values(data)['__proto__'] as Record<string, unknown>;
    expect(proto['polluted']).toBe(true);
    expect(Object.getPrototypeOf(proto)).toBeNull();
    expect(slice(text, data.valueSpan('__proto__'))).toBe('{polluted: true}');
  });

  it('does not apply merge keys', () => {
    const text = '---\nbase: &base {x: 1}\nderived:\n  <<: *base\n  z: 2\n---\n';
    const { data, warnings } = valid(text);
    const derived = values(data)['derived'] as Record<string, unknown>;
    expect(Object.keys(derived)).toEqual(['<<', 'z']);
    expect(derived['x']).toBeUndefined();
    expect(derived['<<']).toEqual({ x: 1 });
    expect(codes(warnings)).toEqual(['alias', 'alias']);
  });

  it('stops a billion-laughs alias bomb quickly', () => {
    const lines = ['---', 'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let level = 1; level < 10; level++) {
      const previous = String.fromCharCode(96 + level);
      const name = String.fromCharCode(97 + level);
      lines.push(
        `${name}: &${name} [${Array.from({ length: 9 }, () => `*${previous}`).join(',')}]`,
      );
    }
    lines.push('---');
    const started = performance.now();
    const result = invalid(lines.join('\n'));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(codes(result.errors)).toEqual(['excessive-aliases']);
  });

  it('stops wide alias expansion and self-referencing aliases', () => {
    const wide = `---\nbig: &big [${Array.from({ length: 4000 }, (_, i) => i).join(',')}]\nc1: *big\nc2: *big\nc3: *big\n---\n`;
    expect(codes(invalid(wide).errors)).toEqual(['excessive-aliases']);
    expect(codes(invalid('---\nloop: &a [*a]\n---\n').errors)).toEqual(['excessive-aliases']);
  });

  it('reports undefined and forward aliases', () => {
    const text = '---\na: *nope\nb: &nope 1\n---\n';
    const result = invalid(text);
    expect(codes(result.errors)).toEqual(['unresolved-alias']);
    expect(slice(text, result.errors[0]?.span)).toBe('*nope');
  });

  it('rejects deep nesting without overflowing the stack', () => {
    const moderate = `---\na: ${'['.repeat(300)}${']'.repeat(300)}\n---\n`;
    expect(codes(invalid(moderate).errors)).toEqual(['too-deep']);
    const extreme = `---\na: ${'['.repeat(30_000)}${']'.repeat(30_000)}\n---\n`;
    expect(invalid(extreme).errors.length).toBeGreaterThan(0);
  });

  it('does not parse oversized frontmatter', () => {
    const text = `---\na: ${'x'.repeat(MAX_FRONTMATTER_LENGTH)}\n---\nbody`;
    const result = invalid(text);
    expect(codes(result.errors)).toEqual(['too-large']);
    expect(text.slice(result.bodyOffset)).toBe('body');
  });

  it('bounds the number of reported errors', () => {
    const result = invalid(`---\na: ${'"'.repeat(5000)}\n---\n`);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.length).toBeLessThanOrEqual(100);
  });
});

describe('invalid YAML', () => {
  it.each([
    ['duplicate key', '---\nname: a\nname: b\n---\n', 'duplicate-key', 'name'],
    ['duplicate key with CRLF', '---\r\nname: a\r\nname: b\r\n---\r\n', 'duplicate-key', 'name'],
    ['keys that collapse to one JS key', '---\n1: a\n"1": b\n---\n', 'duplicate-key', '"1"'],
    ['tab indentation', '---\nmetadata:\n\tkey: 1\n---\n', 'tab-as-indent', '\t'],
    ['multiple documents', '---\na: 1\n...\nb: 2\n---\n', 'multiple-documents', 'b: 2\n'],
    ['document start inside the block', '---\na: 1\n--- b\n---\n', 'multiple-documents', '--- b\n'],
    [
      'unquoted colon in a value',
      '---\ndescription: Use when: x\n---\n',
      'block-as-implicit-key',
      'U',
    ],
    ['sequence root', '---\n- a\n- b\n---\n', 'not-a-mapping', '- a\n- b'],
    ['scalar root', '---\njust text\n---\n', 'not-a-mapping', 'just text'],
    ['null root', '---\n~\n---\n', 'not-a-mapping', '~'],
  ])('%s', (_name, text, code, spanText) => {
    const result = invalid(text);
    expect(result.errors[0]?.code).toBe(code);
    expect(slice(text, result.errors[0]?.span)).toBe(spanText);
    expect(slice(text, result.span)?.startsWith('---')).toBe(true);
  });

  it('keeps the body offset for invalid frontmatter', () => {
    const text = '---\na: [\n---\nbody';
    expect(text.slice(invalid(text).bodyOffset)).toBe('body');
  });
});

describe('warnings', () => {
  it('reports anchors and aliases', () => {
    const text = '---\nbase: &b x\nother: *b\n---\n';
    const { warnings } = valid(text);
    expect(warnings.map((w) => [w.code, slice(text, w.span)])).toEqual([
      ['alias', 'x'],
      ['alias', '*b'],
    ]);
  });

  it('reports explicit tags', () => {
    const text = '---\na: !!str 1\nb: !custom x\nc: !!binary aGk=\n---\n';
    const { warnings, data } = valid(text);
    // Our `tag` warning spans the tagged value; yaml's own warning points at the tag itself.
    expect(warnings.map((w) => [w.code, slice(text, w.span)])).toEqual([
      ['tag', '1'],
      ['tag-resolve-failed', '!custom'],
      ['tag', 'x'],
      ['tag-resolve-failed', '!!binary'],
      ['tag', 'aGk='],
    ]);
    expect(values(data)).toEqual({ a: '1', b: 'x', c: 'aGk=' });
  });

  it.each(['yes', 'No', 'ON', 'off', 'y', 'N'])('reports the YAML 1.1 boolean %s', (word) => {
    const text = `---\nflag: ${word}\nquoted: "${word}"\nreal: true\n---\n`;
    const { warnings, data } = valid(text);
    expect(warnings.map((w) => [w.code, slice(text, w.span)])).toEqual([['yaml11-boolean', word]]);
    expect(values(data)['flag']).toBe(word);
  });

  it('reports the YAML 1.1 boolean key `on`', () => {
    expect(codes(valid('---\non: push\n---\n').warnings)).toEqual(['yaml11-boolean']);
  });

  it('reports numbers whose text changes', () => {
    const text =
      '---\nversion: 1.10\nb: 1e3\nc: 0x1F\nd: +1\ne: 1.5\nf: 007\ng: "1.10"\nh: 0\n---\n';
    const { warnings, data } = valid(text);
    expect(warnings.map((w) => [w.code, slice(text, w.span)])).toEqual([
      ['number-coercion', '1.10'],
      ['number-coercion', '1e3'],
      ['number-coercion', '0x1F'],
      ['number-coercion', '+1'],
      ['number-coercion', '007'],
    ]);
    expect(values(data)).toMatchObject({ version: 1.1, b: 1000, c: 31, d: 1, f: 7, g: '1.10' });
  });

  it('reports null values with a useful span', () => {
    const text = '---\nempty:\ntilde: ~\nword: Null\nset: x\nflow: {k}\n---\n';
    const { warnings } = valid(text);
    expect(warnings.map((w) => [w.code, slice(text, w.span)])).toEqual([
      ['null-value', 'empty'],
      ['null-value', '~'],
      ['null-value', 'Null'],
      ['null-value', 'k'],
    ]);
  });
});
