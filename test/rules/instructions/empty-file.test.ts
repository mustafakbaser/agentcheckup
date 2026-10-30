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

  it('reports a .claude/rules file for GitHub Copilot, which reads it too', () => {
    const files = { '.claude/rules/testing.md': '---\npaths: src/**\n---\n' };
    const copilot = lint(files, { rules, targets: ['copilot'] });
    expect(copilot.findings.map((finding) => [finding.path, finding.platforms])).toEqual([
      ['.claude/rules/testing.md', ['copilot']],
    ]);
    expect(lint(files, { rules }).findings[0]?.platforms).toEqual(['claude-code', 'copilot']);
    // Neither Cursor nor Codex reads it.
    expect(findings(lint(files, { rules, targets: ['cursor', 'codex'] }), RULE)).toEqual([]);
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
      ['.claude/rules/broken.md', '---\npaths: [\n---\n'],
      // A rule whose YAML does not parse loads whole in Cline, which fails open.
      ['.clinerules/broken.md', '---\npaths: [\n---\n'],
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

    it('an AGENTS.md with only frontmatter, for agents that read the frontmatter as text', () => {
      const result = lint(
        { 'AGENTS.md': '---\ntitle: notes\n---\n' },
        { rules, targets: ['claude-code', 'codex', 'cursor', 'copilot', 'windsurf'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  describe('Cline', () => {
    it('reports an AGENTS.md with only frontmatter, which Cline removes, for Cline alone', () => {
      const result = lint({ 'AGENTS.md': '---\ntitle: notes\n---\n' }, { rules });
      expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
        'This file has frontmatter but no body. Cline removes the frontmatter before loading it, so it gets no instructions from it.',
      ]);
      expect(result.findings.map((finding) => finding.platforms)).toEqual([['cline']]);
    });

    it('reads every file in its rules and workflows folders as a rule, whatever its kind', () => {
      const result = lint(
        {
          '.clinerules/CLAUDE.md': '',
          '.clinerules/GEMINI.md': '---\nnote: x\n---\n',
          '.clinerules/workflows/ship.md': '---\nname: ship\n---\n\n',
          '.cline/workflows/release.md': '\n',
          '.clinerules/AGENTS.override.md': '',
          '.clinerules/AGENTS.md': 'Rules.\n',
        },
        { rules },
      );
      expect(
        result.findings.map((finding) => [finding.path, finding.platforms.includes('cline')]),
      ).toEqual([
        ['.cline/workflows/release.md', true],
        ['.clinerules/AGENTS.override.md', true],
        ['.clinerules/CLAUDE.md', true],
        ['.clinerules/GEMINI.md', true],
        ['.clinerules/workflows/ship.md', true],
      ]);
      // The override next to an AGENTS.md is left to instr/override-shadows-agents-md for Codex.
      expect(
        result.findings.find((finding) => finding.path === '.clinerules/AGENTS.override.md')
          ?.platforms,
      ).toEqual(['cline']);
      // Frontmatter is text to the other readers of GEMINI.md.
      expect(
        result.findings.find((finding) => finding.path === '.clinerules/GEMINI.md')?.platforms,
      ).toEqual(['cline']);
    });

    it('does not name Cline for an AGENTS.md in its skills or hooks folders', () => {
      const result = lint(
        { '.cline/skills/x/AGENTS.md': '', '.clinerules/hooks/AGENTS.md': '' },
        { rules },
      );
      expect(result.findings).toHaveLength(2);
      for (const finding of result.findings) expect(finding.platforms).not.toContain('cline');
    });
  });

  it('reports only the targeted readers', () => {
    const result = lint({ 'AGENTS.md': '' }, { rules, targets: ['codex', 'gemini'] });
    expect(result.findings[0]?.platforms).toEqual(['codex']);
  });
});
