import { describe, expect, it } from 'vitest';
import { codexSizeBudgetRule } from '../../../src/rules/instructions/codex-size-budget.js';
import { type FileMap, findings, lint, type LintOptions } from '../../helpers/lint.js';

const RULE = 'instr/codex-size-budget';
const rules = [codexSizeBudgetRule];

/** Lints a Git checkout: Codex chains AGENTS.md files only below a project root marker. */
function lintRepo(files: FileMap, options: Omit<LintOptions, 'rules'> = {}) {
  return lint(files, { rules, ...options, paths: ['.git/HEAD', ...(options.paths ?? [])] });
}

/** `count` lines of 100 bytes each: 99 ASCII characters and LF. */
function lines(count: number, char = 'x'): string {
  return `${char.repeat(99)}\n`.repeat(count);
}

describe('instr/codex-size-budget', () => {
  it('reports a single file over the limit at the exact cut', () => {
    const result = lintRepo({ 'AGENTS.md': lines(400) });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: 'AGENTS.md',
        message:
          'This file is 40,000 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it stops at line 328 and ignores the rest.',
        range: { start: { line: 328, column: 69 }, end: { line: 328, column: 100 } },
      },
    ]);
  });

  it('does not report files under 80% of the limit', () => {
    const result = lintRepo({ 'AGENTS.md': lines(262), 'pkg/AGENTS.md': 'Use pnpm.\n' });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('warns at 80% of the limit and not one byte below', () => {
    // 80% of 32,768 is 26,214.4 bytes.
    const below = lintRepo({ 'AGENTS.md': 'x'.repeat(26_214) });
    expect(findings(below, RULE)).toEqual([]);
    const at = lintRepo({ 'AGENTS.md': 'x'.repeat(26_215) });
    expect(findings(at, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: 'AGENTS.md',
        message:
          'This file is 26,215 bytes, 80% of the 32,768 bytes Codex reads from AGENTS.md files. Codex cuts off anything past that limit.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it('warns, without an error, when the chain is exactly at the limit', () => {
    const result = lintRepo({ 'AGENTS.md': 'x'.repeat(32_768) });
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'warn',
        'This file is 32,768 bytes, 100% of the 32,768 bytes Codex reads from AGENTS.md files. Codex cuts off anything past that limit.',
      ],
    ]);
  });

  it('counts the combined chain and reports the file where the cut happens', () => {
    const result = lintRepo({ 'AGENTS.md': lines(200), 'packages/api/AGENTS.md': lines(200, 'y') });
    const [finding] = findings(result, RULE);
    expect(findings(result, RULE)).toHaveLength(1);
    expect(finding).toEqual({
      ruleId: RULE,
      severity: 'error',
      path: 'packages/api/AGENTS.md',
      message:
        'This file and the AGENTS.md file above it total 40,000 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it stops at line 128 of this file and ignores the rest.',
      range: { start: { line: 128, column: 69 }, end: { line: 128, column: 100 } },
    });
    expect(result.findings[0]?.related).toEqual([
      { path: 'AGENTS.md', message: 'Read by Codex first: 20,000 bytes.' },
    ]);
  });

  it('reports one cut once, listing deeper files that are never read', () => {
    const result = lintRepo({
      'AGENTS.md': lines(400),
      'a/AGENTS.md': 'Use pnpm.\n',
      'a/b/AGENTS.md': 'Run the tests.\n',
      'c/AGENTS.md': 'Use yarn.\n',
    });
    expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
      [
        'AGENTS.md',
        'This file is 40,000 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it stops at line 328 and ignores the rest, and it never reads 3 AGENTS.md files in subdirectories.',
      ],
    ]);
    expect(result.findings[0]?.related.map((related) => related.path)).toEqual([
      'a/AGENTS.md',
      'a/b/AGENTS.md',
      'c/AGENTS.md',
    ]);
  });

  it('reports a file that gets no budget at all when the files above fill it exactly', () => {
    const result = lintRepo({
      'AGENTS.md': 'x'.repeat(32_768),
      'pkg/AGENTS.md': 'Use pnpm.\nAlways.\n',
    });
    expect(findings(result, RULE).map((finding) => [finding.path, finding.severity])).toEqual([
      ['AGENTS.md', 'warn'],
      ['pkg/AGENTS.md', 'error'],
    ]);
    expect(findings(result, RULE)[1]).toMatchObject({
      message:
        'This file and the AGENTS.md file above it total 32,786 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it reads none of this file.',
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
    });
  });

  it('warns once, at the file where the chain first reaches 80%', () => {
    const result = lintRepo({
      'AGENTS.md': lines(270),
      'a/AGENTS.md': lines(10),
      'b/AGENTS.md': lines(10),
    });
    expect(findings(result, RULE).map((finding) => [finding.path, finding.severity])).toEqual([
      ['AGENTS.md', 'warn'],
    ]);
  });

  it('warns on a deeper file whose chain first reaches 80%, naming the files above', () => {
    const result = lintRepo({ 'AGENTS.md': lines(150), 'pkg/AGENTS.md': lines(150) });
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        path: 'pkg/AGENTS.md',
        severity: 'warn',
        message:
          'This file and the AGENTS.md file above it total 30,000 bytes, 91% of the 32,768 bytes Codex reads from AGENTS.md files. Codex cuts off anything past that limit.',
      }),
    ]);
  });

  it('uses AGENTS.override.md instead of AGENTS.md in the same directory', () => {
    const result = lintRepo({ 'AGENTS.override.md': lines(400), 'AGENTS.md': lines(400) });
    expect(findings(result, RULE).map((finding) => finding.path)).toEqual(['AGENTS.override.md']);
  });

  it('counts nothing for a directory whose empty override shadows AGENTS.md', () => {
    const result = lintRepo({ 'AGENTS.override.md': '  \n', 'AGENTS.md': lines(400) });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('skips whitespace-only files, which use no budget', () => {
    const result = lintRepo({ 'AGENTS.md': ' '.repeat(40_000), 'pkg/AGENTS.md': lines(300) });
    expect(findings(result, RULE).map((finding) => [finding.path, finding.severity])).toEqual([
      ['pkg/AGENTS.md', 'warn'],
    ]);
  });

  it('carries the budget over when the kept part of the crossing file is only whitespace', () => {
    const result = lintRepo({
      'AGENTS.md': lines(300),
      'a/AGENTS.md': `${' '.repeat(5_000)}content\n`,
      'a/b/AGENTS.md': 'Use pnpm.\n',
    });
    expect(findings(result, RULE).map((finding) => [finding.path, finding.severity])).toEqual([
      ['AGENTS.md', 'warn'],
      ['a/AGENTS.md', 'error'],
    ]);
    expect(findings(result, RULE)[1]).toMatchObject({
      message:
        'This file and the AGENTS.md file above it total 35,008 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it stops at line 1 of this file and ignores the rest.',
      range: { start: { line: 1, column: 2_769 } },
    });
  });

  describe('cut offsets', () => {
    it('points at a two-byte character that the cut splits', () => {
      const text = `a${'ğ'.repeat(16_384)}`;
      const result = lintRepo({ 'AGENTS.md': text });
      expect(findings(result, RULE)[0]?.range.start).toEqual({ line: 1, column: 16_385 });
    });

    it('points at an emoji (two UTF-16 units) that the cut splits', () => {
      const text = `ab${'😀'.repeat(8_192)}`;
      const result = lintRepo({ 'AGENTS.md': text });
      const finding = findings(result, RULE)[0];
      expect(finding?.message).toContain('This file is 32,770 bytes.');
      expect(finding?.range).toEqual({
        start: { line: 1, column: 16_385 },
        end: { line: 1, column: 16_387 },
      });
    });

    it('points at the character after an exact character boundary', () => {
      const text = `${'😀'.repeat(8_192)}!`;
      const result = lintRepo({ 'AGENTS.md': text });
      expect(findings(result, RULE)[0]?.range).toEqual({
        start: { line: 1, column: 16_385 },
        end: { line: 1, column: 16_386 },
      });
    });

    it('counts the byte order mark, which Codex keeps', () => {
      const text = `\uFEFF${'x'.repeat(32_768)}`;
      const result = lintRepo({ 'AGENTS.md': text });
      const finding = findings(result, RULE)[0];
      expect(finding?.message).toContain('This file is 32,771 bytes.');
      expect(finding?.range.start).toEqual({ line: 1, column: 32_766 });
    });

    it('handles CRLF line endings', () => {
      const text = `${'x'.repeat(98)}\r\n`.repeat(400);
      const result = lintRepo({ 'AGENTS.md': text });
      expect(findings(result, RULE)[0]?.range).toEqual({
        start: { line: 328, column: 69 },
        end: { line: 328, column: 99 },
      });
    });

    it('maps a cut in a UTF-16 file to the right character', () => {
      const body = 'x'.repeat(20_000);
      const bytes = new Uint8Array(2 + body.length * 2);
      bytes[0] = 0xff;
      bytes[1] = 0xfe;
      for (let i = 0; i < body.length; i++) bytes[2 + i * 2] = 0x78;
      const result = lintRepo({ 'AGENTS.md': bytes });
      expect(findings(result, RULE)[0]?.range.start).toEqual({ line: 1, column: 16_384 });
    });
  });

  describe('without a project root marker', () => {
    it('judges each AGENTS.md alone, as Codex reads only the working directory', () => {
      const files = { 'AGENTS.md': lines(200), 'packages/api/AGENTS.md': lines(200, 'y') };
      expect(findings(lint(files, { rules }), RULE)).toEqual([]);
    });

    it('still reports a single file over the limit', () => {
      const result = lint({ 'AGENTS.md': 'Use pnpm.\n', 'pkg/AGENTS.md': lines(400) }, { rules });
      expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
        [
          'pkg/AGENTS.md',
          'This file is 40,000 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it stops at line 328 and ignores the rest.',
        ],
      ]);
    });
  });

  describe('project root', () => {
    it('starts the chain at a nested directory that contains .git', () => {
      const files = { 'AGENTS.md': lines(200), 'vendor-repo/AGENTS.md': lines(200) };
      const nested = lintRepo(files, { paths: ['vendor-repo/.git/HEAD'] });
      expect(findings(nested, RULE)).toEqual([]);
      const flat = lintRepo(files);
      expect(findings(flat, RULE).map((finding) => finding.path)).toEqual([
        'vendor-repo/AGENTS.md',
      ]);
    });

    it('treats a .git file (submodule) as a project root marker', () => {
      const result = lintRepo(
        { 'AGENTS.md': lines(200), 'sub/AGENTS.md': lines(200) },
        { paths: ['sub/.git'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  describe('files that exist but were not read', () => {
    it('stops counting at a directory with an unread override', () => {
      const result = lintRepo(
        { 'AGENTS.md': lines(200), 'pkg/AGENTS.md': lines(200) },
        { ignoredFiles: ['pkg/AGENTS.override.md'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('stops counting at an AGENTS.md that was not read', () => {
      const result = lintRepo({ 'pkg/AGENTS.md': lines(400) }, { ignoredFiles: ['AGENTS.md'] });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('ignores files whose name differs only in case, as Linux does', () => {
      const result = lintRepo({ 'Agents.md': lines(200), 'pkg/AGENTS.md': lines(200) });
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('follows symlinked AGENTS.md files and reports on the real file', () => {
    const shared = lines(200);
    const result = lintRepo(
      { 'AGENTS.md': shared, 'pkg/AGENTS.md': shared },
      { symlinks: { 'pkg/AGENTS.md': 'AGENTS.md' } },
    );
    expect(findings(result, RULE)).toEqual([
      expect.objectContaining({
        path: 'AGENTS.md',
        message:
          'Codex reads this file as "pkg/AGENTS.md". This file and the AGENTS.md file above it total 40,000 bytes. Codex reads at most 32,768 bytes of AGENTS.md content, so it stops at line 128 of this file and ignores the rest.',
      }),
    ]);
  });

  describe('options', () => {
    it('uses maxBytes from the configuration', () => {
      const result = lintRepo(
        { 'AGENTS.md': lines(15) },
        { config: { rules: { [RULE]: ['error', { maxBytes: 1_000 }] } } },
      );
      expect(findings(result, RULE)[0]?.message).toBe(
        'This file is 1,500 bytes. Codex reads at most 1,000 bytes of AGENTS.md content, so it stops at line 11 and ignores the rest.',
      );
    });

    it('fails loudly on an invalid maxBytes', () => {
      const result = lintRepo(
        { 'AGENTS.md': 'x' },
        { config: { rules: { [RULE]: ['error', { maxBytes: 'big' }] } } },
      );
      expect(result.ruleFailures).toEqual([
        { ruleId: RULE, message: 'Option "maxBytes" must be a positive integer, got "big".' },
      ]);
    });
  });

  it('ignores AGENTS.md files inside configuration folders', () => {
    const result = lintRepo({
      'AGENTS.md': lines(200),
      '.codex/AGENTS.md': lines(200),
      'pkg/.github/AGENTS.md': lines(200),
    });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('ignores an AGENTS.md that is a skill reference document', () => {
    const result = lintRepo({
      'AGENTS.md': lines(200),
      'agents/skills/react/SKILL.md': '---\nname: react\ndescription: d\n---\n',
      'agents/skills/react/AGENTS.md': lines(300),
    });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('ignores AGENTS.md files in template and fixture folders', () => {
    const result = lintRepo({
      'AGENTS.md': lines(200),
      'templates/app/AGENTS.md': lines(200),
      'test/fixtures/repo/AGENTS.md': lines(200),
    });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not run when Codex is not targeted', () => {
    const result = lintRepo({ 'AGENTS.md': lines(400) }, { targets: ['claude-code'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});

describe('instr/codex-size-budget with project_doc_max_bytes in the repository', () => {
  it('applies the closest .codex/config.toml, before the maxBytes option', () => {
    const files = {
      'AGENTS.md': lines(3),
      'pkg/AGENTS.md': lines(3, 'y'),
      '.codex/config.toml': 'project_doc_max_bytes = 1000\n',
      'pkg/.codex/config.toml': 'project_doc_max_bytes = 250\n',
    };
    const config = { rules: { [RULE]: ['error', { maxBytes: 100_000 }] } };
    const found = findings(lintRepo(files, { config }), RULE);
    expect(found.map(({ severity, path, message }) => [severity, path, message])).toEqual([
      [
        'error',
        'AGENTS.md',
        'This file is 300 bytes. Codex reads at most 250 bytes of AGENTS.md content, so it stops at line 3 and ignores the rest, and it never reads 1 AGENTS.md file in subdirectories.',
      ],
    ]);
  });

  it('does not report a chain within the repository budget, whatever the option says', () => {
    const files = {
      'AGENTS.md': lines(3),
      '.codex/config.toml': 'project_doc_max_bytes = 65536\n',
    };
    const config = { rules: { [RULE]: ['error', { maxBytes: 100 }] } };
    expect(findings(lintRepo(files, { config }), RULE)).toEqual([]);
    // Without the repository setting, the option applies.
    expect(findings(lintRepo({ 'AGENTS.md': lines(3) }, { config }), RULE)).toHaveLength(1);
  });
});
