import { describe, expect, it } from 'vitest';
import { filenameCaseRule } from '../../../src/rules/instructions/filename-case.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/filename-case';
const rules = [filenameCaseRule];

describe('instr/filename-case', () => {
  it('reports Agents.md with the expected spelling', () => {
    const result = lint({ 'Agents.md': '# Rules\n' }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: 'Agents.md',
        message:
          'This file is named "Agents.md", not "AGENTS.md", so agents find it on macOS and Windows but not on Linux, where file names are case-sensitive. Rename it to "AGENTS.md", or give it another name if it is not agent instructions.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
  });

  it.each([
    ['docs/Claude.md', 'CLAUDE.md'],
    ['claude.local.md', 'CLAUDE.local.md'],
    ['Gemini.md', 'GEMINI.md'],
    ['agents.md', 'AGENTS.md'],
    ['pkg/Agents.override.md', 'AGENTS.override.md'],
  ])('reports %s', (path, expected) => {
    const result = lint({ [path]: 'x' }, { rules });
    expect(findings(result, RULE)[0]?.message).toContain(`not "${expected}", so agents find it`);
  });

  it('does not report all-lower-case names below the scan root, which are usually documents', () => {
    const result = lint(
      { 'docs/claude.md': 'x', 'docs/realtime/gemini.md': 'x', 'pkg/agents.md': 'x' },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not report correctly named files', () => {
    const result = lint(
      {
        'AGENTS.md': 'x',
        'CLAUDE.md': 'x',
        '.claude/CLAUDE.md': 'x',
        'CLAUDE.local.md': 'x',
        'GEMINI.md': 'x',
        'AGENTS.override.md': 'x',
      },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not list Windsurf for agents.md, which Cascade documents, but does for Agents.md', () => {
    const lower = lint({ 'agents.md': 'x' }, { rules });
    expect(lower.findings[0]?.platforms).not.toContain('windsurf');
    expect(lower.findings[0]?.platforms).toContain('codex');
    const mixed = lint({ 'docs/Agents.md': 'x' }, { rules });
    expect(mixed.findings[0]?.platforms).toContain('windsurf');
    expect(findings(lint({ 'agents.md': 'x' }, { rules, targets: ['windsurf'] }), RULE)).toEqual(
      [],
    );
  });

  it('reports only for targeted readers', () => {
    const result = lint({ 'claude.md': 'x', 'agents.md': 'x' }, { rules, targets: ['codex'] });
    expect(findings(result, RULE).map((finding) => finding.path)).toEqual(['agents.md']);
    expect(result.findings[0]?.platforms).toEqual(['codex']);
  });
});
