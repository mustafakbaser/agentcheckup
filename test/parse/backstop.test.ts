import { describe, expect, it, vi } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import { parseJson } from '../../src/parse/json.js';

// Simulates a library failure (for example a stack overflow deep inside the parser): the parse
// functions must turn it into an issue instead of crashing the scan.
const failure = vi.hoisted((): { value: unknown } => ({
  value: new RangeError('Maximum call stack size exceeded'),
}));

vi.mock('yaml', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseDocument: () => {
    throw failure.value;
  },
}));

vi.mock('jsonc-parser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseTree: () => {
    throw failure.value;
  },
}));

describe('backstops', () => {
  it.each([new RangeError('Maximum call stack size exceeded'), 'not an error'])(
    'reports a YAML library failure (%s)',
    (thrown) => {
      failure.value = thrown;
      const text = '---\nname: x\n---\nbody';
      const result = parseFrontmatter(text);
      expect(result).toMatchObject({ kind: 'invalid', bodyOffset: 16 });
      if (result.kind === 'invalid')
        expect(result.errors.map((e) => e.code)).toEqual(['parse-failed']);
    },
  );

  it.each([new RangeError('Maximum call stack size exceeded'), 'not an error'])(
    'reports a JSON library failure (%s)',
    (thrown) => {
      failure.value = thrown;
      const doc = parseJson('{"a": 1}');
      expect(doc.ok).toBe(false);
      if (!doc.ok) expect(doc.errors.map((e) => e.code)).toEqual(['parse-failed']);
    },
  );
});
