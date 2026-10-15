import { describe, expect, it } from 'vitest';
import { overrideShadowsAgentsMdRule } from '../../../src/rules/instructions/override-shadows-agents-md.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/override-shadows-agents-md';
const rules = [overrideShadowsAgentsMdRule];
const WHOLE_FILE = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

describe('instr/override-shadows-agents-md', () => {
  it('reports an empty override next to AGENTS.md as an error', () => {
    const result = lint(
      { 'AGENTS.override.md': '', 'AGENTS.md': '# Rules\n\nUse pnpm.\n' },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: 'AGENTS.override.md',
        message:
          'This AGENTS.override.md is empty, but Codex still reads it instead of the AGENTS.md next to it, so Codex gets no instructions from this directory.',
        range: WHOLE_FILE,
      },
    ]);
    expect(result.findings[0]?.related).toEqual([
      { path: 'AGENTS.md', message: 'Not read by Codex while the override exists.' },
    ]);
  });

  it.each([
    ['whitespace and CRLF', ' \r\n\t\r\n'],
    ['a byte order mark', '\uFEFF\n'],
    ['NEL and ideographic spaces', '\u0085\u3000'],
  ])('treats an override with only %s as empty', (_label, text) => {
    const result = lint({ 'pkg/AGENTS.override.md': text, 'pkg/AGENTS.md': 'x' }, { rules });
    expect(findings(result, RULE).map((finding) => finding.severity)).toEqual(['error']);
  });

  it('notes a non-empty override as info', () => {
    const result = lint(
      { 'AGENTS.override.md': 'Use the staging database.\n', 'AGENTS.md': 'Use pnpm.\n' },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'info',
        path: 'AGENTS.override.md',
        message:
          'Codex reads this file instead of the AGENTS.md next to it, so Codex does not see the instructions in AGENTS.md. Claude Code never reads AGENTS.override.md.',
        range: WHOLE_FILE,
      },
    ]);
  });

  it('reports when AGENTS.md exists but was not read', () => {
    const result = lint({ 'AGENTS.override.md': '' }, { rules, ignoredFiles: ['AGENTS.md'] });
    expect(findings(result, RULE).map((finding) => finding.severity)).toEqual(['error']);
  });

  it('does not report an override without AGENTS.md beside it', () => {
    const result = lint(
      { 'AGENTS.override.md': '', 'pkg/AGENTS.md': 'Use pnpm.\n', 'AGENTS.md/notes.txt': 'x' },
      { rules },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not report when AGENTS.md might exist but is unknown', () => {
    const result = lint(
      { 'vendor/AGENTS.override.md': '' },
      { rules, opaqueDirectories: ['vendor/'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not report a case variant of the override name', () => {
    const result = lint({ 'agents.override.md': '', 'AGENTS.md': 'x' }, { rules });
    expect(findings(result, RULE)).toEqual([]);
  });

  it('does not run when Codex is not targeted', () => {
    const result = lint(
      { 'AGENTS.override.md': '', 'AGENTS.md': 'x' },
      { rules, targets: ['cursor', 'claude-code'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });
});
