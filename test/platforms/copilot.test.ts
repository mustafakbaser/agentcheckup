import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import {
  copilotActivation,
  inPlausibleGithubTree,
  placement,
} from '../../src/platforms/copilot.js';
import * as fromRules from '../../src/rules/copilot/location.js';
import { snapshotFrom } from '../helpers/lint.js';

const activation = (text: string) => copilotActivation(parseFrontmatter(text));

describe('copilotActivation', () => {
  it('applies an applyTo string on every surface', () => {
    expect(activation('---\napplyTo: "**/*.ts, **/*.tsx"\n---\nBody\n')).toEqual({
      frontmatter: 'valid',
      applyTo: { kind: 'patterns', patterns: ['**/*.ts', '**/*.tsx'] },
      described: false,
      cloud: 'on-path',
      vscode: 'on-path',
    });
  });

  it('leaves the cloud agent out of a file without applyTo', () => {
    expect(activation('---\ndescription: TypeScript rules\n---\n')).toMatchObject({
      applyTo: { kind: 'missing' },
      described: true,
      cloud: 'never',
      vscode: 'model-selected',
    });
    expect(activation('No frontmatter.\n')).toMatchObject({
      frontmatter: 'absent',
      cloud: 'never',
      vscode: 'manual',
    });
    expect(activation('---\nname: x\n---\n')).toMatchObject({ cloud: 'never', vscode: 'manual' });
  });

  it.each([
    ['---\napplyTo:\n---\n', 'null'],
    ['---\napplyTo: "  "\n---\n', 'blank'],
    ['---\napplyTo: 3\n---\n', 'invalid'],
    ['---\napplyTo: []\n---\n', 'invalid'],
  ] as const)('applies no files for %j', (text, kind) => {
    expect(activation(text)).toMatchObject({
      applyTo: { kind },
      cloud: 'never',
      vscode: 'unknown',
    });
  });

  it('cannot tell for an undocumented list or YAML that lenient readers accept', () => {
    expect(activation('---\napplyTo: ["a/**", "b/**"]\n---\n')).toMatchObject({
      applyTo: { kind: 'list', patterns: ['a/**', 'b/**'] },
      cloud: 'unknown',
      vscode: 'unknown',
    });
    expect(activation('---\napplyTo: **/*.ts\n---\n')).toMatchObject({
      frontmatter: 'tolerated',
      cloud: 'unknown',
    });
  });

  it('never applies frontmatter Copilot cannot read', () => {
    expect(activation('---\napplyTo: "x"\n')).toMatchObject({
      frontmatter: 'unreadable',
      cloud: 'never',
    });
    expect(activation('---\napplyTo: [a\n---\n')).toMatchObject({
      frontmatter: 'unreadable',
      cloud: 'never',
    });
  });

  it('keeps only documented excludeAgent values', () => {
    expect(activation('---\napplyTo: "**"\nexcludeAgent: cloud-agent\n---\n').excludeAgent).toBe(
      'cloud-agent',
    );
    expect(
      activation('---\napplyTo: "**"\nexcludeAgent: coding-agent\n---\n').excludeAgent,
    ).toBeUndefined();
  });
});

describe('Copilot locations', () => {
  it('are re-exported for the copilot rules', () => {
    expect(fromRules.placement).toBe(placement);
    expect(fromRules.inPlausibleGithubTree).toBe(inPlausibleGithubTree);
  });

  it('place files against .github at a repository root', () => {
    const snapshot = snapshotFrom({}, { paths: ['sub/.git/HEAD'] });
    const at = (path: string) => placement(snapshot, path, 'instructions');
    expect(at('.github/instructions/a.instructions.md')).toEqual({ kind: 'expected' });
    expect(at('.GitHub/instructions/a.instructions.md')).toEqual({ kind: 'case' });
    expect(at('pkg/.github/instructions/a.instructions.md')).toEqual({
      kind: 'nested',
      root: 'pkg',
    });
    expect(at('sub/.github/instructions/a.instructions.md')).toEqual({ kind: 'expected' });
    expect(at('docs/a.instructions.md')).toEqual({ kind: 'elsewhere' });
  });
});
