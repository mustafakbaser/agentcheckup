/**
 * The GitHub Copilot load plans (src/platforms/load/copilot.ts): Copilot CLI, Copilot in VS Code
 * and Copilot cloud agent, on the fixture repository test/fixtures/copilot and on small
 * repositories built in memory.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/compare.js';
import { analyze, type Analysis, type RuleResult, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { buildInventory } from '../../../src/inventory/build.js';
import { walk } from '../../../src/io/walk.js';
import {
  loadCopilotCli,
  loadCopilotCloud,
  loadCopilotVscode,
} from '../../../src/platforms/load/copilot.js';
import type { LoadEntry, LoadPlan } from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

const SCAN = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;

interface Built {
  readonly cli: LoadPlan;
  readonly vscode: LoadPlan;
  readonly cloud: LoadPlan;
  readonly result: RuleResult;
  readonly analysis: Analysis;
}

/** Rules first, then the three loaders over the same analysis, as the engine runs them. */
function buildFrom(snapshot: Snapshot, cwd = ''): Built {
  const analysis = analyze(snapshot, SCAN);
  const result = runRules(analysis, SCAN);
  expect(result.ruleFailures).toEqual([]);
  const options = { cwd, config: analysis.config };
  return {
    cli: loadCopilotCli(analysis, options),
    vscode: loadCopilotVscode(analysis, options),
    cloud: loadCopilotCloud(analysis, options),
    result,
    analysis,
  };
}

function build(files: FileMap, extras: SnapshotExtras = {}, cwd = ''): Built {
  return buildFrom(
    snapshotFrom(files, { ...extras, paths: ['.git/HEAD', ...(extras.paths ?? [])] }),
    cwd,
  );
}

async function fixture(cwd = ''): Promise<Built> {
  const walked = await walk(fileURLToPath(new URL('../../fixtures/copilot', import.meta.url)));
  return buildFrom(
    {
      ...walked,
      paths: new Set([...walked.paths, '.git/']),
      opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
    },
    cwd,
  );
}

/** `position id trigger certainty` of each entry, in plan order. */
function entries(plan: LoadPlan): string[] {
  return plan.entries.map(
    (e) =>
      `${e.position === undefined ? '-' : String(e.position)} ${e.id} ${e.trigger} ${e.certainty}`,
  );
}

/** `id code rule certainty` of each skip. */
function skips(plan: LoadPlan): string[] {
  return plan.skipped.map((s) => `${s.id} ${s.code} ${s.ruleId ?? '-'} ${s.certainty}`);
}

function entry(plan: LoadPlan, id: string): LoadEntry | undefined {
  return plan.entries.find((candidate) => candidate.id === id);
}

function plans({ cli, vscode, cloud }: Built): LoadPlan[] {
  return [cli, vscode, cloud];
}

/**
 * Every skip that names a rule has an unsuppressed finding of that rule on the same file that
 * lists Copilot; every other skip uses a code no rule reports.
 */
function expectSkipsReported(built: Built): void {
  for (const plan of plans(built)) {
    for (const skip of plan.skipped) {
      if (skip.ruleId === undefined) {
        expect(['not-read', 'disabled', 'shadowed-by-preferred']).toContain(skip.code);
        continue;
      }
      const path = built.analysis.index.get(skip.path)?.path ?? skip.path;
      const found = built.result.findings.some(
        (finding) =>
          finding.ruleId === skip.ruleId &&
          finding.path === path &&
          finding.suppressed === undefined &&
          finding.platforms.includes('copilot'),
      );
      expect(found, `${plan.agent}: ${skip.ruleId} on ${path}`).toBe(true);
    }
  }
}

function expectWellFormed(built: Built): void {
  const inventory = buildInventory(built.analysis);
  const ids = new Set([...inventory.mcpServers, ...inventory.hooks].map((item) => item.id));
  for (const plan of plans(built)) {
    const byPathId = (a: { path: string; id: string }, b: { path: string; id: string }): number =>
      compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
    expect([...plan.skipped].sort(byPathId)).toEqual(plan.skipped);
    expect([...plan.incomplete].sort(compareStrings)).toEqual(plan.incomplete);
    expect(new Set(plan.entries.map((e) => e.id)).size).toBe(plan.entries.length);
    const positions = plan.entries.flatMap((e) => (e.position === undefined ? [] : [e.position]));
    expect(positions).toEqual(positions.map((_, i) => i + 1));
    for (const item of plan.entries) {
      expect(item.evidence.length).toBeGreaterThan(0);
      // Copilot documents no order: a position is never documented.
      if (item.position !== undefined) expect(item.certainty).toBe('unverified');
      if (item.inventoryId !== undefined) expect(ids, item.id).toContain(item.inventoryId);
    }
    for (const skip of plan.skipped) expect(skip.evidence.length).toBeGreaterThan(0);
    for (const scope of plan.hidden) {
      for (const location of scope.locations) expect(location.startsWith('/')).toBe(false);
    }
  }
}

