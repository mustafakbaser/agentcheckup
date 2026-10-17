import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/compare.js';
import { analyze, type Analysis, type RuleResult, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { walk } from '../../../src/io/walk.js';
import { buildInventory } from '../../../src/inventory/build.js';
import { checkConsistency } from '../../../src/platforms/load/consistency.js';
import { buildMatrix, matrixPlans } from '../../../src/platforms/load/matrix.js';
import {
  CONTEXT_AGENTS,
  type LoadEntry,
  type LoadPlan,
} from '../../../src/platforms/load/types.js';
import { loadWindsurf } from '../../../src/platforms/load/windsurf.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

const SCAN = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;

interface Built {
  readonly plan: LoadPlan;
  readonly result: RuleResult;
  readonly analysis: Analysis;
}

/** Rules first, then the loader over the same analysis, as the engine runs them. */
function buildFrom(snapshot: Snapshot, cwd = ''): Built {
  const analysis = analyze(snapshot, SCAN);
  const result = runRules(analysis, SCAN);
  expect(result.ruleFailures).toEqual([]);
  return { plan: loadWindsurf(analysis, { cwd, config: analysis.config }), result, analysis };
}

function build(files: FileMap, extras: SnapshotExtras = {}, cwd = ''): Built {
  return buildFrom(snapshotFrom(files, extras), cwd);
}

function entry(plan: LoadPlan, id: string): LoadEntry | undefined {
  return plan.entries.find((candidate) => candidate.id === id);
}

/** `id trigger certainty` for each entry, in plan order. */
function summary(plan: LoadPlan): string[] {
  return plan.entries.map((e) => `${e.id} ${e.trigger} ${e.certainty}`);
}

/** `path code ruleId certainty` for each skip, in plan order. */
function skips(plan: LoadPlan): string[] {
  return plan.skipped.map((s) => `${s.path} ${s.code} ${s.ruleId ?? '-'} ${s.certainty}`);
}

/**
 * Every skip that names a rule has an unsuppressed finding of that rule on the same file that
 * lists Devin Local. A skip on a symlink alias is reported on the real file.
 */
function expectSkipsReported({ plan, result, analysis }: Built): void {
  for (const skip of plan.skipped) {
    if (skip.ruleId === undefined) continue;
    const path = analysis.index.get(skip.path)?.path ?? skip.path;
    const found = result.findings.some(
      (finding) =>
        finding.ruleId === skip.ruleId &&
        finding.path === path &&
        finding.suppressed === undefined &&
        finding.platforms.includes('windsurf'),
    );
    expect(found, `${skip.ruleId} on ${path}`).toBe(true);
  }
}

function expectSorted(plan: LoadPlan): void {
  const byPathId = (a: { path: string; id: string }, b: { path: string; id: string }): number =>
    compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
  expect([...plan.skipped].sort(byPathId)).toEqual(plan.skipped);
  expect([...plan.incomplete].sort(compareStrings)).toEqual(plan.incomplete);
  expect(plan.outOfScope.map((o) => o.path)).toEqual(
    plan.outOfScope.map((o) => o.path).sort(compareStrings),
  );
  expect(new Set(plan.entries.map((e) => e.id)).size).toBe(plan.entries.length);
  // Devin documents no order: no entry has a position.
  expect(plan.entries.filter((e) => e.position !== undefined)).toEqual([]);
  for (const item of [...plan.entries, ...plan.skipped]) {
    expect(item.evidence.length, item.id).toBeGreaterThan(0);
  }
}

/** Every finding of the scan that names Devin Local, as `rule path`. */
function devinFindings({ result }: Built, ruleId: string): string[] {
  return result.findings
    .filter((f) => f.ruleId === ruleId && f.platforms.includes('windsurf'))
    .map((f) => f.path);
}

const RULE = (fields: string, body = 'Rule text.'): string => `---\n${fields}\n---\n\n${body}\n`;

describe('loadWindsurf: instruction files', () => {
  it('loads the root files at session start and nested ones on their path', () => {
    const built = build({
      'AGENTS.md': '# Root\n',
      '.windsurfrules': 'Legacy.\n',
      'CLAUDE.md': '# Claude\n',
      'pkg/AGENTS.md': '# Package\n',
      'pkg/CLAUDE.md': '# Package for Claude\n',
      'pkg/.windsurfrules': 'Nested legacy.\n',
    });
    expect(summary(built.plan)).toEqual([
      'instructions:.windsurfrules startup documented',
      'instructions:AGENTS.md startup documented',
      'instructions:CLAUDE.md startup documented',
      // Devin documents subdirectories for the AGENTS files only.
      'instructions:pkg/.windsurfrules on-path unverified',
      'instructions:pkg/AGENTS.md on-path documented',
      'instructions:pkg/CLAUDE.md on-path unverified',
    ]);
    expect(entry(built.plan, 'instructions:pkg/AGENTS.md')?.patterns).toEqual(['pkg']);
    expect(entry(built.plan, 'instructions:AGENTS.md')?.evidence).toEqual(['devinCliRules']);
    expect(entry(built.plan, 'instructions:CLAUDE.md')?.evidence).toEqual([
      'devinCliRules',
      'devinReadConfigFrom',
    ]);
    expect(built.plan.totals.startup).toEqual({ bytes: 24, chars: 24, tokens: 6 });
    expect(built.plan.limits.map((l) => [l.subject, l.used, l.limit, l.effect])).toEqual([
      ['.windsurfrules', 8, 12_000, 'advice'],
      ['pkg/.windsurfrules', 15, 12_000, 'advice'],
    ]);
    expectSorted(built.plan);
  });

  it('does not read files of other agents', () => {
    const built = build({
      'AGENTS.md': '# Root\n',
      'AGENTS.override.md': '# Codex only\n',
      'CLAUDE.local.md': '# Claude Code only\n',
      'GEMINI.md': '# Gemini CLI only\n',
      '.cursorrules': 'Cursor and Cline only.\n',
      '.github/copilot-instructions.md': 'Copilot only.\n',
      '.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\n---\nCopilot only.\n',
      '.claude/rules/style.md': 'Claude Code only.\n',
      '.clinerules/style.md': 'Cline only.\n',
      '.cursor/skills/s/SKILL.md': RULE('name: s\ndescription: Cursor only.'),
      '.gemini/skills/g/SKILL.md': RULE('name: g\ndescription: Gemini only.'),
      '.codex/skills/c/SKILL.md': RULE('name: c\ndescription: Codex only.'),
      '.agents/skills/team/deep/SKILL.md': RULE('name: deep\ndescription: Too deep.'),
      '.vscode/mcp.json': '{"servers":{"a":{"command":"a"}}}',
      '.cursor/hooks.json': '{"version":1,"hooks":{"stop":[{"command":"x"}]}}',
      '.codex/hooks.json': '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}',
    });
    expect(summary(built.plan)).toEqual(['instructions:AGENTS.md startup documented']);
    expect(built.plan).toMatchObject({ skipped: [], outOfScope: [], incomplete: [] });
  });

  it('skips blank files and case variants, as instr/empty-file and instr/filename-case report', () => {
    const built = build({
      'Agents.md': '# Wrong case\n',
      'pkg/Claude.md': '# Wrong case\n',
      'CLAUDE.md': '  \n\t\n',
      'pkg/AGENTS.md': '',
    });
    expect(skips(built.plan)).toEqual([
      'Agents.md case-mismatch instr/filename-case unverified',
      'CLAUDE.md blank-file instr/empty-file unverified',
      'pkg/AGENTS.md blank-file instr/empty-file unverified',
      'pkg/Claude.md case-mismatch instr/filename-case unverified',
    ]);
    expect(built.plan.entries).toEqual([]);
    expectSkipsReported(built);
  });

  it('reads a lower-case agents.md, which Cascade documents, as unverified', () => {
    const built = build({ 'agents.md': '# Lower case\n' });
    expect(summary(built.plan)).toEqual(['instructions:agents.md startup unverified']);
    expect(devinFindings(built, 'instr/filename-case')).toEqual([]);
  });

  it('lists AGENTS.local.md and AGENT.md without a size: the scan does not read them', () => {
    const built = build(
      { 'AGENTS.md': '# Root\n' },
      {
        paths: ['AGENT.md', 'pkg/AGENTS.local.md', 'docs/AGENT.md/'],
        ignoredFiles: ['AGENTS.local.md'],
      },
    );
    expect(summary(built.plan)).toEqual([
      'instructions:AGENT.md startup documented',
      'instructions:AGENTS.local.md startup documented',
      'instructions:AGENTS.md startup documented',
      'instructions:pkg/AGENTS.local.md on-path documented',
    ]);
    expect(entry(built.plan, 'instructions:AGENT.md')?.size).toBeUndefined();
    expect(built.plan.incomplete).toEqual([
      'unread:AGENT.md',
      'unread:AGENTS.local.md',
      'unread:pkg/AGENTS.local.md',
    ]);
    expect(built.plan.totals.startup.bytes).toBe(7);
  });
});

describe('loadWindsurf: global rules', () => {
  it('reads .devin/global_rules.md and skips the .windsurf one it shadows', () => {
    const { plan } = build(
      { 'AGENTS.md': '# Root\n' },
      { paths: ['.devin/global_rules.md', '.windsurf/global_rules.md'] },
    );
    expect(summary(plan)).toEqual([
      'instructions:.devin/global_rules.md startup documented',
      'instructions:AGENTS.md startup documented',
    ]);
    expect(skips(plan)).toEqual(['.windsurf/global_rules.md shadowed-by-preferred - documented']);
    expect(plan.skipped[0]?.evidence).toEqual(['devinCliRules']);
    expect(plan.incomplete).toEqual(['unread:.devin/global_rules.md']);
  });

  it('reads .windsurf/global_rules.md when there is no .devin one', () => {
    const { plan } = build(
      {},
      { paths: ['.windsurf/global_rules.md', 'pkg/.devin/global_rules.md', 'x/global_rules.md'] },
    );
    expect(summary(plan)).toEqual([
      'instructions:.windsurf/global_rules.md startup documented',
      'instructions:pkg/.devin/global_rules.md on-path unverified',
    ]);
    expect(entry(plan, 'instructions:pkg/.devin/global_rules.md')?.patterns).toEqual(['pkg']);
    expect(plan.skipped).toEqual([]);
  });
});

describe('loadWindsurf: workspace rules', () => {
  it('maps every trigger, and a missing or unknown trigger to unknown', () => {
    const built = build({
      '.devin/rules/always.md': RULE('trigger: always_on'),
      '.devin/rules/glob.md': RULE('trigger: glob\nglobs: "src/**/*.ts, test/**"'),
      '.devin/rules/model.md': RULE('trigger: model_decision\ndescription: When writing SQL'),
      '.devin/rules/agent.md': RULE('trigger: agent\ndescription: When deploying'),
      '.devin/rules/manual.md': RULE('trigger: manual'),
      '.windsurf/rules/missing.md': RULE('description: No trigger'),
      '.windsurf/rules/invalid.md': RULE('trigger: sometimes'),
      '.windsurf/rules/bare.md': 'No frontmatter.\n',
      '.windsurf/rules/broken.md': '---\ntrigger: [always_on\n---\n\nText.\n',
    });
    expect(summary(built.plan)).toEqual([
      'rule:.devin/rules/always.md startup documented',
      'rule:.devin/rules/glob.md on-path documented',
      // Devin CLI names `agent` without saying what it does.
      'rule:.devin/rules/agent.md model-selected unverified',
      'rule:.devin/rules/model.md model-selected documented',
      'rule:.devin/rules/manual.md manual documented',
      'rule:.windsurf/rules/bare.md unknown unverified',
      'rule:.windsurf/rules/broken.md unknown unverified',
      'rule:.windsurf/rules/invalid.md unknown unverified',
      'rule:.windsurf/rules/missing.md unknown unverified',
    ]);
    expect(entry(built.plan, 'rule:.devin/rules/glob.md')?.patterns).toEqual([
      'src/**/*.ts',
      'test/**',
    ]);
    expect(entry(built.plan, 'rule:.devin/rules/always.md')?.evidence).toEqual([
      'devinCliRules',
      'windsurfRules',
    ]);
    expect(built.plan.limits.map((l) => l.subject)).toHaveLength(9);
    expect(built.plan.limits.every((l) => l.key === 'windsurf.workspace_rule_chars')).toBe(true);
    expectSorted(built.plan);
  });

  it('measures each rule against the 12,000-character advice, as instr/windsurf-rule-too-long', () => {
    const built = build({ '.devin/rules/long.md': RULE('trigger: always_on', 'é'.repeat(12_001)) });
    expect(built.plan.limits).toEqual([
      {
        key: 'windsurf.workspace_rule_chars',
        unit: 'chars',
        limit: 12_000,
        used: 12_003,
        subject: '.devin/rules/long.md',
        effect: 'advice',
        evidence: ['windsurfRules'],
      },
    ]);
    expect(built.result.findings.map((f) => f.ruleId)).toContain('instr/windsurf-rule-too-long');
    // Advice: the rule still loads whole.
    expect(entry(built.plan, 'rule:.devin/rules/long.md')?.truncated).toBeUndefined();
  });

  it('skips a rule with no text, and loads rules of a nested folder on its path', () => {
    const built = build({
      '.devin/rules/empty.md': RULE('trigger: always_on', ''),
      'pkg/.devin/rules/always.md': RULE('trigger: always_on'),
      'pkg/.windsurf/rules/model.md': RULE('trigger: model_decision\ndescription: x'),
    });
    expect(skips(built.plan)).toEqual([
      '.devin/rules/empty.md blank-file instr/empty-file unverified',
    ]);
    expect(summary(built.plan)).toEqual([
      'rule:pkg/.devin/rules/always.md on-path documented',
      'rule:pkg/.windsurf/rules/model.md model-selected unverified',
    ]);
    expect(entry(built.plan, 'rule:pkg/.devin/rules/always.md')?.patterns).toEqual(['pkg']);
    expectSkipsReported(built);
  });

  it('reads .cursor/rules through the shared Cursor activation, .md files included', () => {
    const built = build({
      '.cursor/rules/always.mdc': RULE('alwaysApply: true'),
      '.cursor/rules/globs.md': RULE('globs: src/**'),
      '.cursor/rules/picked.md': RULE('description: When asked'),
      '.cursor/rules/manual.md': 'No frontmatter.\n',
      '.cursor/rules/broken.mdc': RULE('globs: *.ts'),
      '.cursor/rules/sub/deep.mdc': RULE('alwaysApply: true'),
      'pkg/.cursor/rules/nested.md': RULE('alwaysApply: true'),
    });
    expect(summary(built.plan)).toEqual([
      'rule:.cursor/rules/always.mdc startup documented',
      // Devin documents `.cursor/rules/*.md` and `*.mdc`, not subfolders.
      'rule:.cursor/rules/sub/deep.mdc startup unverified',
      'rule:.cursor/rules/globs.md on-path documented',
      'rule:pkg/.cursor/rules/nested.md on-path documented',
      'rule:.cursor/rules/picked.md model-selected documented',
      'rule:.cursor/rules/manual.md manual documented',
      'rule:.cursor/rules/broken.mdc unknown unverified',
    ]);
    // Cursor skips the .md files; Devin Local reads them.
    expect(built.result.findings.filter((f) => f.ruleId === 'cursor/md-file-ignored')).toHaveLength(
      4,
    );
    expect(built.plan.skipped).toEqual([]);
    expect(built.plan.limits).toEqual([]);
  });
});

describe('loadWindsurf: skills', () => {
  it('lists skills of its own roots and the imported ones', () => {
    const built = build({
      '.devin/skills/a/SKILL.md': RULE('name: a\ndescription: Does a.'),
      '.windsurf/skills/b/SKILL.md': RULE('description: Does b.'),
      '.agents/skills/c/SKILL.md': 'No frontmatter.\n',
      '.claude/skills/d/SKILL.md': RULE('name: d\ndescription: Does d.\ntriggers: [user]'),
      '.github/skills/team/e/SKILL.md': RULE(
        'name: e\ndescription: Does e.\ntriggers: [user, model]',
      ),
      '.claude/skills/f/SKILL.md': RULE('name: f\ntriggers: user'),
      '.windsurf/skills/h/SKILL.md': RULE('name: h\ntriggers: []'),
      'pkg/.agents/skills/g/SKILL.md': RULE('name: g\ndescription: Does g.'),
      '.devin/skills/a/team/x/SKILL.md': RULE('name: x\ndescription: Too deep.'),
      '.claude/skills/d/assets/x/SKILL.md': RULE('name: x\ndescription: Bundled.'),
    });
    expect(summary(built.plan)).toEqual([
      'skill:.agents/skills/c/SKILL.md model-selected documented',
      'skill:.devin/skills/a/SKILL.md model-selected documented',
      // `triggers` values are not defined one by one.
      'skill:.github/skills/team/e/SKILL.md model-selected unverified',
      'skill:.windsurf/skills/b/SKILL.md model-selected documented',
      'skill:.claude/skills/d/SKILL.md manual unverified',
      'skill:.claude/skills/f/SKILL.md unknown unverified',
      'skill:.windsurf/skills/h/SKILL.md unknown unverified',
    ]);
    // `name` defaults to the directory name; the listing is name and description.
    expect(entry(built.plan, 'skill:.windsurf/skills/b/SKILL.md')).toMatchObject({
      name: 'b',
      size: { bytes: 9, chars: 9, tokens: 3 },
    });
    expect(entry(built.plan, 'skill:.github/skills/team/e/SKILL.md')?.evidence).toEqual([
      'devinCliSkills',
      'devinLocal',
      'devinReadConfigFrom',
      'agentSkillsSpec',
    ]);
    expect(built.plan.outOfScope).toEqual([
      { path: '.claude/skills/d/assets/x/SKILL.md', because: 'payload-folder' },
      { path: 'pkg/.agents/skills/g/SKILL.md', because: 'below-start-dir' },
    ]);
    // The listing of the four the model can pick is in context at session start.
    const listed = built.plan.entries.filter((e) => e.trigger === 'model-selected');
    expect(built.plan.totals.startup.bytes).toBe(
      listed.reduce((sum, e) => sum + (e.size?.bytes ?? 0), 0),
    );
    expectSorted(built.plan);
  });

  it('lists the commands of .claude/commands, which Devin imports as skills', () => {
    const { plan } = build({ '.claude/commands/ship.md': 'Ship it.\n' });
    expect(summary(plan)).toEqual(['command:.claude/commands/ship.md model-selected unverified']);
    expect(entry(plan, 'command:.claude/commands/ship.md')?.name).toBe('ship');
  });
});

describe('loadWindsurf: read_config_from', () => {
  const FILES: FileMap = {
    'AGENTS.md': '',
    '.windsurfrules': 'Legacy.\n',
    'CLAUDE.md': '# Claude\n',
    'Claude.md': '# Wrong case\n',
    '.devin/rules/own.md': RULE('trigger: always_on'),
    '.windsurf/rules/w.md': RULE('trigger: always_on'),
    '.cursor/rules/c.mdc': RULE('alwaysApply: true'),
    '.devin/skills/own/SKILL.md': RULE('name: own\ndescription: Own.'),
    '.agents/skills/std/SKILL.md': RULE('name: std\ndescription: Standard.'),
    '.windsurf/skills/w/SKILL.md': RULE('name: w\ndescription: W.'),
    '.claude/skills/c/SKILL.md': RULE('name: c\ndescription: C.'),
    '.github/skills/g/SKILL.md': RULE('name: g\ndescription: G.'),
    '.claude/commands/run.md': 'Run.\n',
    '.mcp.json': '{"mcpServers":{"m":{"command":"m"}}}',
    '.cursor/mcp.json': '{"mcpServers":{"c":{"command":"c"}}}',
    '.devin/mcp_config.json': '{"mcpServers":{"d":{"command":"d"}}}',
    '.claude/settings.json':
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"./stop.sh"}]}]}}',
  };
  const OFF =
    '{"read_config_from":{"agents_standard":false,"claude":false,"copilot":false,"cursor":false,"windsurf":false}}';

  it('turns each imported source off, and keeps Devin’s own files', () => {
    const built = build(FILES, {
      paths: ['.windsurf/global_rules.md', 'AGENTS.local.md', '.devin/config.json'],
    });
    const off = build(
      { ...FILES, '.devin/config.json': OFF },
      {
        paths: ['.windsurf/global_rules.md', 'AGENTS.local.md'],
      },
    );
    expect(off.plan.skipped.map((s) => `${s.id} ${s.code} ${s.certainty}`)).toEqual([
      'command:.claude/commands/run.md disabled documented',
      expect.stringMatching(/^hook:\.claude\/settings\.json#Stop:[0-9a-f]{8} disabled documented$/),
      'skill:.claude/skills/c/SKILL.md disabled documented',
      'mcp-server:.cursor/mcp.json#c disabled documented',
      'rule:.cursor/rules/c.mdc disabled documented',
      'skill:.github/skills/g/SKILL.md disabled documented',
      'mcp-server:.mcp.json#m disabled documented',
      'instructions:.windsurf/global_rules.md disabled documented',
      'rule:.windsurf/rules/w.md disabled documented',
      'skill:.windsurf/skills/w/SKILL.md disabled documented',
      'instructions:.windsurfrules disabled documented',
      'instructions:AGENTS.local.md disabled documented',
      // Turned off before its emptiness matters: instr/empty-file leaves it alone too.
      'instructions:AGENTS.md disabled documented',
      'instructions:CLAUDE.md disabled documented',
      'instructions:Claude.md disabled documented',
    ]);
    expect(off.plan.skipped.every((s) => s.ruleId === undefined)).toBe(true);
    expect(off.plan.skipped.every((s) => s.evidence.includes('devinReadConfigFrom'))).toBe(true);
    expect(summary(off.plan)).toEqual([
      'mcp-server:.devin/mcp_config.json#d startup documented',
      'rule:.devin/rules/own.md startup documented',
      'skill:.agents/skills/std/SKILL.md model-selected documented',
      'skill:.devin/skills/own/SKILL.md model-selected documented',
    ]);
    expect(off.plan.assumptions.filter((a) => a.key.startsWith('devin.read_config_from'))).toEqual(
      ['agents_standard', 'claude', 'copilot', 'cursor', 'windsurf'].map((source) => ({
        key: `devin.read_config_from.${source}`,
        value: false,
        origin: 'repository',
        evidence: ['devinReadConfigFrom'],
      })),
    );
    // The rules agree: no finding names Devin Local for a source that is off.
    expect(devinFindings(off, 'instr/empty-file')).toEqual([]);
    expect(devinFindings(off, 'instr/filename-case')).toEqual([]);
    expect(devinFindings(built, 'instr/empty-file')).toEqual(['AGENTS.md']);
    expect(skips(built.plan)).toEqual([
      'AGENTS.md blank-file instr/empty-file unverified',
      'Claude.md case-mismatch instr/filename-case unverified',
    ]);
    expectSkipsReported(built);
    expectSkipsReported(off);
  });

  it('applies a nested .devin/config.json below it, as the rules do, unverified', () => {
    const built = build({
      'pkg/.devin/config.json': '{"read_config_from":{"agents_standard":false}}',
      'pkg/AGENTS.md': '',
      'AGENTS.md': '# Root\n',
    });
    expect(skips(built.plan)).toEqual(['pkg/AGENTS.md disabled - unverified']);
    expect(summary(built.plan)).toEqual(['instructions:AGENTS.md startup documented']);
    expect(devinFindings(built, 'instr/empty-file')).toEqual([]);
    expect(
      built.plan.assumptions.find((a) => a.key === 'devin.read_config_from.agents_standard'),
    ).toMatchObject({ value: true, origin: 'default' });
  });

  it('keeps the defaults for values that are not booleans', () => {
    const { plan } = build({
      '.devin/config.json': '{"read_config_from":{"cursor":"no","claude":0}}',
      '.cursor/rules/c.mdc': RULE('alwaysApply: true'),
      'CLAUDE.md': '# Claude\n',
    });
    expect(summary(plan)).toEqual([
      'rule:.cursor/rules/c.mdc startup documented',
      'instructions:CLAUDE.md startup documented',
    ]);
  });
});

