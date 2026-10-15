import { describe, expect, it } from 'vitest';
import { dirnamePosix, joinRelative, normalizeRelative, pathStatus } from '../../src/core/paths.js';
import { snapshotFrom } from '../helpers/lint.js';

describe('normalizeRelative', () => {
  it.each([
    ['a/b', 'a/b'],
    ['./a/./b', 'a/b'],
    ['a/b/../c', 'a/c'],
    ['a//b/', 'a/b'],
    ['', ''],
    ['.', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeRelative(input)).toBe(expected);
  });

  it.each(['..', '../a', 'a/../../b'])('refuses %j, which leaves the root', (input) => {
    expect(normalizeRelative(input)).toBeUndefined();
  });
});

describe('joinRelative and dirnamePosix', () => {
  it('joins relative to a directory', () => {
    expect(joinRelative('docs', 'a.md')).toBe('docs/a.md');
    expect(joinRelative('', 'a.md')).toBe('a.md');
    expect(joinRelative('docs/guides', '../a.md')).toBe('docs/a.md');
    expect(joinRelative('docs', '../../a.md')).toBeUndefined();
  });

  it('returns the directory of a path', () => {
    expect(dirnamePosix('a/b/c.md')).toBe('a/b');
    expect(dirnamePosix('c.md')).toBe('');
  });
});

describe('pathStatus', () => {
  const snapshot = snapshotFrom(
    { 'AGENTS.md': '# a' },
    {
      paths: ['docs/guide.md', 'node_modules/'],
      opaqueDirectories: ['node_modules/', 'generated/'],
      ignoredFiles: ['CLAUDE.local.md'],
    },
  );

  it.each([
    ['AGENTS.md', 'exists'],
    ['docs/guide.md', 'exists'],
    ['docs', 'exists'],
    ['docs/', 'exists'],
    ['./docs/../AGENTS.md', 'exists'],
    ['CLAUDE.local.md', 'exists'],
    ['generated', 'exists'],
    ['node_modules/pkg/AGENTS.md', 'unknown'],
    ['generated/api.md', 'unknown'],
    ['../outside.md', 'unknown'],
    ['docs/missing.md', 'missing'],
    ['missing.md', 'missing'],
  ] as const)('reports %s as %s', (path, status) => {
    expect(pathStatus(snapshot, path)).toBe(status);
  });
});

describe('pathStatus after an incomplete walk', () => {
  it('never reports missing when the entry limit cut the walk short', () => {
    const base = snapshotFrom({ 'AGENTS.md': '# a' });
    const truncated = { ...base, skipped: [{ path: 'src/', reason: 'file-limit' as const }] };
    expect(pathStatus(base, 'missing.md')).toBe('missing');
    expect(pathStatus(truncated, 'missing.md')).toBe('unknown');
    expect(pathStatus(truncated, 'AGENTS.md')).toBe('exists');
  });
});