describe('the fixture repository, a session at the root', () => {
  it('copilot-cli: the standard locations, references, nested files, skills, MCP and hooks', async () => {
    const { cli } = await fixture();
    expect(entries(cli)).toEqual([
      '1 instructions:.github/copilot-instructions.md startup unverified',
      '2 instructions:AGENTS.md startup unverified',
      '3 import:docs/guide.md startup unverified',
      '4 instructions:CLAUDE.md startup unverified',
      '5 instructions:.claude/CLAUDE.md startup unverified',
      '6 instructions:GEMINI.md startup unverified',
      '7 skill:.agents/skills/manual/SKILL.md startup unverified',
      '8 skill:.agents/skills/notes/SKILL.md startup unverified',
      '9 skill:.claude/skills/deploy/SKILL.md startup unverified',
      '10 skill:.github/skills/Bad/SKILL.md startup unverified',
      '- rule:.github/instructions/review.instructions.md on-path documented',
      '- rule:.github/instructions/typescript.instructions.md on-path documented',
      '- instructions:pkg/.github/copilot-instructions.md on-path documented',
      '- instructions:pkg/AGENTS.md on-path documented',
      '- instructions:pkg/CLAUDE.md on-path documented',
      '- hook:.claude/settings.json#PreToolUse:447fbfea on-approval documented',
      '- hook:.github/copilot/settings.json#agentStop:c532ca1a on-approval documented',
      '- hook:.github/hooks/policy.json#SessionStart:113bcac5 on-approval documented',
      '- hook:.github/hooks/policy.json#notification:c532ca1a on-approval documented',
      '- hook:.github/hooks/policy.json#preToolUse:c532ca1a on-approval documented',
      '- mcp-server:.github/mcp.json#tracker on-approval documented',
      '- mcp-server:.mcp.json#docs on-approval documented',
      '- mcp-server:.mcp.json#shared on-approval documented',
      '- rule:.github/instructions/list.instructions.md unknown unverified',
      '- rule:.github/instructions/manual.instructions.md unknown unverified',
      '- rule:.github/instructions/sql.instructions.md unknown unverified',
    ]);
    expect(skips(cli)).toEqual([
      'hook:.claude/settings.json#PostToolBatch:447fbfea not-read - unverified',
      'hook:.github/hooks/broken.json invalid-json json/invalid-syntax documented',
      'hook:.github/hooks/future.json not-read - documented',
      'hook:.github/hooks/policy.json#beforeCommit:c532ca1a not-read - unverified',
      'mcp-server:.github/mcp.json#shared shadowed-by-preferred - documented',
      'instructions:.github/prompts/copilot-instructions.md wrong-location copilot/instructions-misplaced documented',
      'import:AGENTS.md#~/personal.md not-read - documented',
      'instructions:blank/AGENTS.md blank-file instr/empty-file unverified',
      'instructions:lib/Agents.md case-mismatch instr/filename-case unverified',
    ]);
    // GEMINI.md's own reference is not expanded; AGENTS.md's is, once.
    expect(entry(cli, 'import:docs/guide.md')?.via).toEqual(['AGENTS.md']);
    expect(entry(cli, 'instructions:pkg/AGENTS.md')?.patterns).toEqual(['pkg/**']);
    expect(entry(cli, 'rule:.github/instructions/typescript.instructions.md')?.patterns).toEqual([
      '**/*.ts',
      '**/*.tsx',
    ]);
    // pkg/CLAUDE.md is a copy of pkg/AGENTS.md: the CLI drops identical copies.
    expect(entry(cli, 'instructions:pkg/CLAUDE.md')?.size?.chars).toBe(0);
    expect(
      cli.limits.map((limit) => `${limit.key} ${String(limit.limit)} ${limit.subject}`),
    ).toEqual(['copilot-cli.import_max_hops null docs/guide.md']);
  });

  it('copilot-vscode: the workspace root, .claude/rules, description and manual files', async () => {
    const { vscode } = await fixture();
    expect(entries(vscode)).toEqual([
      '1 instructions:.github/copilot-instructions.md startup unverified',
      '2 instructions:AGENTS.md startup unverified',
      '3 instructions:CLAUDE.md startup unverified',
      '4 instructions:.claude/CLAUDE.md startup unverified',
      '5 instructions:CLAUDE.local.md startup unverified',
      '6 skill:.claude/skills/deploy/SKILL.md startup unverified',
      '- rule:.claude/rules/testing.md on-path documented',
      '- rule:.github/instructions/review.instructions.md on-path documented',
      '- rule:.github/instructions/typescript.instructions.md on-path documented',
      '- rule:.github/instructions/sql.instructions.md model-selected documented',
      '- skill:.agents/skills/manual/SKILL.md manual documented',
      '- rule:.github/instructions/manual.instructions.md manual documented',
      '- hook:.github/hooks/policy.json#SessionStart:113bcac5 on-approval documented',
      '- hook:.github/hooks/policy.json#notification:c532ca1a on-approval unverified',
      '- hook:.github/hooks/policy.json#preToolUse:c532ca1a on-approval unverified',
      '- mcp-server:.mcp.json#docs on-approval documented',
      '- mcp-server:.mcp.json#shared on-approval documented',
      '- mcp-server:.vscode/mcp.json#browser on-approval documented',
      '- rule:.github/instructions/list.instructions.md unknown unverified',
    ]);
    expect(skips(vscode)).toEqual([
      'skill:.agents/skills/notes/SKILL.md#release-notes invalid-frontmatter skill/name-dir-mismatch unverified',
      'hook:.claude/settings.json not-read - documented',
      'hook:.github/hooks/broken.json invalid-json json/invalid-syntax documented',
      'hook:.github/hooks/future.json not-read - documented',
      'hook:.github/hooks/policy.json#beforeCommit:c532ca1a not-read - unverified',
      'instructions:.github/prompts/copilot-instructions.md wrong-location copilot/instructions-misplaced documented',
      'skill:.github/skills/Bad/SKILL.md#Bad invalid-frontmatter skill/name-format documented',
      'instructions:blank/AGENTS.md not-read - documented',
      'instructions:lib/Agents.md not-read - documented',
      'instructions:pkg/.github/copilot-instructions.md wrong-location copilot/instructions-misplaced documented',
      'instructions:pkg/AGENTS.md not-read - documented',
    ]);
    expect(entry(vscode, 'rule:.claude/rules/testing.md')?.patterns).toEqual(['**/*.test.ts']);
    expect(
      vscode.limits.map((limit) => `${limit.key} ${String(limit.used)}/${String(limit.limit)}`),
    ).toEqual(['vscode.skill_description_max_chars 47/1024', 'vscode.skill_name_max_chars 13/64']);
  });

  it('copilot-cloud: applyTo only, excludeAgent, the root files and the nearest AGENTS.md', async () => {
    const { cloud } = await fixture();
    expect(entries(cloud)).toEqual([
      '1 instructions:.github/copilot-instructions.md startup unverified',
      '2 instructions:AGENTS.md startup unverified',
      '3 instructions:CLAUDE.md startup unverified',
      '4 instructions:GEMINI.md startup unverified',
      '5 skill:.agents/skills/manual/SKILL.md startup unverified',
      '6 skill:.agents/skills/notes/SKILL.md startup unverified',
      '7 skill:.claude/skills/deploy/SKILL.md startup unverified',
      '8 skill:.github/skills/Bad/SKILL.md startup unverified',
      '- hook:.github/hooks/policy.json#SessionStart:113bcac5 startup unverified',
      '- hook:.github/hooks/policy.json#preToolUse:c532ca1a startup documented',
      '- rule:.github/instructions/typescript.instructions.md on-path documented',
      '- instructions:pkg/AGENTS.md on-path documented',
      '- rule:.github/instructions/list.instructions.md unknown unverified',
    ]);
    expect(skips(cloud)).toEqual([
      'hook:.github/hooks/broken.json invalid-json json/invalid-syntax documented',
      'hook:.github/hooks/future.json not-read - documented',
      'hook:.github/hooks/policy.json#beforeCommit:c532ca1a not-read - unverified',
      'hook:.github/hooks/policy.json#notification:c532ca1a not-read - documented',
      'rule:.github/instructions/manual.instructions.md no-apply-to copilot/apply-to documented',
      'rule:.github/instructions/review.instructions.md not-read - documented',
      'rule:.github/instructions/sql.instructions.md no-apply-to copilot/apply-to documented',
      'instructions:.github/prompts/copilot-instructions.md wrong-location copilot/instructions-misplaced documented',
      'instructions:blank/AGENTS.md blank-file instr/empty-file unverified',
      'instructions:lib/Agents.md case-mismatch instr/filename-case unverified',
      'instructions:pkg/.github/copilot-instructions.md wrong-location copilot/instructions-misplaced documented',
    ]);
    expect(
      cloud.limits.map((limit) => `${limit.key} ${String(limit.limit)} ${limit.effect}`),
    ).toEqual(['copilot.code_review_instruction_lines 1000 advice']);
  });

  it('agrees with the findings, resolves every inventory id and keeps lists sorted', async () => {
    const built = await fixture();
    expectSkipsReported(built);
    expectWellFormed(built);
  });

  it('never reads files that are not Copilot configuration', async () => {
    const built = await fixture();
    for (const plan of plans(built)) {
      const mentioned = [
        ...plan.entries.map((e) => e.path),
        ...plan.skipped.map((s) => s.path),
        ...plan.incomplete,
      ];
      for (const path of [
        '.cursorrules',
        '.codex/skills/codex-only/SKILL.md',
        'scripts/guard.sh',
      ]) {
        expect(mentioned, `${plan.agent} ${path}`).not.toContain(path);
      }
      // A document that only shares the suffix is not meant for Copilot.
      expect(plan.outOfScope).toContainEqual({
        path: 'docs/notes.instructions.md',
        because: 'documentation',
      });
    }
    // VS Code does not read GEMINI.md.
    expect(built.vscode.entries.map((e) => e.path)).not.toContain('GEMINI.md');
  });

  it('states its assumptions and the scopes it cannot see, per surface', async () => {
    const { cli, vscode, cloud } = await fixture();
    expect(cli.assumptions.map((a) => `${a.key}=${String(a.value)}`)).toEqual([
      'copilot.surface=cli',
      'copilot-cli.trusted_folder=true',
    ]);
    expect(vscode.assumptions.map((a) => `${a.key}=${String(a.value)}`)).toEqual([
      'copilot.surface=vscode',
      'vscode.agent_harness=local',
      'vscode.chat.useAgentsMdFile=true',
      'vscode.chat.useClaudeHooks=false',
      'vscode.chat.useClaudeMdFile=true',
      'vscode.chat.useNestedAgentsMdFiles=false',
      'vscode.github.copilot.chat.codeGeneration.useInstructionFiles=true',
      'vscode.workspace_trusted=true',
    ]);
    expect(cloud.assumptions.map((a) => `${a.key}=${String(a.value)}`)).toEqual([
      'copilot.surface=cloud-agent',
    ]);
    expect(cli.hidden.flatMap((scope) => scope.locations)).toContain('~/.copilot/mcp-config.json');
    expect(vscode.hidden.flatMap((scope) => scope.locations)).toContain('~/.claude/skills/');
    expect(cloud.hidden.map((scope) => scope.scope)).toEqual(['account']);
    expect(cloud.hidden[0]?.locations).toContain(
      'cloud agent MCP configuration (repository settings)',
    );
  });
});