describe('loadWindsurf: hooks', () => {
  const command = (cmd: string) => ({ type: 'command', command: cmd });

  it('reads hooks.v1.json, the hooks of .devin/config.json and Claude Code settings', () => {
    const built = build({
      '.devin/hooks.v1.json': JSON.stringify({
        PreToolUse: [{ matcher: 'exec', hooks: [command('./guard.sh')] }],
        BeforeCommit: [{ hooks: [command('./never.sh')] }],
      }),
      '.devin/config.json': JSON.stringify({
        hooks: { PostCompaction: [{ hooks: [command('./compact.sh')] }] },
      }),
      '.claude/settings.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [command('./claude-guard.sh')] }],
          SessionStart: [{ hooks: [command('./start.sh')] }],
          Notification: [{ hooks: [command('./notify.sh')] }],
        },
      }),
      // Cascade's file, which Devin Local does not read.
      '.devin/hooks.json': JSON.stringify({ hooks: { pre_run_command: [command('x')] } }),
    });
    const { plan } = built;
    expect(
      plan.entries.map((e) => `${e.path} ${e.name ?? ''} ${e.trigger} ${e.certainty}`),
    ).toEqual([
      // A Claude Code matcher names Claude Code's tools; Devin matches its own names.
      '.claude/settings.json PreToolUse startup unverified',
      '.claude/settings.json SessionStart startup documented',
      '.devin/config.json PostCompaction startup documented',
      '.devin/hooks.v1.json PreToolUse startup documented',
    ]);
    const inventory = buildInventory(built.analysis);
    for (const hook of plan.entries) {
      expect(hook.inventoryId).toBe(hook.id);
      expect(inventory.hooks.map((item) => item.id)).toContain(hook.inventoryId);
    }
    // hooks/unknown-event reports an event Devin Local does not fire in its own files.
    expect(skips(plan)).toEqual([
      '.claude/settings.json not-read - unverified',
      '.devin/hooks.json not-read - unverified',
      '.devin/hooks.v1.json unknown-event hooks/unknown-event documented',
    ]);
    expect(plan.skipped.map((s) => s.name)).toEqual(['Notification', undefined, 'BeforeCommit']);
    expectSkipsReported(built);
    expect(plan.assumptions).toContainEqual({
      key: 'devin.restrictedMode',
      value: false,
      origin: 'default',
      evidence: ['devinLocal'],
    });
  });

  it('reads hook files from the working directory up to the repository root, not below', () => {
    const settings = (cmd: string) =>
      JSON.stringify({ hooks: { Stop: [{ hooks: [command(cmd)] }] } });
    const files = {
      '.devin/hooks.v1.json': JSON.stringify({ Stop: [{ hooks: [command('./root.sh')] }] }),
      'apps/.claude/settings.json': settings('./apps.sh'),
      'apps/web/.devin/config.json': settings('./web.sh'),
      'apps/web/src/.claude/settings.local.json': settings('./below.sh'),
      'other/.devin/hooks.v1.json': JSON.stringify({ Stop: [{ hooks: [command('./x.sh')] }] }),
    };
    const repo = build(files, { paths: ['.git/HEAD'] }, 'apps/web');
    expect(repo.plan.entries.map((e) => `${e.path} ${e.certainty}`)).toEqual([
      '.devin/hooks.v1.json documented',
      'apps/.claude/settings.json documented',
      'apps/web/.devin/config.json documented',
    ]);
    expect(repo.plan.outOfScope).toEqual([
      { path: 'apps/web/src/.claude/settings.local.json', because: 'below-start-dir' },
    ]);
    // With the repository root inside the working directory, nothing above it counts.
    const inner = build(files, { paths: ['apps/web/.git/HEAD'] }, 'apps/web');
    expect(inner.plan.entries.map((e) => e.path)).toEqual(['apps/web/.devin/config.json']);
    // Without a .git, the directories above are unverified.
    const loose = build(files, {}, 'apps/web');
    expect(loose.plan.entries.map((e) => `${e.path} ${e.certainty}`)).toEqual([
      '.devin/hooks.v1.json unverified',
      'apps/.claude/settings.json unverified',
      'apps/web/.devin/config.json documented',
    ]);
  });

  it('marks a hook file that is not valid JSON incomplete', () => {
    const { plan } = build({ '.devin/hooks.v1.json': '{"Stop": [', '.devin/config.json': '{,}' });
    expect(plan.incomplete).toEqual([
      'unparsed:.devin/config.json',
      'unparsed:.devin/hooks.v1.json',
    ]);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('loadWindsurf: MCP servers', () => {
  it('reads its own files, the legacy config and the imported .mcp.json and .cursor/mcp.json', () => {
    const built = build({
      '.devin/mcp_config.json': JSON.stringify({
        mcpServers: {
          docs: { url: 'https://docs.example.com/mcp' },
          off: { command: 'npx', args: ['-y', 'x@1.0.0'], disabled: true },
        },
      }),
      '.devin/mcp_config.local.json': JSON.stringify({ mcpServers: { mine: { command: 'm' } } }),
      '.devin/config.json': JSON.stringify({ mcpServers: { legacy: { command: 'l' } } }),
      '.mcp.json': JSON.stringify({
        mcpServers: { github: { command: 'gh' }, quiet: { command: 'q', disabled: true } },
      }),
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { linear: { url: 'https://l.example' } } }),
      'pkg/.mcp.json': JSON.stringify({ mcpServers: { nested: { command: 'n' } } }),
      '.vscode/mcp.json': JSON.stringify({ servers: { vs: { command: 'v' } } }),
      '.github/mcp.json': JSON.stringify({ mcpServers: { cli: { command: 'c' } } }),
    });
    const { plan } = built;
    expect(summary(plan)).toEqual([
      'mcp-server:.cursor/mcp.json#linear startup documented',
      // Moved to the dedicated files on startup; where to is not documented.
      'mcp-server:.devin/config.json#legacy startup unverified',
      'mcp-server:.devin/mcp_config.json#docs startup documented',
      'mcp-server:.devin/mcp_config.local.json#mine startup documented',
      'mcp-server:.mcp.json#github startup documented',
    ]);
    expect(skips(plan)).toEqual([
      '.devin/mcp_config.json disabled - documented',
      // The imported formats document no `disabled` field.
      '.mcp.json disabled - unverified',
    ]);
    expect(plan.outOfScope).toEqual([{ path: 'pkg/.mcp.json', because: 'below-start-dir' }]);
    const inventory = buildInventory(built.analysis);
    for (const server of plan.entries) {
      expect(inventory.mcpServers.map((item) => item.id)).toContain(server.inventoryId);
    }
  });

  it('marks a file that is not valid JSON incomplete', () => {
    const { plan } = build({ '.devin/mcp_config.json': '{"mcpServers": {', '.mcp.json': '[]' });
    expect(plan.incomplete).toEqual(['unparsed:.devin/mcp_config.json']);
    // A top-level array parses; it declares no servers.
    expect(plan.entries).toEqual([]);
  });
});

