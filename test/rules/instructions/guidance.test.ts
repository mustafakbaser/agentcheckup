/**
 * The manual steps of the instruction rules that offer no fix: each finding carries one line of
 * guidance that tells the user what to do, and never a fix.
 */
import { describe, expect, it } from 'vitest';
import { instructionsRules } from '../../../src/rules/instructions/index.js';
import { type FileMap, lint } from '../../helpers/lint.js';
import { repairs } from './fix-helpers.js';

const lines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `Line ${index + 1}.`).join('\n');

const CASES: readonly (readonly [ruleId: string, files: FileMap, guidance: string])[] = [
  [
    'instr/claude-md-too-long',
    { 'CLAUDE.md': `${lines(201)}\n` },
    'move instructions that matter for only part of the codebase into path-scoped rules in .claude/rules/ or into skills; @path imports do not help, because imported files load at launch too',
  ],
  [
    'instr/codex-size-budget',
    { 'AGENTS.md': 'Use pnpm for every script.\n'.repeat(1300) },
    'move instructions for one part of the repository into an AGENTS.md in that directory, or cut content; if you raised project_doc_max_bytes, set the maxBytes option to match',
  ],
  ['instr/empty-file', { 'AGENTS.md': '' }, 'add instructions or delete the file'],
  [
    'instr/empty-file',
    { 'CLAUDE.md': '<!-- nothing yet -->\n' },
    'add instructions or delete the file; even an empty CLAUDE file stops Claude Code from reading AGENTS.md',
  ],
  [
    'instr/filename-case',
    { 'docs/Agents.md': 'Use pnpm.\n' },
    'if it holds agent instructions, run: git mv docs/Agents.md docs/AGENTS.md',
  ],
  [
    'instr/filename-case',
    { 'my docs/Agents.md': 'Use pnpm.\n' },
    'rename it with git mv, so that Git records the new letter case on macOS and Windows too',
  ],
  [
    'instr/import-depth',
    {
      'CLAUDE.md': '@a.md\n',
      'a.md': '@b.md\n',
      'b.md': '@c.md\n',
      'c.md': '@d.md\n',
      'd.md': '@e.md\n',
      'e.md': 'Deep.\n',
    },
    'import "e.md" directly from "CLAUDE.md", or from a file fewer hops away',
  ],
  [
    'instr/import-outside-root',
    { 'CLAUDE.md': '@/etc/team/rules.md\n' },
    'copy the file into the repository and import it with a relative path',
  ],
  [
    'instr/override-shadows-agents-md',
    { 'AGENTS.override.md': '', 'AGENTS.md': 'Use pnpm.\n' },
    'delete the empty AGENTS.override.md so that Codex reads AGENTS.md again',
  ],
  [
    'instr/vague-directive',
    { 'AGENTS.md': '# Rules\n\nFollow best practices.\n' },
    'name what you mean, such as the exact test command or a naming rule, or delete the sentence',
  ],
  [
    'instr/windsurf-rule-too-long',
    { '.windsurf/rules/style.md': `${'x'.repeat(12_001)}\n` },
    'split the rule into several rule files with their own activation modes, or move reference material into files the rule points to',
  ],
];

describe('manual steps of rules without a fix', () => {
  it.each(CASES)('%s', (ruleId, files, guidance) => {
    const result = lint(files, {
      rules: instructionsRules,
      paths: ['.git/HEAD'],
      // The import chain of the import-depth case: files read because CLAUDE.md imports them.
      imported: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
    });
    const found = repairs(result, ruleId);
    expect(found.length).toBeGreaterThan(0);
    for (const item of found) {
      expect(item.fix).toBeUndefined();
      expect(item.guidance).toBe(guidance);
    }
  });

  it('gives no manual step where there is nothing to report', () => {
    const result = lint(
      {
        'AGENTS.md': '# Rules\n\nRun pnpm test before every commit.\n',
        'CLAUDE.md': '@AGENTS.md\n',
      },
      { rules: instructionsRules, paths: ['.git/HEAD'] },
    );
    expect(result.findings).toEqual([]);
  });
});