describe('the fixture repository, a session in pkg', () => {
  it('copilot-cli reads every standard location from the root down to pkg at startup', async () => {
    const { cli } = await fixture('pkg');
    expect(entries(cli).slice(0, 9)).toEqual([
      '1 instructions:.github/copilot-instructions.md startup unverified',
      '2 instructions:AGENTS.md startup unverified',
      '3 import:docs/guide.md startup unverified',
      '4 instructions:CLAUDE.md startup unverified',
      '5 instructions:.claude/CLAUDE.md startup unverified',
      '6 instructions:GEMINI.md startup unverified',
      '7 instructions:pkg/.github/copilot-instructions.md startup unverified',
      '8 instructions:pkg/AGENTS.md startup unverified',
      '9 instructions:pkg/CLAUDE.md startup unverified',
    ]);
    expect(cli.skipped.map((s) => s.path)).not.toContain('pkg/.github/copilot-instructions.md');
  });

  it('copilot-vscode sees only the workspace folder', async () => {
    const { vscode } = await fixture('pkg');
    expect(entries(vscode)).toEqual([
      '1 instructions:pkg/.github/copilot-instructions.md startup unverified',
      '2 instructions:pkg/AGENTS.md startup unverified',
      '3 instructions:pkg/CLAUDE.md startup unverified',
    ]);
    expect(vscode.skipped).toEqual([]);
    // VS Code keeps both copies: it documents no deduplication.
    expect(entry(vscode, 'instructions:pkg/CLAUDE.md')?.size?.chars).toBeGreaterThan(0);
  });

  it('copilot-cloud takes the AGENTS.md nearest to the directory it works in at startup', async () => {
    const { cloud } = await fixture('pkg');
    expect(entries(cloud).slice(0, 5)).toEqual([
      '1 instructions:.github/copilot-instructions.md startup unverified',
      '2 instructions:AGENTS.md startup unverified',
      '3 instructions:CLAUDE.md startup unverified',
      '4 instructions:GEMINI.md startup unverified',
      '5 instructions:pkg/AGENTS.md startup unverified',
    ]);
  });
});

