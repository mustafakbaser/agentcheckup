import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { Span } from '../../src/core/types.js';
import {
  MAX_FRONTMATTER_LENGTH,
  MAX_MAPPING_KEYS,
  parseFrontmatter,
  parseYaml,
  YAML_OPTIONS,
} from '../../src/parse/frontmatter.js';
import { hitParserLimit } from '../../src/platforms/yaml.js';
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
      '(globalThis.agentcheckupPwned = true)',
      'module.exports = { name: (() => { globalThis.agentcheckupPwned = true; return "x" })() }',
      '---',
      'body',
    ].join('\n');
    const result = parseFrontmatter(text);
    expect(result.kind).toBe('unsupported');
    expect((globalThis as Record<string, unknown>)['agentcheckupPwned']).toBeUndefined();
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

describe('nested spans', () => {
  const text = [
    '---',
    'hooks:',
    '  PreToolUse:',
    '    - matcher: Bash',
    '      hooks:',
    '        - type: command',
    '          command: ./guard.sh',
    'mcpServers:',
    '  - github',
    '  - "pw":',
    '      args: [-y, "@playwright/mcp"]',
    'base: &base',
    '  command: ./base.sh',
    'copy: *base',
    'empty:',
    '1: number key',
    '---',
    '',
  ].join('\n');
  const { data } = valid(text);

  it('finds values and keys by mapping keys and sequence indices', () => {
    const command = ['hooks', 'PreToolUse', 0, 'hooks', 0, 'command'];
    expect(slice(text, data.valueSpanAt(command))).toBe('./guard.sh');
    expect(slice(text, data.keySpanAt(command))).toBe('command');
    expect(slice(text, data.valueSpanAt(['mcpServers', 0]))).toBe('github');
    expect(slice(text, data.keySpanAt(['mcpServers', 1, 'pw']))).toBe('"pw"');
    expect(slice(text, data.valueSpanAt(['mcpServers', 1, 'pw', 'args', 1]))).toBe(
      '"@playwright/mcp"',
    );
    expect(slice(text, data.valueSpanAt(['1']))).toBe('number key');
  });

  it('agrees with the top-level spans', () => {
    for (const key of data.keys) {
      expect(data.valueSpanAt([key])).toEqual(data.valueSpan(key));
      expect(data.keySpanAt([key])).toEqual(data.keySpan(key));
    }
  });

  it('continues through an alias at its anchor', () => {
    expect(slice(text, data.valueSpanAt(['copy']))).toBe('*base');
    expect(slice(text, data.valueSpanAt(['copy', 'command']))).toBe('./base.sh');
  });

  it('returns nothing for a path that does not exist', () => {
    expect(data.valueSpanAt(['hooks', 'Stop'])).toBeUndefined();
    expect(data.valueSpanAt(['mcpServers', 2])).toBeUndefined();
    expect(data.valueSpanAt(['mcpServers', 'github'])).toBeUndefined();
    expect(data.valueSpanAt(['hooks', 0])).toBeUndefined();
    expect(data.valueSpanAt(['mcpServers', 0, 'name'])).toBeUndefined();
    // A key without a value has an empty value span, as at the top level.
    expect(data.valueSpanAt(['empty'])?.length).toBe(0);
    expect(slice(text, data.keySpanAt(['empty']))).toBe('empty');
    // The last segment of a key span must be a key.
    expect(data.keySpanAt(['mcpServers', 0])).toBeUndefined();
  });

  it('spans the whole block for the empty path, and nothing on empty frontmatter', () => {
    expect(slice(text, data.valueSpanAt([]))?.startsWith('hooks:')).toBe(true);
    const empty = valid('---\n---\n').data;
    expect(empty.valueSpanAt([])).toBeUndefined();
    expect(empty.keySpanAt(['a'])).toBeUndefined();
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

  it('keeps a key tagged as a merge key as <<, however it is written', () => {
    for (const key of ['!!merge ', '? !!merge\n', '!<tag:yaml.org,2002:merge> ', '!!merge <<']) {
      const { data } = valid(`---\nname: x\n${key}: {model: a}\n---\n`);
      expect(Object.keys(values(data))).toEqual(['name', '<<']);
    }
    // Another tag on a key leaves it as written.
    const { data } = valid('---\n!!str <<x: 1\n---\n');
    expect(Object.keys(values(data))).toEqual(['<<x']);
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

describe('repeated keys', () => {
  /** What a parse reports, as the frontmatter parser reads it. */
  const reported = (doc: ReturnType<typeof parseYaml>): unknown => ({
    errors: doc.errors.map((error) => [error.code, error.pos, error.message]),
    warnings: doc.warnings.map((warning) => [warning.code, warning.pos, warning.message]),
    range: doc.contents?.range,
  });
  /** The codes of a parse's errors, sorted. */
  const errorCodes = (doc: ReturnType<typeof parseYaml>): string[] =>
    doc.errors.map((error) => error.code).sort();
  /**
   * Where the repeated keys of YAML without another error are reported, each moved past the white
   * space at its offset: after a key without a value, yaml's check points at the end of that
   * empty value, before the line break, and the errors for YAML with a mapping past the key limit
   * at the repeated key. Undefined when the YAML has another error, and is rejected either way.
   */
  const repeatsAt = (doc: ReturnType<typeof parseYaml>, yaml: string): number[] | undefined => {
    if (doc.errors.some((error) => error.code !== 'DUPLICATE_KEY')) return undefined;
    const atKey = (start: number): number => {
      let offset = start;
      while (offset < yaml.length && (yaml[offset] === ' ' || yaml[offset] === '\n')) offset++;
      return offset;
    };
    return doc.errors.map((error) => atKey(error.pos[0])).sort((a, b) => a - b);
  };

  const KEYS = ['a', 'b', '"a"', "'b'", '0', '00', '0x0', '+0', '-0', '0.0', '~', 'null'];
  const MORE = ['', '.nan', '.NaN', 'true', 'True', '1', '1.0', '[a]', '{a: 1}', '&k a', '*k'];
  const key = fc.constantFrom(...KEYS, ...MORE);
  const value = fc.constantFrom('1', 'x', '', '[a, a]', '&v w', '*v', '{0: a, 00: b}', '{a, a}');
  const pair = fc.tuple(key, value);
  /** Lines of a block mapping, some with a nested block mapping. */
  const blockLines = fc
    .array(fc.tuple(pair, fc.array(pair, { maxLength: 3 })), { maxLength: 6 })
    .map((entries) =>
      entries
        .map(([[k, v], nested]) =>
          nested.length === 0
            ? `${k}: ${v}\n`
            : `${k}:\n${nested.map(([nk, nv]) => `  ${nk}: ${nv}\n`).join('')}`,
        )
        .join(''),
    );
  /** A flow mapping of random pairs followed by `padding`, distinct keys of their own. */
  const flowMap = (padding: readonly string[]) =>
    fc
      .array(pair, { maxLength: 8 })
      .map((pairs) => `{${[...pairs.map(([k, v]) => `${k}: ${v}`), ...padding].join(', ')}}\n`);
  const sequenceOf = (item: fc.Arbitrary<string>) =>
    fc.array(item, { maxLength: 3 }).map((items) => items.map((entry) => `- ${entry}`).join(''));

  it('finds repeats as the unique-key check does, without its quadratic cost', () => {
    const flow = flowMap([]);
    fc.assert(
      fc.property(fc.oneof(blockLines, flow, sequenceOf(flow)), (yaml) => {
        expect(reported(parseYaml(yaml))).toEqual(reported(parseDocument(yaml, YAML_OPTIONS)));
      }),
      { numRuns: 3000 },
    );
  });

  it('reports repeats in YAML with a mapping past the key limit as the check does', () => {
    // Distinct keys that make a mapping one key too many for yaml's check to run.
    const padding = Array.from({ length: MAX_MAPPING_KEYS }, (_, i) => `p${i.toString(36)}`);
    const crowdedBlock = padding.map((name) => `${name}: 1\n`).join('');
    const crowdedFlow = flowMap(padding);
    const yamls = fc.oneof(
      // The repeat in the mapping past the limit, or in a mapping nested in it.
      blockLines.map((lines) => lines + crowdedBlock),
      crowdedFlow,
      sequenceOf(fc.oneof(crowdedFlow, flowMap([]))),
      // The repeat in another mapping than the one past the limit.
      blockLines.map((lines) => `${lines}zz: {${padding.join(', ')}}\n`),
    );
    fc.assert(
      fc.property(yamls, (yaml) => {
        const [ours, checked] = [parseYaml(yaml), parseDocument(yaml, YAML_OPTIONS)];
        expect(errorCodes(ours)).toEqual(errorCodes(checked));
        expect(repeatsAt(ours, yaml)).toEqual(repeatsAt(checked, yaml));
        expect({ ...(reported(ours) as object), errors: [] }).toEqual({
          ...(reported(checked) as object),
          errors: [],
        });
      }),
      { numRuns: 50 },
    );
  });

  it.each([
    ['repeated block keys', 'a: 1\nb: 2\na: 3\n', ['DUPLICATE_KEY']],
    ['a key repeated twice', 'a: 1\na: 2\na: 3\n', ['DUPLICATE_KEY', 'DUPLICATE_KEY']],
    [
      'repeats in flow mappings, inner first',
      'm: {a: 1, a: {b: 1, b: 2}}\n',
      ['DUPLICATE_KEY', 'DUPLICATE_KEY'],
    ],
    ['NaN keys, which never repeat', '.nan: 1\n.NaN: 2\n', []],
    ['a repeat and a syntax error', 'a: 1\na: 2\nb: [x\n', ['DUPLICATE_KEY', 'BAD_INDENT']],
  ])('reports %s next to a mapping past the key limit as the check does', (_name, yaml, errors) => {
    const padding = Array.from({ length: MAX_MAPPING_KEYS + 1 }, (_, i) => `p${String(i)}`);
    const crowded = `${yaml}pad: {${padding.join(', ')}}\n`;
    expect(parseYaml(crowded).errors.map((error) => error.code)).toEqual(errors);
    expect(reported(parseYaml(crowded))).toEqual(reported(parseDocument(crowded, YAML_OPTIONS)));
  });

  it.each([
    ['repeated block keys', '0: a\n00: b\n', ['DUPLICATE_KEY']],
    ['repeated flow keys', '{a: 1, b: 2, a: 3}\n', ['DUPLICATE_KEY']],
    ['a repeat in a nested mapping', 'x:\n  - {k: 1, k: 2}\n', ['DUPLICATE_KEY']],
    ['distinct keys', 'a: 1\nb: {a: 1, b: 2}\nc: [{a: 1}, {a: 2}]\n', []],
    ['NaN keys, which never repeat', '.nan: 1\n.NaN: 2\n', []],
  ])('reports %s as the checked parse does', (_name, yaml, errors) => {
    expect(parseYaml(yaml).errors.map((error) => error.code)).toEqual(errors);
    expect(reported(parseYaml(yaml))).toEqual(reported(parseDocument(yaml, YAML_OPTIONS)));
  });
});

describe('keys per mapping', () => {
  const keys = (count: number, from = 0): string[] =>
    Array.from({ length: count }, (_, i) => `k${(from + i).toString(36)}`);
  const flow = (names: readonly string[]): string => `{${names.join(', ')}}`;

  it('reads real-size mappings, mappings up to the limit and any without a repeat, as before', () => {
    const fields = keys(18).map((key) => `${key}: value`);
    const text = `---\n${fields.join('\n')}\nnested:\n  ${fields.join('\n  ')}\n---\n`;
    expect(valid(text).data.keys).toHaveLength(19);
    const full = valid(`---\nmap: ${flow(keys(MAX_MAPPING_KEYS))}\n---\n`);
    expect(Object.keys(values(full.data)['map'] as object)).toHaveLength(MAX_MAPPING_KEYS);
    // A repeat in a full mapping is still found by yaml's own check.
    const repeated = invalid(`---\nmap: ${flow([...keys(MAX_MAPPING_KEYS - 1), 'k0'])}\n---\n`);
    expect(codes(repeated.errors)).toEqual(['duplicate-key']);
    // Without a repeat, nothing is compared pair by pair: a mapping of any size is read.
    const wide = valid(`---\nmap: ${flow(keys(3 * MAX_MAPPING_KEYS))}\n---\n`);
    expect(Object.keys(values(wide.data)['map'] as object)).toHaveLength(3 * MAX_MAPPING_KEYS);
  });

  it('reports a repeat in YAML with a mapping past the limit at the repeated key', () => {
    const over = flow([...keys(MAX_MAPPING_KEYS), 'k0']);
    const text = `---\nname: demo\nmap: ${over}\n---\n`;
    const result = invalid(text);
    expect(codes(result.errors)).toEqual(['duplicate-key']);
    expect(result.errors[0]?.message).toBe('Map keys must be unique');
    expect(result.errors[0]?.span.offset).toBe(text.lastIndexOf('k0'));
    expect(slice(text, result.errors[0]?.span)).toBe('k0');
    expect(hitParserLimit(result.errors)).toBe(false);
    // The repeat may be in another mapping than the one past the limit.
    const wide = flow(keys(MAX_MAPPING_KEYS + 1));
    const elsewhere = `---\nname: demo\nlist:\n  - ${wide}\nname: again\n---\n`;
    const repeated = invalid(elsewhere);
    expect(codes(repeated.errors)).toEqual(['duplicate-key']);
    expect(slice(elsewhere, repeated.errors[0]?.span)).toBe('name');
    expect(repeated.errors[0]?.span.offset).toBe(elsewhere.lastIndexOf('name'));
  });

  it('parses the costliest mappings within the limit quickly', () => {
    // Mappings of 2,000 keys with a repeat each, as many as fit in the length limit: yaml then
    // compares each key with every earlier one.
    const mappings: string[] = [];
    let yaml = '';
    for (let i = 0; yaml.length < MAX_FRONTMATTER_LENGTH - 20_000; i++) {
      const names = keys(MAX_MAPPING_KEYS - 1, i * MAX_MAPPING_KEYS);
      mappings.push(`m${String(i)}: ${flow([...names, names[0] ?? ''])}`);
      yaml = mappings.join('\n');
    }
    const started = performance.now();
    expect(codes(invalid(`---\n${yaml}\n---\n`).errors)[0]).toBe('duplicate-key');
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
