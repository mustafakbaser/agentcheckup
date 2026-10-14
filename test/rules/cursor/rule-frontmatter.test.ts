import { describe, expect, it } from 'vitest';
import { ruleFrontmatterRule } from '../../../src/rules/cursor/rule-frontmatter.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'cursor/rule-frontmatter';
const rules = [ruleFrontmatterRule];
const PATH = '.cursor/rules/style.mdc';

function run(text: string) {
  return findings(lint({ [PATH]: text }, { rules }), RULE);
}

describe('cursor/rule-frontmatter', () => {
  describe('does not report', () => {
    it.each([
      ['an always-applied rule', '---\nalwaysApply: true\n---\nBody\n'],
      ['a glob rule', '---\nglobs: src/**/*.ts, test/**/*.ts\nalwaysApply: false\n---\n'],
      ['an agent-requested rule', '---\ndescription: RPC conventions\nalwaysApply: false\n---\n'],
      ['the empty fields Cursor writes', '---\ndescription:\nglobs:\nalwaysApply: false\n---\n'],
      ['a rule without frontmatter', 'Use named exports.\n'],
      ['CRLF line endings', '---\r\nglobs: "*.ts"\r\nalwaysApply: false\r\n---\r\nBody\r\n'],
    ])('%s', (_label, text) => {
      expect(run(text)).toEqual([]);
    });
  });

  it('warns about a foreign activation field and suggests the Cursor field', () => {
    expect(run('---\napplyTo: "**/*.ts"\nalwaysApply: false\n---\n')).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: PATH,
        message:
          'Cursor ignores "applyTo", so it does not change when this rule applies. Use "globs" instead.',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 8 } },
      },
    ]);
  });

  it('notes other unknown fields as info', () => {
    expect(
      run('---\nname: style\ntags: [ts]\nalwaysApply: true\n---\n').map((finding) => [
        finding.severity,
        finding.message,
      ]),
    ).toEqual([
      [
        'info',
        'Cursor ignores "name"; rule frontmatter supports only "description", "globs" and "alwaysApply".',
      ],
      [
        'info',
        'Cursor ignores "tags"; rule frontmatter supports only "description", "globs" and "alwaysApply".',
      ],
    ]);
  });

  it.each([
    [
      '"true"',
      '"alwaysApply" is a string ("true"), not the boolean true or false that Cursor expects.',
    ],
    [
      'yes',
      '"alwaysApply" is a string ("yes"), not the boolean true or false that Cursor expects.',
    ],
    ['1', '"alwaysApply" is a number, not the boolean true or false that Cursor expects.'],
  ])('reports alwaysApply: %s at the value', (value, message) => {
    expect(run(`---\nalwaysApply: ${value}\n---\n`)).toEqual([
      expect.objectContaining({
        message,
        range: { start: { line: 2, column: 14 }, end: { line: 2, column: 14 + value.length } },
      }),
    ]);
  });

  it('notes a globs list as info and reports other globs types', () => {
    expect(run('---\nglobs:\n  - "src/**/*.ts"\n---\n')).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          '"globs" is a YAML list. Cursor documents "globs" only as one comma-separated string, such as "src/**/*.ts, test/**/*.ts".',
      }),
    ]);
    expect(
      run('---\nglobs: [1, 2]\n---\n').map((finding) => [finding.severity, finding.message]),
    ).toEqual([['warn', '"globs" is a list, not a comma-separated string of glob patterns.']]);
    expect(run('---\nglobs: true\n---\n').map((finding) => finding.message)).toEqual([
      '"globs" is the boolean true, not a comma-separated string of glob patterns.',
    ]);
  });

  it('reports a description that is not text', () => {
    expect(run('---\ndescription: [a, b]\n---\n').map((finding) => finding.message)).toEqual([
      '"description" is a list, not text.',
    ]);
  });

  it.each([
    [
      'unquoted globs that Cursor writes',
      '---\ndescription: Bash\nglobs: *.sh, *.yml\nalwaysApply: false\n---\n',
    ],
    ['an unquoted recursive glob', '---\nglobs: **/*.css\n---\n'],
    ['a colon in a description', '---\ndescription: Use when: editing\n---\n'],
    ['unclosed frontmatter', '---\nalwaysApply: true\nBody\n'],
    ['TOML frontmatter', '+++\nalwaysApply = true\n+++\n'],
  ])('does not report frontmatter Cursor may read differently: %s', (_label, text) => {
    expect(run(text)).toEqual([]);
  });

  it('reports at most 100 unknown fields', () => {
    const keys = Array.from({ length: 150 }, (_, i) => `k${String(i)}: 1`).join('\n');
    expect(run(`---\n${keys}\n---\n`)).toHaveLength(100);
  });

  it('does not run when Cursor is not targeted', () => {
    const result = lint({ [PATH]: '---\nname: x\n---\n' }, { rules, targets: ['codex'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});
