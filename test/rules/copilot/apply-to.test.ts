import { describe, expect, it } from 'vitest';
import { applyToRule } from '../../../src/rules/copilot/apply-to.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'copilot/apply-to';
const rules = [applyToRule];
const PATH = '.github/instructions/ts.instructions.md';

function run(text: string, path = PATH) {
  return findings(lint({ [path]: text }, { rules }), RULE);
}

describe('copilot/apply-to', () => {
  describe('does not report', () => {
    it.each([
      ['a single pattern', '---\napplyTo: "**/*.ts"\n---\nUse strict mode.\n'],
      ['comma-separated patterns', '---\napplyTo: "**/*.ts,**/*.tsx"\n---\n'],
      ['excludeAgent code-review', '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\n'],
      ['excludeAgent cloud-agent', '---\napplyTo: "**"\nexcludeAgent: cloud-agent\n---\n'],
      ['CRLF line endings', '---\r\napplyTo: "**/*.py"\r\n---\r\nUse pytest.\r\n'],
    ])('%s', (_label, text) => {
      expect(run(text)).toEqual([]);
    });

    it('an ordinary document outside .github that only shares the suffix', () => {
      expect(run('# Setup\n\nInstall Node.js.\n', 'docs/setup.instructions.md')).toEqual([]);
    });
  });

  it('reports a file without frontmatter', () => {
    expect(run('Use strict TypeScript.\n')).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: PATH,
        message:
          'This file has no frontmatter, so it has no "applyTo". Copilot cloud agent and code review never apply this file, and VS Code uses it only when you attach it to a chat.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it('reports frontmatter without applyTo', () => {
    expect(
      run('---\nname: TypeScript\n---\nBody\n').map((finding) => [
        finding.severity,
        finding.message,
      ]),
    ).toEqual([
      [
        'warn',
        'The frontmatter has no "applyTo". Copilot cloud agent and code review never apply this file, and VS Code uses it only when you attach it to a chat.',
      ],
    ]);
  });

  it('notes a description-only file as info, since VS Code loads it on demand', () => {
    expect(
      run('---\ndescription: Use when editing TypeScript\n---\n').map((finding) => [
        finding.severity,
        finding.message,
      ]),
    ).toEqual([
      [
        'info',
        'The frontmatter has a "description" but no "applyTo", so VS Code loads this file only when the description matches the task, and Copilot cloud agent and code review never apply it.',
      ],
    ]);
  });

  it.each([
    ['', '"applyTo" has no value, so it matches no files.'],
    ['"  "', '"applyTo" is empty, so it matches no files.'],
    ['42', '"applyTo" is a number, not a string of comma-separated glob patterns.'],
    ['[]', '"applyTo" is a list, not a string of comma-separated glob patterns.'],
  ])('reports applyTo: %s', (value, message) => {
    expect(
      run(`---\napplyTo: ${value}\n---\n`).map((finding) => [finding.severity, finding.message]),
    ).toEqual([['warn', message]]);
  });

  it('notes an applyTo list as info at the value', () => {
    expect(run('---\napplyTo: ["**/*.ts", "**/*.tsx"]\n---\n')).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          '"applyTo" is a YAML list. GitHub documents "applyTo" only as one string of comma-separated patterns, such as "**/*.ts,**/*.tsx".',
        range: { start: { line: 2, column: 10 }, end: { line: 2, column: 33 } },
      }),
    ]);
  });

  it('notes the legacy coding-agent value as info', () => {
    expect(run('---\napplyTo: "**"\nexcludeAgent: "coding-agent"\n---\n')).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          '"coding-agent" is the "excludeAgent" value from GitHub\'s November 2025 announcement. The current documentation lists only "code-review" and "cloud-agent".',
        range: { start: { line: 3, column: 15 }, end: { line: 3, column: 29 } },
      }),
    ]);
  });

  it('reports an undocumented excludeAgent value', () => {
    expect(
      run('---\napplyTo: "**"\nexcludeAgent: chat\n---\n').map((finding) => finding.message),
    ).toEqual([
      '"excludeAgent" is "chat", not one of the documented values "code-review" and "cloud-agent".',
    ]);
    expect(
      run('---\napplyTo: "**"\nexcludeAgent: [code-review]\n---\n').map((f) => f.message),
    ).toEqual([
      '"excludeAgent" is a list, not one of the documented values "code-review" and "cloud-agent".',
    ]);
  });

  it('reports frontmatter Copilot cannot read', () => {
    const invalid = run('---\napplyTo: "**\n---\n');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.message).toMatch(
      /^The frontmatter is not valid YAML \(.+\), so GitHub Copilot cannot read "applyTo" from it\.$/,
    );
    expect(run('---\napplyTo: "**"\nBody\n').map((finding) => finding.message)).toEqual([
      'The frontmatter has no closing "---" line, so GitHub Copilot cannot read "applyTo" from it. Copilot cloud agent and code review never apply this file, and VS Code uses it only when you attach it to a chat.',
    ]);
    expect(run('+++\napplyTo = "**"\n+++\n').map((finding) => finding.message)).toEqual([
      'The frontmatter is not YAML between "---" lines, so GitHub Copilot cannot read "applyTo" from it.',
    ]);
  });

  it('does not claim Copilot cannot read an unquoted glob', () => {
    expect(run('---\napplyTo: **/*.ts\n---\nBody\n')).toEqual([]);
  });

  it('checks files elsewhere whose frontmatter is meant for Copilot', () => {
    expect(run('---\nexcludeAgent: code-review\n---\n', 'docs/x.instructions.md')).toHaveLength(1);
  });

  it('does not run when Copilot is not targeted', () => {
    expect(findings(lint({ [PATH]: 'x' }, { rules, targets: ['claude-code'] }), RULE)).toEqual([]);
  });
});
