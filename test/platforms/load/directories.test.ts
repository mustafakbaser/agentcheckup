import { describe, expect, it } from 'vitest';
import { analyze, scanWithContext } from '../../../src/core/engine.js';
import { PLATFORM_IDS } from '../../../src/core/types.js';
import {
  MAX_START_DIRECTORIES,
  startDirectories,
} from '../../../src/platforms/load/directories.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';

function directoriesOf(files: FileMap, symlinks: Record<string, string> = {}): string[] {
  return startDirectories(analyze(snapshotFrom(files, { paths: ['.git/HEAD'], symlinks })));
}

describe('startDirectories', () => {
  it('finds the directories that hold an instruction file or own agent configuration', () => {
    expect(
      directoriesOf({
        'CLAUDE.md': 'Root.\n',
        'packages/api/AGENTS.md': 'API.\n',
        'packages/web/.cursor/rules/style.mdc': '---\ndescription: Style.\n---\nStyle.\n',
        'services/billing/.claude/skills/pay/SKILL.md': '---\ndescription: Pay.\n---\nPay.\n',
        'apps/mobile/GEMINI.md': 'Mobile.\n',
        // Owned by the root, which is always planned, and by `docs`, which holds no configuration.
        '.claude/CLAUDE.md': 'Root too.\n',
        '.github/copilot-instructions.md': 'Copilot.\n',
        'docs/guide.md': 'Not agent configuration.\n',
      }),
    ).toEqual(['apps/mobile', 'packages/api', 'packages/web', 'services/billing']);
  });

  it("counts a file under the configuration folder's owner, not under the folder", () => {
    expect(directoriesOf({ 'pkg/.claude/CLAUDE.md': 'Pkg.\n' })).toEqual(['pkg']);
  });

  it('finds a directory through any path that reaches its file', () => {
    expect(
      directoriesOf(
        { 'shared/AGENTS.md': 'Shared.\n', 'pkg/AGENTS.md': 'Shared.\n' },
        { 'pkg/AGENTS.md': 'shared/AGENTS.md' },
      ),
    ).toEqual(['pkg', 'shared']);
  });

  it('finds none in a repository with configuration at the root only', () => {
    expect(directoriesOf({ 'CLAUDE.md': 'Root.\n', '.claude/settings.json': '{}' })).toEqual([]);
  });
});

describe('scanWithContext with start directories', () => {
  const scan = (files: FileMap, options: { cwd?: string; matrix?: boolean } = {}) =>
    scanWithContext(snapshotFrom(files, { paths: ['.git/HEAD'] }), {
      rules: builtinRules,
      trustDirectives: false,
      targets: PLATFORM_IDS,
      agents: ['claude-code', 'codex'],
      startDirectories: true,
      ...options,
    });

  it('plans every agent at the root, and keeps the totals of each start directory', () => {
    const { context } = scan({
      'CLAUDE.md': 'Root.\n',
      'pkg/CLAUDE.md': 'Pkg.\n',
      'pkg/AGENTS.md': 'Agents.\n',
    });
    // The plans of the root only: a start directory keeps its totals, not its plans.
    expect(context.plans.map((plan) => [plan.agent, plan.cwd])).toEqual([
      ['claude-code', ''],
      ['codex', ''],
    ]);
    const chars = (text: string): { bytes: number; chars: number; tokens: number } => ({
      bytes: text.length,
      chars: text.length,
      tokens: Math.ceil(text.length / 4),
    });
    expect(context.directories).toEqual({
      planned: [
        {
          cwd: 'pkg',
          agents: [
            // The root's CLAUDE.md and the package's, as a session in pkg loads them.
            { agent: 'claude-code', startup: chars('Root.\nPkg.\n'), unverified: false },
            { agent: 'codex', startup: chars('Agents.\n'), unverified: false },
          ],
        },
      ],
      notPlanned: 0,
    });
  });

  it(`plans at most ${String(MAX_START_DIRECTORIES)} directories, in path order, and counts the rest`, () => {
    const files: Record<string, string> = { 'CLAUDE.md': 'Root.\n' };
    for (let i = 0; i < MAX_START_DIRECTORIES + 2; i++) {
      files[`pkg/${String(i).padStart(3, '0')}/CLAUDE.md`] = 'Package.\n';
    }
    const { context } = scan(files);
    expect(context.directories?.planned).toHaveLength(MAX_START_DIRECTORIES);
    expect(context.directories?.planned.at(-1)?.cwd).toBe(
      `pkg/${String(MAX_START_DIRECTORIES - 1).padStart(3, '0')}`,
    );
    expect(context.directories?.notPlanned).toBe(2);
  });

  it('takes them from the root, without the matrix', () => {
    expect(() => scan({ 'CLAUDE.md': 'Root.\n' }, { cwd: 'pkg' })).toThrow(/from the root/);
    expect(() => scan({ 'CLAUDE.md': 'Root.\n' }, { matrix: true })).toThrow(/from the root/);
  });
});
