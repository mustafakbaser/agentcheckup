import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import { clineActivation, clinePlace, isClineRuleFile } from '../../src/platforms/cline-rules.js';

describe('clinePlace', () => {
  it.each([
    ['.clinerules/style.md', 'rule', ''],
    ['.clinerules/backend/api.md', 'rule', ''],
    ['.clinerules/workflows/release.md', 'workflow', ''],
    ['.clinerules/hooks/PreToolUse', 'hook', ''],
    ['.clinerules/skills/x/SKILL.md', 'skill', ''],
    ['.cline/rules/style.md', 'rule', ''],
    ['.cline/workflows/release.md', 'workflow', ''],
    ['.cline/hooks/TaskStart', 'hook', ''],
    ['.cline/skills/x/SKILL.md', 'skill', ''],
    ['.cline/agents/reviewer.md', 'agent', ''],
    ['.cline/plugins/guard.js', 'plugin', ''],
    ['apps/web/.clinerules/style.md', 'rule', 'apps/web'],
    ['.Clinerules/Workflows/release.md', 'workflow', ''],
  ] as const)('places %s as a %s', (path, role, root) => {
    expect(clinePlace(path)).toMatchObject({ role, root });
  });

  it.each(['.cline/notes.md', 'docs/style.md', '.clinerules', 'clinerules/style.md'])(
    'does not place %s',
    (path) => {
      expect(clinePlace(path)).toBeUndefined();
    },
  );

  it('names a file directly in .clinerules a rule even when it is named like a folder', () => {
    expect(clinePlace('.clinerules/hooks')).toMatchObject({ role: 'rule' });
  });
});

describe('isClineRuleFile', () => {
  it('accepts the extensions Cline reads', () => {
    expect(['a.md', 'a.markdown', 'a.TXT'].map(isClineRuleFile)).toEqual([true, true, true]);
    expect(['a.mdc', 'a.json', 'PreToolUse'].map(isClineRuleFile)).toEqual([false, false, false]);
  });
});

describe('clineActivation', () => {
  const activation = (text: string) => clineActivation(parseFrontmatter(text));

  it('applies a rule without frontmatter or paths always', () => {
    expect(activation('Body.\n')).toEqual({ mode: 'always', paths: [], documented: true });
    expect(activation('---\ndescription: x\n---\n')).toEqual({
      mode: 'always',
      paths: [],
      documented: true,
    });
  });

  it('applies a rule with paths to the files they match', () => {
    expect(activation('---\npaths:\n  - "src/**"\n  - " test/** "\n---\n')).toEqual({
      mode: 'paths',
      paths: ['src/**', 'test/**'],
      documented: true,
    });
  });

  it('never applies a rule with an empty paths list', () => {
    expect(activation('---\npaths: []\n---\n')).toEqual({
      mode: 'never',
      paths: [],
      documented: true,
    });
    expect(activation('---\npaths: ["  "]\n---\n')).toMatchObject({
      mode: 'never',
      documented: false,
    });
  });

  it('fails open on frontmatter that does not parse, and cannot tell other paths values', () => {
    expect(activation('---\npaths: [a\n---\n')).toEqual({
      mode: 'always',
      paths: [],
      documented: false,
    });
    expect(activation('---\npaths: "src/**"\n---\n')).toMatchObject({
      mode: 'unknown',
      documented: false,
    });
  });
});
