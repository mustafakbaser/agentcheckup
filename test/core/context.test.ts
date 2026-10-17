/**
 * `scanWithContext`: the rules, then the inventory, then the loaders, on one analysis. Findings
 * equal `scanSnapshot`'s (test/core/analyze.test.ts checks that on every rule-test snapshot);
 * these tests cover the options, the report it builds and that the full JSON is deterministic.
 */
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/core/config.js';
import { scanSnapshot, scanWithContext } from '../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../src/core/types.js';
import { scan } from '../../src/index.js';
import { walk } from '../../src/io/walk.js';
import { formatJson } from '../../src/report/json.js';
import { builtinRules } from '../../src/rules/index.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

const OPTIONS = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;
const FIXTURE = fileURLToPath(new URL('../fixtures/context', import.meta.url));

async function contextFixture(): Promise<Snapshot> {
  const walked = await walk(FIXTURE);
  return {
    ...walked,
    paths: new Set([...walked.paths, '.git/']),
    opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
  };
}

/** The same snapshot with its files, paths and directory sets in another order. */
function reordered(snapshot: Snapshot, order: (items: readonly unknown[]) => number[]): Snapshot {
  const permute = <T>(items: readonly T[]): T[] => order(items).map((index) => items[index]!);
  return {
    ...snapshot,
    files: permute(snapshot.files),
    paths: new Set(permute([...snapshot.paths])),
    opaqueDirectories: new Set(permute([...snapshot.opaqueDirectories])),
    ignoredFiles: new Set(permute([...snapshot.ignoredFiles])),
  };
}

const reverse = (items: readonly unknown[]): number[] => items.map((_, i) => items.length - 1 - i);

function json(snapshot: Snapshot): string {
  return formatJson(
    scanWithContext(snapshot, { ...OPTIONS, matrix: true, contextWindow: 200_000 }),
  );
}

describe('scanWithContext', () => {
  const files: FileMap = {
    'AGENTS.md': 'Root.\n',
    'CLAUDE.md': '@AGENTS.md\n',
    'pkg/AGENTS.md': 'Package.\n',
    '.mcp.json': '{"mcpServers":{"github":{"command":"npx","args":["-y","x@1.0.0"]}}}',
  };
  const snapshot = snapshotFrom(files, { paths: ['.git/HEAD'] });

  it('adds the inventory and one plan per modeled target at the root', () => {
    const result = scanWithContext(snapshot, OPTIONS);
    const { context, ...rest } = result;
    expect(rest).toStrictEqual(scanSnapshot(snapshot, OPTIONS));
    expect(context.agents).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot-cli',
      'copilot-vscode',
      'copilot-cloud',
      'windsurf',
      'cline',
    ]);
    expect(context.plans.map((plan) => `${plan.agent}@${plan.cwd}`)).toEqual([
      'claude-code@',
      'codex@',
      'cursor@',
      'copilot-cli@',
      'copilot-vscode@',
      'copilot-cloud@',
      'windsurf@',
      'cline@',
    ]);
    expect(context.matrix).toBeUndefined();
    expect(result.inventory.mcpServers.map((server) => server.id)).toEqual([
      'mcp:.mcp.json#github',
    ]);
    // `sources` holds exactly the keys the plans cite.
    const cited = new Set(
      context.plans.flatMap((plan) => [
        ...plan.entries.flatMap((entry) => entry.evidence),
        ...plan.skipped.flatMap((skip) => skip.evidence),
        ...plan.assumptions.flatMap((assumption) => assumption.evidence),
        ...plan.limits.flatMap((limit) => limit.evidence),
      ]),
    );
    expect(Object.keys(context.sources)).toEqual([...cited].sort());
  });

  it('plans the agents and working directory asked for', () => {
    const { context } = scanWithContext(snapshot, {
      ...OPTIONS,
      agents: ['cursor', 'codex'],
      cwd: 'pkg',
    });
    expect(context.agents).toEqual(['codex', 'cursor']);
    expect(context.plans.map((plan) => `${plan.agent}@${plan.cwd}`)).toEqual([
      'codex@pkg',
      'cursor@pkg',
    ]);
  });

  it('defaults to the modeled agents among the targets', () => {
    const only = scanWithContext(snapshot, { ...OPTIONS, targets: ['codex', 'gemini'] });
    expect(only.context.agents).toEqual(['codex']);
    const none = scanWithContext(snapshot, { ...OPTIONS, targets: ['gemini'] });
    expect(none.context).toEqual({ agents: [], sources: {}, plans: [] });
    const configured = scanWithContext(snapshot, {
      rules: builtinRules,
      config: resolveConfig({ targets: ['cursor'] }),
    });
    expect(configured.context.agents).toEqual(['cursor']);
  });

  it('adds Codex plans per AGENTS.md directory and the matrix', () => {
    const { context } = scanWithContext(snapshot, { ...OPTIONS, matrix: true });
    expect(context.plans.map((plan) => `${plan.agent}@${plan.cwd}`)).toEqual([
      'claude-code@',
      'codex@',
      'codex@pkg',
      'cursor@',
      'copilot-cli@',
      'copilot-vscode@',
      'copilot-cloud@',
      'windsurf@',
      'cline@',
    ]);
    expect(context.matrix?.rows.map((row) => [row.path, ...row.cells])).toEqual([
      // Claude Code, Codex, Cursor, Copilot CLI, VS Code and cloud agent, Devin Local, Cline.
      [
        '.mcp.json',
        'startup',
        'not-read',
        'not-read',
        'startup',
        'startup',
        'not-read',
        'startup',
        'not-read',
      ],
      [
        'AGENTS.md',
        'startup',
        'startup',
        'startup',
        'startup',
        'startup',
        'startup',
        'startup',
        'startup',
      ],
      [
        'CLAUDE.md',
        'startup',
        'not-read',
        'startup',
        'startup',
        'startup',
        'startup',
        'startup',
        'not-read',
      ],
      [
        'pkg/AGENTS.md',
        'skipped',
        'start-dir',
        'on-path',
        'on-path',
        'not-read',
        'on-path',
        'on-path',
        'not-read',
      ],
    ]);
  });

  it('rejects options it cannot plan, before running any rule', () => {
    const bad = [
      { agents: ['gemini'] },
      { cwd: '../x' },
      { cwd: 'a/../b' },
      { cwd: 'pkg/' },
      { contextWindow: 0 },
      { contextWindow: 1.5 },
      { matrix: true, cwd: 'pkg' },
    ] as const;
    for (const options of bad) {
      expect(() => scanWithContext(snapshot, { ...OPTIONS, ...options })).toThrow();
    }
  });
});

