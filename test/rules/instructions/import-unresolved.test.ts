import { describe, expect, it } from 'vitest';
import { importUnresolvedRule } from '../../../src/rules/instructions/import-unresolved.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/import-unresolved';
const rules = [importUnresolvedRule];

describe('instr/import-unresolved', () => {
  it('reports a missing import in CLAUDE.md at the import token', () => {
    const result = lint(
      { 'CLAUDE.md': '# Claude Code\n\nSee @docs/missing-guide.md for the architecture.\n' },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: 'CLAUDE.md',
        message:
          'Imported file "docs/missing-guide.md" does not exist, so Claude Code cannot load it.',
        range: { start: { line: 3, column: 5 }, end: { line: 3, column: 27 } },
      },
    ]);
    expect(result.findings[0]?.platforms).toEqual(['claude-code']);
  });

  it('resolves imports relative to the importing file', () => {
    const result = lint(
      { 'packages/api/CLAUDE.md': '# API\n\n@../../docs/api.md\n@api-details.md\n' },
      { rules, paths: ['docs/api.md'] },
    );
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'Imported file "api-details.md" does not exist, so Claude Code cannot load it.',
    ]);
  });

  it('reports imports reached only through a project rule as information', () => {
    const result = lint(
      { '.claude/rules/api.md': '# API\n\n@../../docs/api.md\n@api-details.md\n' },
      { rules, paths: ['docs/api.md'] },
    );
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'info',
        'Imported file "api-details.md" does not exist. If Claude Code expands imports in project rules, which its documentation does not say, it cannot load it.',
      ],
    ]);
  });

  it('keeps the error when CLAUDE.md also reaches the file a rule imports', () => {
    const result = lint(
      {
        'CLAUDE.md': '@AGENTS.md\n',
        '.claude/rules/a.md': '@../../AGENTS.md\n',
        'AGENTS.md': 'See @docs/missing.md\n',
      },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => [finding.path, finding.severity])).toEqual([
      ['AGENTS.md', 'error'],
    ]);
  });

  it('reports a missing ./ import without an extension', () => {
    const result = lint({ 'CLAUDE.md': 'Read @./notes first.\n' }, { rules });
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'Imported file "./notes" does not exist, so Claude Code cannot load it.',
    ]);
  });

  it('reports a missing import in GEMINI.md with the Gemini CLI consequence', () => {
    const result = lint(
      { 'GEMINI.md': '@./missing.md\nAsk @octocat for reviews.\n<!-- @old/notes.md -->\n' },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => [finding.range.start, finding.message])).toEqual(
      [
        [
          { line: 1, column: 1 },
          'Imported file "./missing.md" does not exist. Gemini CLI replaces the reference with an "Import failed" comment.',
        ],
        // Gemini CLI does not skip HTML comments; "@octocat" is not clearly a file.
        [
          { line: 3, column: 6 },
          'Imported file "old/notes.md" does not exist. Gemini CLI replaces the reference with an "Import failed" comment.',
        ],
      ],
    );
    expect(result.findings[0]?.platforms).toEqual(['gemini']);
  });

  it('does not report an extensionless name that Claude Code might resolve differently', () => {
    const result = lint({ 'CLAUDE.md': 'See @README for an overview.\n' }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('checks AGENTS.md when Claude Code reads it directly', () => {
    const files = { 'AGENTS.md': 'Use pnpm. Details: @docs/setup.md\n' };
    expect(findings(lint(files, { rules }), RULE)).toHaveLength(1);
    // With a CLAUDE.md on the path Claude Code does not read AGENTS.md, and nothing imports it.
    expect(findings(lint({ ...files, 'CLAUDE.md': 'Use yarn.\n' }, { rules }), RULE)).toEqual([]);
    // Imported from CLAUDE.md, AGENTS.md is read again, and so are its imports.
    const bridged = lint({ ...files, 'CLAUDE.md': '@AGENTS.md\n' }, { rules });
    expect(findings(bridged, RULE).map((finding) => finding.path)).toEqual(['AGENTS.md']);
  });

  it('checks AGENTS.md when CLAUDE.md is a symlink to it', () => {
    const text = 'Use pnpm. Details: @docs/setup.md and @docs/style.md\n';
    const linked = { symlinks: { 'CLAUDE.md': 'AGENTS.md' }, paths: ['docs/style.md'] };
    const result = lint({ 'AGENTS.md': text, 'CLAUDE.md': text }, { rules, ...linked });
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        severity: 'error',
        path: 'AGENTS.md',
        message: 'Imported file "docs/setup.md" does not exist, so Claude Code cannot load it.',
      }),
    ]);
    // Nothing to report once the file exists.
    const fixed = lint(
      { 'AGENTS.md': text, 'CLAUDE.md': text },
      { rules, ...linked, paths: ['docs/setup.md', 'docs/style.md'] },
    );
    expect(findings(fixed, RULE)).toEqual([]);
  });

  it('reports imports read through a symlink in another directory as information', () => {
    // Claude Code reads .claude/CLAUDE.md, a link to AGENTS.md. agentcheckup resolves its
    // imports from .claude/, which Claude Code's documentation does not confirm.
    const text = 'Details: @docs/setup.md\n';
    const result = lint(
      { 'AGENTS.md': text, '.claude/CLAUDE.md': text },
      { rules, symlinks: { '.claude/CLAUDE.md': 'AGENTS.md' }, paths: ['docs/setup.md'] },
    );
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        severity: 'info',
        path: 'AGENTS.md',
        message:
          'Imported file "docs/setup.md" does not exist. Claude Code reads this through a symlink in another directory than the file it points to; if it resolves imports from the link\'s directory, which its documentation does not say, it cannot load it.',
      }),
    ]);
    // Present next to the link: nothing to report.
    const present = lint(
      { 'AGENTS.md': text, '.claude/CLAUDE.md': text },
      { rules, symlinks: { '.claude/CLAUDE.md': 'AGENTS.md' }, paths: ['.claude/docs/setup.md'] },
    );
    expect(findings(present, RULE)).toEqual([]);
  });

  it('checks a file that GEMINI.md links to, from the link', () => {
    const text = 'See @./missing.md\n';
    const result = lint(
      { 'AGENTS.md': text, 'GEMINI.md': text, 'CLAUDE.md': 'Root.\n' },
      { rules, symlinks: { 'GEMINI.md': 'AGENTS.md' } },
    );
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({ severity: 'error', path: 'AGENTS.md' }),
    ]);
    expect(result.findings[0]?.platforms).toEqual(['gemini']);
  });

  it('merges the same token reported for both agents', () => {
    const result = lint(
      { 'GEMINI.md': '@./AGENTS.md\n', 'AGENTS.md': 'See @docs/missing.md\n' },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'Imported file "docs/missing.md" does not exist. Claude Code cannot load it, and Gemini CLI replaces the reference with an "Import failed" comment.',
    ]);
    expect(result.findings[0]?.platforms).toEqual(['claude-code', 'gemini']);
  });

  describe('trailing punctuation', () => {
    it('does not report a Claude import whose path exists without the trailing period', () => {
      const result = lint(
        { 'CLAUDE.md': 'See @docs/guide.md.\n' },
        { rules, paths: ['docs/guide.md'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('shows a missing Claude import without its trailing punctuation', () => {
      const result = lint({ 'CLAUDE.md': 'See @docs/missing.md.\n' }, { rules });
      expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
        'Imported file "docs/missing.md" does not exist, so Claude Code cannot load it.',
      ]);
    });

    it('shows a missing Gemini import as written, trailing punctuation included', () => {
      const result = lint({ 'GEMINI.md': 'See @./missing.md.\n' }, { rules });
      expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
        'Imported file "./missing.md." does not exist. Gemini CLI replaces the reference with an "Import failed" comment.',
      ]);
    });

    it('reports a Gemini import that only fails because of the trailing period', () => {
      const result = lint({ 'GEMINI.md': 'See @./guide.md.\n' }, { rules, paths: ['guide.md'] });
      expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
        'Gemini CLI reads this import as "./guide.md.", including the trailing ".". No such file exists, so Gemini CLI replaces the reference with an "Import failed" comment.',
      ]);
    });
  });

  describe('does not report', () => {
    it.each([
      ['an existing file', 'See @docs/guide.md for details.'],
      ['a package mention', 'We use @tanstack/react-query and @types/node.'],
      ['a user mention', 'Ask @octocat.'],
      ['an import in a code span', 'Type `@docs/missing.md` to import.'],
      ['an import in a code block', '```\n@docs/missing.md\n```'],
      ['an import in an HTML comment', '<!-- @docs/old.md -->\nUse pnpm.'],
      ['an e-mail address', 'Contact team@example.com.'],
      ['a path outside the scan root', 'See @../shared/rules.md.'],
      ['an absolute path', 'See @/etc/agent/rules.md.'],
      ['a home path', 'See @~/.claude/notes.md.'],
    ])('%s', (_label, text) => {
      const result = lint({ 'CLAUDE.md': `${text}\n` }, { rules, paths: ['docs/guide.md'] });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a target inside a directory agentcheckup did not list', () => {
      const result = lint(
        { 'CLAUDE.md': '@node_modules/pkg/README.md\n' },
        { rules, opaqueDirectories: ['node_modules/'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a gitignored file that exists', () => {
      const result = lint(
        { 'CLAUDE.md': '@notes/local.md\n' },
        { rules, ignoredFiles: ['notes/local.md'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('imports of a file deeper than Claude Code follows', () => {
      const result = lint(
        {
          'CLAUDE.md': '@AGENTS.md\n',
          'AGENTS.md': '@GEMINI.md\n',
          'GEMINI.md': '@./.cursorrules\n',
          '.cursorrules': '@./.windsurfrules\n',
          '.windsurfrules': '@docs/missing.md\n',
        },
        { rules, targets: ['claude-code'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('does not treat a case variant such as docs/claude.md as a CLAUDE.md', () => {
    const result = lint({ 'docs/claude.md': 'See @docs/missing.md\n' }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('reports at most 100 missing imports per file', () => {
    const text = Array.from({ length: 150 }, (_, i) => `@docs/m${String(i)}.md`).join('\n');
    expect(findings(lint({ 'CLAUDE.md': text }, { rules }), RULE)).toHaveLength(100);
  });

  it('does not check imports in template files, which resolve in the generated project', () => {
    const result = lint({ 'templates/app/CLAUDE.md': '@docs/architecture.md\n' }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('handles non-ASCII paths and CRLF', () => {
    const result = lint({ 'CLAUDE.md': 'Kılavuz:\r\n@docs/kılavuz.md\r\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        message: 'Imported file "docs/kılavuz.md" does not exist, so Claude Code cannot load it.',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 17 } },
      }),
    ]);
  });

  it('checks only targeted agents', () => {
    const files = { 'CLAUDE.md': '@docs/a.md\n', 'GEMINI.md': '@./b.md\n' };
    expect(findings(lint(files, { rules, targets: ['gemini'] }), RULE).map((f) => f.path)).toEqual([
      'GEMINI.md',
    ]);
    expect(findings(lint(files, { rules, targets: ['codex'] }), RULE)).toEqual([]);
  });
});
