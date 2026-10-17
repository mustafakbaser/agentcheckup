import { describe, expect, it } from 'vitest';
import type { Span } from '../../src/core/types.js';
import fc from 'fast-check';
import {
  JSON_ISSUE,
  MAX_CANONICAL_LENGTH,
  MAX_JSON_DEPTH,
  MAX_JSON_LENGTH,
  parseJson,
  parseJsonc,
  parseJsonWithComments,
  stripJsonComments,
} from '../../src/parse/json.js';
import type { JsonDocument } from '../../src/parse/types.js';

const slice = (text: string, span: Span | undefined): string | undefined =>
  span === undefined ? undefined : text.slice(span.offset, span.offset + span.length);

function ok(text: string): Extract<JsonDocument, { ok: true }> {
  const doc = parseJson(text);
  if (!doc.ok) throw new Error(`expected ok, got ${JSON.stringify(doc.errors)}`);
  return doc;
}

function failed(text: string): Extract<JsonDocument, { ok: false }> {
  const doc = parseJson(text);
  if (doc.ok) throw new Error('expected a failure');
  return doc;
}

const issues = (text: string): [string, string | undefined][] =>
  failed(text).errors.map((error) => [error.code, slice(text, error.span)]);

describe('values', () => {
  it.each([
    ['{"a": 1, "b": [true, null, "x"], "c": {"d": -0.5e3}}'],
    ['[]'],
    ['"just a string"'],
    ['42'],
    ['null'],
    ['\r\n {\r\n\t"a" : "\\u00e9\\ud83d\\ude80\\n"\r\n}\r\n'],
    ['{"big": 123456789012345678901234567890, "inf": 1e400}'],
    ['"\\ud800"'],
  ])('matches JSON.parse for %s', (text) => {
    expect(JSON.stringify(ok(text).value)).toBe(JSON.stringify(JSON.parse(text)));
  });

  it('builds frozen null-prototype objects', () => {
    const { value } = ok('{"a": {"b": [{"c": 1}]}}');
    const a = (value as Record<string, unknown>)['a'] as Record<string, unknown>;
    const b = a['b'] as Record<string, unknown>[];
    for (const object of [value, a, b[0]]) {
      expect(Object.getPrototypeOf(object)).toBeNull();
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('keeps __proto__ as an own key without polluting prototypes', () => {
    const text =
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}';
    const value = ok(text).value as Record<string, unknown>;
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value)).toEqual(['__proto__', 'constructor']);
    expect((value['__proto__'] as Record<string, unknown>)['polluted']).toBe(true);
  });

  it('lets the last duplicate key win, like JSON.parse, and points spans at it', () => {
    const text = '{"a": 1, "b": 2, "a": {"x": 3}}';
    const doc = ok(text);
    expect(JSON.stringify(doc.value)).toBe(JSON.stringify(JSON.parse(text)));
    expect(slice(text, doc.valueSpan(['a']))).toBe('{"x": 3}');
    expect(doc.keySpan(['a'])).toEqual({ offset: 17, length: 3 });
    expect(slice(text, doc.valueSpan(['a', 'x']))).toBe('3');
  });
});

describe('spans', () => {
  const text =
    '{\r\n  "servers": {\r\n    "fs": {"command": "npx", "args": ["-y", "server"]}\r\n  },\r\n  "n": 1\r\n}';
  const doc = ok(text);

  it.each<[(string | number)[], string | undefined, string | undefined]>([
    [[], text, undefined],
    [['servers', 'fs', 'command'], '"npx"', '"command"'],
    [['servers', 'fs', 'args'], '["-y", "server"]', '"args"'],
    [['servers', 'fs', 'args', 1], '"server"', undefined],
    [['n'], '1', '"n"'],
    [['missing'], undefined, undefined],
    [['servers', 'fs', 'args', 5], undefined, undefined],
    [['servers', 'fs', 'args', -1], undefined, undefined],
    [['servers', 'fs', 'args', 0.5], undefined, undefined],
    [['servers', 0], undefined, undefined],
    [['n', 'x'], undefined, undefined],
  ])('path %j', (path, value, key) => {
    expect(slice(text, doc.valueSpan(path))).toBe(value);
    expect(slice(text, doc.keySpan(path))).toBe(key);
  });
});

