import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../src/core/config.js';
import {
  type Analysis,
  type AnalyzeOptions,
  analyze,
  runRules,
  type RuleResult,
} from '../../../src/core/engine.js';
import { hash53 } from '../../../src/core/fingerprint.js';
import type { Snapshot } from '../../../src/core/types.js';
import { walk } from '../../../src/io/walk.js';
import { CLAUDE_MAX_FILE_BYTES, loadClaudeCode } from '../../../src/platforms/load/claude-code.js';
import { withSubagents } from '../../../src/platforms/load/subagents.js';
import type { LoadEntry, LoadPlan, SkippedLoad } from '../../../src/platforms/load/types.js';
import { SOURCES } from '../../../src/platforms/sources.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

interface PlanOptions extends SnapshotExtras {
  readonly cwd?: string;
  readonly contextWindow?: number;
  readonly config?: unknown;
  /** Scan without a `.git` entry at the root. */
  readonly noGit?: boolean;
  readonly analyze?: AnalyzeOptions;
  /**
   * Run no rules before planning, for inputs that only the loader needs to see, such as files
   * over 4 MiB. Plans without rule ids only.
   */
  readonly withoutRules?: boolean;
}

interface Planned {
  readonly plan: LoadPlan;
  readonly result: RuleResult;
  readonly analysis: Analysis;
}

/**
 * The local version of the consistency check: every skip that names a rule has an unsuppressed
 * finding of that rule, on that path, for Claude Code.
 */
function expectConsistent(plan: LoadPlan, result: RuleResult): void {
  expect(result.ruleFailures).toEqual([]);
  for (const skip of plan.skipped) {
    if (skip.ruleId === undefined) continue;
    const finding = result.findings.find(
      (candidate) =>
        candidate.suppressed === undefined &&
        candidate.ruleId === skip.ruleId &&
        candidate.path === skip.path &&
        candidate.platforms.includes('claude-code'),
    );
    expect(finding, `${skip.id} has no ${skip.ruleId} finding`).toBeDefined();
  }
}

/** Scans `files` with every built-in rule, then plans Claude Code's load for `options.cwd`. */
function planFor(files: FileMap, options: PlanOptions = {}): Planned {
  const extras: SnapshotExtras = {
    ...options,
    paths: [...(options.noGit === true ? [] : ['.git/HEAD']), ...(options.paths ?? [])],
  };
  const snapshot = snapshotFrom(files, extras);
  return planSnapshot(snapshot, options);
}

function planSnapshot(snapshot: Snapshot, options: PlanOptions = {}): Planned {
  const config = options.config === undefined ? undefined : resolveConfig(options.config);
  const analysis = analyze(snapshot, {
    ...options.analyze,
    ...(config === undefined ? {} : { config }),
  });
  const rules = options.withoutRules === true ? [] : builtinRules;
  const result = runRules(analysis, { rules, trustDirectives: false });
  // The plan as loadPlans assembles it, with the subagents every agent's plan lists.
  const plan = withSubagents(
    loadClaudeCode(analysis, {
      cwd: options.cwd ?? '',
      config: analysis.config,
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
    }),
    analysis,
  );
  if (options.withoutRules === true) {
    expect(plan.skipped.filter((skip) => skip.ruleId !== undefined)).toEqual([]);
  } else {
    expectConsistent(plan, result);
  }
  return { plan, result, analysis };
}

function plan(files: FileMap, options: PlanOptions = {}): LoadPlan {
  return planFor(files, options).plan;
}

/** `position trigger role path`, the shape most tests compare. */
function summary(entries: readonly LoadEntry[]): string[] {
  return entries.map((entry) =>
    [entry.position ?? '-', entry.trigger, entry.role, entry.path].join(' '),
  );
}

function entry(result: LoadPlan, id: string): LoadEntry {
  const found = result.entries.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`No entry ${id}: ${result.entries.map((e) => e.id).join(', ')}`);
  }
  return found;
}

function skips(result: LoadPlan): string[] {
  return result.skipped.map((skip: SkippedLoad) =>
    [skip.id, skip.code, skip.ruleId ?? '-'].join(' '),
  );
}

function limit(result: LoadPlan, key: string) {
  return result.limits.find((candidate) => candidate.key === key);
}