describe('loadWindsurf: workspace and visibility', () => {
  it('treats cwd as the folder opened in Devin Desktop', () => {
    const { plan } = build(
      {
        'AGENTS.md': '# Outside the workspace\n',
        '.devin/rules/r.md': RULE('trigger: always_on'),
        'apps/web/AGENTS.md': '# Web\n',
        'apps/web/src/AGENTS.md': '# Source\n',
        'apps/web/.devin/rules/r.md': RULE('trigger: always_on'),
        'apps/web/.agents/skills/s/SKILL.md': RULE('name: s\ndescription: d'),
        'apps/web/.mcp.json': JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
        'apps/api/AGENTS.md': '# Sibling\n',
      },
      {},
      'apps/web',
    );
    expect(plan.cwd).toBe('apps/web');
    expect(summary(plan)).toEqual([
      'rule:apps/web/.devin/rules/r.md startup documented',
      'mcp-server:apps/web/.mcp.json#a startup documented',
      'instructions:apps/web/AGENTS.md startup documented',
      'instructions:apps/web/src/AGENTS.md on-path documented',
      'skill:apps/web/.agents/skills/s/SKILL.md model-selected documented',
    ]);
  });

  it('reports files it could not read as incomplete', () => {
    const { plan } = build(
      { 'AGENTS.md': '# Root\n' },
      {
        ignoredFiles: ['.devin/rules/secret.md', 'notes/todo.md', '.devin/mcp_config.local.json'],
        paths: ['.cursor/rules/x.md', '.claude/settings.local.json', 'docs/readme.md'],
        opaqueDirectories: ['.windsurf/', '.claude/worktrees/', 'node_modules/', '.agents/skills/'],
      },
    );
    expect(plan.incomplete).toEqual([
      'unread:.agents/skills/',
      'unread:.claude/settings.local.json',
      'unread:.cursor/rules/x.md',
      'unread:.devin/mcp_config.local.json',
      'unread:.devin/rules/secret.md',
      'unread:.windsurf/',
    ]);
  });

  it('states its assumptions and the scopes it cannot see', () => {
    const { plan } = build({});
    expect(plan.assumptions.map((a) => `${a.key}=${String(a.value)} ${a.origin}`)).toEqual([
      'devin.agent=devin-local default',
      'devin.read_config_from.agents_standard=true default',
      'devin.read_config_from.claude=true default',
      'devin.read_config_from.copilot=true default',
      'devin.read_config_from.cursor=true default',
      'devin.read_config_from.windsurf=true default',
      'devin.restrictedMode=false default',
    ]);
    expect(plan.hidden.map((h) => h.scope)).toEqual(['managed', 'user', 'plugin']);
    const user = plan.hidden.find((h) => h.scope === 'user')?.locations;
    for (const location of [
      '~/.config/devin/AGENTS.md',
      '~/.config/devin/config.json',
      '~/.config/devin/mcp_config.json',
      '~/.config/devin/skills',
      '~/.devin/rules',
      '~/.devin/global_rules.md',
      '~/.agents/skills',
      '~/.codeium/<channel>/skills',
    ]) {
      expect(user).toContain(location);
    }
    expect(plan.hidden.find((h) => h.scope === 'managed')?.locations).toContain('/etc/devin/rules');
    expect(plan).toMatchObject({ entries: [], skipped: [], incomplete: [], limits: [] });
  });
});

