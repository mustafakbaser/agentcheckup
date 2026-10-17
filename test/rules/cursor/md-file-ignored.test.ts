import { describe, expect, it } from 'vitest';
import { mdFileIgnoredRule } from '../../../src/rules/cursor/md-file-ignored.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'cursor/md-file-ignored';
const rules = [mdFileIgnoredRule];

describe('cursor/md-file-ignored', () => {
  it('reports a .md file in .cursor/rules', () => {
    const result = lint({ '.cursor/rules/style.md': 'Prefer named exports.\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: '.cursor/rules/style.md',
        message:
          'Cursor loads only .mdc files from .cursor/rules, so it ignores "style.md". Rename it to "style.mdc" and add frontmatter with description, globs or alwaysApply.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it('reports nested and non-ASCII file names', () => {
    const result = lint({ '.cursor/rules/frontend/bileşen.md': 'x' }, { rules });
    expect(findings(result, RULE)[0]?.message).toContain('Rename it to "bileşen.mdc"');
  });

  it('does not report .mdc rules or a README', () => {
    const result = lint(
      {
        '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nx',
        '.cursor/rules/README.md': '# Our rules',
        '.cursor/rules/team/readme.md': '# Team rules',
      },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not run when Cursor is not targeted', () => {
    const result = lint({ '.cursor/rules/style.md': 'x' }, { rules, targets: ['windsurf'] });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('offers asking for globs instead of "alwaysApply: true", and only then', () => {
    const result = lint(
      {
        '.cursor/rules/style.md': 'Prefer named exports.\n',
        '.cursor/rules/db.md': '---\ndescription: Database rules\n---\nx\n',
      },
      { rules },
    );
    const fixes = new Map(result.findings.map((finding) => [finding.path, finding.fix]));
    expect(fixes.get('.cursor/rules/style.md')?.alternatives).toEqual([
      {
        id: 'cursor/md-file-ignored#ask-globs',
        class: 'review',
        title: 'Rename .cursor/rules/style.md to style.mdc and add "globs"',
        changes: [],
        notes: ['Devin Local in Windsurf reads the file under either name.'],
        input: {
          field: 'cursor-globs',
          question: 'Attach this rule to the files that match glob patterns, such as src/**/*.ts?',
          label: '"globs" patterns',
          target: { kind: 'frontmatter', path: '.cursor/rules/style.md', key: 'globs' },
        },
      },
    ]);
    // The file already says when to apply it: the rename alone fixes it.
    expect(fixes.get('.cursor/rules/db.md')?.id).toBe('cursor/md-file-ignored#rename');
    expect(fixes.get('.cursor/rules/db.md')?.alternatives).toBeUndefined();
  });
});