describe('loadClaudeCode: instruction files', () => {
  it('skips instruction files whose names match only when case is ignored', () => {
    const result = plan({
      'claude.md': 'Lower.\n',
      'pkg/Agents.md': 'Mixed.\n',
      'AGENTS.md': 'A.\n',
    });
    expect(skips(result)).toEqual([
      'instructions:claude.md case-mismatch instr/filename-case',
      'instructions:pkg/Agents.md case-mismatch instr/filename-case',
    ]);
    expect(summary(result.entries)).toEqual(['1 startup instructions AGENTS.md']);
  });

  it('loads CLAUDE files from the root down to the working directory, local after CLAUDE.md', () => {
    const result = plan(
      {
        'CLAUDE.md': 'Root.\n',
        'CLAUDE.local.md': 'Mine.\n',
        'pkg/CLAUDE.md': 'Package.\n',
        'pkg/deep/CLAUDE.md': 'Below the working directory.\n',
        'other/CLAUDE.md': 'Another branch.\n',
      },
      { cwd: 'pkg', ignoredFiles: [] },
    );
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup instructions CLAUDE.local.md',
      '3 startup instructions pkg/CLAUDE.md',
      '- on-path instructions other/CLAUDE.md',
      '- on-path instructions pkg/deep/CLAUDE.md',
    ]);
    expect(entry(result, 'instructions:CLAUDE.md').certainty).toBe('documented');
    expect(entry(result, 'instructions:pkg/deep/CLAUDE.md')).toMatchObject({
      patterns: ['pkg/deep/**'],
      certainty: 'documented',
    });
    // Whether Claude Code loads files from another branch of the tree is not documented.
    expect(entry(result, 'instructions:other/CLAUDE.md')).toMatchObject({
      patterns: ['other/**'],
      certainty: 'unverified',
    });
    expect(entry(result, 'instructions:CLAUDE.md')).toMatchObject({
      realPath: 'CLAUDE.md',
      size: { bytes: 6, chars: 6, tokens: 2 },
      evidence: ['claudeMemory'],
    });
  });

  it('marks CLAUDE.md and .claude/CLAUDE.md in one directory as unverified order', () => {
    const result = plan({
      'CLAUDE.md': 'One.\n',
      '.claude/CLAUDE.md': 'Two.\n',
      'CLAUDE.local.md': 'Three.\n',
    });
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup instructions .claude/CLAUDE.md',
      '3 startup instructions CLAUDE.local.md',
    ]);
    expect(result.entries.map((e) => e.certainty)).toEqual([
      'unverified',
      'unverified',
      'documented',
    ]);
    // Alone in its directory, .claude/CLAUDE.md has a documented place.
    expect(plan({ '.claude/CLAUDE.md': 'Two.\n' }).entries[0]?.certainty).toBe('documented');
  });

  it('counts what Claude Code receives: block HTML comments removed', () => {
    const text = '# Title\n\n<!-- maintainer note -->\n\nBody.\n';
    const result = plan({ 'CLAUDE.md': text });
    const size = entry(result, 'instructions:CLAUDE.md').size;
    expect(size).toEqual({
      bytes: text.length,
      chars: text.length - '<!-- maintainer note -->'.length,
      tokens: Math.ceil((text.length - '<!-- maintainer note -->'.length) / 4),
    });
    expect(result.totals.startup).toEqual(size);
  });

  it('reads AGENTS.md only when no CLAUDE file is at or above the working directory', () => {
    const files = {
      'AGENTS.md': 'Root agents.\n',
      'pkg/AGENTS.md': 'Package agents.\n',
      'pkg/sub/AGENTS.md': 'Nested agents.\n',
      'web/AGENTS.md': 'Web agents.\n',
      'web/CLAUDE.md': 'Web claude.\n',
    };
    const root = plan(files);
    expect(summary(root.entries)).toEqual([
      '1 startup instructions AGENTS.md',
      '- on-path instructions pkg/AGENTS.md',
      '- on-path instructions pkg/sub/AGENTS.md',
      '- on-path instructions web/CLAUDE.md',
    ]);
    // A nested AGENTS.md with a CLAUDE file on its path: the rule reports it.
    expect(skips(root)).toEqual([
      'instructions:web/AGENTS.md shadowed-by-claude-md instr/agents-md-ignored-by-claude',
    ]);

    // Starting in web/, a CLAUDE file is on the path, so Claude Code reads no AGENTS.md. The rule
    // judges each AGENTS.md from its own directory, so only web/AGENTS.md carries its id.
    const web = plan(files, { cwd: 'web' });
    expect(summary(web.entries)).toEqual(['1 startup instructions web/CLAUDE.md']);
    expect(skips(web)).toEqual([
      'instructions:AGENTS.md shadowed-by-claude-md -',
      'instructions:pkg/AGENTS.md shadowed-by-claude-md -',
      'instructions:pkg/sub/AGENTS.md shadowed-by-claude-md -',
      'instructions:web/AGENTS.md shadowed-by-claude-md instr/agents-md-ignored-by-claude',
    ]);
  });

  it('loads an AGENTS.md that a CLAUDE file imports instead of skipping it', () => {
    const result = plan({ 'AGENTS.md': 'Shared.\n', 'CLAUDE.md': '@AGENTS.md\n' });
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup import AGENTS.md',
    ]);
    expect(entry(result, 'import:AGENTS.md').via).toEqual(['CLAUDE.md']);
    expect(result.skipped).toEqual([]);
  });

  it('does not treat AGENTS.md under .agents/, in a skill or in a template folder as instructions', () => {
    const result = plan({
      'CLAUDE.md': 'Root.\n',
      '.agents/AGENTS.md': 'Agent folder.\n',
      '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: X.\n---\n',
      '.claude/skills/x/AGENTS.md': 'Reference material.\n',
      'templates/app/AGENTS.md': 'Copied into new projects.\n',
    });
    expect(skips(result)).toEqual([]);
    expect(result.outOfScope).toEqual([
      { path: 'templates/app/AGENTS.md', because: 'payload-folder' },
    ]);
  });

  it('shows the alias path and the real path of a symlinked CLAUDE.md', () => {
    const result = plan(
      { 'AGENTS.md': 'Shared.\n', 'CLAUDE.md': 'Shared.\n' },
      { symlinks: { 'CLAUDE.md': 'AGENTS.md' } },
    );
    expect(result.entries).toHaveLength(1);
    expect(entry(result, 'instructions:CLAUDE.md')).toMatchObject({
      path: 'CLAUDE.md',
      realPath: 'AGENTS.md',
    });
    expect(result.skipped).toEqual([]);
  });

  it('skips a file over 4 MiB, read or seen by the walker', () => {
    const big = `${'x'.repeat(CLAUDE_MAX_FILE_BYTES)}\n`;
    const read = plan({ 'CLAUDE.md': big }, { withoutRules: true });
    expect(read.entries).toEqual([]);
    expect(skips(read)).toEqual(['instructions:CLAUDE.md over-byte-budget -']);
    expect(limit(read, 'claude-code.memory_file_max_bytes')).toMatchObject({
      limit: CLAUDE_MAX_FILE_BYTES,
      used: CLAUDE_MAX_FILE_BYTES + 1,
      subject: 'CLAUDE.md',
      effect: 'skips',
    });

    const snapshot = snapshotFrom({ 'AGENTS.md': 'x\n' }, { paths: ['CLAUDE.md', 'README.md'] });
    const skipped: Snapshot = {
      ...snapshot,
      skipped: [
        { path: 'CLAUDE.md', reason: 'too-large', size: CLAUDE_MAX_FILE_BYTES + 10 },
        { path: 'README.md', reason: 'too-large', size: 2 * 1024 * 1024 },
      ],
    };
    const walked = planSnapshot(skipped).plan;
    // Whether a CLAUDE.md that Claude Code skips still hides AGENTS.md is not known: no claim.
    expect(skips(walked)).toEqual(['instructions:CLAUDE.md over-byte-budget -']);
    expect(walked.entries).toEqual([]);
  });

  it('reports CLAUDE files it cannot see as incomplete and claims nothing about AGENTS.md', () => {
    const result = plan({ 'AGENTS.md': 'Root agents.\n' }, { ignoredFiles: ['CLAUDE.local.md'] });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.incomplete).toEqual(['unread:CLAUDE.local.md']);
  });
});

