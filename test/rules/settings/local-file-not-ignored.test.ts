import { describe, expect, it } from 'vitest';
import { localFileNotIgnoredRule } from '../../../src/rules/settings/local-file-not-ignored.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'settings/local-file-not-ignored';
const rules = [localFileNotIgnoredRule];
const BASE =
  'CLAUDE.local.md is not covered by any .gitignore in this repository. Once it is committed, Claude Code loads these personal instructions for everyone in the project; add it to .gitignore.';

describe('settings/local-file-not-ignored', () => {
  it('reports a CLAUDE.local.md the scan could read', () => {
    expect(
      findings(lint({ 'CLAUDE.local.md': '# Mine\nUse my sandbox.\n' }, { rules }), ID),
    ).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: 'CLAUDE.local.md',
        message: BASE,
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it('adds the AGENTS.md consequence when no CLAUDE.md shadows it already', () => {
    const result = findings(
      lint({ 'pkg/CLAUDE.local.md': 'x', 'pkg/AGENTS.md': 'y', 'AGENTS.md': 'z' }, { rules }),
      ID,
    );
    expect(result.map((finding) => finding.message)).toEqual([
      'CLAUDE.local.md is not covered by any .gitignore in this repository. Once it is committed, Claude Code loads these personal instructions for everyone in the project and stops reading the AGENTS.md next to it; add it to .gitignore.',
    ]);
    for (const shadow of [
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      'pkg/CLAUDE.md',
      'pkg/.claude/CLAUDE.md',
    ]) {
      const files = { 'pkg/CLAUDE.local.md': 'x', 'pkg/AGENTS.md': 'y', [shadow]: 'c' };
      expect(findings(lint(files, { rules }), ID).map((finding) => finding.message)).toEqual([
        BASE,
      ]);
    }
    // A CLAUDE.md in a sibling directory does not shadow this one.
    const sibling = { 'pkg/CLAUDE.local.md': 'x', 'pkg/AGENTS.md': 'y', 'other/CLAUDE.md': 'c' };
    expect(findings(lint(sibling, { rules }), ID)[0]?.message).toContain('AGENTS.md next to it');
  });

  it('does not report a gitignored CLAUDE.local.md, which the walker never reads', () => {
    const result = lint(
      { 'AGENTS.md': '# Shared\n' },
      { rules, ignoredFiles: ['CLAUDE.local.md'] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('does not report CLAUDE.md, .claude/settings.local.json or other files', () => {
    const files = {
      'CLAUDE.md': '# Team\n',
      '.claude/settings.local.json': '{}',
      'docs/CLAUDE.local.md.txt': 'x',
    };
    expect(findings(lint(files, { rules }), ID)).toEqual([]);
  });

  it('runs only when Claude Code is targeted', () => {
    expect(findings(lint({ 'CLAUDE.local.md': 'x' }, { rules, targets: ['codex'] }), ID)).toEqual(
      [],
    );
  });
});

describe('settings/local-file-not-ignored without gitignore', () => {
  it('reports nothing when the walk did not apply .gitignore files', () => {
    const result = lint(
      { 'CLAUDE.local.md': '# local notes\n' },
      { rules: [localFileNotIgnoredRule], gitignoreApplied: false },
    );
    expect(findings(result, 'settings/local-file-not-ignored')).toEqual([]);
  });
});
