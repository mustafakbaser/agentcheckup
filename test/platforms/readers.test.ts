import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { PLATFORM_IDS } from '../../src/core/types.js';
import { effectiveReaders } from '../../src/platforms/readers.js';
import { emptyFileRule } from '../../src/rules/instructions/empty-file.js';
import type { RuleResult } from '../../src/core/engine.js';
import { type FileMap, lint, snapshotFrom } from '../helpers/lint.js';

const platformsOf = (result: RuleResult) =>
  result.findings.filter((f) => f.ruleId === 'instr/empty-file').map((f) => f.platforms);

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function readersOf(files: FileMap, path: string): readonly string[] {
  const analysis = analyze(snapshotFrom(files), {});
  const artifact = analysis.index.get(path);
  if (artifact === undefined) throw new Error(`no artifact ${path}`);
  return effectiveReaders(analysis, artifact);
}

const AGENTS_READERS = ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'windsurf'];

describe('effectiveReaders', () => {
  it('keeps the default readers without settings', () => {
    expect(readersOf({ 'AGENTS.md': 'x\n' }, 'AGENTS.md')).toEqual(AGENTS_READERS);
  });

  it('adds Gemini CLI where context.fileName names the file', () => {
    const settings = json({ context: { fileName: ['AGENTS.md'] } });
    const files = {
      'AGENTS.md': 'x\n',
      'pkg/AGENTS.md': 'x\n',
      'CLAUDE.md': 'x\n',
      'other/AGENTS.md': 'x\n',
      'other/.gemini/settings.json': json({ context: { fileName: 'CLAUDE.md' } }),
    };
    expect(readersOf({ ...files, '.gemini/settings.json': settings }, 'AGENTS.md')).toEqual([
      'claude-code',
      'cline',
      'codex',
      'copilot',
      'cursor',
      'gemini',
      'windsurf',
    ]);
    // Below the directory whose settings name it: loaded just in time.
    expect(readersOf({ ...files, '.gemini/settings.json': settings }, 'pkg/AGENTS.md')).toContain(
      'gemini',
    );
    // Settings name other files, or sit in a directory the file is not in.
    expect(readersOf({ ...files, '.gemini/settings.json': settings }, 'CLAUDE.md')).not.toContain(
      'gemini',
    );
    expect(readersOf(files, 'AGENTS.md')).not.toContain('gemini');
    expect(readersOf(files, 'other/AGENTS.md')).not.toContain('gemini');
  });

  it('removes Devin Local where read_config_from turns the source off', () => {
    const files = {
      'AGENTS.md': 'x\n',
      'CLAUDE.md': 'x\n',
      '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\nx\n',
      '.windsurf/rules/a.md': 'x\n',
      '.devin/rules/a.md': 'x\n',
      '.devin/config.json': json({ read_config_from: { agents_standard: false, cursor: false } }),
    };
    expect(readersOf(files, 'AGENTS.md')).not.toContain('windsurf');
    expect(readersOf(files, '.cursor/rules/a.mdc')).toEqual(['cursor']);
    // Sources left on, and Devin's own rules.
    expect(readersOf(files, 'CLAUDE.md')).toContain('windsurf');
    expect(readersOf(files, '.windsurf/rules/a.md')).toEqual(['windsurf']);
    expect(readersOf(files, '.devin/rules/a.md')).toEqual(['windsurf']);
    // A value that is not a boolean keeps the default.
    expect(
      readersOf(
        { ...files, '.devin/config.json': json({ read_config_from: { agents_standard: 'no' } }) },
        'AGENTS.md',
      ),
    ).toContain('windsurf');
  });
});

describe('targetedReaders in a rule', () => {
  it("lists the readers the repository's settings add and remove on a finding", () => {
    const files = {
      'AGENTS.md': '',
      '.gemini/settings.json': json({ context: { fileName: 'AGENTS.md' } }),
      '.devin/config.json': json({ read_config_from: { agents_standard: false } }),
    };
    const result = lint(files, { rules: [emptyFileRule], targets: PLATFORM_IDS });
    expect(platformsOf(result)).toEqual([
      ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'gemini'],
    ]);
    // Without the settings, the default readers.
    const plain = lint({ 'AGENTS.md': '' }, { rules: [emptyFileRule], targets: PLATFORM_IDS });
    expect(platformsOf(plain)).toEqual([AGENTS_READERS]);
  });
});