// Only files agentcheckup classifies are read, so imported files in these tests are named like
// path-specific instruction files (`*.instructions.md`), which it reads wherever they are.
describe('loadClaudeCode: imports', () => {
  it('inlines imports after the importing file, depth first, each file once', () => {
    const result = plan({
      'CLAUDE.md': '@docs/a.instructions.md\n@docs/b.instructions.md\n@docs/a.instructions.md\n',
      'CLAUDE.local.md': '@docs/b.instructions.md\n',
      'docs/a.instructions.md': '@c.instructions.md\n',
      'docs/b.instructions.md': 'B.\n',
      'docs/c.instructions.md': 'C.\n',
    });
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup import docs/a.instructions.md',
      '3 startup import docs/c.instructions.md',
      '4 startup import docs/b.instructions.md',
      '5 startup instructions CLAUDE.local.md',
    ]);
    expect(entry(result, 'import:docs/c.instructions.md').via).toEqual([
      'CLAUDE.md',
      'docs/a.instructions.md',
    ]);
    expect(entry(result, 'import:docs/c.instructions.md').size).toEqual({
      bytes: 3,
      chars: 3,
      tokens: 1,
    });
    expect(limit(result, 'claude-code.import_max_hops')).toMatchObject({
      limit: 4,
      used: 2,
      subject: 'docs/c.instructions.md',
    });
  });

  it('does not follow imports inside HTML comments', () => {
    const result = plan({
      'CLAUDE.md': '<!-- @docs/old.instructions.md -->\n@docs/new.instructions.md\n',
      'docs/old.instructions.md': 'Old.\n',
      'docs/new.instructions.md': 'New.\n',
    });
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup import docs/new.instructions.md',
    ]);
  });

  it('skips an import of a missing file with the rule that reports it', () => {
    const result = plan({ 'CLAUDE.md': 'See @docs/missing.md and @octocat.\n' });
    expect(skips(result)).toEqual([
      'import:CLAUDE.md#docs/missing.md import-unresolved instr/import-unresolved',
    ]);
  });

  it('skips imports that leave the repository, except in CLAUDE.local.md', () => {
    const result = plan({
      'CLAUDE.md':
        '@~/.claude/personal.md\n@/etc/team/rules.md\n@../outside.md\n@/components/Button\n',
      'CLAUDE.local.md': '@~/.claude/mine.md\n',
    });
    expect(skips(result)).toEqual([
      'import:CLAUDE.md#../outside.md import-outside-root instr/import-outside-root',
      'import:CLAUDE.md#/etc/team/rules.md import-outside-root instr/import-outside-root',
      'import:CLAUDE.md#~/.claude/personal.md import-outside-root instr/import-outside-root',
    ]);
    // Without a .git entry, the scan root may not be the repository root.
    const noGit = plan({ 'CLAUDE.md': '@../outside.md\n' }, { noGit: true });
    expect(noGit.skipped).toEqual([]);
  });

  it('follows four hops and skips the fifth with instr/import-depth', () => {
    const name = (i: number): string => `d${String(i)}.instructions.md`;
    const files: Record<string, string> = { 'CLAUDE.md': `@${name(1)}\n` };
    for (let i = 1; i <= 6; i++) files[name(i)] = `@${name(i + 1)}\n`;
    files[name(7)] = 'End.\n';
    const result = plan(files);
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      `2 startup import ${name(1)}`,
      `3 startup import ${name(2)}`,
      `4 startup import ${name(3)}`,
      `5 startup import ${name(4)}`,
    ]);
    expect(skips(result)).toEqual([
      `import:${name(4)}#${name(5)} import-too-deep instr/import-depth`,
    ]);
    expect(entry(result, `import:${name(4)}`).via).toEqual([
      'CLAUDE.md',
      name(1),
      name(2),
      name(3),
    ]);
    expect(limit(result, 'claude-code.import_max_hops')).toMatchObject({
      used: 5,
      subject: name(4),
    });
  });

  it('lists an imported file it did not read without a size, and the plan as incomplete', () => {
    const result = plan(
      {
        'CLAUDE.md': '@README.md\n@package.json\n@node_modules/pkg/GUIDE.md\n@docs/\n@README.md\n',
      },
      { paths: ['README.md', 'package.json', 'docs/x.txt'], opaqueDirectories: ['node_modules/'] },
    );
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup import README.md',
      '3 startup import package.json',
    ]);
    expect(entry(result, 'import:README.md')).toMatchObject({
      realPath: 'README.md',
      via: ['CLAUDE.md'],
      certainty: 'documented',
    });
    expect(entry(result, 'import:README.md').size).toBeUndefined();
    // A path inside a directory that was not listed may exist: incomplete, but no entry.
    expect(result.incomplete).toEqual([
      'unread:README.md',
      'unread:node_modules/pkg/GUIDE.md',
      'unread:package.json',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('follows the imports of AGENTS.md when CLAUDE.md is a symlink to it', () => {
    const text = '@docs/guide.md\n@docs/missing.md\n';
    const result = plan(
      { 'AGENTS.md': text, 'CLAUDE.md': text, 'docs/guide.md': 'Guide.\n' },
      { symlinks: { 'CLAUDE.md': 'AGENTS.md' }, imported: ['docs/guide.md'] },
    );
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup import docs/guide.md',
    ]);
    expect(entry(result, 'import:docs/guide.md')).toMatchObject({
      via: ['CLAUDE.md'],
      size: { bytes: 7, chars: 7, tokens: 2 },
      certainty: 'documented',
    });
    // The skip names the file that holds the import, where the rule reports it.
    expect(skips(result)).toEqual([
      'import:AGENTS.md#docs/missing.md import-unresolved instr/import-unresolved',
    ]);
    expect(result.incomplete).toEqual([]);
  });

  it('resolves imports from a symlinked CLAUDE.md in another directory, as unverified', () => {
    const text = '@notes.md\n@/etc/team/rules.md\n';
    const result = plan(
      { 'AGENTS.md': text, '.claude/CLAUDE.md': text, '.claude/notes.md': 'Notes.\n' },
      { symlinks: { '.claude/CLAUDE.md': 'AGENTS.md' }, imported: ['.claude/notes.md'] },
    );
    expect(result.entries.map((item) => [item.id, item.realPath, item.certainty])).toEqual([
      ['instructions:.claude/CLAUDE.md', 'AGENTS.md', 'documented'],
      ['import:.claude/notes.md', '.claude/notes.md', 'unverified'],
    ]);
    // An absolute path names the same file wherever the link sits.
    expect(result.skipped).toEqual([
      expect.objectContaining({
        id: 'import:AGENTS.md#/etc/team/rules.md',
        code: 'import-outside-root',
        ruleId: 'instr/import-outside-root',
        certainty: 'documented',
      }),
    ]);
  });

  it('expands imports of nested files with the same trigger and patterns', () => {
    const result = plan({
      'CLAUDE.md': 'Root.\n',
      'pkg/CLAUDE.md': '@notes.instructions.md\n',
      'pkg/notes.instructions.md': 'Notes.\n',
    });
    expect(entry(result, 'import:pkg/notes.instructions.md')).toMatchObject({
      trigger: 'on-path',
      patterns: ['pkg/**'],
      via: ['pkg/CLAUDE.md'],
    });
    expect(entry(result, 'import:pkg/notes.instructions.md').position).toBeUndefined();
  });
});

describe('loadClaudeCode: rules', () => {
  it('loads rules without paths at launch and scoped rules on matching files', () => {
    const result = plan({
      '.claude/rules/always.md': 'Always.\n',
      '.claude/rules/scoped.md': '---\npaths:\n  - "src/**/*.ts"\n  - "test/**"\n---\nScoped.\n',
      '.claude/rules/comma.md': '---\npaths: "src/{a,b}/*.ts, docs/**"\n---\nComma.\n',
      '.claude/rules/broken.md': '---\npaths: [unclosed\n---\nBroken YAML.\n',
      '.claude/rules/empty.md': '---\npaths:\n---\nEmpty paths.\n',
    });
    expect(summary(result.entries)).toEqual([
      '1 startup rule .claude/rules/always.md',
      '2 startup rule .claude/rules/broken.md',
      '3 startup rule .claude/rules/empty.md',
      '- on-path rule .claude/rules/comma.md',
      '- on-path rule .claude/rules/scoped.md',
    ]);
    expect(entry(result, 'rule:.claude/rules/scoped.md')).toMatchObject({
      patterns: ['src/**/*.ts', 'test/**'],
      certainty: 'documented',
    });
    expect(entry(result, 'rule:.claude/rules/comma.md').patterns).toEqual([
      'src/{a,b}/*.ts',
      'docs/**',
    ]);
    // Several startup rules in one directory: their order is not documented. What an empty
    // `paths` does is not documented either.
    expect(entry(result, 'rule:.claude/rules/empty.md').certainty).toBe('unverified');
    // Invalid YAML loads the rule at launch (documented); alone it would be documented.
    const alone = plan({ '.claude/rules/broken.md': '---\npaths: [unclosed\n---\nBroken.\n' });
    expect(alone.entries[0]).toMatchObject({ trigger: 'startup', certainty: 'documented' });
  });

  it('marks imports reached only through a rule as unverified', () => {
    const result = plan({
      '.claude/rules/r.md': '@../../docs/guide.md\n@../../docs/missing.md\n',
      'docs/guide.md': 'Guide.\n',
    });
    expect(entry(result, 'import:docs/guide.md').certainty).toBe('unverified');
    expect(result.skipped).toEqual([
      expect.objectContaining({
        code: 'import-unresolved',
        ruleId: 'instr/import-unresolved',
        certainty: 'unverified',
      }),
    ]);
  });

  it("loads rules of another directory's .claude folder on demand, unverified", () => {
    const result = plan({
      'CLAUDE.md': 'Root.\n',
      'pkg/.claude/rules/a.md': 'A.\n',
      'pkg/.claude/rules/b.md': '---\npaths: "lib/**"\n---\nB.\n',
    });
    expect(entry(result, 'rule:pkg/.claude/rules/a.md')).toMatchObject({
      trigger: 'on-path',
      patterns: ['pkg/**'],
      certainty: 'unverified',
    });
    expect(entry(result, 'rule:pkg/.claude/rules/b.md').patterns).toEqual(['lib/**']);
    // Started inside pkg, they are the project's rules.
    const inside = plan(
      { 'pkg/.claude/rules/a.md': 'A.\n', 'pkg/.claude/rules/b.md': '---\npaths: "lib/**"\n---\n' },
      { cwd: 'pkg' },
    );
    expect(summary(inside.entries)).toEqual([
      '1 startup rule pkg/.claude/rules/a.md',
      '- on-path rule pkg/.claude/rules/b.md',
    ]);
  });
});

