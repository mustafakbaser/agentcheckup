/**
 * The engine split: `analyze` decodes, classifies and sets up lazy, budgeted parsers; `runRules`
 * runs the rules over that analysis; `scanSnapshot` composes the two. Load plans and the
 * inventory reuse an analysis after the rules ran, so the split must not change any finding.
 * test/helpers/lint.ts sends every rule test through `analyze` + `runRules`; the golden reports
 * (golden.test.ts) pin the output byte for byte.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/core/config.js';
import {
  analyze,
  buildArtifacts,
  runRules,
  type ScanOptions,
  scanSnapshot,
  scanWithContext,
} from '../../src/core/engine.js';
import { buildInventory } from '../../src/inventory/build.js';
import { type AnyRule, PLATFORM_IDS, type Snapshot } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import type { MarkdownDocument } from '../../src/parse/types.js';
import { defineRule } from '../../src/rules/define.js';
import { builtinRules } from '../../src/rules/index.js';
import { type FileMap, type LintOptions, scanOptionsFrom, snapshotFrom } from '../helpers/lint.js';

/**
 * `runRules(analyze())` gives what `scanSnapshot` gives without the inventory, and
 * `scanWithContext`, which runs the loaders after the rules, gives what `scanSnapshot` gives plus
 * the context: planning never changes a finding or the inventory.
 */
function expectSameScan(snapshot: Snapshot, options: ScanOptions): void {
  const split = runRules(analyze(snapshot, options), options);
  expect(split.ruleFailures).toEqual([]);
  const scanned = scanSnapshot(snapshot, options);
  const { inventory, ...rules } = scanned;
  expect(split).toStrictEqual(rules);
  expect(inventory).toStrictEqual(buildInventory(analyze(snapshot, options)));
  for (const matrix of [false, true]) {
    const { context, ...rest } = scanWithContext(snapshot, { ...options, matrix });
    expect(rest).toStrictEqual(scanned);
    expect(context.plans.length).toBeGreaterThanOrEqual(context.agents.length);
  }
}

/** Reports every Markdown artifact the budget cut short, in rule order (path order). */
const partialMarkdown: AnyRule = defineRule({
  meta: {
    id: 'test/partial',
    title: 'Markdown was cut short',
    rationale: 'Test rule.',
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['agents-md', 'claude-md'],
    platforms: ['codex', 'claude-code'],
    sources: [
      { title: 'test', url: 'https://example.com', checked: '2026-10-15', status: 'verified' },
    ],
    since: '2026.10',
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      if (!context.markdown(artifact).analysis.complete) {
        context.report({ artifact, message: 'partial' });
      }
    }
  },
});

