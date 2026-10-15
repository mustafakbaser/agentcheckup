import { describe, expect, it } from 'vitest';
import { vagueDirectiveRule } from '../../../src/rules/instructions/vague-directive.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/vague-directive';
const rules = [vagueDirectiveRule];

describe('instr/vague-directive', () => {
  it('reports a bullet that is only generic advice', () => {
    const result = lint(
      { 'AGENTS.md': '# Rules\n\n- Use pnpm, not npm.\n- Follow best practices.\n' },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: 'AGENTS.md',
        message:
          '"Follow best practices." is generic advice that tells the agent nothing about this project. Replace it with the specific command, convention or path you mean.',
        range: { start: { line: 4, column: 3 }, end: { line: 4, column: 25 } },
      },
    ]);
  });

  it('finds generic sentences inside a paragraph, across emphasis and line breaks', () => {
    const text =
      'Run `pnpm test` before committing. **Write clean code!** Be careful\nKeep functions small.\r\n';
    const result = lint({ 'CLAUDE.md': text }, { rules });
    expect(findings(result, RULE).map((finding) => finding.range.start)).toEqual([
      { line: 1, column: 36 },
      { line: 1, column: 58 },
    ]);
  });

  it.each([
    'Test your changes',
    'Format code properly.',
    'Keep files organized.',
    'Write clean, maintainable code.',
    'Use meaningful variable names.',
    "Don't introduce bugs.",
    'Follow the existing architecture.',
  ])('reports %j', (sentence) => {
    const result = lint({ 'GEMINI.md': `${sentence}\n` }, { rules });
    expect(findings(result, RULE)).toHaveLength(1);
  });

  describe('does not report', () => {
    it.each([
      ['a specific instruction', 'Follow best practices for React hooks in docs/hooks.md.'],
      ['a concrete command', 'Run `pnpm test` before committing.'],
      ['code', '```\nFollow best practices.\n```\n'],
      ['inline code', '`Write clean code.`'],
      ['a heading', '## Follow best practices\n\nUse ESLint.'],
      ['an HTML comment', '<!-- Be careful. -->\nUse pnpm.'],
      ['a longer sentence', 'Be careful when deleting rows from the payments table.'],
    ])('%s', (_label, text) => {
      expect(findings(lint({ 'AGENTS.md': text }, { rules }), RULE)).toEqual([]);
    });

    it('text that is not predominantly English', () => {
      const text =
        'Değişiklikleri küçük tut. Kullanıcı arayüzü metinleri Türkçe olmalı.\n\nBe careful.\n';
      expect(findings(lint({ 'AGENTS.md': text }, { rules }), RULE)).toEqual([]);
    });

    it('files no targeted platform reads', () => {
      const result = lint({ 'CLAUDE.md': 'Be careful.' }, { rules, targets: ['codex'] });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('a file with no prose', () => {
      expect(findings(lint({ 'AGENTS.md': '```sh\npnpm test\n```\n' }, { rules }), RULE)).toEqual(
        [],
      );
    });
  });

  it('reports at most 100 sentences per file', () => {
    const result = lint({ 'AGENTS.md': '- Be careful.\n'.repeat(150) }, { rules });
    expect(findings(result, RULE)).toHaveLength(100);
  });

  it('normalizes typographic apostrophes', () => {
    const result = lint({ 'AGENTS.md': 'Don\u2019t introduce bugs.' }, { rules });
    expect(findings(result, RULE)).toHaveLength(1);
  });
});