describe('loadClaudeCode: skills, commands and subagents', () => {
  it('lists skills from the working directory up to the repository root', () => {
    const result = plan(
      {
        '.claude/skills/deploy/SKILL.md':
          '---\nname: deploy\ndescription: Deploys.\nwhen_to_use: On release.\n---\nBody text.\n',
        'pkg/.claude/skills/lint/SKILL.md': '---\ndescription: Lints.\n---\n',
        'pkg/sub/.claude/skills/nested/SKILL.md': '---\ndescription: Nested.\n---\n',
        'other/.claude/skills/far/SKILL.md': '---\ndescription: Far.\n---\n',
        '.claude/skills/deep/inner/SKILL.md': '---\ndescription: Too deep for Claude Code.\n---\n',
        '.agents/skills/codex-only/SKILL.md': '---\ndescription: Codex.\n---\n',
        'CLAUDE.md': 'Root.\n',
      },
      { cwd: 'pkg' },
    );
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup skill .claude/skills/deploy/SKILL.md',
      '3 startup skill pkg/.claude/skills/lint/SKILL.md',
      '- on-path skill other/.claude/skills/far/SKILL.md',
      '- on-path skill pkg/sub/.claude/skills/nested/SKILL.md',
    ]);
    const deploy = entry(result, 'skill:.claude/skills/deploy/SKILL.md');
    expect(deploy).toMatchObject({
      name: 'deploy',
      // The listing holds the name and the description, `when_to_use` appended.
      size: { chars: 'deployDeploys.On release.'.length },
      deferred: { chars: 'Body text.\n'.length },
      certainty: 'documented',
      evidence: ['claudeSkills'],
    });
    expect(entry(result, 'skill:pkg/.claude/skills/lint/SKILL.md').name).toBe('lint');
    expect(entry(result, 'skill:pkg/sub/.claude/skills/nested/SKILL.md')).toMatchObject({
      patterns: ['pkg/sub/**'],
      certainty: 'documented',
    });
    expect(entry(result, 'skill:other/.claude/skills/far/SKILL.md').certainty).toBe('unverified');
  });

  it('leaves a skill the model cannot pick out of the listing: it loads when you run it', () => {
    const result = plan({
      '.claude/skills/deploy/SKILL.md':
        '---\ndescription: Deploys.\ndisable-model-invocation: true\n---\nDeploy steps.\n',
      // Claude Code reads yes, no, on, off, 1 and 0 in any case as booleans, quoted or not.
      '.claude/skills/quoted/SKILL.md':
        '---\ndescription: Quoted.\ndisable-model-invocation: "true"\n---\nBody.\n',
      '.claude/skills/yes/SKILL.md':
        '---\ndescription: Yes.\ndisable-model-invocation: YES\n---\nBody.\n',
      '.claude/skills/one/SKILL.md':
        '---\ndescription: One.\ndisable-model-invocation: 1\n---\nBody.\n',
      '.claude/skills/off/SKILL.md':
        '---\ndescription: Off.\ndisable-model-invocation: Off\n---\nBody.\n',
      // Any other value is not a boolean: the skill stays in the listing.
      '.claude/skills/maybe/SKILL.md':
        '---\ndescription: Maybe.\ndisable-model-invocation: maybe\n---\nBody.\n',
    });
    expect(summary(result.entries)).toEqual([
      '1 startup skill .claude/skills/maybe/SKILL.md',
      '2 startup skill .claude/skills/off/SKILL.md',
      '- manual skill .claude/skills/deploy/SKILL.md',
      '- manual skill .claude/skills/one/SKILL.md',
      '- manual skill .claude/skills/quoted/SKILL.md',
      '- manual skill .claude/skills/yes/SKILL.md',
    ]);
    expect(entry(result, 'skill:.claude/skills/deploy/SKILL.md')).toEqual({
      id: 'skill:.claude/skills/deploy/SKILL.md',
      role: 'skill',
      trigger: 'manual',
      path: '.claude/skills/deploy/SKILL.md',
      realPath: '.claude/skills/deploy/SKILL.md',
      name: 'deploy',
      size: { bytes: 14, chars: 14, tokens: 4 },
      certainty: 'documented',
      evidence: ['claudeSkills'],
    });
    // Only the skills the model can pick are in the startup listing and its limits.
    expect(result.totals.startup.chars).toBe('maybeMaybe.offOff.'.length);
    expect(limit(result, 'claude-code.skill_listing_max_desc_chars')?.subject).toBe(
      '.claude/skills/maybe/SKILL.md',
    );
  });

  it('applies skillOverrides from the settings of the working directory, local over shared', () => {
    const skills = {
      '.claude/skills/a/SKILL.md': '---\ndescription: Alpha.\n---\nA body.\n',
      '.claude/skills/b/SKILL.md': '---\ndescription: Beta.\n---\nB body.\n',
      '.claude/skills/c/SKILL.md': '---\ndescription: Gamma.\n---\nC body.\n',
      '.claude/skills/d/SKILL.md': '---\ndescription: Delta.\n---\nD body.\n',
    };
    const result = plan({
      ...skills,
      '.claude/settings.json': JSON.stringify({
        skillOverrides: { a: 'name-only', b: 'off', c: 'on', d: 'hidden' },
      }),
      '.claude/settings.local.json': JSON.stringify({
        skillOverrides: { b: 'user-invocable-only' },
      }),
    });
    expect(summary(result.entries)).toEqual([
      '1 startup skill .claude/skills/a/SKILL.md',
      '2 startup skill .claude/skills/c/SKILL.md',
      '3 startup skill .claude/skills/d/SKILL.md',
      '- manual skill .claude/skills/b/SKILL.md',
    ]);
    expect(entry(result, 'skill:.claude/skills/a/SKILL.md')).toMatchObject({
      size: { chars: 1 },
      evidence: ['claudeSkills', 'claudeSettings'],
    });
    expect(entry(result, 'skill:.claude/skills/b/SKILL.md').size?.chars).toBe('B body.\n'.length);
    // `hidden` is not one of the four states: the skill is listed as usual.
    expect(entry(result, 'skill:.claude/skills/d/SKILL.md')).toMatchObject({
      size: { chars: 'dDelta.'.length },
      evidence: ['claudeSkills'],
    });
    // A name-only entry's description is not in the listing, so the limit does not measure it.
    expect(limit(result, 'claude-code.skill_listing_budget')?.used).toBe(
      'Gamma.'.length + 'Delta.'.length,
    );

    const off = plan({
      ...skills,
      '.claude/settings.json': JSON.stringify({ skillOverrides: { b: 'off' } }),
    });
    expect(off.skipped).toEqual([
      {
        id: 'skill:.claude/skills/b/SKILL.md#b',
        role: 'skill',
        path: '.claude/skills/b/SKILL.md',
        name: 'b',
        code: 'disabled',
        certainty: 'documented',
        evidence: ['claudeSkills', 'claudeSettings'],
      },
    ]);

    // The settings of another directory do not apply to a session started at the root.
    const elsewhere = plan({
      ...skills,
      'pkg/.claude/settings.json': JSON.stringify({ skillOverrides: { a: 'off' } }),
    });
    expect(elsewhere.skipped).toEqual([]);
    expect(entry(elsewhere, 'skill:.claude/skills/a/SKILL.md').trigger).toBe('startup');
  });

  it('stops at the repository root', () => {
    const result = plan(
      {
        '.claude/skills/outer/SKILL.md': '---\ndescription: Outer.\n---\n',
        'sub/.claude/skills/inner/SKILL.md': '---\ndescription: Inner.\n---\n',
      },
      { cwd: 'sub', paths: ['sub/.git'] },
    );
    expect(result.entries.map((e) => e.path)).toEqual(['sub/.claude/skills/inner/SKILL.md']);
  });

  it('cuts each listing entry at 1,536 characters and applies the documented defaults', () => {
    const long = 'é'.repeat(1500);
    const result = plan({
      '.claude/skills/long/SKILL.md': `---\ndescription: ${long}\nwhen_to_use: ${'w'.repeat(100)}\n---\n`,
      '.claude/skills/bare/SKILL.md': '\n# Bare skill\n\nDoes things.\n',
      '.claude/skills/broken/SKILL.md': '---\ndescription: [unclosed\n---\nBody.\n',
      '.claude/skills/open/SKILL.md': '---\ndescription: never closed\n',
    });
    // The name, then the description cut at 1,536 characters.
    expect(entry(result, 'skill:.claude/skills/long/SKILL.md').size).toEqual({
      bytes: 'long'.length + 1500 * 2 + 36,
      chars: 'long'.length + 1536,
      tokens: Math.ceil(('long'.length + 1536) / 4),
    });
    expect(limit(result, 'claude-code.skill_listing_max_desc_chars')).toMatchObject({
      limit: 1536,
      used: 1600,
      subject: '.claude/skills/long/SKILL.md',
      effect: 'shortens',
    });
    // No frontmatter: the name is the directory and the description the first body line.
    expect(entry(result, 'skill:.claude/skills/bare/SKILL.md')).toMatchObject({
      name: 'bare',
      size: { chars: 'bare# Bare skill'.length },
      certainty: 'documented',
    });
    // YAML that does not parse: the skill loads with no fields.
    expect(entry(result, 'skill:.claude/skills/broken/SKILL.md')).toMatchObject({
      name: 'broken',
      size: { chars: 'broken'.length },
      deferred: { chars: 'Body.\n'.length },
    });
    expect(entry(result, 'skill:.claude/skills/open/SKILL.md').certainty).toBe('unverified');
    // The listing is computed for the working directory, the scan root here.
    expect(limit(result, 'claude-code.skill_listing_budget')).toMatchObject({
      unit: 'chars',
      limit: null,
      used: 1536 + '# Bare skill'.length + '---'.length,
      subject: '',
      label: 'skills listing',
    });
    expect(limit(result, 'claude-code.skill_listing_max_desc_chars')?.label).toBeUndefined();
  });

  it('derives the listing budget from the context window', () => {
    const files = { '.claude/skills/a/SKILL.md': '---\ndescription: A.\n---\n' };
    expect(
      limit(plan(files, { contextWindow: 200_000 }), 'claude-code.skill_listing_budget'),
    ).toMatchObject({ limit: 8000, used: 2 });
  });

  it('loads commands when invoked and lists subagents from the start', () => {
    const result = plan({
      '.claude/commands/review.md': '---\ndescription: Review.\n---\nReview the diff.\n',
      '.claude/commands/git/commit.md': 'Commit.\n',
      '.claude/agents/reviewer.md':
        '---\nname: reviewer\ndescription: Reviews code.\n---\nPrompt.\n',
      '.claude/agents/broken.md': '---\nname: -bad\ndescription: Starts with a dash.\n---\n',
      '.claude/agents/README.md': '# Our agents\n',
      'pkg/.claude/agents/far.md': '---\nname: far\ndescription: Far.\n---\n',
    });
    expect(entry(result, 'command:.claude/commands/review.md')).toMatchObject({
      trigger: 'manual',
      name: 'review',
      size: { chars: 'Review the diff.\n'.length },
      certainty: 'documented',
    });
    expect(entry(result, 'command:.claude/commands/git/commit.md').name).toBe('git/commit');
    // The model picks a subagent by its name and description, which are in context from the
    // start; what the subagent itself starts with goes to a window of its own.
    expect(entry(result, 'subagent:.claude/agents/reviewer.md')).toMatchObject({
      trigger: 'startup',
      name: 'reviewer',
      size: { chars: 'reviewerReviews code.'.length },
      certainty: 'documented',
      evidence: ['claudeSubagents'],
    });
    expect(entry(result, 'subagent:.claude/agents/reviewer.md').position).toBeUndefined();
    expect(result.totals.startup.chars).toBe('reviewerReviews code.'.length);
    expect(skips(result)).toEqual([
      'subagent:.claude/agents/broken.md invalid-subagent instr/subagent-invalid',
    ]);
    // Claude Code walks up from the working directory: a folder below it is not read.
    expect(result.outOfScope).toEqual([
      { path: '.claude/agents/README.md', because: 'documentation' },
      { path: 'pkg/.claude/agents/far.md', because: 'below-start-dir' },
    ]);
    expect(limit(result, 'claude-code.agent_descriptions_tokens')).toEqual({
      key: 'claude-code.agent_descriptions_tokens',
      label: 'subagents listing',
      unit: 'tokens',
      limit: 15_000,
      used: Math.ceil('reviewerReviews code.'.length / 4),
      subject: '',
      effect: 'advice',
      evidence: ['claudeSubagents'],
    });
  });

  it('lists a subagent with YAML that lenient readers accept as unverified', () => {
    const result = plan({
      '.claude/agents/lenient.md': '---\nname: lenient\ndescription: Use when: reviewing\n---\n',
    });
    expect(entry(result, 'subagent:.claude/agents/lenient.md')).toMatchObject({
      trigger: 'startup',
      certainty: 'unverified',
    });
    // What it lists is not known.
    expect(entry(result, 'subagent:.claude/agents/lenient.md').size).toBeUndefined();
    expect(result.skipped).toEqual([]);
  });

  it("lists a subagent only Claude Code's own reader reads as unverified, not as skipped", () => {
    const result = plan({
      '.claude/agents/repeated.md': '---\nname: a\nname: repeated\ndescription: d\n---\n',
      '.claude/agents/retried.md': '---\nname: retried\ndescription: @mention a reviewer\n---\n',
      '.claude/agents/inline.md': '---\nname: inline\ndescription: Reviews --- and more\n',
    });
    for (const name of ['inline', 'repeated', 'retried']) {
      expect(entry(result, `subagent:.claude/agents/${name}.md`).certainty).toBe('unverified');
    }
    expect(result.skipped).toEqual([]);
  });
});

