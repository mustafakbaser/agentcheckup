import { describe, expect, it } from 'vitest';
import { agentsMdIgnoredByClaudeRule } from '../../../src/rules/instructions/agents-md-ignored-by-claude.js';
import { findings, lint } from '../../helpers/lint.js';
import { fixedText, fixFiles, repairs, selectRule } from './fix-helpers.js';

const RULE = 'instr/agents-md-ignored-by-claude';
const rules = [agentsMdIgnoredByClaudeRule];
const AGENTS = '# Project\n\nUse pnpm.\n';

describe('instr/agents-md-ignored-by-claude', () => {
  it('reports AGENTS.md next to a CLAUDE.md that does not import it', () => {
    const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '# Claude\n\nUse yarn.\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: 'AGENTS.md',
        message:
          'Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md. Add the line "@AGENTS.md" to that file so Claude Code reads both.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
    expect(result.findings[0]?.related).toEqual([
      {
        path: 'CLAUDE.md',
        message: 'Claude Code reads this file instead of AGENTS.md.',
      },
    ]);
  });

  it('reports a nested AGENTS.md shadowed by a CLAUDE.md in a parent directory', () => {
    const result = lint(
      { 'packages/api/AGENTS.md': AGENTS, 'CLAUDE.md': 'Use yarn.\n' },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'Claude Code reads "CLAUDE.md" from a parent directory and skips this AGENTS.md. To have Claude Code read it, add a CLAUDE.md in this directory with the line "@AGENTS.md".',
    ]);
  });

  it.each([
    ['.claude/CLAUDE.md', 'the line "@../AGENTS.md" to that file'],
    ['CLAUDE.local.md', 'the line "@AGENTS.md" to that file'],
  ])('names %s and the import path relative to it', (claudeFile, expected) => {
    const result = lint({ 'AGENTS.md': AGENTS, [claudeFile]: 'Use yarn.\n' }, { rules });
    expect(findings(result, RULE)[0]?.message).toContain(
      `Claude Code reads "${claudeFile}" in this directory`,
    );
    expect(findings(result, RULE)[0]?.message).toContain(expected);
  });

  it('suggests the .claude/AGENTS.md import path', () => {
    const result = lint({ '.claude/AGENTS.md': AGENTS, 'CLAUDE.md': 'x\n' }, { rules });
    expect(findings(result, RULE)[0]?.message).toContain(
      'the line "@.claude/AGENTS.md" to that file',
    );
  });

  describe('does not report', () => {
    it.each([
      ['an @AGENTS.md import', '@AGENTS.md\n'],
      ['an @./AGENTS.md import', 'Shared rules: @./AGENTS.md\n'],
    ])('a CLAUDE.md with %s', (_label, claude) => {
      expect(findings(lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': claude }, { rules }), RULE)).toEqual(
        [],
      );
    });

    it('a CLAUDE.md that is a symlink to AGENTS.md', () => {
      const result = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS },
        { rules, symlinks: { 'CLAUDE.md': 'AGENTS.md' } },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a CLAUDE.md that is an identical copy of AGENTS.md', () => {
      const result = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS.replaceAll('\n', '\r\n') },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md and CLAUDE.md that are symlinks to the same unread file', () => {
      const result = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS, 'GEMINI.md': AGENTS },
        {
          rules,
          symlinks: { 'AGENTS.md': '.rules', 'CLAUDE.md': '.rules', 'GEMINI.md': '.rules' },
        },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('an AGENTS.md that is a skill reference document', () => {
      const result = lint(
        {
          'CLAUDE.md': 'x\n',
          'agents/skills/react-best-practices/SKILL.md': '---\nname: r\ndescription: d\n---\n',
          'agents/skills/react-best-practices/AGENTS.md': AGENTS,
        },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md in a template or example project', () => {
      const result = lint(
        {
          'CLAUDE.md': 'x\n',
          'packages/create-app/src/template/AGENTS.md': AGENTS,
          'packages/cli/app-template/AGENTS.md': AGENTS,
          'examples/basic/AGENTS.md': AGENTS,
        },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md without any CLAUDE file', () => {
      expect(findings(lint({ 'AGENTS.md': AGENTS }, { rules }), RULE)).toEqual([]);
    });

    it('AGENTS.md when the only CLAUDE file was not read', () => {
      const result = lint({ 'AGENTS.md': AGENTS }, { rules, ignoredFiles: ['CLAUDE.local.md'] });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md with a CLAUDE.md only in a subdirectory', () => {
      const result = lint({ 'AGENTS.md': AGENTS, 'docs/CLAUDE.md': 'x\n' }, { rules });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a nested AGENTS.md imported from the parent CLAUDE.md', () => {
      const result = lint(
        { 'packages/api/AGENTS.md': AGENTS, 'CLAUDE.md': '@packages/api/AGENTS.md\n' },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md imported by a .claude/rules file', () => {
      const result = lint(
        {
          'AGENTS.md': AGENTS,
          'CLAUDE.md': 'x\n',
          '.claude/rules/shared.md': '@../../AGENTS.md\n',
        },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a nested AGENTS.md imported by a rule in its own package', () => {
      const result = lint(
        {
          'packages/api/AGENTS.md': AGENTS,
          'CLAUDE.md': 'x\n',
          'packages/api/.claude/rules/agents.md': '@../../AGENTS.md\n',
        },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md imported through another instruction file', () => {
      const result = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': '@GEMINI.md\n', 'GEMINI.md': '@./AGENTS.md\n' },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('when CLAUDE.md imports an unread file that could import AGENTS.md', () => {
      const result = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': '@docs/all.md\n' },
        { rules, paths: ['docs/all.md'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('AGENTS.md in configuration folders or with a case variant name', () => {
      const result = lint(
        {
          '.agents/AGENTS.md': AGENTS,
          '.codex/AGENTS.md': AGENTS,
          'pkg/.github/AGENTS.md': AGENTS,
          'docs/Agents.md': AGENTS,
          'CLAUDE.md': 'x\n',
        },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('still reports when only a rule outside the path or a case-variant rule folder imports it', () => {
    const result = lint(
      {
        'AGENTS.md': AGENTS,
        'CLAUDE.md': 'x\n',
        'other/.claude/rules/a.md': '@../../../AGENTS.md\n',
        '.Claude/Rules/b.md': '@../../AGENTS.md\n',
      },
      { rules },
    );
    expect(findings(result, RULE)).toHaveLength(1);
  });

  it('still reports a CLAUDE.md that only differs a little from AGENTS.md', () => {
    const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': `${AGENTS}Use yarn.\n` }, { rules });
    expect(findings(result, RULE)).toHaveLength(1);
  });

  it.each([
    ['in an HTML comment', '<!-- @AGENTS.md -->\nUse yarn.\n'],
    ['in a code span', 'Do not write `@AGENTS.md` here.\n'],
    ['as an unread JSON file', '@package.json\n'],
  ])('still reports when the import is %s', (_label, claude) => {
    const result = lint(
      { 'AGENTS.md': AGENTS, 'CLAUDE.md': claude },
      { rules, paths: ['package.json'] },
    );
    expect(findings(result, RULE)).toHaveLength(1);
  });

  it('does not run when Claude Code is not targeted', () => {
    const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': 'x\n' }, { rules, targets: ['codex'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});

describe('instr/agents-md-ignored-by-claude fix', () => {
  const CLAUDE = '# Claude\n\nUse yarn.\n';

  it('adds the import as line 1 of the CLAUDE.md next to AGENTS.md, as a safe fix', () => {
    const result = lint(
      { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE },
      { rules, targets: ['claude-code'] },
    );
    expect(repairs(result, RULE)).toEqual([
      {
        path: 'AGENTS.md',
        fix: {
          id: `${RULE}#import`,
          class: 'safe',
          title: 'Add "@AGENTS.md" as line 1 of CLAUDE.md',
          changes: [
            {
              kind: 'edit',
              path: 'CLAUDE.md',
              edits: [{ offset: 0, length: 0, text: '@AGENTS.md\n\n' }],
            },
          ],
          notes: [],
        },
      },
    ]);
  });

  it('notes that GitHub Copilot CLI may read AGENTS.md twice when Copilot is targeted', () => {
    const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE }, { rules });
    expect(repairs(result, RULE)[0]?.fix?.notes).toEqual([
      'GitHub Copilot CLI also reads CLAUDE.md, so it may load AGENTS.md twice after this change (not verified).',
    ]);
  });

  it('imports "@../AGENTS.md" into .claude/CLAUDE.md, resolved from the importing file', () => {
    const run = fixFiles(
      { 'AGENTS.md': AGENTS, '.claude/CLAUDE.md': CLAUDE },
      { rules },
      selectRule(RULE, ['safe']),
    );
    expect(fixedText(run, '.claude/CLAUDE.md')).toBe(`@../AGENTS.md\n\n${CLAUDE}`);
    expect(run.verification).toMatchObject({ resolved: 1, introduced: [] });
  });

  it('creates a CLAUDE.md for an AGENTS.md shadowed from a parent directory, for review', () => {
    const files = { 'CLAUDE.md': CLAUDE, 'packages/api/AGENTS.md': AGENTS };
    expect(repairs(lint(files, { rules, targets: ['claude-code'] }), RULE)).toEqual([
      {
        path: 'packages/api/AGENTS.md',
        fix: {
          id: `${RULE}#create`,
          class: 'review',
          title: 'Create packages/api/CLAUDE.md with the line "@AGENTS.md"',
          changes: [{ kind: 'create', path: 'packages/api/CLAUDE.md', text: '@AGENTS.md\n' }],
          notes: [
            'Claude Code loads the new file, and AGENTS.md through it, when it works with files in packages/api.',
          ],
        },
      },
    ]);
    expect(fixFiles(files, { rules }, selectRule(RULE, ['safe'])).applied).toEqual([]);
  });

  it('creates a committed CLAUDE.md instead of editing CLAUDE.local.md', () => {
    const run = fixFiles(
      { 'AGENTS.md': AGENTS, 'CLAUDE.local.md': 'My sandbox.\n' },
      { rules },
      selectRule(RULE),
    );
    expect(run.files.map((file) => [file.op, file.path])).toEqual([['create', 'CLAUDE.md']]);
    expect(fixedText(run, 'CLAUDE.local.md')).toBe('My sandbox.\n');
    expect(run.applied[0]?.fix.notes?.[0]).toBe(
      'CLAUDE.local.md stays as it is. Commit the new file, so that Claude Code reads AGENTS.md through the import for everyone.',
    );
  });

  it('warns that a nested CLAUDE.md hides parent AGENTS.md files when only CLAUDE.local.md is above', () => {
    const result = lint(
      { 'CLAUDE.local.md': 'Mine.\n', 'pkg/AGENTS.md': AGENTS },
      { rules, targets: ['claude-code'] },
    );
    expect(repairs(result, RULE)[0]?.fix?.notes).toEqual([
      'CLAUDE.local.md stays as it is. Commit the new file, so that Claude Code reads AGENTS.md through the import for everyone.',
      'In sessions started in pkg, an AGENTS.md in a parent directory then loads only if a CLAUDE.md imports it.',
    ]);
  });

  describe('leaves to the user', () => {
    it('a suppressed finding', () => {
      const run = fixFiles(
        {
          'AGENTS.md': `<!-- agentcheckup-disable-file ${RULE} -- separate on purpose -->\n${AGENTS}`,
          'CLAUDE.md': CLAUDE,
        },
        { rules },
        selectRule(RULE),
      );
      expect(run.before.findings.find((finding) => finding.ruleId === RULE)?.suppressed).toEqual({
        kind: 'inline',
        reason: 'separate on purpose',
      });
      expect(run.applied).toEqual([]);
      expect(run.files).toEqual([]);
    });

    it('a CLAUDE.md that is a symlink, or that another path links to', () => {
      const linked = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE },
        { rules, symlinks: { 'CLAUDE.md': 'shared/rules.md' } },
      );
      expect(repairs(linked, RULE)).toEqual([
        {
          path: 'AGENTS.md',
          guidance:
            'add the line "@AGENTS.md" at the top of "CLAUDE.md" by hand: "CLAUDE.md" is a symbolic link to "shared/rules.md"',
        },
      ]);
      const aliased = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE, 'GEMINI.md': CLAUDE },
        { rules, symlinks: { 'GEMINI.md': 'CLAUDE.md' } },
      );
      expect(repairs(aliased, RULE)).toEqual([
        {
          path: 'AGENTS.md',
          guidance:
            'add the line "@AGENTS.md" at the top of "CLAUDE.md" by hand: "GEMINI.md" is a symbolic link to this file',
        },
      ]);
      const viaAlias = lint(
        { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE, 'docs/CLAUDE.md': CLAUDE },
        { rules, symlinks: { 'CLAUDE.md': 'docs/CLAUDE.md' } },
      );
      expect(repairs(viaAlias, RULE)[0]).toEqual({
        path: 'AGENTS.md',
        guidance:
          'add the line "@AGENTS.md" at the top of "CLAUDE.md" by hand: "CLAUDE.md" is a symbolic link to "docs/CLAUDE.md"',
      });
    });

    it('a CLAUDE.md that is a symlink checked out as text: instr/symlink-materialized fixes it', () => {
      const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': 'AGENTS.md' }, { rules });
      expect(repairs(result, RULE)).toEqual([
        {
          path: 'AGENTS.md',
          guidance:
            'replace the path in "CLAUDE.md" with the line "@AGENTS.md" (see instr/symlink-materialized)',
        },
      ]);
    });

    it('a CLAUDE.md whose frontmatter is not closed', () => {
      const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '---\nowner: me\n' }, { rules });
      expect(repairs(result, RULE)).toEqual([
        { path: 'AGENTS.md', guidance: 'add the line "@AGENTS.md" at the top of "CLAUDE.md"' },
      ]);
    });

    it('a new CLAUDE.md whose name another file takes in a different letter case', () => {
      const result = lint(
        { 'CLAUDE.md': CLAUDE, 'pkg/AGENTS.md': AGENTS },
        { rules, paths: ['pkg/claude.md'] },
      );
      expect(repairs(result, RULE)).toEqual([
        { path: 'pkg/AGENTS.md', guidance: 'add the line "@AGENTS.md" to "pkg/CLAUDE.md"' },
      ]);
    });
  });
});
