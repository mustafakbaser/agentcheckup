import { describe, expect, it } from 'vitest';
import { importDepthRule } from '../../../src/rules/instructions/import-depth.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/import-depth';
const rules = [importDepthRule];

/**
 * CLAUDE.md -> AGENTS.md -> GEMINI.md -> .cursorrules -> .windsurfrules -> copilot instructions.
 * AGENTS.md is not a Claude Code root here, because CLAUDE.md exists. Dotfiles without an
 * extension need `./` to count as imports.
 */
const CLAUDE_CHAIN = {
  'CLAUDE.md': '@AGENTS.md\n',
  'AGENTS.md': '@GEMINI.md\n',
  'GEMINI.md': '@./.cursorrules\n',
  '.cursorrules': '@./.windsurfrules\n',
  '.windsurfrules': 'See @.github/copilot-instructions.md\n',
  '.github/copilot-instructions.md': 'Use pnpm.\n',
};

describe('instr/import-depth', () => {
  it('reports the Claude Code import five hops from CLAUDE.md', () => {
    const result = lint(CLAUDE_CHAIN, { rules, targets: ['claude-code'] });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: '.windsurfrules',
        message:
          'This import is 5 hops from "CLAUDE.md". Claude Code follows imports at most 4 hops deep, so ".github/copilot-instructions.md" is not loaded.',
        range: { start: { line: 1, column: 5 }, end: { line: 1, column: 37 } },
      },
    ]);
    expect(result.findings[0]?.platforms).toEqual(['claude-code']);
  });

  it('does not report when the deep file is also imported within the limit', () => {
    const result = lint(
      { ...CLAUDE_CHAIN, 'CLAUDE.md': '@AGENTS.md\n@.github/copilot-instructions.md\n' },
      { rules, targets: ['claude-code'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('ignores absolute and commented-out imports at the hop limit', () => {
    const result = lint(
      {
        ...CLAUDE_CHAIN,
        '.windsurfrules': '@/Users/alice/notes.md\n<!-- @.github/copilot-instructions.md -->\n',
      },
      { rules, targets: ['claude-code'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('reports a token once when several roots reach it too deep', () => {
    const result = lint(
      { ...CLAUDE_CHAIN, 'CLAUDE.local.md': '@AGENTS.md\n' },
      { rules, targets: ['claude-code'] },
    );
    expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
      'This import is 5 hops from "CLAUDE.local.md". Claude Code follows imports at most 4 hops deep, so ".github/copilot-instructions.md" is not loaded.',
    ]);
  });

  it('reports a chain that starts at a project rule as information', () => {
    const result = lint(
      { ...CLAUDE_CHAIN, 'CLAUDE.md': 'x\n', '.claude/rules/a.md': '@../../AGENTS.md\n' },
      { rules, targets: ['claude-code'] },
    );
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'info',
        'This import is 5 hops from ".claude/rules/a.md". Claude Code follows imports at most 4 hops deep, so ".github/copilot-instructions.md" is not loaded. Claude Code\'s documentation does not say it expands imports in project rules.',
      ],
    ]);
  });

  it('counts hops from a CLAUDE.md that is a symlink to AGENTS.md', () => {
    // AGENTS.md (as CLAUDE.md) -> a.md -> b.md -> c.md -> d.md -> e.md: five hops.
    const chain = (directory: string): Record<string, string> => ({
      [`${directory}a.md`]: '@b.md\n',
      [`${directory}b.md`]: '@c.md\n',
      [`${directory}c.md`]: '@d.md\n',
      [`${directory}d.md`]: '@e.md\n',
      [`${directory}e.md`]: 'End.\n',
    });
    const imported = (directory: string): string[] =>
      ['a', 'b', 'c', 'd', 'e'].map((name) => `${directory}${name}.md`);
    const linked = (link: string, directory: string) =>
      lint(
        { 'AGENTS.md': '@a.md\n', [link]: '@a.md\n', ...chain(directory) },
        {
          rules,
          targets: ['claude-code'],
          symlinks: { [link]: 'AGENTS.md' },
          imported: imported(directory),
        },
      );

    expect(findings(linked('CLAUDE.md', ''), RULE)).toEqual([
      expect.objectContaining({
        severity: 'error',
        path: 'd.md',
        message:
          'This import is 5 hops from "CLAUDE.md". Claude Code follows imports at most 4 hops deep, so "e.md" is not loaded.',
      }),
    ]);
    // Through a link in another directory, the imports resolve from the link: information.
    expect(findings(linked('.claude/CLAUDE.md', '.claude/'), RULE)).toEqual([
      expect.objectContaining({
        severity: 'info',
        path: '.claude/d.md',
        message:
          'This import is 5 hops from ".claude/CLAUDE.md". Claude Code follows imports at most 4 hops deep, so ".claude/e.md" is not loaded. Claude Code reads this through a symlink in another directory than the file it points to, and its documentation does not say whether imports then resolve from the link\'s directory, as agentcheckup assumes, or from the target\'s.',
      }),
    ]);
    // Four hops are fine.
    const short = lint(
      { 'AGENTS.md': '@b.md\n', 'CLAUDE.md': '@b.md\n', ...chain('') },
      {
        rules,
        targets: ['claude-code'],
        symlinks: { 'CLAUDE.md': 'AGENTS.md' },
        imported: imported(''),
      },
    );
    expect(findings(short, RULE)).toEqual([]);
  });

  it('does not report a too-deep import of a missing file', () => {
    const result = lint(
      { ...CLAUDE_CHAIN, '.windsurfrules': '@docs/missing.md\n' },
      { rules, targets: ['claude-code'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('stays silent when the chain passes through a file it did not read', () => {
    const result = lint(
      {
        'CLAUDE.md': '@docs/index.md\n@AGENTS.md\n',
        'AGENTS.md': '@GEMINI.md\n',
        'GEMINI.md': '@./.cursorrules\n',
        '.cursorrules': '@./.windsurfrules\n',
        '.windsurfrules': '@.github/copilot-instructions.md\n',
        '.github/copilot-instructions.md': 'x',
      },
      { rules, targets: ['claude-code'], paths: ['docs/index.md'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });

  it('reports the Gemini CLI import six hops from GEMINI.md', () => {
    const result = lint(
      {
        'GEMINI.md': '@./AGENTS.md\n',
        'AGENTS.md': '@./CLAUDE.md\n',
        'CLAUDE.md': '@./.cursorrules\n',
        '.cursorrules': '@./.windsurfrules\n',
        '.windsurfrules': '@./.github/copilot-instructions.md\n',
        '.github/copilot-instructions.md': '@../.clinerules/style.md\n',
        '.clinerules/style.md': 'Use tabs.\n',
      },
      { rules, targets: ['gemini'] },
    );
    expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
      [
        '.github/copilot-instructions.md',
        'This import is 6 hops from "GEMINI.md". Gemini CLI follows imports at most 5 hops deep, so ".clinerules/style.md" is not loaded.',
      ],
    ]);
  });

  describe('cycles', () => {
    it('notes the import that closes a cycle', () => {
      const result = lint(
        { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': 'Claude users: see @CLAUDE.md\n' },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([
        {
          ruleId: RULE,
          severity: 'info',
          path: 'AGENTS.md',
          message:
            'This import closes a cycle: CLAUDE.md → AGENTS.md → CLAUDE.md. The imported file is already loaded earlier in the chain, so the import adds no new instructions.',
          range: { start: { line: 1, column: 19 }, end: { line: 1, column: 29 } },
        },
      ]);
    });

    it('notes a file that imports itself', () => {
      const result = lint({ 'CLAUDE.md': '@CLAUDE.md\n' }, { rules });
      expect(findings(result, RULE).map((finding) => finding.message)).toEqual([
        'This import closes a cycle: CLAUDE.md → CLAUDE.md. The imported file is already loaded earlier in the chain, so the import adds no new instructions.',
      ]);
    });

    it('does not report a diamond', () => {
      const result = lint(
        {
          'CLAUDE.md': '@AGENTS.md\n@GEMINI.md\n',
          'AGENTS.md': '@GEMINI.md\n',
          'GEMINI.md': 'Use pnpm.\n',
        },
        { rules, targets: ['claude-code'] },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('ignores a cycle closed beyond the hop limit, which the agent never reaches', () => {
      const result = lint(
        { ...CLAUDE_CHAIN, '.github/copilot-instructions.md': '@../CLAUDE.md\n' },
        { rules, targets: ['claude-code'] },
      );
      expect(findings(result, RULE).map((finding) => [finding.severity, finding.path])).toEqual([
        ['error', '.windsurfrules'],
      ]);
    });

    it('elides the middle of a long cycle', () => {
      const result = lint(
        {
          ...CLAUDE_CHAIN,
          'CLAUDE.md': '@AGENTS.md\n@.github/copilot-instructions.md\n',
          '.github/copilot-instructions.md': '@../CLAUDE.md\n',
        },
        { rules, targets: ['claude-code'] },
      );
      expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
        [
          '.github/copilot-instructions.md',
          'This import closes a cycle: CLAUDE.md → AGENTS.md → GEMINI.md → … → .github/copilot-instructions.md → CLAUDE.md. The imported file is already loaded earlier in the chain, so the import adds no new instructions.',
        ],
      ]);
    });

    it('ignores imports inside HTML comments for Claude Code', () => {
      const result = lint(
        { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '<!-- @CLAUDE.md -->\n' },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([]);
    });
  });

  it('does not run when neither agent is targeted', () => {
    const result = lint(CLAUDE_CHAIN, { rules, targets: ['codex'] });
    expect(findings(result, RULE)).toEqual([]);
  });
});
