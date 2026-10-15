import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/compare.js';
import { analyze, type Analysis, type RuleResult, runRules } from '../../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { walk } from '../../../src/io/walk.js';
import { buildInventory } from '../../../src/inventory/build.js';
import { cursorActivation } from '../../../src/platforms/cursor-rules.js';
import { loadCursor } from '../../../src/platforms/load/cursor.js';
import type { LoadEntry, LoadPlan } from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

const SCAN = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;

interface Built {
  readonly plan: LoadPlan;
  readonly result: RuleResult;
  readonly analysis: Analysis;
}

/** Rules first, then the loader over the same analysis, as the engine will run them. */
function buildFrom(snapshot: Snapshot, cwd = ''): Built {
  const analysis = analyze(snapshot, SCAN);
  const result = runRules(analysis, SCAN);
  expect(result.ruleFailures).toEqual([]);
  return { plan: loadCursor(analysis, { cwd, config: analysis.config }), result, analysis };
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

/**
 * Every skip that names a rule has an unsuppressed finding of that rule on the same file that
 * lists Cursor. A skip on a symlink alias is reported on the real file.
 */
function expectSkipsReported({ plan, result, analysis }: Built): void {
  for (const skip of plan.skipped) {
    if (skip.ruleId === undefined) {
      expect(skip.code).toBe('not-read');
      continue;
    }
    const path = analysis.index.get(skip.path)?.path ?? skip.path;
    const found = result.findings.some(
      (finding) =>
        finding.ruleId === skip.ruleId &&
        finding.path === path &&
        finding.suppressed === undefined &&
        finding.platforms.includes('cursor'),
    );
    expect(found, `${skip.ruleId} on ${path}`).toBe(true);
  }
}

function expectSorted(plan: LoadPlan): void {
  const byPathId = (a: { path: string; id: string }, b: { path: string; id: string }): number =>
    compareStrings(a.path, b.path) || compareStrings(a.id, b.id);
  expect([...plan.skipped].sort(byPathId)).toEqual(plan.skipped);
  expect([...plan.incomplete].sort(compareStrings)).toEqual(plan.incomplete);
  expect([...plan.outOfScope].map((o) => o.path)).toEqual(
    plan.outOfScope.map((o) => o.path).sort(compareStrings),
  );
  expect(new Set(plan.entries.map((e) => e.id)).size).toBe(plan.entries.length);
  const positions = plan.entries.flatMap((e) => (e.position === undefined ? [] : [e.position]));
  expect(positions).toEqual(positions.map((_, i) => i + 1));
}

const FRONTMATTER = (fields: string): string => `---\n${fields}\n---\n\nBody.\n`;

describe('loadCursor: .cursor/rules', () => {
  it('maps the four activation modes to triggers', () => {
    const built = build({
      '.cursor/rules/always.mdc': FRONTMATTER('alwaysApply: true\nglobs: src/**'),
      '.cursor/rules/globs.mdc': FRONTMATTER('globs: src/**/*.ts, test/**/*.ts\ndescription: x'),
      '.cursor/rules/agent.mdc': FRONTMATTER('description: When writing SQL'),
      '.cursor/rules/manual.mdc': FRONTMATTER('alwaysApply: false'),
      '.cursor/rules/bare.mdc': 'No frontmatter.\n',
    });
    expect(summary(built.plan)).toEqual([
      'rule:.cursor/rules/always.mdc startup documented',
      'rule:.cursor/rules/globs.mdc on-path documented',
      'rule:.cursor/rules/agent.mdc model-selected documented',
      'rule:.cursor/rules/bare.mdc manual documented',
      'rule:.cursor/rules/manual.mdc manual documented',
    ]);
    expect(entry(built.plan, 'rule:.cursor/rules/globs.mdc')?.patterns).toEqual([
      'src/**/*.ts',
      'test/**/*.ts',
    ]);
    expect(entry(built.plan, 'rule:.cursor/rules/always.mdc')?.position).toBe(1);
    expect(built.plan.limits.map((limit) => [limit.subject, limit.used, limit.effect])).toEqual([
      ['.cursor/rules/agent.mdc', 5, 'advice'],
      ['.cursor/rules/always.mdc', 6, 'advice'],
      ['.cursor/rules/bare.mdc', 1, 'advice'],
      ['.cursor/rules/globs.mdc', 6, 'advice'],
      ['.cursor/rules/manual.mdc', 5, 'advice'],
    ]);
    // The manual rule without frontmatter is the one cursor/rule-never-applied reports; the
    // explicit `alwaysApply: false` is not reported.
    const never = built.result.findings.filter((f) => f.ruleId === 'cursor/rule-never-applied');
    expect(never.map((f) => f.path)).toEqual(['.cursor/rules/bare.mdc']);
    expectSkipsReported(built);
  });

  it('marks undocumented frontmatter forms unverified, and invalid YAML as unknown', () => {
    const { plan } = build({
      '.cursor/rules/list.mdc': FRONTMATTER('globs:\n  - src/**\n  - " "'),
      '.cursor/rules/quoted.mdc': FRONTMATTER('alwaysApply: "true"'),
      // Cursor's editor writes unquoted globs, which YAML rejects: the mode is unknown.
      '.cursor/rules/unquoted.mdc': FRONTMATTER('globs: *.ts, **/*.tsx'),
      '.cursor/rules/unclosed.mdc': '---\nalwaysApply: true\n',
    });
    expect(summary(plan)).toEqual([
      'rule:.cursor/rules/list.mdc on-path unverified',
      'rule:.cursor/rules/quoted.mdc manual unverified',
      'rule:.cursor/rules/unclosed.mdc unknown unverified',
      'rule:.cursor/rules/unquoted.mdc unknown unverified',
    ]);
    expect(entry(plan, 'rule:.cursor/rules/list.mdc')?.patterns).toEqual(['src/**']);
  });

  it('skips .md files, keeps README as documentation, and marks nested folders unverified', () => {
    const built = build({
      '.cursor/rules/style.md': 'Use tabs.\n',
      '.cursor/rules/sub/deep.mdc': FRONTMATTER('alwaysApply: true'),
      '.cursor/rules/README.md': '# Rules\n',
      '.cursor/rules/sub/Readme.md': '# Sub rules\n',
      'packages/api/.cursor/rules/api.mdc': FRONTMATTER('alwaysApply: true'),
      'packages/api/.cursor/rules/old.md': 'Old.\n',
    });
    expect(summary(built.plan)).toEqual([
      'rule:.cursor/rules/sub/deep.mdc startup documented',
      'rule:packages/api/.cursor/rules/api.mdc startup unverified',
    ]);
    expect(built.plan.skipped.map((s) => [s.path, s.code, s.ruleId, s.certainty])).toEqual([
      ['.cursor/rules/style.md', 'not-mdc', 'cursor/md-file-ignored', 'documented'],
      ['packages/api/.cursor/rules/old.md', 'not-mdc', 'cursor/md-file-ignored', 'unverified'],
    ]);
    expect(built.plan.outOfScope).toEqual([
      { path: '.cursor/rules/README.md', because: 'documentation' },
      { path: '.cursor/rules/sub/Readme.md', because: 'documentation' },
    ]);
    expectSkipsReported(built);
  });
});

describe('cursorActivation', () => {
  it('agrees with the documented table', () => {
    const modes = [
      'alwaysApply: true',
      'alwaysApply: false\nglobs: a/**',
      'alwaysApply: false\ndescription: d',
      'alwaysApply: false',
      'description: "   "',
    ].map((fields) => {
      const { analysis } = build({ '.cursor/rules/r.mdc': FRONTMATTER(fields) });
      return cursorActivation(analysis.frontmatter(analysis.artifacts[0]!)).mode;
    });
    expect(modes).toEqual(['always', 'globs', 'description', 'manual', 'manual']);
  });
});

describe('loadCursor: instructions', () => {
  it('loads the root files at startup and nested AGENTS.md on path', () => {
    const built = build({
      'AGENTS.md': '# Root\n',
      'CLAUDE.md': '# Claude\n',
      '.cursorrules': 'Legacy.\n',
      'packages/api/AGENTS.md': '# API\n',
      // Documented at the project root only: not listed.
      'packages/api/CLAUDE.md': '# Nested Claude\n',
      'packages/api/.cursorrules': 'Nested legacy.\n',
      '.claude/CLAUDE.md': '# Claude dir\n',
      // Other agents' files.
      'AGENTS.override.md': 'Codex only.\n',
      'CLAUDE.local.md': 'Claude only.\n',
      '.github/copilot-instructions.md': 'Copilot only.\n',
    });
    expect(summary(built.plan)).toEqual([
      'instructions:.cursorrules startup documented',
      'instructions:AGENTS.md startup documented',
      'instructions:CLAUDE.md startup documented',
      'instructions:packages/api/AGENTS.md on-path documented',
    ]);
    expect(built.plan.entries.map((e) => e.position)).toEqual([1, 2, 3, undefined]);
    expect(entry(built.plan, 'instructions:packages/api/AGENTS.md')?.patterns).toEqual([
      'packages/api',
    ]);
    expect(built.plan.totals.startup).toEqual({ bytes: 24, chars: 24, tokens: 6 });
    expect(built.plan.skipped).toEqual([]);
  });

  it('skips blank files and case-mismatched names with the rules that report them', () => {
    const built = build({
      'Agents.md': '# Wrong case\n',
      'CLAUDE.md': '  \n\n',
      'docs/AGENTS.md': '',
    });
    expect(built.plan.entries).toEqual([]);
    expect(built.plan.skipped.map((s) => [s.path, s.code, s.ruleId, s.certainty])).toEqual([
      ['Agents.md', 'case-mismatch', 'instr/filename-case', 'unverified'],
      ['CLAUDE.md', 'blank-file', 'instr/empty-file', 'unverified'],
      ['docs/AGENTS.md', 'blank-file', 'instr/empty-file', 'unverified'],
    ]);
    expectSkipsReported(built);
  });

  it('lists a symlinked CLAUDE.md as its own entry', () => {
    const built = build(
      { 'AGENTS.md': '# Shared\n', 'CLAUDE.md': '# Shared\n' },
      { symlinks: { 'CLAUDE.md': 'AGENTS.md' } },
    );
    expect(built.plan.entries.map((e) => [e.path, e.realPath, e.trigger])).toEqual([
      ['AGENTS.md', 'AGENTS.md', 'startup'],
      ['CLAUDE.md', 'AGENTS.md', 'startup'],
    ]);
  });
});

describe('loadCursor: skills', () => {
  const skill = (name: string, extra = ''): string =>
    FRONTMATTER(`name: ${name}\ndescription: Does ${name}.${extra}`);

  it('finds skills recursively in the four skills folders', () => {
    const built = build({
      '.agents/skills/a/SKILL.md': skill('a'),
      '.cursor/skills/group/b/SKILL.md': skill('b'),
      '.claude/skills/c/SKILL.md': skill('c'),
      '.codex/skills/d/SKILL.md': skill('d'),
      // Not read by Cursor.
      '.github/skills/e/SKILL.md': skill('e'),
      '.gemini/skills/f/SKILL.md': skill('f'),
      'docs/skills/g/SKILL.md': skill('g'),
    });
    expect(summary(built.plan)).toEqual([
      'skill:.agents/skills/a/SKILL.md model-selected documented',
      'skill:.claude/skills/c/SKILL.md model-selected documented',
      'skill:.codex/skills/d/SKILL.md model-selected documented',
      'skill:.cursor/skills/group/b/SKILL.md model-selected documented',
    ]);
    const a = entry(built.plan, 'skill:.agents/skills/a/SKILL.md');
    expect(a).toMatchObject({ name: 'a', size: { chars: 'a\nDoes a.'.length } });
    expect(a?.deferred?.chars).toBe('\nBody.\n'.length);
    // Listings of skills the model can pick are startup context; bodies are on demand.
    expect(built.plan.totals.startup.chars).toBe(4 * 'a\nDoes a.'.length);
    expect(built.plan.totals.onDemand.chars).toBe(4 * '\nBody.\n'.length);
  });

  it('scopes nested folders, honors paths and disable-model-invocation', () => {
    const built = build({
      'apps/web/.cursor/skills/ui/SKILL.md': skill('ui'),
      'apps/web/.agents/skills/lint/SKILL.md': skill('lint'),
      'apps/web/.claude/skills/story/SKILL.md': skill('story'),
      '.cursor/skills/sql/SKILL.md': skill('sql', '\npaths:\n  - "db/**"\n  - "*.sql"'),
      '.cursor/skills/legacy/SKILL.md': skill('legacy', '\nglobs: "a/**, b/**"'),
      '.cursor/skills/deploy/SKILL.md': skill('deploy', '\ndisable-model-invocation: true'),
      'apps/api/.cursor/skills/both/SKILL.md': skill('both', '\npaths: "src/**"'),
    });
    expect(
      built.plan.entries.map((e) => `${e.path} ${e.trigger} ${e.certainty} ${String(e.patterns)}`),
    ).toEqual([
      '.cursor/skills/legacy/SKILL.md on-path documented a/**,b/**',
      '.cursor/skills/sql/SKILL.md on-path documented db/**,*.sql',
      'apps/api/.cursor/skills/both/SKILL.md on-path unverified src/**',
      'apps/web/.agents/skills/lint/SKILL.md on-path documented apps/web',
      'apps/web/.claude/skills/story/SKILL.md on-path unverified apps/web',
      'apps/web/.cursor/skills/ui/SKILL.md on-path documented apps/web',
      '.cursor/skills/deploy/SKILL.md manual documented undefined',
    ]);
  });

  it('loads a skill whose name differs from its folder, which is a warning', () => {
    const built = build({
      '.cursor/skills/review/SKILL.md': FRONTMATTER('name: code-review\ndescription: Reviews.'),
    });
    expect(summary(built.plan)).toEqual([
      'skill:.cursor/skills/review/SKILL.md model-selected documented',
    ]);
    expect(built.plan.entries[0]?.name).toBe('review');
    expect(built.plan.skipped).toEqual([]);
    const mismatch = built.result.findings.filter((f) => f.ruleId === 'skill/name-dir-mismatch');
    expect(mismatch.map((f) => [f.severity, f.platforms])).toEqual([['warn', ['cursor']]]);
  });

  it('leaves out bundled skills and other agents’ plugins, and doubts unparsed frontmatter', () => {
    const { plan } = build({
      '.cursor/skills/kit/SKILL.md': skill('kit'),
      '.cursor/skills/kit/assets/template/SKILL.md': skill('template'),
      'plugins/x/.codex-plugin/plugin.json': '{}',
      'plugins/x/skills/y/SKILL.md': skill('y'),
      '.agents/skills/broken/SKILL.md': '---\nname: [broken\n---\nBody.\n',
      '.agents/skills/plain/SKILL.md': 'Just a body.\n',
    });
    expect(summary(plan)).toEqual([
      'skill:.agents/skills/broken/SKILL.md model-selected unverified',
      'skill:.agents/skills/plain/SKILL.md model-selected unverified',
      'skill:.cursor/skills/kit/SKILL.md model-selected documented',
    ]);
    expect(plan.outOfScope).toEqual([
      { path: '.cursor/skills/kit/assets/template/SKILL.md', because: 'payload-folder' },
      { path: 'plugins/x/skills/y/SKILL.md', because: 'other-agent-plugin' },
    ]);
  });
});

describe('loadCursor: MCP servers and hooks', () => {
  it('lists MCP servers on approval, unverified, with inventory ids', () => {
    const { plan } = build({
      '.cursor/mcp.json': JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] }, docs: { url: 'x' } },
      }),
      // Claude Code's file and nested Cursor configs are not Cursor's project MCP config.
      '.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      'packages/a/.cursor/mcp.json': JSON.stringify({ mcpServers: { nested: { command: 'x' } } }),
    });
    expect(plan.entries.map((e) => [e.id, e.trigger, e.certainty, e.inventoryId])).toEqual([
      [
        'mcp-server:.cursor/mcp.json#docs',
        'on-approval',
        'unverified',
        'mcp:.cursor/mcp.json#docs',
      ],
      [
        'mcp-server:.cursor/mcp.json#github',
        'on-approval',
        'unverified',
        'mcp:.cursor/mcp.json#github',
      ],
    ]);
  });

  it('skips config files that do not parse with json/invalid-syntax', () => {
    const built = build({
      '.cursor/mcp.json': '{ "mcpServers": { ',
      '.cursor/hooks.json': '{ "version": 1, // comment\n "hooks": {} }',
      '.claude/settings.json': '{ "hooks": ',
    });
    expect(built.plan.entries).toEqual([]);
    expect(built.plan.skipped.map((s) => [s.id, s.code, s.ruleId])).toEqual([
      ['hook:.cursor/hooks.json', 'invalid-json', 'json/invalid-syntax'],
      ['mcp-server:.cursor/mcp.json', 'invalid-json', 'json/invalid-syntax'],
    ]);
    // The Claude Code settings finding lists Claude Code only, so Cursor's view is unknown.
    expect(built.plan.incomplete).toEqual(['unparsed:.claude/settings.json']);
    expectSkipsReported(built);
  });

  it('lists Cursor hooks and mapped Claude Code hooks, and skips unknown events', () => {
    const guard = { type: 'command', command: './guard.sh' };
    const built = build({
      '.cursor/hooks.json': JSON.stringify({
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: './guard.sh' }, { command: './guard.sh' }],
          PreToolUse: [{ command: './wrong-case.sh' }],
        },
      }),
      '.claude/settings.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [guard] }],
          Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }],
          SubagentStart: [{ hooks: [{ type: 'command', command: 'start' }] }],
          NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
        },
      }),
      '.claude/settings.local.json': JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [guard] }] },
      }),
      // Nested settings are not read by Cursor.
      'apps/x/.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [guard] }] } }),
    });
    const hooks = built.plan.entries.map((e) => [
      e.path,
      e.name,
      e.id.replace(/:[0-9a-f]{8}/, ':#'),
    ]);
    expect(hooks).toEqual([
      ['.claude/settings.json', 'PreToolUse', 'hook:.claude/settings.json#PreToolUse:#'],
      [
        '.claude/settings.local.json',
        'UserPromptSubmit',
        'hook:.claude/settings.local.json#UserPromptSubmit:#',
      ],
      [
        '.cursor/hooks.json',
        'beforeShellExecution',
        'hook:.cursor/hooks.json#beforeShellExecution:#',
      ],
      [
        '.cursor/hooks.json',
        'beforeShellExecution',
        'hook:.cursor/hooks.json#beforeShellExecution:#:2',
      ],
    ]);
    const inventory = buildInventory(built.analysis);
    for (const hook of built.plan.entries) {
      expect(hook.trigger).toBe('on-approval');
      expect(hook.inventoryId).toBe(hook.id);
      expect(inventory.hooks.map((item) => item.id)).toContain(hook.inventoryId);
    }
    expect(built.plan.skipped.map((s) => [s.path, s.code, s.ruleId, s.certainty])).toEqual([
      ['.claude/settings.json', 'not-read', undefined, 'documented'],
      ['.claude/settings.json', 'not-read', undefined, 'unverified'],
      ['.cursor/hooks.json', 'unknown-event', 'hooks/unknown-event', 'documented'],
    ]);
    expect(built.plan.skipped.map((s) => s.name?.split(':')[0])).toEqual([
      'Notification',
      'SubagentStart',
      'PreToolUse',
    ]);
    expectSkipsReported(built);
  });
});

