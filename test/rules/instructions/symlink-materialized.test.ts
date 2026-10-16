import { describe, expect, it } from 'vitest';
import { symlinkMaterializedRule } from '../../../src/rules/instructions/symlink-materialized.js';
import { findings, lint } from '../../helpers/lint.js';
import { fixedText, fixFiles, repairs, selectRule } from './fix-helpers.js';

const RULE = 'instr/symlink-materialized';
const rules = [symlinkMaterializedRule];
const AGENTS = '# Project\n\nUse pnpm.\n';

describe('instr/symlink-materialized', () => {
  it('reports CLAUDE.md that contains only the path of AGENTS.md', () => {
    const result = lint({ 'CLAUDE.md': 'AGENTS.md', 'AGENTS.md': AGENTS }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: 'CLAUDE.md',
        message:
          'This file contains only the path "AGENTS.md". Git checks out a committed symlink as a one-line text file when core.symlinks is off, so agents read this line instead of the instructions in "AGENTS.md".',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
      },
    ]);
    expect(result.findings[0]?.related).toEqual([
      {
        path: 'AGENTS.md',
        message: 'The file this one links to.',
      },
    ]);
  });

  it.each([
    ['packages/api/CLAUDE.md', '../../AGENTS.md', 'AGENTS.md'],
    ['.github/copilot-instructions.md', '../AGENTS.md', 'AGENTS.md'],
    ['GEMINI.md', './docs/agents.md', 'docs/agents.md'],
    ['.cursorrules', 'AGENTS.md\r\n', 'AGENTS.md'],
    ['.claude/rules/shared.md', '../../docs/rules/shared.md', 'docs/rules/shared.md'],
  ])('reports %s pointing at %j', (path, text, target) => {
    const result = lint(
      { [path]: text, 'AGENTS.md': AGENTS, 'docs/agents.md': AGENTS },
      { rules, paths: ['docs/rules/shared.md'] },
    );
    expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
      [path, expect.stringContaining(`instructions in "${target}"`)],
    ]);
  });

  describe('does not report', () => {
    it.each([
      ['a normal one-line instruction', 'Use pnpm.'],
      ['a sentence naming the file', 'See AGENTS.md'],
      ['an import', '@AGENTS.md'],
      ['an absolute path', '/home/me/AGENTS.md'],
      ['a home path', '~/AGENTS.md'],
      ['a URL', 'https://example.com/AGENTS.md'],
      ['a Windows path', '..\\AGENTS.md'],
      ['a heading', '#AGENTS.md'],
      ['a missing file', 'MISSING.md'],
      ['a directory', 'docs'],
      ['a non-Markdown file', 'package.json'],
      ['its own name', 'CLAUDE.md'],
      ['a path above the scan root', '../AGENTS.md'],
      ['an empty file', ''],
      ['two lines', 'AGENTS.md\nAGENTS.md'],
      ['a very long token', `${'a/'.repeat(600)}AGENTS.md`],
    ])('%s', (_label, text) => {
      const result = lint(
        { 'CLAUDE.md': text, 'AGENTS.md': AGENTS, 'docs/guide.md': 'x' },
        { rules, paths: ['package.json'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a path whose existence is unknown', () => {
      const result = lint(
        { 'CLAUDE.md': 'vendor/AGENTS.md' },
        { rules, opaqueDirectories: ['vendor/'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('files read by no targeted platform', () => {
      const result = lint(
        { 'CLAUDE.md': 'AGENTS.md', 'AGENTS.md': AGENTS },
        { rules, targets: ['codex'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('accepts a target that is an instruction file without a Markdown extension', () => {
    const result = lint(
      { '.windsurfrules': '.cursorrules', '.cursorrules': 'Use pnpm.' },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => finding.path)).toEqual(['.windsurfrules']);
  });
});

describe('instr/symlink-materialized fix', () => {
  const ENABLE_SYMLINKS =
    'run "git config core.symlinks true" and check the file out again; on Windows, creating symlinks needs Developer Mode or Administrator rights';

  it('replaces the path in CLAUDE.md with an import, for review', () => {
    const result = lint({ 'CLAUDE.md': 'AGENTS.md\n', 'AGENTS.md': AGENTS }, { rules });
    expect(repairs(result, RULE)).toEqual([
      {
        path: 'CLAUDE.md',
        fix: {
          id: `${RULE}#import`,
          class: 'review',
          title: 'Replace the path in CLAUDE.md with the import "@AGENTS.md"',
          changes: [
            {
              kind: 'edit',
              path: 'CLAUDE.md',
              edits: [{ offset: 0, length: 9, text: '@AGENTS.md' }],
            },
          ],
          notes: [
            'Git then records this file as a regular file instead of a symlink, and agents read the linked instructions through the import.',
          ],
        },
      },
    ]);
  });

  it.each([
    ['GEMINI.md', 'AGENTS.md', '@./AGENTS.md'],
    ['GEMINI.md', './docs/agents.md', '@./docs/agents.md'],
    ['docs/GEMINI.md', '../AGENTS.md', '@../AGENTS.md'],
    ['CLAUDE.local.md', 'docs/agents.md', '@docs/agents.md'],
  ])('imports in %s %j as %j', (path, target, line) => {
    const run = fixFiles(
      { [path]: target, 'AGENTS.md': AGENTS, 'docs/agents.md': AGENTS },
      { rules },
      selectRule(RULE),
    );
    expect(fixedText(run, path)).toBe(line);
    expect(run.verification).toMatchObject({ resolved: 1, introduced: [] });
  });

  describe('leaves to the user', () => {
    it.each([
      ['AGENTS.md', 'CLAUDE.md'],
      ['.cursorrules', 'AGENTS.md'],
      ['.github/copilot-instructions.md', '../AGENTS.md'],
    ])('%s, which has no imports: symlinks must be enabled', (path, target) => {
      const result = lint({ 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS, [path]: target }, { rules });
      expect(repairs(result, RULE)).toEqual([{ path, guidance: ENABLE_SYMLINKS }]);
    });

    it('a target an import cannot name as written', () => {
      const result = lint(
        { 'CLAUDE.md': 'docs/a+b.md', 'AGENTS.md': AGENTS },
        { rules, paths: ['docs/a+b.md'] },
      );
      expect(repairs(result, RULE)).toEqual([{ path: 'CLAUDE.md', guidance: ENABLE_SYMLINKS }]);
    });

    it('a file another path links to', () => {
      const result = lint(
        { 'CLAUDE.md': 'AGENTS.md', 'GEMINI.md': 'AGENTS.md', 'AGENTS.md': AGENTS },
        { rules, symlinks: { 'GEMINI.md': 'CLAUDE.md' } },
      );
      expect(repairs(result, RULE)).toEqual([
        {
          path: 'CLAUDE.md',
          guidance:
            'replace the path with the line "@AGENTS.md" by hand: "GEMINI.md" is a symbolic link to this file',
        },
      ]);
    });
  });
});