describe('errors', () => {
  it.each<[string, string, [string, string | undefined][]]>([
    ['line comment', '{"a": 1 // note\n}', [[JSON_ISSUE.comment, '// note']]],
    ['block comment', '/* c */ {}', [[JSON_ISSUE.comment, '/* c */']]],
    ['trailing comma in object', '{"a": 1,}', [[JSON_ISSUE.trailingComma, ',']]],
    ['trailing comma in array', '[1, 2, ]', [[JSON_ISSUE.trailingComma, ',']]],
    [
      'nested trailing commas',
      '{"a": [1,], }',
      [
        [JSON_ISSUE.trailingComma, ','],
        [JSON_ISSUE.trailingComma, ','],
      ],
    ],
    [
      'comment between comma and brace',
      '{"a": 1, // c\n}',
      [
        [JSON_ISSUE.trailingComma, ','],
        [JSON_ISSUE.comment, '// c'],
      ],
    ],
    // jsonc-parser reports an unterminated comment as a comment running to the end, which is
    // also how strip-json-comments (Gemini CLI) treats it.
    ['unterminated comment', '{} /* x', [[JSON_ISSUE.comment, '/* x']]],
    ['missing comma', '[1 2]', [['comma-expected', '2']]],
    [
      'single quotes',
      "{'a': 1}",
      [
        ['invalid-symbol', "'a'"],
        ['property-name-expected', ':'],
        ['value-expected', '}'],
      ],
    ],
    ['two values', '{}{}', [['end-of-file-expected', '{']]],
    ['empty', '', [['value-expected', '']]],
    ['whitespace only', ' \r\n\t', [['value-expected', '']]],
    ['control character in a string', '"a\u0001b"', [['invalid-character', '"a\u0001b"']]],
    ['bad escape', '"\\x"', [['invalid-escape-character', '"\\x"']]],
    [
      'NaN',
      'NaN',
      [
        ['invalid-symbol', 'NaN'],
        ['value-expected', ''],
      ],
    ],
  ])('%s', (_name, text, expected) => {
    expect(issues(text)).toEqual(expected);
  });

  it('gives every issue a message', () => {
    for (const error of failed('{"a" 1, /* */ "b": [1,],}').errors) {
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('bounds the number of errors', () => {
    expect(failed(`[${','.repeat(100_000)}]`).errors).toHaveLength(100);
  });

  it('rejects oversized input without parsing it', () => {
    const doc = failed(' '.repeat(MAX_JSON_LENGTH + 1));
    expect(doc.errors.map((error) => error.code)).toEqual([JSON_ISSUE.tooLarge]);
  });

  it('rejects deep nesting without overflowing the stack', () => {
    const text = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const started = performance.now();
    expect(failed(text).errors).toEqual([
      {
        code: JSON_ISSUE.tooDeep,
        message: `Nesting is deeper than ${MAX_JSON_DEPTH} levels.`,
        span: { offset: MAX_JSON_DEPTH, length: 1 },
      },
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(ok(`${'['.repeat(MAX_JSON_DEPTH)}${']'.repeat(MAX_JSON_DEPTH)}`).value).toBeDefined();
  });

  it('does not count brackets inside strings or comments as nesting', () => {
    const deep = '['.repeat(MAX_JSON_DEPTH + 10);
    expect(ok(`["${deep}"]`).value).toEqual([deep]);
    expect(issues(`/* ${deep} */ {}`)).toEqual([[JSON_ISSUE.comment, `/* ${deep} */`]]);
  });
});

/**
 * strip-json-comments 3.1.1 (MIT, Sindre Sorhus), transcribed as a test oracle: Gemini CLI reads
 * settings.json as `JSON.parse(stripJsonComments(content))`.
 */
function referenceStrip(jsonString: string): string {
  const strip = (string: string, start?: number, end?: number) =>
    string.slice(start, end).replace(/\S/g, ' ');
  const isEscaped = (string: string, quotePosition: number) => {
    let index = quotePosition - 1;
    let backslashCount = 0;
    while (string[index] === '\\') {
      index -= 1;
      backslashCount += 1;
    }
    return Boolean(backslashCount % 2);
  };
  let insideString = false;
  let insideComment: false | 'single' | 'multi' = false;
  let offset = 0;
  let result = '';
  for (let i = 0; i < jsonString.length; i++) {
    const currentCharacter = jsonString[i];
    const nextCharacter = jsonString[i + 1];
    if (!insideComment && currentCharacter === '"') {
      if (!isEscaped(jsonString, i)) insideString = !insideString;
    }
    if (insideString) continue;
    if (!insideComment && `${currentCharacter}${nextCharacter}` === '//') {
      result += jsonString.slice(offset, i);
      offset = i;
      insideComment = 'single';
      i++;
    } else if (insideComment === 'single' && `${currentCharacter}${nextCharacter}` === '\r\n') {
      i++;
      insideComment = false;
      result += strip(jsonString, offset, i);
      offset = i;
      continue;
    } else if (insideComment === 'single' && currentCharacter === '\n') {
      insideComment = false;
      result += strip(jsonString, offset, i);
      offset = i;
    } else if (!insideComment && `${currentCharacter}${nextCharacter}` === '/*') {
      result += jsonString.slice(offset, i);
      offset = i;
      insideComment = 'multi';
      i++;
      continue;
    } else if (insideComment === 'multi' && `${currentCharacter}${nextCharacter}` === '*/') {
      i++;
      insideComment = false;
      result += strip(jsonString, offset, i + 1);
      offset = i + 1;
      continue;
    }
  }
  return result + (insideComment ? strip(jsonString.slice(offset)) : jsonString.slice(offset));
}

describe('VS Code view (JSONC)', () => {
  it.each<[string, string, unknown]>([
    ['line and block comments', '{\n  // local\n  "a": /* one */ 1\n}', { a: 1 }],
    ['trailing commas', '{"a": [1, 2,], "b": {"c": 3,},}', { a: [1, 2], b: { c: 3 } }],
    [
      'both',
      '{"servers": {"x": {"command": "npx", // note\n},},}',
      { servers: { x: { command: 'npx' } } },
    ],
    ['strict JSON', '{"a": 1}', { a: 1 }],
  ])('accepts %s', (_name, text, expected) => {
    const doc = parseJsonc(text);
    if (!doc.ok) throw new Error(JSON.stringify(doc.errors));
    expect(JSON.stringify(doc.value)).toBe(JSON.stringify(expected));
    // The other views reject what only JSONC allows.
    if (_name !== 'strict JSON') expect(parseJson(text).ok).toBe(false);
  });

  it('keeps spans on the original text', () => {
    const text = '{\n  // servers\n  "servers": {"fs": {"command": "npx",},}, /* end */\n}';
    const doc = parseJsonc(text);
    if (!doc.ok) throw new Error('expected ok');
    expect(slice(text, doc.valueSpan(['servers', 'fs', 'command']))).toBe('"npx"');
    expect(slice(text, doc.keySpan(['servers']))).toBe('"servers"');
  });

  it.each<[string, string]>([
    ['an unterminated object', '{"servers": {'],
    ['an unterminated block comment', '{"a": 1} /* open'],
    ['a missing comma', '{"a": 1 "b": 2}'],
    ['an empty file', ''],
  ])('rejects %s', (_name, text) => {
    expect(parseJsonc(text).ok).toBe(false);
  });

  it('applies the same limits as strict JSON', () => {
    const deep = parseJsonc(`${'['.repeat(MAX_JSON_DEPTH + 1)}${']'.repeat(MAX_JSON_DEPTH + 1)}`);
    expect(!deep.ok && deep.errors[0]?.code).toBe(JSON_ISSUE.tooDeep);
    const large = parseJsonc(`"${'x'.repeat(MAX_JSON_LENGTH)}"`);
    expect(!large.ok && large.errors[0]?.code).toBe(JSON_ISSUE.tooLarge);
  });
});

describe('Gemini CLI view (comments stripped)', () => {
  it.each<[string, string, unknown]>([
    ['line comment', '{"a": 1 // note\n}', { a: 1 }],
    ['CRLF line comment', '{\r\n  // note\r\n  "a": 1\r\n}', { a: 1 }],
    ['block comment', '{/* c */"a": [1, /* d */ 2]}', { a: [1, 2] }],
    ['unterminated block comment', '{"a": 1} /* never closed', { a: 1 }],
    [
      'comment markers inside strings',
      '{"url": "https://x//y", "c": "/* no */"}',
      { url: 'https://x//y', c: '/* no */' },
    ],
    ['escaped quote before //', '{"a\\"//": 1}', { 'a"//': 1 }],
  ])('accepts %s', (_name, text, expected) => {
    const doc = parseJsonWithComments(text);
    if (!doc.ok) throw new Error(JSON.stringify(doc.errors));
    expect(JSON.stringify(doc.value)).toBe(JSON.stringify(expected));
  });

  it('keeps spans on the original text', () => {
    const text = '{\n  // servers\n  "servers": {"fs": {"command": "npx"}} /* end */\n}';
    const doc = parseJsonWithComments(text);
    if (!doc.ok) throw new Error('expected ok');
    expect(slice(text, doc.valueSpan(['servers', 'fs', 'command']))).toBe('"npx"');
    expect(slice(text, doc.keySpan(['servers']))).toBe('"servers"');
  });

  it.each<[string, string, string[]]>([
    ['trailing comma stays fatal', '{"a": 1, // c\n}', [JSON_ISSUE.trailingComma]],
    ['lone CR does not end a line comment', '{"a": 1 // c\r}', ['close-brace-expected']],
    ['non-breaking space survives in a comment', '{} // a\u00a0b', ['invalid-symbol']],
  ])('rejects: %s', (_name, text, codes) => {
    const doc = parseJsonWithComments(text);
    if (doc.ok) throw new Error('expected a failure');
    expect(doc.errors.map((error) => error.code)).toEqual(codes);
  });

  it('strips like strip-json-comments 3.1.1 and keeps the length', () => {
    const fragments = [
      '//',
      '/*',
      '*/',
      '"',
      '\\',
      '\n',
      '\r',
      '\r\n',
      ' ',
      'a',
      '{',
      '}',
      ':',
      '1',
      ',',
      '\u00a0',
      '🚀',
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...fragments), { maxLength: 60 }), (parts) => {
        const text = parts.join('');
        const stripped = stripJsonComments(text);
        expect(stripped).toBe(referenceStrip(text));
        expect(stripped).toHaveLength(text.length);
      }),
      { numRuns: 500 },
    );
  });

  it('matches JSON.parse after stripping', () => {
    fc.assert(
      fc.property(
        fc.json({ maxDepth: 3 }),
        fc.nat(),
        fc.constantFrom('// c\n', '/* c */', '// c\r\n', ','),
        (json, at, insert) => {
          const position = json.length === 0 ? 0 : at % json.length;
          const text = json.slice(0, position) + insert + json.slice(position);
          let expected: unknown;
          let parses = true;
          try {
            expected = JSON.parse(referenceStrip(text));
          } catch {
            parses = false;
          }
          const doc = parseJsonWithComments(text);
          expect(doc.ok).toBe(parses);
          if (doc.ok) expect(JSON.stringify(doc.value)).toBe(JSON.stringify(expected));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is plain parseJson on text without comments', () => {
    const text = '{"a": [1, 2], "b": "c"}';
    expect(stripJsonComments(text)).toBe(text);
  });
});

describe('duplicate keys', () => {
  it('has no warnings without duplicates', () => {
    expect(ok('{"a": 1, "b": {"a": 2}, "c": [{"a": 3}, {"a": 4}]}').warnings).toEqual([]);
    expect(ok('[1, 2]').warnings).toEqual([]);
  });

  it('warns on the overridden key; the last value wins, as with JSON.parse', () => {
    const text = '{"a": 1, "b": 2, "a": 3}';
    const doc = ok(text);
    expect(doc.warnings).toEqual([
      {
        code: 'duplicate-key',
        message: 'Duplicate key "a": JSON.parse keeps the last value, so this one is ignored.',
        span: { offset: 1, length: 3 },
      },
    ]);
    expect((doc.value as Record<string, unknown>)['a']).toBe(3);
  });

  it('warns once per overridden occurrence, at any depth, in source order', () => {
    const text = '{"x": {"k": 1, "k": 2, "k": 3}, "x": [{"__proto__": 1, "__proto__": 2}]}';
    const { warnings } = ok(text);
    expect(warnings.map((w) => [w.code, w.span.offset, slice(text, w.span)])).toEqual([
      ['duplicate-key', 1, '"x"'],
      ['duplicate-key', 7, '"k"'],
      ['duplicate-key', 15, '"k"'],
      ['duplicate-key', 39, '"__proto__"'],
    ]);
  });

  it('bounds the number of warnings', () => {
    const text = `{${Array.from({ length: 1000 }, () => '"a": 1').join(', ')}}`;
    expect(ok(text).warnings).toHaveLength(100);
  });

  it('keeps messages short and free of control characters', () => {
    const long = 'k'.repeat(100);
    const [longWarning] = ok(`{"${long}": 1, "${long}": 2}`).warnings;
    expect(longWarning?.message).toContain(`"${'k'.repeat(60)}…"`);
    const [escapeWarning] = ok('{"a\\u001b[31m": 1, "a\\u001b[31m": 2}').warnings;
    expect(escapeWarning?.message).toBe(
      'Duplicate key "a [31m": JSON.parse keeps the last value, so this one is ignored.',
    );
  });

  it('reports duplicates through parseJsonWithComments, with spans on the original text', () => {
    const text = '{\n  // first\n  "a": 1,\n  /* again */ "a": 2\n}';
    const doc = parseJsonWithComments(text);
    if (!doc.ok) throw new Error(JSON.stringify(doc.errors));
    expect(doc.warnings.map((w) => [w.code, w.span.offset, slice(text, w.span)])).toEqual([
      ['duplicate-key', text.indexOf('"a"'), '"a"'],
    ]);
    expect(parseJsonWithComments('{"a": 1}')).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('locate', () => {
  const text =
    '{\n  "mcpServers": {\n    "docs": { "url": "https://x.example", "port": 1.50 },\n' +
    '    "list": [ "a", { "b": 2, "a": [true, null] } ]\n  }\n}\n';
  const doc = ok(text);
  const at = (needle: string, length = needle.length) =>
    doc.locate({ offset: text.indexOf(needle), length });

  it('finds the value under a key, a value or a whole property', () => {
    const property = '"docs": { "url": "https://x.example", "port": 1.50 }';
    for (const span of ['"docs"', '{ "url"', property]) {
      expect(at(span)).toMatchObject({
        path: ['mcpServers', 'docs'],
        type: 'object',
        inArray: false,
      });
    }
    expect(at('"url"')).toMatchObject({ path: ['mcpServers', 'docs', 'url'], type: 'string' });
    // A span inside a string, as for a hidden character, points at the string.
    expect(at('x.example')?.path).toEqual(['mcpServers', 'docs', 'url']);
    expect(at('"url"')?.canonical()).toBe('"https://x.example"');
    expect(at('1.50')?.canonical()).toBe('1.5');
  });

  it('numbers array elements and marks them', () => {
    expect(at('"a",', 3)).toMatchObject({
      path: ['mcpServers', 'list', 0],
      type: 'string',
      inArray: true,
    });
    // A span that also covers the comma is not inside the element: it points at the array.
    expect(at('"a",')).toMatchObject({ path: ['mcpServers', 'list'], type: 'array' });
    expect(at('{ "b"')).toMatchObject({ path: ['mcpServers', 'list', 1], inArray: true });
    expect(at('true')).toMatchObject({
      path: ['mcpServers', 'list', 1, 'a', 0],
      type: 'boolean',
    });
    expect(at('null')?.canonical()).toBe('null');
  });

  it('writes containers canonically: keys sorted, no whitespace, the last duplicate', () => {
    expect(at('{ "b"')?.canonical()).toBe('{"a":[true,null],"b":2}');
    const duplicates = ok('{"z": 1, "a": {"y": [1, 2]}, "z": 3}');
    expect(duplicates.locate({ offset: 0, length: 1 })?.canonical()).toBe(
      '{"a":{"y":[1,2]},"z":3}',
    );
  });

  it('cuts the canonical text of a large container, never of a string', () => {
    const big = ok(`[${Array.from({ length: 5000 }, (_, i) => `"item${i}"`).join(',')}]`);
    expect(big.locate({ offset: 0, length: 1 })?.canonical()).toHaveLength(MAX_CANONICAL_LENGTH);
    const long = `"${'x'.repeat(10_000)}"`;
    expect(ok(long).locate({ offset: 5, length: 1 })?.canonical()).toBe(long);
  });

  it('returns the same object for the same value, and nothing outside the root', () => {
    expect(at('"docs"')).toBe(at('{ "url"'));
    expect(at('"url"')).toBe(at('https'));
    const padded = ok('  {"a": 1}  ');
    expect(padded.locate({ offset: 0, length: 1 })).toBeUndefined();
    expect(padded.locate({ offset: 11, length: 0 })).toBeUndefined();
    expect(ok('{"a": 1}').locate({ offset: 0, length: 8 })).toMatchObject({
      path: [],
      type: 'object',
    });
  });

  it('locates the earlier of two duplicate keys at its own position', () => {
    const first = ok('{"a": 1, "a": 2}').locate({ offset: 1, length: 3 });
    expect(first).toMatchObject({ path: ['a'], type: 'number' });
    expect(first?.canonical()).toBe('1');
  });

  it('stays logarithmic per level on a wide object', () => {
    const wide = `{${Array.from({ length: 50_000 }, (_, i) => `"k${i}": ${i}`).join(', ')}}`;
    const wideDoc = ok(wide);
    const started = performance.now();
    for (let i = 0; i < 50_000; i += 7) {
      const offset = wide.indexOf(`"k${i}"`);
      expect(wideDoc.locate({ offset, length: 1 })?.path).toEqual([`k${i}`]);
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
