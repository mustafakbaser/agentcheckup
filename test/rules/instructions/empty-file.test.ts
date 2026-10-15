import { describe, expect, it } from 'vitest';
import { READERS } from '../../../src/platforms/classify.js';
import { emptyFileRule } from '../../../src/rules/instructions/empty-file.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/empty-file';
const rules = [emptyFileRule];
const WHOLE_FILE = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

describe('instr/empty-file', () => {
  it('reports a zero-byte AGENTS.md', () => {
    const result = lint({ 'AGENTS.md': '' }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: 'AGENTS.md',
        message: 'This file is empty, so agents get no instructions from it.',
        range: WHOLE_FILE,
      },
    ]);
    expect(result.findings[0]?.platforms).toEqual(READERS['agents-md']);
  });

  it.each([
    ['CLAUDE.md', ' \n\n'],
    ['GEMINI.md', '\r\n\r\n'],
    ['.github/copilot-instructions.md', '\t'],
    ['.cursorrules', '\n'],
    ['.windsurfrules', '   '],
    ['AGENTS.override.md', '\n'],
    ['CLAUDE.local.md', '\uFEFF\n'],
  ])('reports whitespace-only %s', (path, text) => {
    const result = lint({ [path]: text }, { rules });
    expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
      [path, 'This file contains only whitespace, so agents get no instructions from it.'],
    ]);
  });

  it.each([
    ['.claude/rules/testing.md', '---\npaths:\n  - "src/**"\n---\n\n'],
    ['.windsurf/rules/style.md', '---\ntrigger: always_on\n---\n'],
    ['.clinerules/style.md', '---\npaths: []\n---'],
  ])('reports a rule with frontmatter but no body: %s', (path, text) => {
    const result = lint({ [path]: text }, { rules });
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'This rule has frontmatter but no body, so it adds no instructions when it loads.',
    ]);
  });

  it('reports a CLAUDE.md that holds only HTML comments', () => {
    const result = lint(
      { 'CLAUDE.md': '<!-- TODO: add project instructions -->\n\n<!-- owner: platform -->\n' },
      { rules },
    );
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'This CLAUDE.md contains only HTML comments, which Claude Code strips before loading, so Claude Code gets no instructions from it.',
    ]);
    // Only Claude Code is documented to strip comments: the finding is for Claude Code alone.
    expect(result.findings.map((finding) => finding.platforms)).toEqual([['claude-code']]);
    const withoutClaude = lint(
      { 'CLAUDE.md': '<!-- TODO -->\n' },
      { rules, targets: ['cursor', 'copilot'] },
    );
    expect(findings(withoutClaude, RULE)).toEqual([]);
  });

  describe('does not report', () => {
    it.each([
      ['AGENTS.md', 'Use pnpm.'],
      ['CLAUDE.md', '<!-- maintainer note -->\nRun `pnpm test` before committing.\n'],
      ['CLAUDE.md', '```\n<!-- kept in a code block -->\n```\n'],
      ['GEMINI.md', 'Kullanıcı arayüzü metinleri Türkçe olmalı. 🚀\n'],
      ['.claude/rules/testing.md', '---\npaths: src/**\n---\nUse vitest.\n'],
      ['AGENTS.md', '---\ntitle: notes\n---\n'],
      ['.claude/rules/broken.md', '---\npaths: [\n---\n'],
      ['AGENTS.md', '\u200B'],
    ])('%s with content %j', (path, text) => {
      const result = lint({ [path]: text }, { rules });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('an empty override next to AGENTS.md (instr/override-shadows-agents-md reports it)', () => {
      const result = lint({ 'AGENTS.override.md': '', 'AGENTS.md': 'x' }, { rules });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('files no targeted platform reads', () => {
      const result = lint({ 'CLAUDE.md': '', '.cursorrules': '' }, { rules, targets: ['codex'] });
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('reports only the targeted readers', () => {
    const result = lint({ 'AGENTS.md': '' }, { rules, targets: ['codex', 'gemini'] });
    expect(result.findings[0]?.platforms).toEqual(['codex']);
  });
});
