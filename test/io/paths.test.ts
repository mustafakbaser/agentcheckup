import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  errorCode,
  joinRelative,
  relativeInsideRoot,
  sanitizeLinkText,
  splitComponents,
  stripRootPrefix,
} from '../../src/io/paths.js';

describe('joinRelative', () => {
  it('joins with a slash, except at the root', () => {
    expect(joinRelative('', 'AGENTS.md')).toBe('AGENTS.md');
    expect(joinRelative('a/b', 'AGENTS.md')).toBe('a/b/AGENTS.md');
  });
});

describe('relativeInsideRoot', () => {
  it('works on POSIX paths', () => {
    const api = path.posix;
    expect(relativeInsideRoot('/repo', '/repo', api)).toBe('');
    expect(relativeInsideRoot('/repo', '/repo/a/b.md', api)).toBe('a/b.md');
    expect(relativeInsideRoot('/repo', '/repo/..hidden', api)).toBe('..hidden');
    expect(relativeInsideRoot('/repo', '/repo-evil/a', api)).toBeUndefined();
    expect(relativeInsideRoot('/repo', '/', api)).toBeUndefined();
    expect(relativeInsideRoot('/repo/sub', '/repo', api)).toBeUndefined();
  });

  it('works on Windows paths, including other drives and shares', () => {
    const api = path.win32;
    expect(relativeInsideRoot('C:\\repo', 'C:\\repo\\a\\b.md', api)).toBe('a/b.md');
    expect(relativeInsideRoot('C:\\repo', 'c:\\REPO\\a', api)).toBe('a');
    expect(relativeInsideRoot('C:\\repo', 'D:\\repo\\a', api)).toBeUndefined();
    expect(relativeInsideRoot('C:\\repo', '\\\\server\\share\\a', api)).toBeUndefined();
    expect(relativeInsideRoot('C:\\repo', 'C:\\other', api)).toBeUndefined();
  });
});

describe('splitComponents', () => {
  it('splits on / only on POSIX, on both separators on Windows', () => {
    expect(splitComponents('a/b\\c', path.posix)).toEqual(['a', 'b\\c']);
    expect(splitComponents('a/b\\c', path.win32)).toEqual(['a', 'b', 'c']);
  });
});

describe('stripRootPrefix', () => {
  it('matches the root component by component on POSIX', () => {
    const api = path.posix;
    expect(stripRootPrefix('/repo', '/repo/a/../b', api)).toEqual(['a', '..', 'b']);
    expect(stripRootPrefix('/repo', '/repo', api)).toEqual([]);
    expect(stripRootPrefix('//repo/', '//repo/./x', api)).toEqual(['x']);
    expect(stripRootPrefix('/repo', '/./repo/x', api)).toEqual(['x']);
    expect(stripRootPrefix('/repo', '/repo/', api)).toEqual([]);
    expect(stripRootPrefix('/repo', '/repo/x/./', api)).toEqual(['x', '.', '']);
    expect(stripRootPrefix('/a/repo', '/a/repo-evil/x', api)).toBeUndefined();
    expect(stripRootPrefix('/a/repo', '/a/../a/repo/x', api)).toBeUndefined();
    expect(stripRootPrefix('/a/repo', '/a', api)).toBeUndefined();
    expect(stripRootPrefix('/Repo', '/repo/x', api)).toBeUndefined();
    expect(stripRootPrefix('/', '/etc/hosts', api)).toEqual(['etc', 'hosts']);
  });

  it('matches case-insensitively and across separators on Windows', () => {
    const api = path.win32;
    expect(stripRootPrefix('C:\\Repo', 'c:/repo/x', api)).toEqual(['x']);
    expect(stripRootPrefix('C:\\repo', 'D:\\repo\\x', api)).toBeUndefined();
    expect(stripRootPrefix('C:\\repo', '\\\\attacker\\share\\repo\\x', api)).toBeUndefined();
    expect(stripRootPrefix('\\\\srv\\share\\repo', '\\\\srv\\share\\repo\\x', api)).toEqual(['x']);
    expect(stripRootPrefix('C:\\repo', '\\repo\\x', api)).toBeUndefined();
  });
});

describe('sanitizeLinkText', () => {
  it('leaves ordinary text alone', () => {
    const text = '../shared/ş İ 😀/AGENTS.md';
    expect(sanitizeLinkText(text)).toBe(text);
  });

  it('replaces C0, C1 and bidi control characters', () => {
    expect(sanitizeLinkText('\u001b[2Ja\nb\rc\u0000d\u007f\u009be\u202ef\u2067g\u200fh')).toBe(
      '\uFFFD[2Ja\uFFFDb\uFFFDc\uFFFDd\uFFFD\uFFFDe\uFFFDf\uFFFDg\uFFFDh',
    );
    expect(sanitizeLinkText('\u061c\u200e')).toBe('\uFFFD\uFFFD');
  });
});

describe('errorCode', () => {
  it('extracts string codes only', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errorCode(Object.assign(new Error('x'), { code: 42 }))).toBeUndefined();
    expect(errorCode('ENOENT')).toBeUndefined();
  });
});
