import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DiffRanges,
  insideOneRange,
  MAX_DIFF_BYTES,
  MAX_DIFF_HUNKS,
  MAX_DIFF_PATH_LENGTH,
  parseUnifiedDiff,
} from '../../src/report/unified-diff.js';

/** The ranges of each file as plain data, in diff order. */
function ranges(diff: DiffRanges): Record<string, [number, number][]> {
  return Object.fromEntries(
    [...diff.files].map(([path, list]) => [path, list.map((range) => [range.start, range.end])]),
  );
}

function parsed(lines: readonly string[]): Record<string, [number, number][]> {
  return ranges(parseUnifiedDiff(`${lines.join('\n')}\n`));
}

describe('parseUnifiedDiff', () => {
  it('reads the RIGHT ranges of several files and hunks', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/AGENTS.md b/AGENTS.md',
        'index 1111111..2222222 100644',
        '--- a/AGENTS.md',
        '+++ b/AGENTS.md',
        '@@ -1,3 +1,4 @@ # Heading',
        ' # Agents',
        '+',
        ' Use pnpm.',
        ' Run tests.',
        '@@ -10,2 +11 @@',
        '-old line',
        ' kept',
        'diff --git a/docs/a b.md b/docs/a b.md',
        '--- a/docs/a b.md\t',
        '+++ b/docs/a b.md\t',
        '@@ -5 +5,2 @@',
        '-x',
        '+y',
        '+z',
        '',
      ].join('\n'),
    );
    expect(ranges(diff)).toEqual({
      'AGENTS.md': [
        [1, 4],
        [11, 11],
      ],
      'docs/a b.md': [[5, 6]],
    });
    expect(diff.truncated).toBe(false);
  });

  it('reads a new file and skips a hunk that only removes lines', () => {
    expect(
      parsed([
        'diff --git a/CLAUDE.md b/CLAUDE.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/CLAUDE.md',
        '@@ -0,0 +1,2 @@',
        '+@AGENTS.md',
        '+',
        'diff --git a/x.md b/x.md',
        '--- a/x.md',
        '+++ b/x.md',
        '@@ -3,2 +2,0 @@',
        '-gone',
        '-gone too',
        '@@ -9 +7 @@',
        '-a',
        '+b',
      ]),
    ).toEqual({ 'CLAUDE.md': [[1, 2]], 'x.md': [[7, 7]] });
  });

  it('counts "\\ No newline at end of file" as no line', () => {
    expect(
      parsed([
        '--- a/a.md',
        '+++ b/a.md',
        '@@ -1 +1,2 @@',
        '-last',
        '\\ No newline at end of file',
        '+last',
        '+added',
        '\\ No newline at end of file',
        '@@ -8 +9 @@',
        '-p',
        '+q',
      ]),
    ).toEqual({
      'a.md': [
        [1, 2],
        [9, 9],
      ],
    });
  });

  it('accepts CRLF line endings, in headers and content', () => {
    const text = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+three',
      '@@ -20 +20,3 @@',
      '-x',
      '+x',
      '+y',
      '+z',
      '',
    ].join('\r\n');
    expect(ranges(parseUnifiedDiff(text))).toEqual({
      'a.md': [
        [1, 2],
        [20, 22],
      ],
    });
  });

  it('reads a line that looks like a header inside a hunk as content', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/notes.md b/notes.md',
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -1,2 +1,5 @@',
        ' intro',
        '++++ b/.agents/skills/build/SKILL.md',
        '+@@ -1,100 +1,100 @@',
        '+--- a/README.md',
        '+diff --git a/x b/x',
        '-+++ b/AGENTS.md',
        '@@ -10 +13 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
    );
    expect(ranges(diff)).toEqual({
      'notes.md': [
        [1, 5],
        [13, 13],
      ],
    });
  });

  it('skips quoted paths, deleted files, binary files and renames without content', () => {
    expect(
      parsed([
        'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
        '--- "a/caf\\303\\251.md"',
        '+++ "b/caf\\303\\251.md"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/old.md b/old.md',
        'deleted file mode 100644',
        '--- a/old.md',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-+++ b/AGENTS.md',
        '-@@ -1 +1 @@',
        'diff --git a/logo.png b/logo.png',
        'new file mode 100644',
        'Binary files /dev/null and b/logo.png differ',
        'diff --git a/icon.png b/icon.png',
        'GIT binary patch',
        'literal 12',
        'zcmV-;0B~j',
        '',
        'diff --git a/from.md b/to.md',
        'similarity index 100%',
        'rename from from.md',
        'rename to to.md',
        'diff --git a/kept.md b/kept.md',
        '--- a/kept.md',
        '+++ b/kept.md',
        '@@ -2 +2 @@',
        '-c',
        '+d',
      ]),
    ).toEqual({ 'kept.md': [[2, 2]] });
  });

  it('leaves out paths that are not plain relative paths', () => {
    const header = (path: string): string[] => [`+++ ${path}`, '@@ -1 +1 @@', '-a', '+b'];
    expect(
      parsed([
        ...header('b/../outside.md'),
        ...header('b/./a.md'),
        ...header('b/a//b.md'),
        ...header('b/'),
        ...header('w/mnemonic-prefix.md'),
        ...header('/etc/passwd'),
        ...header(`b/${'x'.repeat(MAX_DIFF_PATH_LENGTH + 1)}`),
        ...header('b/tab\u0001name.md'),
        ...header('b/a.md\t2026-10-17 10:00:00.000000000 +0000'),
        ...header(`b/${'y'.repeat(MAX_DIFF_PATH_LENGTH)}`),
      ]),
    ).toEqual({ 'a.md': [[1, 1]], ['y'.repeat(MAX_DIFF_PATH_LENGTH)]: [[1, 1]] });
  });

  it('drops a hunk whose lines do not add up to its header', () => {
    expect(
      parsed([
        '+++ b/short.md',
        '@@ -1,3 +1,3 @@',
        ' a',
        'diff --git a/next.md b/next.md',
        '+++ b/next.md',
        '@@ -1,2 +1 @@',
        '-a',
        '-b',
        '-c',
        '@@ -5 +4 @@',
        '-x',
        '+y',
        '+++ b/cut.md',
        '@@ -1,5 +1,5 @@',
        ' only one line',
      ]),
    ).toEqual({ 'next.md': [[4, 4]] });
  });

  it('ignores hunk headers it cannot read and hunks before any file', () => {
    expect(
      parsed([
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '+++ b/a.md',
        '@@ -1 +1@@',
        '@@@ -1,1 -1,1 +1,1 @@@',
        '@@ -1 +0,4 @@',
        '-a',
        ' b',
        ' c',
        ' d',
        ' e',
        '@@ -0,0 +0,0 @@',
        '@@ -99999999999 +1 @@',
        '@@ -2 +2 @@',
        '-x',
        '+y',
      ]),
    ).toEqual({ 'a.md': [[2, 2]] });
  });

  it('treats an empty line inside a hunk as a context line', () => {
    expect(parsed(['+++ b/a.md', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+c'])).toEqual({
      'a.md': [[1, 3]],
    });
  });

  it('keeps at most MAX_DIFF_HUNKS hunks', () => {
    const hunk = '@@ -1 +1 @@\n-a\n+b\n';
    const diff = parseUnifiedDiff(`+++ b/a.md\n${hunk.repeat(MAX_DIFF_HUNKS + 2)}`);
    expect(diff.truncated).toBe(true);
    expect(diff.files.get('a.md')).toHaveLength(MAX_DIFF_HUNKS);
    expect(parseUnifiedDiff(`+++ b/a.md\n${hunk.repeat(3)}`).truncated).toBe(false);
  });

  it('parses hostile input of the largest size in bounded time without throwing', () => {
    const block = '+++ b/a.md\n@@ -1 +1 @@\n-\n+\n';
    const inputs = [
      '@'.repeat(MAX_DIFF_BYTES),
      '\n'.repeat(MAX_DIFF_BYTES),
      `+++ b/${'a'.repeat(MAX_DIFF_BYTES - 6)}`,
      `@@ -1 +1 @@${' 9'.repeat(MAX_DIFF_BYTES / 2 - 6)}`,
      '@@ -1,999999999 +1,999999999 @@\n'.padEnd(MAX_DIFF_BYTES, '+'),
      block.repeat(Math.floor(MAX_DIFF_BYTES / block.length)),
    ];
    const started = performance.now();
    for (const input of inputs) expect(() => parseUnifiedDiff(input)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('never throws and returns only valid ranges, whatever the input', () => {
    const line = fc.oneof(
      fc.constantFrom(
        'diff --git a/a.md b/a.md',
        '--- a/a.md',
        '+++ b/a.md',
        '+++ b/b.md',
        '+++ /dev/null',
        '+++ "b/q.md"',
        '@@ -1 +1 @@',
        '@@ -1,2 +1,3 @@',
        '@@ -0,0 +1,2 @@',
        '\\ No newline at end of file',
        'Binary files a/x and b/x differ',
        '',
      ),
      fc.string({ maxLength: 12 }).map((text) => `${'+- @\\'.charAt(text.length % 5)}${text}`),
      fc.string({ maxLength: 20 }),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 40 }), fc.boolean(), (lines, crlf) => {
        const diff = parseUnifiedDiff(lines.join(crlf ? '\r\n' : '\n'));
        for (const list of diff.files.values()) {
          for (const range of list) {
            expect(Number.isSafeInteger(range.start) && range.start >= 1).toBe(true);
            expect(range.end).toBeGreaterThanOrEqual(range.start);
          }
        }
      }),
    );
  });
});

describe('insideOneRange', () => {
  const diff = parseUnifiedDiff(
    '+++ b/a.md\n@@ -1,2 +1,2 @@\n a\n b\n@@ -10 +10,2 @@\n-c\n+c\n+d\n',
  );

  it('accepts lines inside one range', () => {
    expect(insideOneRange(diff, 'a.md', 1, 2)).toBe(true);
    expect(insideOneRange(diff, 'a.md', 11, 11)).toBe(true);
  });

  it('refuses lines outside the ranges, across two ranges, or of another file', () => {
    expect(insideOneRange(diff, 'a.md', 3, 3)).toBe(false);
    expect(insideOneRange(diff, 'a.md', 2, 10)).toBe(false);
    expect(insideOneRange(diff, 'a.md', 10, 12)).toBe(false);
    expect(insideOneRange(diff, 'b.md', 1, 1)).toBe(false);
  });
});