describe('loadCursor: workspace and visibility', () => {
  it('treats cwd as the folder opened in Cursor', () => {
    const { plan } = build(
      {
        'AGENTS.md': '# Outside the workspace\n',
        'apps/web/AGENTS.md': '# Web\n',
        'apps/web/src/AGENTS.md': '# Source\n',
        'apps/web/.cursor/rules/r.mdc': FRONTMATTER('alwaysApply: true'),
        'apps/web/.cursor/skills/s/SKILL.md': FRONTMATTER('name: s\ndescription: d'),
        'apps/api/AGENTS.md': '# Sibling\n',
      },
      {},
      'apps/web',
    );
    expect(plan.cwd).toBe('apps/web');
    expect(summary(plan)).toEqual([
      'instructions:apps/web/AGENTS.md startup documented',
      'rule:apps/web/.cursor/rules/r.mdc startup documented',
      'instructions:apps/web/src/AGENTS.md on-path documented',
      'skill:apps/web/.cursor/skills/s/SKILL.md model-selected documented',
    ]);
  });

  it('reports files it could not read as incomplete', () => {
    const { plan } = build(
      { 'AGENTS.md': '# Root\n' },
      {
        ignoredFiles: ['.cursor/rules/secret.mdc', 'notes/todo.md'],
        paths: ['.cursor/mcp.json'],
        opaqueDirectories: ['.cursor/skills/', '.claude/worktrees/', 'node_modules/'],
      },
    );
    expect(plan.incomplete).toEqual([
      'unread:.cursor/mcp.json',
      'unread:.cursor/rules/secret.mdc',
      'unread:.cursor/skills/',
    ]);
  });

  it('states its assumptions and the scopes it cannot see', () => {
    const { plan } = build({});
    expect(plan.assumptions.map((a) => `${a.key}=${String(a.value)}`)).toEqual([
      'cursor.mode=agent',
      'cursor.thirdPartyConfigs=true',
      'cursor.trustedWorkspace=true',
    ]);
    expect(plan.hidden.map((h) => h.scope)).toEqual(['account', 'managed', 'team', 'user']);
    expect(plan.hidden.find((h) => h.scope === 'user')?.locations).toContain('~/.cursor/rules');
    expect(plan).toMatchObject({ entries: [], skipped: [], incomplete: [], limits: [] });
  });
});