describe('analyze', () => {
  it('decodes and classifies like buildArtifacts, and indexes every path and alias', () => {
    const snapshot = snapshotFrom(
      {
        '.agents/skills/deploy/SKILL.md': '---\nname: deploy\n---\nShip it.\n',
        '.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\nShip it.\n',
        'AGENTS.md': '# Project\n',
        'README.md': 'not agent configuration',
        'vendor/AGENTS.md': '# Vendored\n',
      },
      { symlinks: { '.claude/skills/deploy/SKILL.md': '.agents/skills/deploy/SKILL.md' } },
    );
    const config = resolveConfig({ ignore: ['vendor/**'] });
    const analysis = analyze(snapshot, { config });

    expect(analysis.snapshot).toBe(snapshot);
    expect(analysis.config).toBe(config);
    expect(analysis.artifacts).toStrictEqual(buildArtifacts(snapshot, config));
    const skill = analysis.artifacts[0]!;
    expect([...analysis.index]).toEqual([
      ['.agents/skills/deploy/SKILL.md', skill],
      ['AGENTS.md', analysis.artifacts[1]],
      ['.claude/skills/deploy/SKILL.md', skill],
    ]);
  });

  it('targets the given platforms, else the configured ones, else every platform', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': '# Project\n' });
    const config = resolveConfig({ targets: ['cursor', 'codex'] });

    const explicit = analyze(snapshot, { config, targets: ['gemini', 'claude-code', 'gemini'] });
    expect(explicit.targetList).toEqual(['claude-code', 'gemini']);
    expect([...explicit.targets]).toEqual(['claude-code', 'gemini']);
    expect(analyze(snapshot, { config }).targetList).toEqual(['codex', 'cursor']);
    expect(analyze(snapshot).targetList).toEqual([...PLATFORM_IDS].sort());
  });

  it('parses nothing up front, so the Markdown budget goes to whoever asks first', () => {
    const files = { 'a/AGENTS.md': 'x'.repeat(100), 'b/AGENTS.md': 'y'.repeat(100) };
    const analysis = analyze(snapshotFrom(files), { markdownBudget: 150 });
    const [a, b] = analysis.artifacts;

    // Rules visit files in path order; asking for b first shows nothing was parsed in advance.
    expect(analysis.markdown(b!).analysis).toMatchObject({ complete: true, analyzedLength: 100 });
    expect(analysis.markdown(a!).analysis.complete).toBe(false);
  });

  it('caches each parse, and the parsers work without `this`', () => {
    const analysis = analyze(
      snapshotFrom({
        '.mcp.json': '{"mcpServers": {}}',
        'skills/x/SKILL.md': '---\nname: x\n---\nBody.\n',
      }),
    );
    const [mcp, skill] = analysis.artifacts;
    const { frontmatter, markdown, json } = analysis;

    expect(frontmatter(skill!)).toBe(analysis.frontmatter(skill!));
    expect(markdown(skill!)).toBe(analysis.markdown(skill!));
    expect(json(mcp!)).toBe(analysis.json(mcp!));
    expect(json(mcp!)).toMatchObject({ ok: true, value: { mcpServers: {} } });
  });

  it('keeps the parses the rules made, for use after runRules', () => {
    const seen = new Map<string, MarkdownDocument>();
    const recorder: AnyRule = defineRule({
      ...partialMarkdown,
      check(context) {
        for (const artifact of context.artifacts) {
          seen.set(artifact.path, context.markdown(artifact));
        }
      },
    });
    const files = { 'AGENTS.md': 'a'.repeat(100), 'CLAUDE.md': 'c'.repeat(100) };
    const analysis = analyze(snapshotFrom(files), { markdownBudget: 150 });
    runRules(analysis, { rules: [recorder] });

    expect(seen.size).toBe(2);
    for (const artifact of analysis.artifacts) {
      expect(analysis.markdown(artifact)).toBe(seen.get(artifact.path));
    }
    // The budget was spent in rule order, so the second file stays cut short afterwards too.
    expect(analysis.markdown(analysis.index.get('CLAUDE.md')!).analysis.complete).toBe(false);
  });
});