describe('instruction files', () => {
  it('skips a .github folder whose letter case differs on every surface', () => {
    const built = build({
      '.GitHub/copilot-instructions.md': 'Wrong case.\n',
      '.github/instructions/x.instructions.md': '---\napplyTo: "**"\n---\nX.\n',
    });
    for (const plan of plans(built)) {
      expect(skips(plan), plan.agent).toEqual([
        'instructions:.GitHub/copilot-instructions.md case-mismatch copilot/instructions-misplaced unverified',
      ]);
    }
    expectSkipsReported(built);
  });

  it('follows CLI references depth first, once each, inside the repository only', () => {
    const { cli, vscode, cloud } = build(
      {
        '.github/copilot-instructions.md': '@../a.md\n@/etc/passwd\n@../../outside.md\n',
        'a.md': 'A.\n@b.md\n',
        'b.md': 'B.\n@a.md\n@c.md\n',
        'c.md': 'C.\n',
        'AGENTS.md': '@README.md\n@c.md\n',
      },
      // The walker reads the files instruction files import; README.md it did not read.
      { paths: ['README.md'], imported: ['a.md', 'b.md', 'c.md'] },
    );
    expect(entries(cli)).toEqual([
      '1 instructions:.github/copilot-instructions.md startup unverified',
      '2 import:a.md startup unverified',
      '3 import:b.md startup unverified',
      '4 import:c.md startup unverified',
      '5 instructions:AGENTS.md startup unverified',
      '6 import:README.md startup unverified',
    ]);
    expect(entry(cli, 'import:c.md')?.via).toEqual([
      '.github/copilot-instructions.md',
      'a.md',
      'b.md',
    ]);
    // README.md exists but was not read: listed without a size, and its references are unknown.
    expect(entry(cli, 'import:README.md')?.size).toBeUndefined();
    expect(cli.incomplete).toEqual(['unread:README.md']);
    expect(skips(cli)).toEqual([
      'import:.github/copilot-instructions.md#../../outside.md not-read - documented',
      'import:.github/copilot-instructions.md#/etc/passwd not-read - documented',
    ]);
    expect(cli.limits[0]).toMatchObject({
      key: 'copilot-cli.import_max_hops',
      used: 3,
      limit: null,
    });
    // VS Code and the cloud agent do not expand references.
    for (const plan of [vscode, cloud]) {
      expect(plan.entries.filter((e) => e.role === 'import')).toEqual([]);
    }
  });

  it('reads path-specific files at the repository root and the working directory, not between', () => {
    const files = {
      '.github/instructions/root.instructions.md': '---\napplyTo: "**"\n---\nRoot.\n',
      'pkg/.github/instructions/pkg.instructions.md': '---\napplyTo: "**"\n---\nPkg.\n',
    };
    const atPkg = build(files, {}, 'pkg').cli;
    expect(entries(atPkg)).toEqual([
      '- rule:.github/instructions/root.instructions.md on-path documented',
      '- rule:pkg/.github/instructions/pkg.instructions.md on-path documented',
    ]);
    const below = build(files, { paths: ['pkg/sub/x.ts'] }, 'pkg/sub');
    expect(entries(below.cli)).toEqual([
      '- rule:.github/instructions/root.instructions.md on-path documented',
    ]);
    expect(skips(below.cli)).toEqual([
      'rule:pkg/.github/instructions/pkg.instructions.md wrong-location copilot/instructions-misplaced documented',
    ]);
    expectSkipsReported(below);
  });

  it('the cloud agent: no applyTo comes first, then excludeAgent; old values are unverified', () => {
    const { cloud } = build({
      '.github/instructions/both.instructions.md': '---\nexcludeAgent: "cloud-agent"\n---\nBoth.\n',
      '.github/instructions/old.instructions.md':
        '---\napplyTo: "**"\nexcludeAgent: "coding-agent"\n---\nOld.\n',
      '.github/instructions/code-review.instructions.md':
        '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nNot for review.\n',
      '.github/instructions/unquoted.instructions.md': '---\napplyTo: **/*.ts\n---\nTolerated.\n',
    });
    expect(entries(cloud)).toEqual([
      '- rule:.github/instructions/code-review.instructions.md on-path documented',
      '- rule:.github/instructions/old.instructions.md on-path unverified',
      '- rule:.github/instructions/unquoted.instructions.md unknown unverified',
    ]);
    expect(skips(cloud)).toEqual([
      'rule:.github/instructions/both.instructions.md no-apply-to copilot/apply-to documented',
    ]);
  });

  it('VS Code reads .claude/rules: paths, every file without them, and undocumented forms', () => {
    const { vscode, cli, cloud } = build({
      '.claude/rules/all.md': 'No frontmatter.\n',
      '.claude/rules/string.md': '---\npaths: "src/**, test/**"\n---\nString.\n',
      '.claude/rules/broken.md': '---\npaths: [unclosed\n---\nBroken.\n',
      '.claude/rules/deep/nested.md': '---\npaths:\n  - "a/**"\n---\nNested.\n',
      '.claude/rules/number.md': '---\npaths: 5\n---\nNumber.\n',
      '.claude/rules/braces.md': '---\npaths: "src/{a,b}/**, c/**"\n---\nBraces.\n',
    });
    expect(entries(vscode)).toEqual([
      '- rule:.claude/rules/all.md on-path documented',
      '- rule:.claude/rules/braces.md on-path unverified',
      '- rule:.claude/rules/deep/nested.md on-path unverified',
      '- rule:.claude/rules/string.md on-path unverified',
      '- rule:.claude/rules/broken.md unknown unverified',
      '- rule:.claude/rules/number.md unknown unverified',
    ]);
    expect(entry(vscode, 'rule:.claude/rules/braces.md')?.patterns).toEqual([
      'src/{a,b}/**',
      'c/**',
    ]);
    expect(entry(vscode, 'rule:.claude/rules/all.md')?.patterns).toEqual(['**']);
    expect(entry(vscode, 'rule:.claude/rules/string.md')?.patterns).toEqual(['src/**', 'test/**']);
    expect(cli.entries).toEqual([]);
    expect(cloud.entries).toEqual([]);
  });

  it('keeps a blank file no rule reports for Copilot: VS Code loads CLAUDE.local.md as it is', () => {
    const built = build({ 'CLAUDE.local.md': '\n', 'AGENTS.md': '' });
    expect(entries(built.vscode)).toEqual(['1 instructions:CLAUDE.local.md startup unverified']);
    expect(skips(built.vscode)).toEqual([
      'instructions:AGENTS.md blank-file instr/empty-file unverified',
    ]);
    expectSkipsReported(built);
  });

  it('loads a copy once on the CLI: a symlink, an identical file, a file it already imported', () => {
    const built = build(
      {
        'AGENTS.md': 'Shared rules.\n@GEMINI.md\n',
        'CLAUDE.md': 'Shared rules.\n@GEMINI.md\n',
        'GEMINI.md': 'Gemini.\n',
        'pkg/AGENTS.md': 'Package.\n',
        'pkg/CLAUDE.md': 'Package.\n',
        'notes/agents-link': 'Package.\n',
      },
      { symlinks: { 'pkg/CLAUDE.md': 'pkg/AGENTS.md', 'notes/agents-link': 'pkg/AGENTS.md' } },
    );
    expect(entries(built.cli)).toEqual([
      '1 instructions:AGENTS.md startup unverified',
      '2 import:GEMINI.md startup unverified',
      '3 instructions:CLAUDE.md startup unverified',
      '- instructions:pkg/AGENTS.md on-path documented',
      '- instructions:pkg/CLAUDE.md on-path documented',
    ]);
    expect(built.cli.entries.map((e) => e.size?.chars)).toEqual([25, 8, 0, 9, 0]);
    // VS Code documents no deduplication: both root files count in full.
    expect(entries(built.vscode)).toEqual([
      '1 instructions:AGENTS.md startup unverified',
      '2 instructions:CLAUDE.md startup unverified',
    ]);
    expect(built.vscode.entries.map((e) => e.size?.chars)).toEqual([25, 25]);
  });

  it('flags instruction files it would read that the walk did not', () => {
    const { cli, vscode, cloud } = build(
      { 'AGENTS.md': 'Root.\n' },
      {
        paths: ['pkg/GEMINI.md', '.github/copilot-instructions.md'],
        opaqueDirectories: ['.github/skills/'],
      },
    );
    expect(cli.incomplete).toEqual([
      'unread:.github/copilot-instructions.md',
      'unread:.github/skills/',
      'unread:pkg/GEMINI.md',
    ]);
    expect(vscode.incomplete).toEqual([
      'unread:.github/copilot-instructions.md',
      'unread:.github/skills/',
    ]);
    expect(cloud.incomplete).toEqual([
      'unread:.github/copilot-instructions.md',
      'unread:.github/skills/',
    ]);
  });

  it('flags configuration files each surface would read that the walk did not', () => {
    const unread = [
      '.claude/rules/r.md',
      '.claude/settings.json',
      '.github/copilot/settings.json',
      '.github/hooks/h.json',
      '.github/instructions/x.instructions.md',
      '.github/mcp.json',
      '.github/skills/s/SKILL.md',
      '.mcp.json',
      '.vscode/mcp.json',
      'docs/y.instructions.md',
    ];
    const { cli, vscode, cloud } = build({ 'AGENTS.md': 'Root.\n' }, { paths: unread });
    const files = (plan: LoadPlan): string[] => plan.incomplete.map((item) => item.slice(7));
    expect(files(cli)).toEqual([
      '.claude/settings.json',
      '.github/copilot/settings.json',
      '.github/hooks/h.json',
      '.github/instructions/x.instructions.md',
      '.github/mcp.json',
      '.github/skills/s/SKILL.md',
      '.mcp.json',
    ]);
    expect(files(vscode)).toEqual([
      '.claude/rules/r.md',
      '.claude/settings.json',
      '.github/hooks/h.json',
      '.github/instructions/x.instructions.md',
      '.github/skills/s/SKILL.md',
      '.mcp.json',
      '.vscode/mcp.json',
    ]);
    expect(files(cloud)).toEqual([
      '.github/hooks/h.json',
      '.github/instructions/x.instructions.md',
      '.github/skills/s/SKILL.md',
    ]);
  });
});