describe('loadCursor: context fixture', () => {
  async function fixture(): Promise<Snapshot> {
    const walked = await walk(fileURLToPath(new URL('../../fixtures/context', import.meta.url)));
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
      'instructions:AGENTS.md startup documented',
      'rule:.cursor/rules/always.mdc startup documented',
      'rule:.cursor/rules/typescript.mdc on-path documented',
      'instructions:packages/api/AGENTS.md on-path documented',
      'instructions:packages/api/src/handlers/AGENTS.md on-path documented',
      'skill:packages/web/.claude/skills/storybook/SKILL.md on-path unverified',
      'instructions:packages/web/AGENTS.md on-path documented',
      'instructions:services/AGENTS.md on-path documented',
      'instructions:services/billing/AGENTS.md on-path documented',
      'instructions:services/billing/ledger/AGENTS.md on-path documented',
      'instructions:services/billing/ledger/export/AGENTS.md on-path documented',
      'instructions:tools/AGENTS.md on-path documented',
      'skill:.agents/skills/changelog/SKILL.md model-selected documented',
      // The byte order mark: Cursor does not document how it reads one.
      'skill:.agents/skills/db-migrate/SKILL.md model-selected unverified',
      'skill:.claude/skills/release/SKILL.md model-selected documented',
      // No frontmatter.
      'skill:.claude/skills/triage/SKILL.md model-selected unverified',
      'rule:.cursor/rules/api-design.mdc model-selected documented',
      'skill:.cursor/skills/review/SKILL.md model-selected documented',
      'rule:.cursor/rules/manual.mdc manual documented',
      'hook:.claude/settings.json#PreToolUse:733d584e on-approval documented',
      'hook:.cursor/hooks.json#beforeShellExecution:447fbfea on-approval documented',
      'mcp-server:.cursor/mcp.json#linear on-approval unverified',
      'mcp-server:.cursor/mcp.json#postgres on-approval unverified',
    ]);
    expect(plan.skipped.map((s) => [s.path, s.code, s.ruleId])).toEqual([
      ['.cursor/rules/notes.md', 'not-mdc', 'cursor/md-file-ignored'],
    ]);
    expect(plan.outOfScope).toEqual([
      { path: '.cursor/rules/README.md', because: 'documentation' },
      // Cursor reads CLAUDE.md at the workspace root only.
      { path: 'packages/api/CLAUDE.md', because: 'below-start-dir' },
      { path: 'packages/web/CLAUDE.md', because: 'below-start-dir' },
    ]);
    expect(plan.incomplete).toEqual([]);
    expect(plan.totals.startup.tokens).toBe(Math.ceil(plan.totals.startup.chars / 4));
    expectSkipsReported(built);
    expectSorted(plan);
  });
});

