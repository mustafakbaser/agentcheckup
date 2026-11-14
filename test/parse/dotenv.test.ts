/**
 * parseDotenv (src/parse/dotenv.ts) reads `.env` files as the `dotenv` package's `parse()` does,
 * which Gemini CLI calls. The expected values follow that function's documented expression; the
 * quirks a hostile file could use to hide a variable from a line-by-line reader are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../src/parse/dotenv.js';

const parsed = (text: string): Record<string, string> =>
  Object.fromEntries(parseDotenv(text).map((entry) => [entry.name, entry.value]));

const lines = (text: string): string[] =>
  parseDotenv(text).map((entry) => `${entry.name}@${String(entry.line)}`);

describe('parseDotenv', () => {
  it('reads names, values, export, quotes and comments', () => {
    expect(
      parsed(
        [
          '# comment',
          'PLAIN=value # trailing comment',
          'export EXPORTED=1',
          "SINGLE='a # not a comment'",
          'DOUBLE="line\\nbreak"',
          'BACKTICK=`tick`',
          'SPACED = padded  ',
          'COLON: yes',
          'EMPTY=',
          'dotted.name-x=ok',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      PLAIN: 'value',
      EXPORTED: '1',
      SINGLE: 'a # not a comment',
      DOUBLE: 'line\nbreak',
      BACKTICK: 'tick',
      SPACED: 'padded',
      COLON: 'yes',
      EMPTY: '',
      'dotted.name-x': 'ok',
    });
  });

  it('does not report lines that set nothing', () => {
    expect(
      parsed(['# A=1', 'just text', 'NO_SEPARATOR', 'COLON:nospace', '=value', ''].join('\n')),
    ).toEqual({});
    expect(parseDotenv('')).toEqual([]);
  });

  it('lets a later line win, and counts lines in any line ending', () => {
    expect(parsed('A=1\nA=2\n')).toEqual({ A: '2' });
    expect(lines('A=1\r\nB=2\rC=3\nA=4\n')).toEqual(['B@2', 'C@3', 'A@4']);
  });

  it('runs quoted values over lines, which hides the names inside them', () => {
    expect(parsed("A='first\nHIDDEN=1\nlast'\nB=2\n")).toEqual({
      A: 'first\nHIDDEN=1\nlast',
      B: '2',
    });
    // An unclosed quote is an ordinary value, so the next line still counts.
    expect(parsed("A='open\nB=2\n")).toEqual({ A: "'open", B: '2' });
    // A closing quote must end its line; otherwise the value is plain text up to `#`.
    expect(parsed('A="x" y\nB="z"\n')).toEqual({ A: '"x" y', B: 'z' });
  });

  it('crosses lines where `\\s` does', () => {
    expect(parsed('A\n=1\n')).toEqual({ A: '1' });
    expect(parsed('A=\n"quoted"\n')).toEqual({ A: 'quoted' });
    expect(parsed('A=\nB=2\n')).toEqual({ A: '', B: '2' });
    expect(parsed('export\nA=1\n')).toEqual({ A: '1' });
    expect(lines('\n\n  A=1\n')).toEqual(['A@3']);
  });

  it('starts lines after U+2028 and U+2029 too, but keeps them in unquoted values', () => {
    expect(parsed('# note B=1\n')).toEqual({ B: '1' });
    expect(parsed('A=x B=y\n')).toEqual({ A: 'x B=y' });
  });

  it('ignores __proto__', () => {
    expect(parsed('__proto__=x\nA=1\n')).toEqual({ A: '1' });
    expect(Object.getPrototypeOf(parsed('__proto__=x\n'))).toBe(Object.prototype);
  });
});