describe('loadClaudeCode: subagents through a symlink', () => {
  // `.claude/agents -> ../.github/agents`: Claude Code follows the link and reads each Copilot
  // agent file as a subagent, though the engine folds it into the Copilot artifact.
  const symlinks = {
    '.claude/agents/fix.agent.md': '.github/agents/fix.agent.md',
    '.claude/agents/broken.agent.md': '.github/agents/broken.agent.md',
  };
  const fix = '---\nname: fix\ndescription: Fixes issues.\n---\nFix it.\n';
  const broken = '---\ndescription: No name.\n---\n';
  const files = {
    '.github/agents/fix.agent.md': fix,
    '.github/agents/broken.agent.md': broken,
    '.github/agents/plain.agent.md': '---\nname: plain\ndescription: Copilot only.\n---\n',
    // A symlink reads its target's bytes.
    '.claude/agents/fix.agent.md': fix,
    '.claude/agents/broken.agent.md': broken,
  };

  it('lists the subagent at the path Claude Code reads it from', () => {
    const analysis = analyze(snapshotFrom(files, { paths: ['.git/HEAD'], symlinks }));
    const result = runRules(analysis, { rules: builtinRules, trustDirectives: false });
    const planned = withSubagents(
      loadClaudeCode(analysis, { cwd: '', config: analysis.config }),
      analysis,
    );
    expect(entry(planned, 'subagent:.claude/agents/fix.agent.md')).toMatchObject({
      path: '.claude/agents/fix.agent.md',
      realPath: '.github/agents/fix.agent.md',
      name: 'fix',
      certainty: 'documented',
    });
    expect(skips(planned)).toEqual([
      'subagent:.claude/agents/broken.agent.md invalid-subagent instr/subagent-invalid',
    ]);
    // The rule reports on the file it reads, the real one, and names the path Claude Code reads.
    expect(
      result.findings
        .filter((finding) => finding.ruleId === 'instr/subagent-invalid')
        .map((finding) => [finding.path, finding.message]),
    ).toEqual([
      [
        '.github/agents/broken.agent.md',
        'The frontmatter has no "name", so Claude Code treats this file as documentation and does not load the subagent. Claude Code reads this file as ".claude/agents/broken.agent.md".',
      ],
    ]);
    // A Copilot agent file no symlink reaches is not a subagent.
    expect(planned.entries.some((item) => item.path.includes('plain'))).toBe(false);
  });
});

