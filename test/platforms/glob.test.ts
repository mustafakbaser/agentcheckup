import { describe, expect, it } from 'vitest';
import { claudeMdExcluded, claudePathPatterns } from '../../src/platforms/claude-memory.js';
import { expandBraces, matchAbsoluteGlob } from '../../src/platforms/glob.js';

describe('matchAbsoluteGlob', () => {
  it('matches a pattern led by ** whatever directory the repository is in', () => {
    expect(matchAbsoluteGlob('**/vendor/**/CLAUDE.md', 'vendor/lib/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/vendor/**/CLAUDE.md', 'a/vendor/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('/**/CLAUDE.md', 'pkg/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/*.md', 'docs/CLAUDE.md')).toBe('match');
  });

  it('does not let the directories above the scan root complete a ** pattern', () => {
    expect(matchAbsoluteGlob('**/vendor/**/CLAUDE.md', 'CLAUDE.md')).toBe('no');
    expect(matchAbsoluteGlob('**/monorepo/CLAUDE.md', 'CLAUDE.md')).toBe('no');
    expect(matchAbsoluteGlob('**/vendor/CLAUDE.md', 'pkg/CLAUDE.md')).toBe('no');
  });

  it('says an absolute or relative pattern may match when a tail of it matches', () => {
    expect(matchAbsoluteGlob('/home/user/monorepo/CLAUDE.md', 'CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('/home/user/monorepo/pkg/CLAUDE.md', 'pkg/CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('/home/**/rules/*.md', '.claude/rules/x.md')).toBe('maybe');
    expect(matchAbsoluteGlob('~/repo/CLAUDE.md', 'CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('CLAUDE.md', 'CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('/home/user/monorepo/CLAUDE.md', 'pkg/AGENTS.md')).toBe('no');
    // The scan root may be a `docs` directory.
    expect(matchAbsoluteGlob('docs/CLAUDE.md', 'CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('docs/CLAUDE.md', 'AGENTS.md')).toBe('no');
  });

  it('says a match that depends on dot files may match', () => {
    // Whether ** and * take a name that starts with a dot differs between glob libraries.
    expect(matchAbsoluteGlob('**/CLAUDE.md', '.claude/CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('**/*/CLAUDE.md', '.claude/CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('**/.claude/CLAUDE.md', '.claude/CLAUDE.md')).toBe('match');
  });

  it('reads ?, classes, escapes and braces', () => {
    expect(matchAbsoluteGlob('**/pkg-?/CLAUDE.md', 'pkg-a/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/pkg-[a-c]/CLAUDE.md', 'pkg-b/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/pkg-[!a-c]/CLAUDE.md', 'pkg-b/CLAUDE.md')).toBe('no');
    expect(matchAbsoluteGlob('**/pkg-[^a]/CLAUDE.md', 'pkg-z/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/a\\*b/CLAUDE.md', 'a*b/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/a\\*b/CLAUDE.md', 'axb/CLAUDE.md')).toBe('no');
    expect(matchAbsoluteGlob('**/{web,api}/CLAUDE.md', 'api/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/{web,api}/CLAUDE.md', 'docs/CLAUDE.md')).toBe('no');
    // An unclosed class or brace is literal.
    expect(matchAbsoluteGlob('**/[ab/CLAUDE.md', '[ab/CLAUDE.md')).toBe('match');
    expect(matchAbsoluteGlob('**/{ab/CLAUDE.md', '{ab/CLAUDE.md')).toBe('match');
  });

  it('does not evaluate extglobs, negation, too many alternatives or long patterns', () => {
    expect(matchAbsoluteGlob('**/@(a|b)/CLAUDE.md', 'a/CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob('!**/CLAUDE.md', 'CLAUDE.md')).toBe('maybe');
    expect(matchAbsoluteGlob(`**/${'{a,b}'.repeat(7)}/x.md`, 'a/x.md')).toBe('maybe');
    expect(matchAbsoluteGlob(`**/${'a'.repeat(2000)}`, 'a')).toBe('maybe');
  });

  it('stays fast on patterns built to backtrack', () => {
    const name = `${'a'.repeat(500)}b`;
    const pattern = `**/${'*a'.repeat(100)}c`;
    expect(matchAbsoluteGlob(pattern, name)).toBe('no');
    const deep = Array.from({ length: 200 }, () => 'x').join('/');
    expect(matchAbsoluteGlob(`${'**/x/'.repeat(50)}y`, deep)).toBe('no');
  });
});

describe('expandBraces', () => {
  it('expands nested groups and keeps a group without a comma', () => {
    expect(expandBraces('a/{b,c{d,e}}/f')).toEqual(['a/b/f', 'a/cd/f', 'a/ce/f']);
    expect(expandBraces('a/{b}/c')).toEqual(['a/{b}/c']);
    expect(expandBraces('a/\\{b,c}/d')).toEqual(['a/\\{b,c}/d']);
  });
});

describe('claudeMdExcluded and claudePathPatterns', () => {
  it('takes the strongest match over patterns and paths', () => {
    const excludes = { patterns: ['/abs/CLAUDE.md', '**/vendor/CLAUDE.md'], truncated: false };
    expect(claudeMdExcluded(excludes, ['vendor/CLAUDE.md'])).toBe('match');
    expect(claudeMdExcluded(excludes, ['CLAUDE.md'])).toBe('maybe');
    expect(claudeMdExcluded(excludes, ['docs/AGENTS.md'])).toBe('no');
    expect(claudeMdExcluded({ patterns: [], truncated: true }, ['CLAUDE.md'])).toBe('maybe');
  });

  it('reads a comma-separated string or a list of strings', () => {
    expect(claudePathPatterns('src/**, lib/{a,b}/*.ts')).toEqual(['src/**', 'lib/{a,b}/*.ts']);
    expect(claudePathPatterns(['src/**', ' '])).toEqual(['src/**']);
    expect(claudePathPatterns(['src/**', 3])).toEqual([]);
    expect(claudePathPatterns(true)).toEqual([]);
  });
});
