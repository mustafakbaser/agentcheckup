import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import {
  clineDisabled,
  clineFlagTypeError,
  clinePlace,
  clinePlaceIn,
  clineRuleHasPaths,
  isClineRuleFile,
  isClineRuleOrWorkflow,
} from '../../src/platforms/cline-rules.js';

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

  it('places the rules.md, workflows and skills of a managed plugin folder', () => {
    expect(clinePlace('.cline/acme/rules.md')).toEqual({
      role: 'rule',
      root: '',
      folder: '.cline',
      plugin: '.cline/acme',
    });
    expect(clinePlace('pkg/.cline/acme/workflows/ship.md')).toMatchObject({
      role: 'workflow',
      root: 'pkg',
      plugin: 'pkg/.cline/acme',
    });
    expect(clinePlace('.cline/acme/skills/x/SKILL.md')).toMatchObject({ role: 'skill' });
    // Names inside the plugin folder are joined as written, and workflows are not nested.
    for (const path of [
      '.cline/acme/Rules.md',
      '.cline/acme/notes.md',
      '.cline/acme/workflows/a/b.md',
      '.cline/acme/managed.json',
    ]) {
      expect(clinePlace(path), path).toBeUndefined();
    }
  });

  it('counts a managed plugin folder only when it holds a managed.json', () => {
    const paths = new Set([
      '.cline/acme/managed.json',
      '.cline/acme/rules.md',
      '.cline/x/rules.md',
    ]);
    expect(clinePlaceIn(paths, '.cline/acme/rules.md')).toMatchObject({ role: 'rule' });
    expect(clinePlaceIn(paths, '.cline/x/rules.md')).toBeUndefined();
    expect(clinePlaceIn(paths, '.cline/rules/style.md')).toMatchObject({ role: 'rule' });
    expect(isClineRuleOrWorkflow(paths, '.cline/acme/rules.md')).toBe(true);
    expect(isClineRuleOrWorkflow(paths, '.cline/x/rules.md')).toBe(false);
  });
});

describe('isClineRuleFile', () => {
  it('accepts the extensions Cline reads', () => {
    expect(['a.md', 'a.markdown', 'a.TXT'].map(isClineRuleFile)).toEqual([true, true, true]);
    expect(['a.mdc', 'a.json', 'PreToolUse'].map(isClineRuleFile)).toEqual([false, false, false]);
  });
});

describe('clineRuleHasPaths', () => {
  const hasPaths = (text: string) => clineRuleHasPaths(parseFrontmatter(text));

  it('sees paths in any form, which the released extension and CLI ignore', () => {
    expect(hasPaths('---\npaths:\n  - "src/**"\n---\nBody.\n')).toBe(true);
    expect(hasPaths('---\npaths: []\n---\nBody.\n')).toBe(true);
    expect(hasPaths('---\npaths: "src/**"\n---\nBody.\n')).toBe(true);
  });

  it('sees none without the field, with a null one, or in frontmatter that does not parse', () => {
    expect(hasPaths('Body.\n')).toBe(false);
    expect(hasPaths('---\ndescription: x\n---\nBody.\n')).toBe(false);
    expect(hasPaths('---\npaths:\n---\nBody.\n')).toBe(false);
    expect(hasPaths('---\npaths: [a\n---\nBody.\n')).toBe(false);
  });
});

describe('clineDisabled', () => {
  const disabled = (text: string) => clineDisabled(parseFrontmatter(text));

  it('turns a file off with disabled: true, or enabled: false when disabled is not set', () => {
    expect(disabled('---\ndisabled: true\n---\nBody.\n')).toBe(true);
    expect(disabled('---\nenabled: false\n---\nBody.\n')).toBe(true);
    expect(disabled('---\ndisabled: ~\nenabled: false\n---\nBody.\n')).toBe(true);
    expect(disabled('---\r\ndisabled: true\r\npaths: [src/**]\r\n---\r\nBody.\r\n')).toBe(true);
  });

  it('keeps a file on otherwise: a boolean disabled wins over enabled', () => {
    expect(disabled('---\ndisabled: false\nenabled: false\n---\nBody.\n')).toBe(false);
    expect(disabled('---\nenabled: true\n---\nBody.\n')).toBe(false);
    expect(disabled('---\npaths: [src/**]\n---\nBody.\n')).toBe(false);
    expect(disabled('No frontmatter. disabled: true\n')).toBe(false);
    expect(disabled('')).toBe(false);
    // Text is not a boolean: clineFlagTypeError's case.
    expect(disabled('---\ndisabled: "true"\n---\nBody.\n')).toBe(false);
    // Frontmatter that does not parse, or is a list, has no flags.
    expect(disabled('---\ndisabled: true\npaths: [a\n---\nBody.\n')).toBe(false);
    expect(disabled('---\n- disabled: true\n---\nBody.\n')).toBe(false);
  });
});

describe('clineFlagTypeError', () => {
  it('names the toggle field the SDK rejects', () => {
    expect(clineFlagTypeError({ disabled: 'yes' })).toBe('disabled');
    expect(clineFlagTypeError({ disabled: 1, enabled: 'no' })).toBe('disabled');
    expect(clineFlagTypeError({ enabled: 'no' })).toBe('enabled');
    expect(clineFlagTypeError({ disabled: null, enabled: [] })).toBe('enabled');
  });

  it('accepts booleans and missing flags, and ignores enabled next to a boolean disabled', () => {
    expect(clineFlagTypeError({})).toBeUndefined();
    expect(clineFlagTypeError({ disabled: true, enabled: 'no' })).toBeUndefined();
    expect(clineFlagTypeError({ disabled: null, enabled: null })).toBeUndefined();
    expect(clineFlagTypeError({ enabled: false })).toBeUndefined();
  });
});