describe('runRules(analyze()) matches scanSnapshot', () => {
  async function fixture(name: string, gitRoot: boolean): Promise<Snapshot> {
    const walked = await walk(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
    if (!gitRoot) return walked;
    // As in golden.test.ts: git cannot store a `.git` entry inside the fixture.
    return {
      ...walked,
      paths: new Set([...walked.paths, '.git/']),
      opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
    };
  }

  const fixtureOptions: readonly { readonly name: string; readonly options: ScanOptions }[] = [
    {
      name: 'golden options',
      options: { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false },
    },
    {
      name: 'a tight Markdown budget',
      options: { rules: builtinRules, markdownBudget: 4096, markdownLineBudget: 120 },
    },
    {
      name: 'configured targets and severities',
      options: {
        rules: builtinRules,
        config: resolveConfig({
          targets: ['codex', 'cursor'],
          rules: { 'instr/codex-size-budget': 'info' },
          overrides: [{ files: ['packages/**'], rules: { 'instr/empty-file': 'off' } }],
        }),
      },
    },
  ];

  it.each(fixtureOptions)('on the golden fixtures, with $name', async ({ options }) => {
    expectSameScan(await fixture('context', true), options);
    expectSameScan(await fixture('smoke', false), options);
  });

  const skill = (name: string): string => `---\nname: ${name}\ndescription: Ships ${name}.\n---\n`;

  /** In-memory repositories like the rule tests build, run with every built-in rule. */
  const samples: readonly {
    readonly name: string;
    readonly files: FileMap;
    readonly options: Omit<LintOptions, 'rules'>;
    readonly budget?: Pick<ScanOptions, 'markdownBudget' | 'markdownLineBudget'>;
  }[] = [
    {
      name: 'instruction files, imports and subagents',
      files: {
        'CLAUDE.md': '# Project\n\n@docs/guide.md\n@missing.md\n<!-- @hidden.md -->\n',
        'AGENTS.md': '# Agents\n\nTry to be careful when possible.\n',
        'packages/api/AGENTS.override.md': '',
        'packages/api/AGENTS.md': '# API\n',
        '.claude/rules/ts.md': '---\npaths:\n  - "src/**/*.ts"\n---\n# TypeScript\n',
        '.claude/rules/broken.md': '---\npaths: [unclosed\n---\n# Broken\n',
        '.claude/agents/reviewer.md': '---\nname: reviewer\n---\nReview changes.\n',
        'Claude.md': '# Wrong case\n',
      },
      options: { paths: ['docs/guide.md', '.git/'] },
    },
    {
      name: 'skills reached through symlinks',
      files: {
        '.agents/skills/deploy/SKILL.md': skill('deploy'),
        '.claude/skills/deploy/SKILL.md': skill('deploy'),
        '.claude/skills/ship/SKILL.md': skill('deploy'),
        '.claude/skills/bad/SKILL.md':
          '\uFEFF---\nname: Bad Name\nmetadata: x\n---\nSee [x](x.md).\n',
        'skills/empty/SKILL.md': '',
      },
      options: {
        symlinks: { '.claude/skills/deploy/SKILL.md': '.agents/skills/deploy/SKILL.md' },
      },
    },
    {
      name: 'MCP servers, hooks and settings',
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: {
            remote: { url: 'http://example.com/mcp' },
            local: {
              command: 'npx',
              args: ['some-server'],
              env: { TOKEN: 'ghp_' + 'a'.repeat(36) },
            },
          },
        }),
        '.claude/settings.json': JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1' },
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
            OnSomething: [],
          },
        }),
        '.claude/settings.local.json': '{"permissions": {"allow": ["Bash(*)"]}}',
        '.cursor/mcp.json': '{"mcpServers": {"a": {"command": "uvx", "args": ["tool"]}}}',
        '.cursor/hooks.json':
          '{"version": 1, "hooks": {"beforeShellExecution": [{"command": "x"}]}}',
        '.gemini/settings.json': '// comment\n{"mcpServers": {"g": {"httpUrl": "http://x"}}}\n',
        '.codex/hooks.json': '{"hooks": {}, "hooks": {}}',
      },
      options: { gitignoreApplied: false },
    },
    {
      name: 'rule files of every other agent',
      files: {
        '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nAlways.\n',
        '.cursor/rules/never.mdc': '---\nalwaysApply: false\n---\nNever applied.\n',
        '.cursor/rules/notes.md': 'Ignored by Cursor.\n',
        '.cursorrules': 'Legacy rules.\n',
        '.github/copilot-instructions.md': '# Copilot\n',
        '.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\n---\nTypeScript.\n',
        '.windsurf/rules/x.md': 'Long line of rules.\n'.repeat(400),
        '.clinerules/x.md': '# Cline\n',
        'GEMINI.md': '# Gemini\n\u202Ehidden\n',
      },
      options: { targets: ['cursor', 'copilot', 'windsurf', 'cline', 'gemini'] },
    },
    {
      name: 'trusted directives and a configuration',
      files: {
        'AGENTS.md':
          '# Title\n<!-- agentcheckup-disable-next-line instr/vague-directive -- legacy -->\nTry to be careful when possible.\n<!-- agentcheckup-disable-next-line test/nope -->\n',
        'CLAUDE.md': '<!-- agentcheckup-disable-file instr/empty-file -- r -->\n',
        'vendor/AGENTS.md': '',
      },
      options: {
        trustDirectives: true,
        config: {
          ignore: ['vendor/**'],
          rules: { 'instr/agents-md-ignored-by-claude': 'error', 'no/such-rule': 'warn' },
        },
      },
    },
    {
      name: 'many Markdown files over a small budget',
      files: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `pkg${index}/AGENTS.md`,
          `# Package ${index}\n\n${'- item\n'.repeat(index * 5)}`,
        ]),
      ),
      options: { config: {}, targets: ['codex', 'claude-code'] },
      budget: { markdownBudget: 400, markdownLineBudget: 90 },
    },
  ];

  it.each(samples)('on rule-test snapshots: $name', ({ files, options, budget }) => {
    const lintOptions: LintOptions = { ...options, rules: builtinRules };
    expectSameScan(snapshotFrom(files, lintOptions), {
      ...scanOptionsFrom(lintOptions),
      ...budget,
    });
  });

  it('on a small budget, with the parse order the rules set', () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`d${index}/AGENTS.md`, 'line\n'.repeat(10)]),
    );
    const options: ScanOptions = { rules: [partialMarkdown], markdownLineBudget: 25 };
    expectSameScan(snapshotFrom(files), options);
    expect(scanSnapshot(snapshotFrom(files), options).findings.map((f) => f.path)).toEqual([
      'd2/AGENTS.md',
      'd3/AGENTS.md',
      'd4/AGENTS.md',
      'd5/AGENTS.md',
    ]);
  });
});