describe('skills', () => {
  const SKILL = (name: string, extra = ''): string =>
    `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\nBody.\n`;

  it('lists skills of the repository root on every surface; nested roots start elsewhere', () => {
    const { cli, vscode, cloud } = build({
      '.github/skills/a/SKILL.md': SKILL('a'),
      'pkg/.claude/skills/b/SKILL.md': SKILL('b'),
      '.cursor/skills/c/SKILL.md': SKILL('c'),
    });
    for (const plan of [cli, vscode, cloud]) {
      expect(entries(plan)).toEqual(['1 skill:.github/skills/a/SKILL.md startup unverified']);
      expect(entry(plan, 'skill:.github/skills/a/SKILL.md')?.deferred?.chars).toBe(6);
    }
    expect(cli.outOfScope).toEqual([
      { path: 'pkg/.claude/skills/b/SKILL.md', because: 'below-start-dir' },
    ]);
    expect(vscode.outOfScope).toEqual(cli.outOfScope);
    expect(cloud.outOfScope).toEqual([]);
  });

  it('reads skills between the root and the working directory on the CLI only, unverified', () => {
    const { cli, vscode, cloud } = build(
      {
        'pkg/.agents/skills/p/SKILL.md': SKILL('p'),
        'other/.agents/skills/o/SKILL.md': SKILL('o'),
        '.agents/skills/r/SKILL.md': SKILL('r'),
        // A skill at .claude itself makes the skills below it its resources.
        '.claude/SKILL.md': SKILL('claude'),
        '.claude/skills/inner/SKILL.md': SKILL('inner'),
      },
      {},
      'pkg',
    );
    expect(entries(cli)).toEqual([
      '1 skill:.agents/skills/r/SKILL.md startup unverified',
      '2 skill:pkg/.agents/skills/p/SKILL.md startup unverified',
    ]);
    // VS Code opens pkg as the workspace; the cloud agent reads the repository root.
    expect(entries(vscode)).toEqual(['1 skill:pkg/.agents/skills/p/SKILL.md startup unverified']);
    expect(entries(cloud)).toEqual(['1 skill:.agents/skills/r/SKILL.md startup unverified']);
    // A SKILL.md inside another skill is one of its resources.
    expect(cloud.outOfScope).toEqual([
      { path: '.claude/skills/inner/SKILL.md', because: 'payload-folder' },
    ]);
  });

  it('VS Code skips a skill whose name it rejects, and one that is off for both model and user', () => {
    const long = 'x'.repeat(65);
    const built = build({
      [`.github/skills/${long}/SKILL.md`]: SKILL(long),
      '.github/skills/off/SKILL.md': SKILL(
        'off',
        'disable-model-invocation: true\nuser-invocable: false\n',
      ),
      '.github/skills/templates/SKILL.md': SKILL('other'),
    });
    expect(skips(built.vscode)).toEqual([
      'skill:.github/skills/off/SKILL.md#off disabled - documented',
      `skill:.github/skills/${long}/SKILL.md#${long} invalid-frontmatter skill/name-format unverified`,
    ]);
    // No rule judges a skill in a template folder: listed, as no finding says otherwise.
    expect(entries(built.vscode)).toEqual([
      '1 skill:.github/skills/templates/SKILL.md startup unverified',
    ]);
    expect(built.cli.skipped).toEqual([]);
    expectSkipsReported(built);
  });
});