describe('loadClaudeCode: MCP servers and hooks', () => {
  const mcp = JSON.stringify({
    mcpServers: {
      local: { command: 'npx', args: ['-y', 'server@1.0.0'] },
      remote: { type: 'http', url: 'https://example.com/mcp' },
      docs: { url: 'https://docs.example.com/mcp' },
    },
  });

  it('lists .mcp.json servers after approval and skips a url without a type', () => {
    const result = plan({ '.mcp.json': mcp });
    expect(summary(result.entries)).toEqual([
      '- on-approval mcp-server .mcp.json',
      '- on-approval mcp-server .mcp.json',
    ]);
    expect(entry(result, 'mcp-server:.mcp.json#local')).toMatchObject({
      name: 'local',
      inventoryId: 'mcp:.mcp.json#local',
      certainty: 'documented',
      evidence: ['claudeMcp'],
    });
    expect(entry(result, 'mcp-server:.mcp.json#local').size).toBeUndefined();
    expect(skips(result)).toEqual([
      'mcp-server:.mcp.json#docs url-without-type mcp/url-without-type',
    ]);
  });

  it('marks servers and hooks above the working directory as unverified', () => {
    const result = plan(
      {
        '.mcp.json': mcp,
        'pkg/sub/.mcp.json': JSON.stringify({ mcpServers: { below: { command: 'x' } } }),
        '.claude/settings.json': JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
        }),
        'pkg/sub/.claude/settings.json': '{}',
      },
      { cwd: 'pkg' },
    );
    expect(entry(result, 'mcp-server:.mcp.json#local').certainty).toBe('unverified');
    expect(result.entries.filter((e) => e.role === 'hook').map((e) => e.certainty)).toEqual([
      'unverified',
    ]);
    expect(result.outOfScope).toEqual([
      { path: 'pkg/sub/.claude/settings.json', because: 'below-start-dir' },
      { path: 'pkg/sub/.mcp.json', because: 'below-start-dir' },
    ]);
  });

  it("leaves another agent's plugin out and skips a file that does not parse", () => {
    const result = plan({
      '.mcp.json': '{ "mcpServers": { "a": { "command": "x" } }, }',
      '.claude/settings.json': '{ "hooks": ',
    });
    expect(skips(result)).toEqual([
      'hook:.claude/settings.json invalid-json json/invalid-syntax',
      'mcp-server:.mcp.json invalid-json json/invalid-syntax',
    ]);
    // Claude Code does not document how it treats a trailing comma in .mcp.json.
    expect(result.skipped.map((skip) => skip.certainty)).toEqual(['documented', 'unverified']);

    const plugin = plan(
      { '.mcp.json': mcp, '.codex-plugin/plugin.json': '{ "name": "p" }' },
      { noGit: true },
    );
    expect(plugin.entries).toEqual([]);
    expect(plugin.outOfScope).toEqual([{ path: '.mcp.json', because: 'other-agent-plugin' }]);
  });

  it('lists hooks with inventory ids and skips unknown events', () => {
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: './guard.sh' }] },
        ],
        preToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }],
      },
    });
    const result = plan({
      '.claude/settings.json': settings,
      '.claude/settings.local.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://x' }] }] },
      }),
    });
    const hooks = result.entries.filter((e) => e.role === 'hook');
    expect(hooks.map((hook) => [hook.name, hook.trigger, hook.inventoryId])).toEqual([
      [
        'PreToolUse',
        'on-approval',
        `hook:.claude/settings.json#PreToolUse:${hash53('./guard.sh').slice(-8)}`,
      ],
      [
        'PreToolUse',
        'on-approval',
        `hook:.claude/settings.json#PreToolUse:${hash53('./guard.sh').slice(-8)}:2`,
      ],
      ['Stop', 'on-approval', expect.stringMatching(/^hook:\.claude\/settings\.local\.json#Stop:/)],
    ]);
    expect(hooks.every((hook) => hook.id === hook.inventoryId)).toBe(true);
    expect(skips(result)).toEqual([
      'hook:.claude/settings.json#preToolUse unknown-event hooks/unknown-event',
    ]);
  });
});