describe('determinism of the full context JSON', () => {
  it('is byte-identical for the context fixture in any file order, and across runs', async () => {
    const snapshot = await contextFixture();
    const first = json(snapshot);
    expect(json(snapshot)).toBe(first);
    expect(json(reordered(snapshot, reverse))).toBe(first);
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const order = (items: readonly unknown[]): number[] => {
          // A seeded Fisher–Yates shuffle.
          const indexes = items.map((_, i) => i);
          let state = seed >>> 0;
          for (let i = indexes.length - 1; i > 0; i--) {
            state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
            const j = state % (i + 1);
            [indexes[i], indexes[j]] = [indexes[j]!, indexes[i]!];
          }
          return indexes;
        };
        expect(json(reordered(snapshot, order))).toBe(first);
      }),
      { numRuns: 5 },
    );
  });

  it('is byte-identical for generated snapshots in reverse order', () => {
    const path = fc.constantFrom(
      'AGENTS.md',
      'AGENTS.override.md',
      'a/AGENTS.md',
      'a/b/AGENTS.md',
      'CLAUDE.md',
      'a/CLAUDE.md',
      '.claude/skills/s/SKILL.md',
      '.agents/skills/t/SKILL.md',
      '.cursor/rules/r.mdc',
      '.cursor/rules/x.md',
      '.claude/settings.json',
      '.cursor/hooks.json',
      '.mcp.json',
    );
    const content = fc.constantFrom(
      '',
      'Text.\n',
      '@AGENTS.md\n',
      '---\nname: s\ndescription: Does s.\n---\n',
      '---\nglobs: *.ts\n---\n',
      '{"mcpServers":{"a":{"command":"a"},"u":{"url":"https://u"}}}',
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"},{"type":"command","command":"x"}]}]}}',
      '{',
    );
    fc.assert(
      fc.property(fc.dictionary(path, content, { maxKeys: 8 }), (files) => {
        const snapshot = snapshotFrom(files, { paths: ['.git/HEAD'] });
        expect(json(reordered(snapshot, reverse))).toBe(json(snapshot));
      }),
      { numRuns: 40 },
    );
  });
});

describe('scan', () => {
  it('adds the context when asked', async () => {
    const plain = await scan(FIXTURE, { targets: ['codex'] });
    expect(plain.context).toBeUndefined();
    expect(plain.inventory.mcpServers.length).toBeGreaterThan(0);
    const withContext = await scan(FIXTURE, { targets: ['codex'], context: true });
    expect(withContext.context?.agents).toEqual(['codex']);
    const matrix = await scan(FIXTURE, { context: { agents: ['cursor'], matrix: true } });
    expect(matrix.context?.matrix?.rows.length).toBeGreaterThan(0);
    expect(withContext.findings).toEqual(plain.findings);
  });
});