describe('MCP servers', () => {
  const server = (name: string): string =>
    `"${name}": { "command": "npx", "args": ["-y", "${name}@1.0.0"] }`;

  it('the CLI walks up from the working directory; the closer file wins a name', () => {
    const { cli, vscode, cloud } = build(
      {
        '.mcp.json': `{ "mcpServers": { ${server('a')}, ${server('b')} } }`,
        '.github/mcp.json': `{ ${server('a')}, ${server('c')} }`,
        'pkg/.mcp.json': `{ "mcpServers": { ${server('b')}, "remote": { "url": "https://r.example.com" } } }`,
        '.vscode/mcp.json': `{ "servers": { ${server('v')} } }`,
      },
      {},
      'pkg',
    );
    expect(entries(cli)).toEqual([
      '- mcp-server:.github/mcp.json#c on-approval documented',
      '- mcp-server:.mcp.json#a on-approval documented',
      '- mcp-server:pkg/.mcp.json#b on-approval documented',
      '- mcp-server:pkg/.mcp.json#remote on-approval unverified',
    ]);
    expect(skips(cli)).toEqual([
      'mcp-server:.github/mcp.json#a shadowed-by-preferred - documented',
      'mcp-server:.mcp.json#b shadowed-by-preferred - documented',
    ]);
    // VS Code reads its workspace folder only; the cloud agent's servers are not in the repository.
    expect(vscode.entries.filter((e) => e.role === 'mcp-server').map((e) => e.id)).toEqual([
      'mcp-server:pkg/.mcp.json#b',
      'mcp-server:pkg/.mcp.json#remote',
    ]);
    expect(cloud.entries).toEqual([]);
  });

  it('marks files it cannot parse incomplete, and nested ones out of scope', () => {
    const { cli, vscode } = build({
      '.vscode/mcp.json': '{ // VS Code allows comments\n "servers": {} }',
      '.github/mcp.json': '{',
      'pkg/.mcp.json': `{ "mcpServers": { ${server('p')} } }`,
      'pkg/.vscode/mcp.json': `{ "servers": { ${server('q')} } }`,
    });
    expect(cli.incomplete).toEqual(['unparsed:.github/mcp.json']);
    expect(cli.outOfScope).toEqual([{ path: 'pkg/.mcp.json', because: 'below-start-dir' }]);
    expect(vscode.incomplete).toEqual(['unparsed:.vscode/mcp.json']);
    expect(vscode.outOfScope).toEqual([
      { path: 'pkg/.vscode/mcp.json', because: 'below-start-dir' },
    ]);
  });
});