describe('loadClaudeCode: plan', () => {
  it('states its assumptions, the scopes it cannot see and its sources', () => {
    const result = plan({ 'CLAUDE.md': 'x\n' });
    expect(result.agent).toBe('claude-code');
    expect(result.cwd).toBe('');
    expect(result.assumptions).toEqual([
      expect.objectContaining({
        key: 'claude-code.instructions_mode',
        value: 'claude-md-or-agents-md',
      }),
      expect.objectContaining({ key: 'claude-code.min_version', value: '2.1.277' }),
      expect.objectContaining({ key: 'claude-code.session', value: 'interactive' }),
      expect.objectContaining({ key: 'claude-code.workspace_trusted', value: true }),
    ]);
    expect(result.hidden.map((scope) => scope.scope)).toEqual([
      'account',
      'managed',
      'plugin',
      'user',
    ]);
    const user = result.hidden.find((scope) => scope.scope === 'user');
    expect(user?.locations).toEqual(
      expect.arrayContaining(['~/.claude/CLAUDE.md', '~/.claude.json']),
    );
    for (const scope of result.hidden) {
      expect(scope.locations).toEqual([...scope.locations].sort());
      expect(scope.roles).toEqual([...scope.roles].sort());
    }
    const keys = new Set(Object.keys(SOURCES));
    const cited = [
      ...result.entries.flatMap((e) => e.evidence),
      ...result.assumptions.flatMap((a) => a.evidence),
      ...result.limits.flatMap((l) => l.evidence),
    ];
    for (const key of cited) expect(keys.has(key)).toBe(true);
  });

  it('records the context window and the configured line limit as assumptions', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${String(i)}.`).join('\n');
    const result = plan(
      { 'CLAUDE.md': lines },
      {
        contextWindow: 1_000_000,
        config: { rules: { 'instr/claude-md-too-long': ['info', { maxLines: 50 }] } },
      },
    );
    expect(result.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'claude-code.context_window',
          value: 1_000_000,
          origin: 'flag',
        }),
        expect.objectContaining({
          key: 'claude-code.memory_file_lines',
          value: 50,
          origin: 'rule-option',
        }),
      ]),
    );
    expect(limit(result, 'claude-code.memory_file_lines')).toMatchObject({
      limit: 50,
      used: 60,
      subject: 'CLAUDE.md',
      effect: 'advice',
    });
    expect(limit(plan({ 'CLAUDE.md': lines }), 'claude-code.memory_file_lines')?.limit).toBe(200);
  });

  it('adds skill bodies and every other trigger to the on-demand total', () => {
    const result = plan({
      'CLAUDE.md': 'abcd\n',
      'pkg/CLAUDE.md': 'efgh\n',
      '.claude/skills/s/SKILL.md': '---\ndescription: Desc.\n---\nBody\n',
    });
    // CLAUDE.md (5) and the listing, `s` and `Desc.` (6).
    expect(result.totals.startup).toEqual({ bytes: 11, chars: 11, tokens: 3 });
    expect(result.totals.onDemand).toEqual({ bytes: 10, chars: 10, tokens: 3 });
  });

  it('reports a file the Markdown budget cut short as incomplete', () => {
    const { plan: cut } = planFor(
      { 'CLAUDE.md': `${'Text. '.repeat(50)}\n@docs/a.md\n`, 'docs/a.md': 'A.\n' },
      { analyze: { markdownBudget: 20 } },
    );
    expect(cut.incomplete).toContain('markdown-budget:CLAUDE.md');
  });
});

describe('loadClaudeCode: the context fixture', () => {
  async function fixturePlans(): Promise<{ root: Planned; api: Planned }> {
    const directory = fileURLToPath(new URL('../../fixtures/context', import.meta.url));
    const walked = await walk(directory);
    // As in test/core/golden.test.ts: scanned as a checkout with a .git directory at the root.
    const snapshot: Snapshot = {
      ...walked,
      paths: new Set([...walked.paths, '.git/']),
      opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
    };
    return { root: planSnapshot(snapshot), api: planSnapshot(snapshot, { cwd: 'packages/api' }) };
  }

  it('plans a session at the root and in packages/api', async () => {
    const { root, api } = await fixturePlans();
    expect(summary(root.plan.entries.filter((e) => e.trigger === 'startup'))).toEqual([
      '1 startup instructions AGENTS.md',
      '2 startup rule .claude/rules/style.md',
      '3 startup skill .claude/skills/release/SKILL.md',
      '4 startup skill .claude/skills/triage/SKILL.md',
    ]);
    expect(entry(root.plan, 'import:packages/web/AGENTS.md')).toMatchObject({
      trigger: 'on-path',
      via: ['packages/web/CLAUDE.md'],
    });
    expect(entry(root.plan, 'import:.github/copilot-instructions.md').via).toEqual([
      'packages/web/CLAUDE.md',
      'packages/web/AGENTS.md',
    ]);
    expect(entry(root.plan, 'rule:.claude/rules/testing.md').patterns).toEqual(['**/*.test.ts']);
    expect(entry(root.plan, 'skill:packages/web/.claude/skills/storybook/SKILL.md').trigger).toBe(
      'on-path',
    );
    expect(entry(root.plan, 'mcp-server:.mcp.json#github').inventoryId).toBe(
      'mcp:.mcp.json#github',
    );
    expect(skips(root.plan)).toEqual([
      'hook:.claude/settings.json#BeforeCommit unknown-event hooks/unknown-event',
      'import:.github/copilot-instructions.md#../docs/release-checklist.md import-unresolved instr/import-unresolved',
      'mcp-server:.mcp.json#docs url-without-type mcp/url-without-type',
      'instructions:packages/api/AGENTS.md shadowed-by-claude-md instr/agents-md-ignored-by-claude',
      'instructions:packages/api/src/handlers/AGENTS.md shadowed-by-claude-md instr/agents-md-ignored-by-claude',
    ]);
    expect(root.plan.incomplete).toEqual([]);

    expect(summary(api.plan.entries.filter((e) => e.trigger === 'startup'))).toEqual([
      '1 startup rule .claude/rules/style.md',
      '2 startup instructions packages/api/CLAUDE.md',
      '3 startup skill .claude/skills/release/SKILL.md',
      '4 startup skill .claude/skills/triage/SKILL.md',
    ]);
    expect(
      api.plan.skipped.filter((skip) => skip.code === 'shadowed-by-claude-md').map((s) => s.path),
    ).toEqual([
      'AGENTS.md',
      'packages/api/AGENTS.md',
      'packages/api/src/handlers/AGENTS.md',
      'services/AGENTS.md',
      'services/billing/AGENTS.md',
      'services/billing/ledger/AGENTS.md',
      'services/billing/ledger/export/AGENTS.md',
      'tools/AGENTS.md',
    ]);
    expect(entry(api.plan, 'mcp-server:.mcp.json#github').certainty).toBe('unverified');
  });

  it('at the root, every loading finding for Claude Code has its skip', async () => {
    const { root } = await fixturePlans();
    const reported = new Set(
      root.plan.skipped.flatMap((skip) =>
        skip.ruleId === undefined ? [] : [`${skip.ruleId} ${skip.path}`],
      ),
    );
    const loadingRules = new Set(root.plan.skipped.flatMap((skip) => skip.ruleId ?? []));
    const findings = root.result.findings.filter(
      (finding) => loadingRules.has(finding.ruleId) && finding.platforms.includes('claude-code'),
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(reported).toContain(`${finding.ruleId} ${finding.path}`);
  });
});

describe('loadClaudeCode: determinism and hostile input', () => {
  const files: FileMap = {
    'CLAUDE.md': '@docs/a.instructions.md\n@docs/b.instructions.md\n',
    'docs/a.instructions.md': '@b.instructions.md\n',
    'docs/b.instructions.md': '@a.instructions.md\n',
    'AGENTS.md': 'Shadowed.\n',
    'pkg/CLAUDE.md': 'Pkg.\n',
    'pkg/AGENTS.md': 'Shadowed too.\n',
    '.claude/rules/x.md': 'X.\n',
    '.claude/rules/y.md': '---\npaths: "**/*.ts"\n---\n',
    '.claude/skills/b/SKILL.md': '---\ndescription: B.\n---\n',
    '.claude/skills/a/SKILL.md': '---\ndescription: A.\n---\n',
    '.claude/agents/bad.md': '---\nname: bad\n---\n',
    '.mcp.json': '{"mcpServers":{"z":{"command":"z"},"a":{"command":"a"},"u":{"url":"https://u"}}}',
    '.claude/settings.json':
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}],"Nope":[]}}',
  };

  it('gives the same plan for shuffled input', () => {
    const snapshot = snapshotFrom(files, { paths: ['.git/HEAD'] });
    const shuffled: Snapshot = {
      ...snapshot,
      files: [...snapshot.files].reverse(),
      paths: new Set([...snapshot.paths].reverse()),
    };
    const a = planSnapshot(snapshot).plan;
    const b = planSnapshot(shuffled).plan;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const analysis = analyze(snapshot);
    runRules(analysis, { rules: builtinRules });
    const twice = [0, 1].map(() =>
      JSON.stringify(loadClaudeCode(analysis, { cwd: '', config: analysis.config })),
    );
    expect(twice[1]).toBe(twice[0]);
    expect(a.entries.map((e) => e.id.replace(/:[0-9a-f]{8}$/, ''))).toEqual([
      'instructions:CLAUDE.md',
      'import:docs/a.instructions.md',
      'import:docs/b.instructions.md',
      'rule:.claude/rules/x.md',
      'skill:.claude/skills/a/SKILL.md',
      'skill:.claude/skills/b/SKILL.md',
      'rule:.claude/rules/y.md',
      'instructions:pkg/CLAUDE.md',
      'hook:.claude/settings.json#Stop',
      'mcp-server:.mcp.json#a',
      'mcp-server:.mcp.json#z',
    ]);
    expect(skips(a)).toEqual([
      'subagent:.claude/agents/bad.md invalid-subagent instr/subagent-invalid',
      'hook:.claude/settings.json#Nope unknown-event hooks/unknown-event',
      'mcp-server:.mcp.json#u url-without-type mcp/url-without-type',
      'instructions:AGENTS.md shadowed-by-claude-md instr/agents-md-ignored-by-claude',
      'instructions:pkg/AGENTS.md shadowed-by-claude-md instr/agents-md-ignored-by-claude',
    ]);
  });

  it('survives import cycles and self-imports', () => {
    const result = plan({
      'CLAUDE.md': '@CLAUDE.md\n@a.instructions.md\n',
      'a.instructions.md': '@b.instructions.md\n@a.instructions.md\n',
      'b.instructions.md': '@a.instructions.md\n@CLAUDE.md\n',
    });
    expect(summary(result.entries)).toEqual([
      '1 startup instructions CLAUDE.md',
      '2 startup import a.instructions.md',
      '3 startup import b.instructions.md',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('stays fast on long chains and wide import graphs', () => {
    const name = (i: number): string => `c${String(i)}.instructions.md`;
    const chain: Record<string, string> = { 'CLAUDE.md': `@${name(0)}\n` };
    for (let i = 0; i < 2000; i++) chain[name(i)] = `@${name(i + 1)}\n`;
    const started = performance.now();
    const long = plan(chain);
    expect(long.entries).toHaveLength(5);
    expect(skips(long)).toEqual([
      `import:${name(3)}#${name(4)} import-too-deep instr/import-depth`,
    ]);

    const wide: Record<string, string> = {};
    const names = Array.from({ length: 120 }, (_, i) => `w${String(i)}.instructions.md`);
    const imports = names.map((file) => `@${file}`).join('\n');
    wide['CLAUDE.md'] = imports;
    for (const file of names) wide[file] = imports;
    const dense = plan(wide);
    expect(dense.entries).toHaveLength(121);
    expect(dense.skipped).toEqual([]);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it('marks the plan incomplete when the import search runs out of budget', () => {
    const names = Array.from({ length: 120 }, (_, i) => `w${String(i)}.instructions.md`);
    const files: Record<string, string> = {};
    for (const file of names) files[file] = names.map((target) => `@${target}`).join('\n');
    // Each nested CLAUDE.md reaches the whole clique: 14,400 imports per search.
    for (let i = 0; i < 16; i++) files[`p${String(i)}/CLAUDE.md`] = `@../${names[0] ?? ''}\n`;
    const result = plan(files);
    expect(result.entries).toHaveLength(16 + 120);
    expect(result.incomplete.some((item) => item.startsWith('import-budget:'))).toBe(true);
  });

  it('skips an imported file over 4 MiB without reading its imports', () => {
    const big = `@more.instructions.md\n${'x'.repeat(CLAUDE_MAX_FILE_BYTES)}`;
    const result = plan(
      {
        'CLAUDE.md': '@big.instructions.md\n',
        'big.instructions.md': big,
        'more.instructions.md': 'More.\n',
      },
      { withoutRules: true },
    );
    expect(summary(result.entries)).toEqual(['1 startup instructions CLAUDE.md']);
    expect(skips(result)).toEqual(['import:big.instructions.md over-byte-budget -']);
  });
});

