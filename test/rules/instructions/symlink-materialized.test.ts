import { describe, expect, it } from 'vitest';
import { symlinkMaterializedRule } from '../../../src/rules/instructions/symlink-materialized.js';
import { findings, lint } from '../../helpers/lint.js';

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