describe('hooks', () => {
  it('skips a hooks file that does not parse, and leaves settings files to their rules', () => {
    const built = build({
      '.github/hooks/commas.json': '{ "version": 1, "hooks": { "sessionStart": [], }, }',
      '.github/copilot/settings.json': '{',
      '.claude/settings.json': '{',
      'pkg/.github/hooks/nested.json': '{',
    });
    expect(skips(built.cli)).toEqual([
      'hook:.github/hooks/commas.json invalid-json json/invalid-syntax unverified',
    ]);
    expect(built.cli.incomplete).toEqual([
      'unparsed:.claude/settings.json',
      'unparsed:.github/copilot/settings.json',
    ]);
    expect(built.cli.outOfScope).toEqual([
      { path: 'pkg/.github/hooks/nested.json', because: 'below-start-dir' },
    ]);
    // The cloud agent reads neither settings file.
    expect(built.cloud.incomplete).toEqual([]);
    expectSkipsReported(built);
  });

  it('rejects a file whose event list is not an array, and finds no hooks in other shapes', () => {
    const { cli } = build({
      '.github/hooks/x.json': '{ "version": 1, "hooks": { "sessionStart": { "bash": "x" } } }',
      '.github/hooks/array.json': '[]',
      '.github/hooks/none.json': '{ "version": 1 }',
    });
    expect(skips(cli)).toEqual(['hook:.github/hooks/x.json not-read - documented']);
    expect(cli.entries).toEqual([]);
  });
});
