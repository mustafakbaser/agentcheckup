import { describe, expect, it } from 'vitest';
import { isBlank, isRustWhitespace } from '../../../src/rules/instructions/codex.js';
import {
  basename,
  inPayloadFolder,
  nearestGitRoot,
  relativePath,
  selfAndAncestors,
} from '../../../src/rules/instructions/helpers.js';
import { isFileSystemPath } from '../../../src/rules/instructions/import-outside-root.js';
import {
  agentsMdDirectory,
  looksLikeFilePath,
  withoutTrailingPunctuation,
} from '../../../src/rules/instructions/import-graph.js';
import {
  describeValue,
  issueDetail,
  yamlSyntaxError,
} from '../../../src/rules/instructions/yaml.js';
import { snapshotFrom } from '../../helpers/lint.js';

describe('path helpers', () => {
  it('lists a directory and its ancestors, nearest first', () => {
    expect(selfAndAncestors('a/b/c')).toEqual(['a/b/c', 'a/b', 'a', '']);
    expect(selfAndAncestors('')).toEqual(['']);
  });

  it('computes relative paths between directories and files', () => {
    expect(relativePath('', 'AGENTS.md')).toBe('AGENTS.md');
    expect(relativePath('.claude', 'AGENTS.md')).toBe('../AGENTS.md');
    expect(relativePath('a/b', 'a/c/AGENTS.md')).toBe('../c/AGENTS.md');
    expect(relativePath('a', 'a/b/AGENTS.md')).toBe('b/AGENTS.md');
  });

  it('finds the nearest .git entry', () => {
    const snapshot = snapshotFrom({ 'a/b/AGENTS.md': 'x' }, { paths: ['a/.git'] });
    expect(nearestGitRoot(snapshot, 'a/b')).toBe('a');
    expect(nearestGitRoot(snapshotFrom({ 'x/AGENTS.md': 'x' }), 'x')).toBeUndefined();
    expect(basename('a/b/AGENTS.md')).toBe('AGENTS.md');
  });
});

describe('inPayloadFolder', () => {
  it.each([
    ['templates/app/AGENTS.md', true],
    ['src/ExtensionTemplate/App/.github/x.md', true],
    ['examples/basic/CLAUDE.md', true],
    ['test/__fixtures__/AGENTS.md', true],
    ['assets/AGENTS.md', true],
    ['template.md', false],
    ['AGENTS.md', false],
    ['packages/api/AGENTS.md', false],
  ])('%s is %s', (path, expected) => {
    expect(inPayloadFolder(path)).toBe(expected);
  });
});

describe('Codex whitespace', () => {
  it('matches Rust char::is_whitespace, not JavaScript trim', () => {
    expect(isRustWhitespace(0x85)).toBe(true);
    expect(isRustWhitespace(0xfeff)).toBe(false);
    expect(isRustWhitespace(0x200b)).toBe(false);
    expect(isBlank(' \t\r\n\u3000')).toBe(true);
    expect(isBlank('\uFEFF')).toBe(false);
  });
});

describe('import helpers', () => {
  it.each([
    ['docs/guide.md', true],
    ['./notes', true],
    ['../shared/x', true],
    ['AGENTS.md', true],
    ['tanstack/react-query', false],
    ['octocat', false],
    ['types/node', false],
    ['.env', false],
    ['v1.2', false],
    ['file.', false],
    ['x.verylongextension', false],
    ['x.m_d', false],
    ['https://example.com/a.md', false],
  ])('looksLikeFilePath(%j) is %s', (path, expected) => {
    expect(looksLikeFilePath(path)).toBe(expected);
  });

  it('strips trailing punctuation', () => {
    expect(withoutTrailingPunctuation('docs/a.md.')).toBe('docs/a.md');
    expect(withoutTrailingPunctuation('docs/a.md),')).toBe('docs/a.md');
    expect(withoutTrailingPunctuation('docs/a.md')).toBe('docs/a.md');
  });

  it('maps .claude/AGENTS.md to its project directory', () => {
    expect(agentsMdDirectory('AGENTS.md')).toBe('');
    expect(agentsMdDirectory('.claude/AGENTS.md')).toBe('');
    expect(agentsMdDirectory('pkg/.claude/AGENTS.md')).toBe('pkg');
    expect(agentsMdDirectory('pkg/AGENTS.md')).toBe('pkg');
  });

  it('recognizes file-system absolute paths but not path aliases', () => {
    expect(isFileSystemPath('/Users/alice/notes.md')).toBe(true);
    expect(isFileSystemPath('/home/bob/x.md')).toBe(true);
    expect(isFileSystemPath('C:/Users/x.md')).toBe(true);
    expect(isFileSystemPath('c:\\notes.md')).toBe(true);
    expect(isFileSystemPath('/components/ui/button.tsx')).toBe(false);
    expect(isFileSystemPath('/')).toBe(false);
  });
});

describe('YAML helpers', () => {
  it('describes values', () => {
    expect(describeValue(null)).toBe('empty');
    expect(describeValue([1])).toBe('a list');
    expect(describeValue('x')).toBe('a string');
    expect(describeValue(1)).toBe('a number');
    expect(describeValue(false)).toBe('the boolean false');
    expect(describeValue({ a: 1 })).toBe('a mapping');
  });

  it('ignores agentcheck limit codes and trims messages', () => {
    const span = { offset: 0, length: 1 };
    expect(yamlSyntaxError([])).toBeUndefined();
    expect(yamlSyntaxError([{ code: 'too-large', message: 'x', span }])).toBeUndefined();
    const issue = { code: 'bad-indent', message: 'Bad indentation. ', span };
    expect(yamlSyntaxError([issue])).toBe(issue);
    expect(issueDetail(issue)).toBe('Bad indentation');
    expect(issueDetail({ ...issue, message: 'No period' })).toBe('No period');
  });
});