describe('loadWindsurf: the devin fixture', () => {
  async function fixture(): Promise<Snapshot> {
    const walked = await walk(fileURLToPath(new URL('../../fixtures/devin', import.meta.url)));
    return {
      ...walked,
      paths: new Set([...walked.paths, '.git/']),
      opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
    };
  }

  it('builds the plan at the root', async () => {
    const built = buildFrom(await fixture());
    const { plan } = built;
    expect(summary(plan)).toEqual([
      'instructions:.devin/global_rules.md startup documented',
      expect.stringMatching(
        /^hook:\.devin\/hooks\.v1\.json#PreToolUse:[0-9a-f]{8} startup documented$/,
      ),
      'mcp-server:.devin/mcp_config.json#docs startup documented',
      'rule:.devin/rules/always.md startup documented',
      'mcp-server:.mcp.json#github startup documented',
      'rule:.windsurf/rules/style.md startup documented',
      'instructions:.windsurfrules startup documented',
      'instructions:AGENTS.local.md startup documented',
      'instructions:AGENTS.md startup documented',
      'instructions:CLAUDE.md startup documented',
      'rule:.cursor/rules/react.mdc on-path documented',
      'rule:.devin/rules/tests.md on-path documented',
      'instructions:packages/api/AGENTS.md on-path documented',
      'rule:.devin/rules/sql.md model-selected documented',
      'skill:.devin/skills/deploy/SKILL.md model-selected documented',
      'skill:.claude/skills/review/SKILL.md manual unverified',
      'rule:.cursor/rules/notes.md manual documented',
      'rule:.devin/rules/release.md manual documented',
      'rule:.devin/rules/untriggered.md unknown unverified',
    ]);
    expect(skips(plan)).toEqual([
      '.devin/hooks.v1.json unknown-event hooks/unknown-event documented',
      '.devin/mcp_config.json disabled - documented',
      '.github/skills/triage/SKILL.md disabled - documented',
      '.windsurf/global_rules.md shadowed-by-preferred - documented',
    ]);
    // Devin Local must not read CLAUDE.local.md or GEMINI.md.
    const mentioned = [
      ...plan.entries.map((e) => e.path),
      ...plan.skipped.map((s) => s.path),
      ...plan.outOfScope.map((o) => o.path),
    ];
    expect(mentioned).not.toContain('CLAUDE.local.md');
    expect(mentioned).not.toContain('GEMINI.md');
    expect(plan.incomplete).toEqual(['unread:.devin/global_rules.md', 'unread:AGENTS.local.md']);
    expect(plan.totals.startup.tokens).toBe(Math.ceil(plan.totals.startup.chars / 4));
    expectSkipsReported(built);
    expectSorted(plan);
  });

  it('agrees with the findings, and its matrix column shows what it reads', async () => {
    const snapshot = await fixture();
    const analysis = analyze(snapshot, { targets: PLATFORM_IDS });
    const { findings } = runRules(analysis, { rules: builtinRules, trustDirectives: false });
    const plans = matrixPlans(analysis, { agents: CONTEXT_AGENTS, config: analysis.config });
    const report = checkConsistency({ findings, plans, view: analysis });
    expect(report.mismatches).toEqual([]);
    expect(report.allowed['skip-without-rule']).toBeUndefined();
    const column = CONTEXT_AGENTS.indexOf('windsurf');
    const cells = buildMatrix(analysis, plans, CONTEXT_AGENTS).rows.map(
      (row) => `${row.path} ${row.cells[column] ?? ''}`,
    );
    expect(cells).toContain('.cursor/rules/notes.md manual');
    expect(cells).toContain('.devin/hooks.v1.json startup');
    expect(cells).toContain('.github/skills/triage skipped');
    expect(cells).toContain('CLAUDE.local.md not-read');
  });
});