describe('loadClaudeCode: edge cases', () => {
  it('reads rule frontmatter the way Claude Code does', () => {
    const result = plan({
      '.claude/rules/fields.md': '---\ndescription: Not read by Claude Code.\n---\nText.\n',
    });
    expect(result.entries[0]).toMatchObject({ trigger: 'startup', certainty: 'documented' });
    const open = plan({ '.claude/rules/open.md': '---\npaths: "src/**"\nText.\n' });
    expect(open.entries[0]).toMatchObject({ trigger: 'startup', certainty: 'unverified' });
  });

  it('ignores files that are not where Claude Code looks', () => {
    const result = plan({
      'AGENTS.md': 'Root.\n',
      '.agents/AGENTS.md': 'Agent folder.\n',
      'pkg/Claude.md': 'Case variant.\n',
      'pkg/.claude/CLAUDE.local.md': 'Not a documented location.\n',
      'examples/demo/AGENTS.md': 'Example.\n',
      'templates/.claude/rules/r.md': 'Template rule.\n',
      'templates/.claude/skills/t/SKILL.md': '---\ndescription: T.\n---\n',
      'examples/.claude/commands/c.md': 'Example command.\n',
    });
    expect(summary(result.entries)).toEqual(['1 startup instructions AGENTS.md']);
    expect(result.outOfScope).toEqual([
      { path: 'examples/.claude/commands/c.md', because: 'payload-folder' },
      { path: 'examples/demo/AGENTS.md', because: 'payload-folder' },
      { path: 'templates/.claude/rules/r.md', because: 'payload-folder' },
      { path: 'templates/.claude/skills/t/SKILL.md', because: 'payload-folder' },
    ]);
  });

  it('claims nothing about an AGENTS.md whose CLAUDE files it cannot see', () => {
    const result = plan(
      { 'AGENTS.md': 'Root.\n', 'pkg/AGENTS.md': 'Package.\n' },
      { ignoredFiles: ['pkg/CLAUDE.local.md', 'web/AGENTS.md'], paths: ['web/x.ts'] },
    );
    expect(summary(result.entries)).toEqual(['1 startup instructions AGENTS.md']);
    expect(result.skipped).toEqual([]);
    expect(result.incomplete).toEqual(['unread:pkg/CLAUDE.local.md']);
    const inWeb = plan({ 'AGENTS.md': 'Root.\n' }, { cwd: 'web', ignoredFiles: ['web/AGENTS.md'] });
    expect(inWeb.incomplete).toEqual(['unread:web/AGENTS.md']);
  });

  it('loads a nested file once when an import already loaded it', () => {
    const result = plan({ 'AGENTS.md': '@pkg/CLAUDE.md\n', 'pkg/CLAUDE.md': 'Package.\n' });
    expect(summary(result.entries)).toEqual([
      '1 startup instructions AGENTS.md',
      '2 startup import pkg/CLAUDE.md',
    ]);
  });

  it('keeps a skip the rule does not report, without its id', () => {
    // The rule does not judge a chain through a file it did not read (README.md may import).
    const name = (i: number): string => `d${String(i)}.instructions.md`;
    const files: Record<string, string> = { 'CLAUDE.md': `@README.md\n@${name(1)}\n` };
    for (let i = 1; i <= 5; i++) files[name(i)] = `@${name(i + 1)}\n`;
    files[name(6)] = 'End.\n';
    const deep = plan(files, { paths: ['README.md'] });
    expect(skips(deep)).toEqual([`import:${name(4)}#${name(5)} import-too-deep -`]);

    // Files in a template folder resolve their imports in the projects they are copied into.
    const template = plan(
      { 'templates/app/CLAUDE.md': '@docs/missing.md\n' },
      { cwd: 'templates/app' },
    );
    expect(skips(template)).toEqual([
      'import:templates/app/CLAUDE.md#docs/missing.md import-unresolved -',
    ]);
  });

  it('lists an unread import of a nested file on demand', () => {
    const result = plan({ 'pkg/CLAUDE.md': '@README.md\n' }, { paths: ['pkg/README.md'] });
    expect(entry(result, 'import:pkg/README.md')).toMatchObject({
      trigger: 'on-path',
      patterns: ['pkg/**'],
      via: ['pkg/CLAUDE.md'],
    });
    expect(entry(result, 'import:pkg/README.md').position).toBeUndefined();
  });

  it('lists a skill under the path Claude Code reaches it by', () => {
    const skill = '---\nname: shared\ndescription: Shared.\n---\n';
    const result = plan(
      { '.agents/skills/shared/SKILL.md': skill, '.claude/skills/shared/SKILL.md': skill },
      { symlinks: { '.claude/skills/shared/SKILL.md': '.agents/skills/shared/SKILL.md' } },
    );
    expect(entry(result, 'skill:.claude/skills/shared/SKILL.md')).toMatchObject({
      trigger: 'startup',
      realPath: '.agents/skills/shared/SKILL.md',
      name: 'shared',
    });
  });

  it("marks another directory's commands as unverified", () => {
    const result = plan({ 'pkg/.claude/commands/x.md': 'X.\n' });
    expect(entry(result, 'command:pkg/.claude/commands/x.md')).toMatchObject({
      trigger: 'manual',
      name: 'x',
      certainty: 'unverified',
    });
  });

  it('flags config files it could not read or parse', () => {
    const deep = `{"mcpServers":${'['.repeat(600)}${']'.repeat(600)}}`;
    const result = plan(
      {
        '.mcp.json': deep,
        'pkg/.mcp.json': '{}',
        'pkg/.codex-plugin/plugin.json': '{"name":"p"}',
      },
      { ignoredFiles: ['.claude/settings.local.json'], noGit: true },
    );
    expect(result.incomplete).toEqual(['unparsed:.mcp.json', 'unread:.claude/settings.local.json']);
    expect(result.skipped).toEqual([]);
    expect(result.outOfScope).toEqual([{ path: 'pkg/.mcp.json', because: 'other-agent-plugin' }]);
  });
});