describe('loadCursor: determinism and hostile input', () => {
  const FILES: FileMap = {
    'AGENTS.md': '# Root\n',
    'b/AGENTS.md': '# B\n',
    'a/AGENTS.md': '# A\n',
    '.cursor/rules/z.mdc': FRONTMATTER('alwaysApply: true'),
    '.cursor/rules/a.mdc': FRONTMATTER('alwaysApply: true'),
    '.cursor/rules/m.md': 'x\n',
    '.cursor/skills/s/SKILL.md': FRONTMATTER('name: s\ndescription: d'),
    '.cursor/mcp.json': '{"mcpServers":{"z":{"command":"a"},"a":{"command":"b"}}}',
    '.cursor/hooks.json': '{"hooks":{"stop":[{"command":"b"}],"sessionStart":[{"command":"a"}]}}',
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
    const deep = `${'['.repeat(3000)}${']'.repeat(3000)}`;
    const built = build({
      '.cursor/mcp.json':
        '{"mcpServers":{"__proto__":{"command":"a"},"constructor":{"command":"b"},' +
        '"a#b:c":{"command":"c"},"‮":{"command":"d"},"bad":7}}',
      '.cursor/hooks.json': '{"hooks":{"__proto__":[{"command":"x"}],"stop":[{"command":7}]}}',
      '.cursor/rules/x.mdc': `---\nglobs: ${'a,'.repeat(5000)}\ndescription: ${'é'.repeat(10_000)}\n---\n`,
      '.cursor/rules/y.mdc': '---\nkey: [unclosed\n---\n',
      '.cursor/rules/z.mdc': '---\n&a [*a]\n---\n',
      '.cursor/rules/#weird name.mdc': FRONTMATTER('alwaysApply: true'),
      '.claude/settings.json':
        '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":7}]}]}}',
      // Deeper than agentcheckup's JSON parser goes: not a syntax error, so not a skip.
      '.claude/settings.local.json': `{"hooks":${deep}}`,
    });
    const { plan } = built;
    expect(plan.entries.filter((e) => e.role === 'mcp-server').map((e) => e.name)).toEqual([
      '__proto__',
      'a#b:c',
      'constructor',
      '‮',
    ]);
    expect(plan.entries.filter((e) => e.role === 'hook').map((e) => e.path)).toEqual([
      '.claude/settings.json',
      '.cursor/hooks.json',
    ]);
    expect(entry(plan, 'rule:.cursor/rules/x.mdc')?.patterns).toHaveLength(5000);
    expect(entry(plan, 'rule:.cursor/rules/y.mdc')?.certainty).toBe('unverified');
    expect(entry(plan, 'rule:.cursor/rules/z.mdc')?.certainty).toBe('unverified');
    expect(entry(plan, 'rule:.cursor/rules/#weird name.mdc')?.trigger).toBe('startup');
    expect(plan.skipped.map((s) => s.name)).toEqual(['__proto__']);
    expect(plan.incomplete).toEqual(['unparsed:.claude/settings.local.json']);
    expectSkipsReported(built);
    expectSorted(plan);
  });

  it('keeps skips consistent with findings on generated rules and skills', () => {
    const value = fc.constantFrom(
      'true',
      'false',
      '"true"',
      '',
      'src/**',
      '[a, b]',
      '{a: 1}',
      '*.ts',
    );
    const field = fc.tuple(fc.constantFrom('alwaysApply', 'globs', 'description', 'paths'), value);
    const frontmatter = fc.oneof(
      fc
        .array(field, { maxLength: 3 })
        .map((fields) => FRONTMATTER(fields.map(([key, v]) => `${key}: ${v}`).join('\n'))),
      fc.constantFrom('', '   \n', 'No frontmatter.\n', '---\nunclosed\n', '﻿---\na: 1\n---\n'),
    );
    const path = fc.constantFrom(
      '.cursor/rules/r.mdc',
      '.cursor/rules/r.md',
      '.cursor/rules/README.md',
      'x/.cursor/rules/r.mdc',
      '.cursor/skills/s/SKILL.md',
      'x/.agents/skills/s/SKILL.md',
      'AGENTS.md',
      'Agents.md',
      'CLAUDE.md',
      '.cursorrules',
    );
    fc.assert(
      fc.property(fc.dictionary(path, frontmatter, { maxKeys: 5 }), (files) => {
        const built = build(files);
        expectSkipsReported(built);
        expectSorted(built.plan);
      }),
      { numRuns: 60 },
    );
  });
});
