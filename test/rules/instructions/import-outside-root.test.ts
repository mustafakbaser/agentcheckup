import { describe, expect, it } from 'vitest';
import { importOutsideRootRule } from '../../../src/rules/instructions/import-outside-root.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/import-outside-root';
const rules = [importOutsideRootRule];
const GIT = ['.git/HEAD'];

describe('instr/import-outside-root', () => {
  it('notes a home-directory import in CLAUDE.md as info', () => {
    const result = lint({ 'CLAUDE.md': '- @~/.claude/my-project-instructions.md\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: 'CLAUDE.md',
        message:
          'Import "@~/.claude/my-project-instructions.md" loads a file from each user\'s home directory, so teammates and CI runners without that file get nothing from it. Claude Code also asks for approval before it loads files outside the working directory.',
        range: { start: { line: 1, column: 3 }, end: { line: 1, column: 40 } },
      },
    ]);
  });

  it('warns about an absolute file-system path in CLAUDE.md', () => {
    const result = lint({ 'CLAUDE.md': 'Notes: @/Users/alice/notes.md\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        severity: 'warn',
        message:
          'Import "@/Users/alice/notes.md" uses an absolute path, which exists only on machines with the same directory layout. Claude Code also asks for approval before it loads files outside the working directory.',
        range: { start: { line: 1, column: 8 }, end: { line: 1, column: 30 } },
      }),
    ]);
  });

  it('does not report a TypeScript path alias mentioned in CLAUDE.md', () => {
    const result = lint({ 'CLAUDE.md': 'Import UI from @/components/ui/button.tsx.\n' }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('warns about a relative import that leaves the repository', () => {
    const files = { 'CLAUDE.md': 'Shared: @../shared/rules.md\n' };
    expect(findings(lint(files, { rules, paths: GIT }), RULE)).toEqual([
      expect.objectContaining({
        severity: 'warn',
        message:
          'Import "@../shared/rules.md" resolves outside the repository, so other clones and CI runners do not have that file. Claude Code also asks for approval before it loads files outside the working directory.',
      }),
    ]);
    // Without .git the scanned directory may be a subdirectory of the repository.
    expect(findings(lint(files, { rules }), RULE)).toEqual([]);
  });

  it('does not report CLAUDE.local.md, which is personal', () => {
    const result = lint(
      { 'CLAUDE.local.md': '@~/.claude/me.md\n@/Users/me/notes.md\n@../x.md\n' },
      { rules, paths: GIT },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not report imports inside the repository or in HTML comments', () => {
    const result = lint(
      { 'CLAUDE.md': '@docs/guide.md\n<!-- @/Users/alice/old.md -->\n' },
      { rules, paths: [...GIT, 'docs/guide.md'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  describe('Gemini CLI', () => {
    it('warns about any absolute import', () => {
      const result = lint({ 'GEMINI.md': '@/components/ui.md\n' }, { rules });
      expect(findings(result, RULE)).toEqual([
        expect.objectContaining({
          message:
            'Import "@/components/ui.md" uses an absolute path, which does not exist on other machines. Gemini CLI also rejects imports outside the project root and inserts an "Import failed" comment instead.',
        }),
      ]);
      expect(result.findings[0]?.platforms).toEqual(['gemini']);
    });

    it('warns about a relative import outside the project root', () => {
      const result = lint({ 'GEMINI.md': '@../shared.md\n' }, { rules, paths: GIT });
      expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
        [
          'error',
          'Import "@../shared.md" resolves outside the project root, so Gemini CLI does not load it and inserts an "Import failed ... Path traversal attempt" comment instead.',
        ],
      ]);
    });

    it('uses the nearest .git as the project root', () => {
      const result = lint(
        { 'vendor/lib/GEMINI.md': '@../../docs/shared.md\n@./local.md\n' },
        { rules, paths: ['vendor/lib/.git', 'docs/shared.md', 'vendor/lib/local.md'] },
      );
      expect(findings(result, RULE).map((finding) => finding.range.start.line)).toEqual([1]);
    });

    it('does not guess the project root without .git', () => {
      const result = lint({ 'GEMINI.md': '@../shared.md\n' }, { rules });
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('reports at most 100 imports per file', () => {
    const text = Array.from({ length: 150 }, (_, i) => `@/Users/a/n${String(i)}.md`).join('\n');
    expect(findings(lint({ 'CLAUDE.md': text }, { rules }), RULE)).toHaveLength(100);
  });

  it('reports an import reached only through a project rule as information', () => {
    const result = lint({ '.claude/rules/a.md': '@/Users/alice/notes.md\n' }, { rules });
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'info',
        'Import "@/Users/alice/notes.md" uses an absolute path, which exists only on machines with the same directory layout. Claude Code also asks for approval before it loads files outside the working directory. Claude Code\'s documentation does not say it expands imports in project rules.',
      ],
    ]);
  });

  it('checks a file that CLAUDE.md links to, from the link', () => {
    const text = '@/Users/alice/notes.md\n@../outside.md\n@../../up.md\n';
    const scan = (link: string) =>
      findings(
        lint(
          { 'AGENTS.md': text, [link]: text },
          { rules, paths: GIT, symlinks: { [link]: 'AGENTS.md' } },
        ),
        RULE,
      ).map((finding) => [finding.severity, finding.message]);
    const absolute =
      'Import "@/Users/alice/notes.md" uses an absolute path, which exists only on machines with the same directory layout. Claude Code also asks for approval before it loads files outside the working directory.';
    const relative = (path: string) =>
      `Import "@${path}" resolves outside the repository, so other clones and CI runners do not have that file. Claude Code also asks for approval before it loads files outside the working directory.`;
    expect(scan('CLAUDE.md')).toEqual([
      ['warn', absolute],
      ['warn', relative('../outside.md')],
      ['warn', relative('../../up.md')],
    ]);
    // From .claude/, `../outside.md` stays inside the repository. A relative import that still
    // leaves it depends on where the link sits: information. The absolute path does not.
    expect(scan('.claude/CLAUDE.md')).toEqual([
      ['warn', absolute],
      [
        'info',
        `${relative('../../up.md')} Claude Code reads this through a symlink in another directory than the file it points to, and its documentation does not say whether imports then resolve from the link's directory, as agentcheckup assumes, or from the target's.`,
      ],
    ]);
  });

  it('does not run when neither agent is targeted', () => {
    const result = lint({ 'CLAUDE.md': '@/Users/a/b.md\n' }, { rules, targets: ['cursor'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});
