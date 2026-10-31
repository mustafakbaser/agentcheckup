import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedText, cachedVersions, cacheText } from '../../../scripts/drift/cache.js';
import { formatTextDiff, sentenceLines } from '../../../scripts/drift/diff.js';
import { sha256 } from '../../../scripts/drift/normalize.js';
import { HOSTILE_ALL } from '../../report/hostile.js';
import { unsafeCodePoints } from '../../report/safety.js';

const URL_A = 'https://docs.example/a';
const URL_B = 'https://docs.example/b';

describe('the drift text cache', () => {
  let cache: string;
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), 'agentcheckup-drift-cache-'));
  });
  afterEach(async () => {
    await rm(cache, { recursive: true, force: true });
  });

  it('keeps each version of a source under the hashes of its URL and its text', async () => {
    expect(await cacheText(cache, URL_A, '# A\n\nfirst')).toBe(sha256('# A\n\nfirst'));
    const directory = join(cache, sha256(URL_A));
    expect((await readdir(directory)).sort()).toEqual([`${sha256('# A\n\nfirst')}.txt`, 'url.txt']);
    expect(await readFile(join(directory, 'url.txt'), 'utf8')).toBe(`${URL_A}\n`);
    expect(await cachedText(cache, URL_A, sha256('# A\n\nfirst'))).toBe('# A\n\nfirst');
  });

  it('keeps earlier versions, newest first, and never rewrites one', async () => {
    const first = await cacheText(cache, URL_A, 'one');
    const second = await cacheText(cache, URL_A, 'two');
    const directory = join(cache, sha256(URL_A));
    await utimes(join(directory, `${first}.txt`), 1_000, 1_000);
    await utimes(join(directory, `${second}.txt`), 2_000, 2_000);
    expect(await cacheText(cache, URL_A, 'one')).toBe(first);
    expect((await cachedVersions(cache, URL_A)).map((version) => version.hash)).toEqual([
      second,
      first,
    ]);
    expect((await cachedVersions(cache, URL_A))[1]?.cachedAt).toBe(1_000_000);
  });

  it('knows nothing of a source or a hash it has not seen', async () => {
    await cacheText(cache, URL_A, 'one');
    expect(await cachedVersions(cache, URL_B)).toEqual([]);
    expect(await cachedText(cache, URL_B, sha256('one'))).toBeUndefined();
    expect(await cachedText(cache, URL_A, sha256('two'))).toBeUndefined();
    expect(await cachedText(cache, URL_A, '../../etc/passwd')).toBeUndefined();
  });
});

describe('formatTextDiff', () => {
  const labels = { from: `${URL_A} (baseline aaa)`, to: `${URL_A} (now bbb)` };

  it('prints a unified diff of the normalized text', () => {
    const before = ['# Memory', '', 'Files load at startup.', 'Imports go five hops deep.'];
    const after = ['# Memory', '', 'Files load at startup.', 'Imports go four hops deep.'];
    expect(formatTextDiff(before.join('\n'), after.join('\n'), labels)).toBe(
      [
        `--- ${URL_A} (baseline aaa)`,
        `+++ ${URL_A} (now bbb)`,
        '@@ -1,4 +1,4 @@',
        ' # Memory',
        ' ',
        ' Files load at startup.',
        '-Imports go five hops deep.',
        '+Imports go four hops deep.',
        '',
      ].join('\n'),
    );
  });

  it('prints nothing for the same text', () => {
    expect(formatTextDiff('a\nb', 'a\nb', labels)).toBe('');
  });

  it('shows a source new to the cache as added lines', () => {
    expect(formatTextDiff('', 'a', labels)).toContain('@@ -0,0 +1 @@\n+a\n');
  });

  it('shows the sentence that changed in the one long line of an HTML page', () => {
    const page = (word: string): string =>
      `${'An introduction that is long enough to wrap. '.repeat(5)}Limits are ${word}. The end.`;
    const diff = formatTextDiff(page('32 KiB'), page('64 KiB'), labels);
    expect(diff).toContain('\n-Limits are 32 KiB.\n+Limits are 64 KiB.\n');
    expect(sentenceLines('Short. Line.')).toBe('Short. Line.');
  });

  it('neutralizes control characters and workflow commands from the network', () => {
    const diff = formatTextDiff('::error::x\nsafe', `::error::x\n${HOSTILE_ALL}`, labels);
    expect(unsafeCodePoints(diff, { newline: true, tab: true })).toEqual([]);
    expect(diff.split('\n').some((line) => line.trimStart().startsWith('::'))).toBe(false);
    expect(diff).toContain('\n <U+003A>:error::x\n');
  });
});