describe('loadWindsurf: determinism and hostile input', () => {
  const FILES: FileMap = {
    'AGENTS.md': '# Root\n',
    'b/AGENTS.md': '# B\n',
    'a/AGENTS.md': '# A\n',
    '.devin/rules/z.md': RULE('trigger: always_on'),
    '.devin/rules/a.md': RULE('trigger: glob\nglobs: "*.ts"'),
    '.cursor/rules/m.md': 'x\n',
    '.devin/skills/s/SKILL.md': RULE('name: s\ndescription: d'),
    '.devin/mcp_config.json': '{"mcpServers":{"z":{"command":"a"},"a":{"command":"b"}}}',
    '.devin/hooks.v1.json': '{"Stop":[{"hooks":[{"type":"command","command":"b"}]}]}',
  };

  it('gives the same plan for files in any order, twice', () => {
    const forward = JSON.stringify(build(FILES).plan);
    const reversed: Record<string, string | Uint8Array> = {};
    for (const key of Object.keys(FILES).reverse()) reversed[key] = FILES[key]!;
    expect(JSON.stringify(build(reversed).plan)).toBe(forward);
    expect(JSON.stringify(build(FILES).plan)).toBe(forward);
    expectSorted(build(FILES).plan);
  });

  it('handles hostile names and values', () => {
    const built = build({
      '.devin/mcp_config.json':
        '{"mcpServers":{"__proto__":{"command":"a"},"constructor":{"command":"b"},' +
        '"a#b:c":{"command":"c"},"‮":{"command":"d"},"bad":7}}',
      '.devin/hooks.v1.json': '{"__proto__":[{"hooks":[{"type":"command","command":"x"}]}]}',
      '.devin/config.json': '{"read_config_from":{"__proto__":{"cursor":false},"cursor":"off"}}',
      '.devin/rules/x.md': `---\ntrigger: glob\nglobs: ${'a,'.repeat(5000)}\n---\nText.\n`,
      '.devin/rules/y.md': '---\ntrigger: [unclosed\n---\nText.\n',
      '.devin/rules/#weird name.md': RULE('trigger: always_on'),
      '.cursor/rules/c.mdc': RULE('alwaysApply: true'),
    });
    const { plan } = built;
    expect(plan.entries.filter((e) => e.role === 'mcp-server').map((e) => e.name)).toEqual([
      '__proto__',
      'a#b:c',
      'constructor',
      '‮',
    ]);
    expect(entry(plan, 'rule:.devin/rules/x.md')?.patterns).toHaveLength(5000);
    expect(entry(plan, 'rule:.devin/rules/y.md')?.trigger).toBe('unknown');
    expect(entry(plan, 'rule:.devin/rules/#weird name.md')?.trigger).toBe('startup');
    // `__proto__` is not a source, and "off" is not a boolean: Cursor's rules still load.
    expect(entry(plan, 'rule:.cursor/rules/c.mdc')?.trigger).toBe('startup');
    expect(plan.skipped.map((s) => s.name)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expectSorted(plan);
  });

  it('keeps skips consistent with findings on generated files', () => {
    const value = fc.constantFrom(
      'always_on',
      'glob',
      'model_decision',
      'manual',
      'agent',
      'sometimes',
      '',
      '[a, b]',
      'true',
    );
    const field = fc.tuple(
      fc.constantFrom('trigger', 'globs', 'description', 'alwaysApply', 'triggers'),
      value,
    );
    const text = fc.oneof(
      fc
        .array(field, { maxLength: 3 })
        .map((fields) => RULE(fields.map(([key, v]) => `${key}: ${v}`).join('\n'))),
      fc.constantFrom('', '   \n', 'No frontmatter.\n', '---\nunclosed\n', '﻿---\na: 1\n---\n'),
    );
    const path = fc.constantFrom(
      'AGENTS.md',
      'Agents.md',
      'agents.md',
      'pkg/AGENTS.md',
      'CLAUDE.md',
      'claude.md',
      '.windsurfrules',
      '.devin/rules/r.md',
      '.windsurf/rules/r.md',
      'pkg/.devin/rules/r.md',
      '.cursor/rules/r.md',
      '.cursor/rules/r.mdc',
      '.devin/skills/s/SKILL.md',
      '.claude/skills/s/SKILL.md',
    );
    const config = fc.constantFrom(
      undefined,
      '{"read_config_from":{"agents_standard":false}}',
      '{"read_config_from":{"claude":false,"windsurf":false}}',
      '{',
    );
    fc.assert(
      fc.property(
        fc.dictionary(path, text, { maxKeys: 5 }),
        config,
        fc.boolean(),
        (files, settings, nested) => {
          const where = nested ? 'pkg/.devin/config.json' : '.devin/config.json';
          const built = build(settings === undefined ? files : { ...files, [where]: settings });
          expectSkipsReported(built);
          expectSorted(built.plan);
          const report = checkConsistency({
            findings: built.result.findings,
            plans: [built.plan],
            view: built.analysis,
          });
          expect(report.mismatches).toEqual([]);
        },
      ),
      { numRuns: 80 },
    );
  });
});
