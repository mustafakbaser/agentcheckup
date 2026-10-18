/**
 * The batch strategy of fixRounds (src/fix/verify.ts) against the isolated one, which scans each
 * fix alone: the same run in every respect (decisions, effects, files, the scans before and
 * after), from fewer scans. The test rules report on a file from that file alone, except
 * test/cross, whose findings on AGENTS.md depend on other files, as the batch strategy allows.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  AnyRule,
  Artifact,
  ArtifactKind,
  Fix,
  FixClass,
  RuleContext,
  Severity,
} from '../../src/core/types.js';
import type { FixSelection } from '../../src/fix/index.js';
import { fixRounds, type FixRoundsOptions, type FixRun } from '../../src/fix/verify.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { ALL_CLASSES, SAFE_ONLY, testRule } from './helpers.js';

const MARKDOWN: readonly ArtifactKind[] = [
  'agents-md',
  'claude-md',
  'claude-rule',
  'skill',
  'cursor-rule',
  'cursor-rule-md',
];

/** Each line of the artifact's text with its offset, without the line break. */
function linesOf(artifact: Artifact): { readonly text: string; readonly offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const text of artifact.decoded.text.split('\n')) {
    out.push({ text, offset });
    offset += text.length + 1;
  }
  return out;
}

function fixOf(id: string, cls: FixClass, changes: Fix['changes']): Fix {
  return { id, class: cls, title: id, changes };
}

/**
 * A rule that reports every line equal to `token`, and fixes it by replacing the line with
 * `replacement`, or by inserting `replacement` above it when `insert` is set. File-local: what it
 * reports on a file depends only on that file.
 */
function lineRule(
  id: string,
  token: string,
  replacement: string,
  options: { severity?: Severity; cls?: FixClass; insert?: boolean } = {},
): AnyRule {
  return testRule({
    id,
    appliesTo: MARKDOWN,
    severity: options.severity ?? 'warn',
    check(context, artifact) {
      for (const line of linesOf(artifact)) {
        if (line.text !== token) continue;
        const edit =
          options.insert === true
            ? { offset: line.offset, length: 0, text: `${replacement}\n` }
            : { offset: line.offset, length: line.text.length, text: replacement };
        context.report({
          artifact,
          message: `${token} here.`,
          span: { offset: line.offset, length: line.text.length },
          fix: fixOf(`${id}#line`, options.cls ?? 'safe', [
            { kind: 'edit', path: artifact.path, edits: [edit] },
          ]),
        });
      }
    },
  });
}

/**
 * Reports on the root AGENTS.md, once per other file that contains a `CROSS` line: a finding on
 * one file that depends on another file, which only scanning the fix alone can attribute.
 */
const cross = testRule({
  id: 'test/cross',
  appliesTo: ['agents-md'],
  check(context: RuleContext<undefined>, artifact) {
    if (artifact.path !== 'AGENTS.md') return;
    for (const other of context.allArtifacts) {
      if (other.path === artifact.path) continue;
      if (!linesOf(other).some((line) => line.text === 'CROSS')) continue;
      context.report({ artifact, message: `CROSS in ${other.path}.` });
    }
  },
});

/** Adds an MCP server: a gate hit, so verification demotes the safe fix to review. */
const server = testRule({
  id: 'test/server',
  appliesTo: ['mcp-json'],
  platforms: ['claude-code'],
  check(context, artifact) {
    const { text } = artifact.decoded;
    if (text.includes('"docs"')) return;
    const at = text.indexOf('{}');
    if (at < 0) return;
    context.report({
      artifact,
      message: 'No docs server.',
      fix: fixOf('test/server#add', 'safe', [
        {
          kind: 'edit',
          path: artifact.path,
          edits: [
            { offset: at, length: 2, text: '{"docs": {"command": "npx", "args": ["docs"]}}' },
          ],
        },
      ]),
    });
  },
});

/** Renames a Cursor rule to `.mdc`. */
const extension = testRule({
  id: 'test/extension',
  appliesTo: ['cursor-rule-md'],
  platforms: ['cursor'],
  check(context, artifact) {
    context.report({
      artifact,
      message: 'Not .mdc.',
      fix: fixOf('test/extension#rename', 'safe', [
        { kind: 'rename', from: artifact.path, to: `${artifact.path}c` },
      ]),
    });
  },
});

/** Creates CLAUDE.md that imports AGENTS.md: a new file, and a Claude Code startup change. */
const claude = testRule({
  id: 'test/claude',
  severity: 'info',
  check(context, artifact) {
    if (artifact.path !== 'AGENTS.md' || context.snapshot.paths.has('CLAUDE.md')) return;
    if (!linesOf(artifact).some((line) => line.text === 'NEED-CLAUDE')) return;
    context.report({
      artifact,
      message: 'No CLAUDE.md.',
      fix: fixOf('test/claude#create', 'review', [
        { kind: 'create', path: 'CLAUDE.md', text: '@AGENTS.md\n' },
      ]),
    });
  },
});

/**
 * Creates an MCP config the inventory cannot read: a gate hit on an `incomplete` entry, by path
 * for VS Code's config, and as `invalid-json:<path>` for Cursor's.
 */
const config = (token: string, path: string, text: string): AnyRule =>
  testRule({
    id: `test/config-${token.toLowerCase()}`,
    severity: 'info',
    check(context, artifact) {
      if (artifact.path !== 'AGENTS.md' || context.snapshot.paths.has(path)) return;
      if (!linesOf(artifact).some((line) => line.text === token)) return;
      context.report({
        artifact,
        message: `No ${path}.`,
        fix: fixOf(`test/config#${token}`, 'safe', [{ kind: 'create', path, text }]),
      });
    },
  });

const RULES: readonly AnyRule[] = [
  lineRule('test/fix-a', 'FIX-A', 'done'),
  // Conflicts with test/fix-a on the same line.
  lineRule('test/also-a', 'FIX-A', 'also', { severity: 'info' }),
  // Its fix adds an error: verification drops it.
  lineRule('test/fix-b', 'FIX-B', 'BAD'),
  lineRule('test/bad', 'BAD', 'ok', { severity: 'error' }),
  // Its fix leaves the finding.
  lineRule('test/stubborn', 'STUBBORN', 'note', { insert: true }),
  // Startup token changes, and a fix the next round's rule reports.
  lineRule('test/grow', 'GROW', `grown ${'text '.repeat(25)}`, { severity: 'info', cls: 'review' }),
  lineRule('test/heading', 'HEAD', '# Heading\nNEXT', { severity: 'info' }),
  lineRule('test/next', 'NEXT', 'next done', { severity: 'info' }),
  // Its fix adds a finding on another file.
  lineRule('test/fix-c', 'FIX-C', 'CROSS'),
  cross,
  server,
  extension,
  claude,
  config(
    'NEED-VSCODE',
    '.vscode/mcp.json',
    '{"servers": {"docs": {"type": "http", "url": "https://docs.example.com/mcp"}}}\n',
  ),
  config('NEED-CURSOR', '.cursor/mcp.json', '{ not json\n'),
];

const BODY = [
  'plain text',
  'FIX-A',
  'FIX-B',
  'BAD',
  'STUBBORN',
  'GROW',
  'HEAD',
  'FIX-C',
  'CROSS',
  'NEED-CLAUDE',
  'NEED-VSCODE',
  'NEED-CURSOR',
];

const PATHS: Readonly<Record<string, string>> = {
  'AGENTS.md': '',
  'CLAUDE.md': '',
  'pkg/AGENTS.md': '',
  '.claude/rules/style.md': '',
  '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ships the app.\n---\n',
  '.cursor/rules/notes.md': '',
  '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\n',
};

const repository: fc.Arbitrary<FileMap> = fc
  .tuple(
    fc.subarray(Object.keys(PATHS), { minLength: 1 }),
    fc.boolean(),
    fc.array(fc.array(fc.constantFrom(...BODY), { maxLength: 6 }), {
      minLength: Object.keys(PATHS).length,
      maxLength: Object.keys(PATHS).length,
    }),
  )
  .map(([paths, mcp, bodies]) => {
    const files: Record<string, string> = {};
    paths.forEach((path, index) => {
      const lines = bodies[index] ?? [];
      files[path] = (PATHS[path] ?? '') + lines.map((line) => `${line}\n`).join('');
    });
    if (mcp) files['.mcp.json'] = '{"mcpServers": {}}\n';
    return files;
  });

/** The rules, and how many scans ran them. */
function counting(rules: readonly AnyRule[]): { rules: AnyRule[]; scans: () => number } {
  let scans = 0;
  const [first, ...rest] = rules;
  if (first === undefined) throw new Error('no rules');
  const counter: AnyRule = {
    meta: first.meta,
    defaultOptions: first.defaultOptions as unknown,
    check(context: RuleContext<unknown>) {
      scans++;
      first.check(context as never);
    },
  };
  return { rules: [counter, ...rest], scans: () => scans };
}

function both(
  files: FileMap,
  rules: readonly AnyRule[] = RULES,
  selection: FixSelection = ALL_CLASSES,
  maxRounds?: number,
): { batch: FixRun; isolated: FixRun; scans: { batch: number; isolated: number } } {
  const run = (strategy: NonNullable<FixRoundsOptions['strategy']>) => {
    const counted = counting(rules);
    const result = fixRounds(snapshotFrom(files), { rules: counted.rules }, selection, maxRounds, {
      strategy,
    });
    return { result, scans: counted.scans() };
  };
  const batch = run('batch');
  const isolated = run('isolated');
  return {
    batch: batch.result,
    isolated: isolated.result,
    scans: { batch: batch.scans, isolated: isolated.scans },
  };
}

describe('batch verification', () => {
  it('decides, applies and reports exactly as scanning each fix alone', () => {
    fc.assert(
      fc.property(
        repository,
        fc.constantFrom(SAFE_ONLY, ALL_CLASSES),
        fc.integer({ min: 1, max: 3 }),
        (files, selection, maxRounds) => {
          const { batch, isolated } = both(files, RULES, selection, maxRounds);
          expect(batch).toEqual(isolated);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('agrees with scanning each fix alone when two instruction files have the same text', () => {
    // A counterexample the property found: equal AGENTS.md and CLAUDE.md, and an always-applied
    // Cursor rule without a body, safe fixes only, one round.
    const files = {
      'AGENTS.md': 'HEAD\n',
      'CLAUDE.md': 'HEAD\n',
      '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\n',
    };
    const { batch, isolated } = both(files, RULES, SAFE_ONLY, 1);
    expect(batch).toEqual(isolated);
  });

  it('finds the fix that changes another file by halving the group', () => {
    const files: Record<string, string> = { 'AGENTS.md': '# Root\n' };
    for (let index = 0; index < 16; index++) files[`p${String(index)}/AGENTS.md`] = 'FIX-A\n';
    files['p9/AGENTS.md'] = 'FIX-C\n';
    const { batch, isolated, scans } = both(files);
    expect(batch).toEqual(isolated);
    expect(batch.skipped.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/fix-c', 'verification-failed'],
    ]);
    expect(batch.applied).toHaveLength(15);
    // Isolated: the scan before, one per fix, and the combination. Batch: the scan before, the
    // group, about two scans per halving, the combination.
    expect(scans.isolated).toBe(1 + 16 + 1);
    expect(scans.batch).toBeLessThanOrEqual(1 + 1 + 2 * Math.log2(16) + 1);
  });

  it('scans a fix that fails in a group alone, and the rest of the group again', () => {
    const files = {
      'AGENTS.md': 'FIX-A\n',
      'pkg/AGENTS.md': 'FIX-B\n',
      '.claude/rules/style.md': 'FIX-A\n',
    };
    const { batch, isolated, scans } = both(files);
    expect(batch).toEqual(isolated);
    expect(batch.skipped.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/fix-b', 'verification-failed'],
    ]);
    expect(batch.applied.map((item) => item.ruleId)).toEqual(['test/fix-a', 'test/fix-a']);
    // Before, the group, test/fix-b alone, the other two again (then the combination they are).
    expect(scans.batch).toBe(4);
    expect(scans.isolated).toBe(5);
  });

  it('gives each fix its own startup tokens when several change one agent', () => {
    const files = { 'CLAUDE.md': '# Claude\nGROW\n', '.claude/rules/style.md': 'GROW\n' };
    const { batch, isolated, scans } = both(files);
    expect(batch).toEqual(isolated);
    expect(scans.batch).toBeLessThan(scans.isolated);
    const claudeTokens = (index: number) =>
      batch.applied[index]?.effects.find(
        (effect) => effect.kind === 'tokens' && effect.agent === 'claude-code',
      );
    const [first, second] = [claudeTokens(0), claudeTokens(1)];
    const plan = (run: FixRun['before']) =>
      run.context.plans.find((item) => item.agent === 'claude-code')?.totals.startup;
    const [start, end] = [plan(batch.before), plan(batch.after)];
    if (first?.kind !== 'tokens' || second?.kind !== 'tokens') throw new Error('no effect');
    expect(first.before).toBe(start?.tokens);
    expect(second.before).toBe(start?.tokens);
    // Each fix alone adds its own text; together they add both.
    const added = (effect: typeof first) => effect.after - effect.before;
    expect(added(first)).toBeGreaterThan(0);
    expect(added(second)).toBeGreaterThan(0);
    expect(first.after).toBeLessThan(end?.tokens ?? 0);
    expect(second.after).toBeLessThan(end?.tokens ?? 0);
  });

  it('demotes, renames and creates as the isolated scans do', () => {
    const files = {
      'AGENTS.md': 'NEED-CLAUDE\nNEED-VSCODE\nNEED-CURSOR\nFIX-A\n',
      '.cursor/rules/notes.md': 'FIX-A\n',
      '.mcp.json': '{"mcpServers": {}}\n',
    };
    for (const selection of [SAFE_ONLY, ALL_CLASSES]) {
      const { batch, isolated } = both(files, RULES, selection);
      expect(batch).toEqual(isolated);
    }
    const { batch } = both(files);
    expect(batch.files.map((file) => [file.op, file.path])).toEqual([
      ['create', '.cursor/mcp.json'],
      ['rename', '.cursor/rules/notes.mdc'],
      ['edit', '.mcp.json'],
      ['create', '.vscode/mcp.json'],
      ['edit', 'AGENTS.md'],
      ['create', 'CLAUDE.md'],
    ]);
    const gates = batch.applied.flatMap((item) =>
      item.effects.flatMap((effect) =>
        effect.kind === 'gate' ? [[item.ruleId, item.fix.class, effect.class, effect.id]] : [],
      ),
    );
    expect(gates).toEqual([
      ['test/server', 'review', 'mcp', 'mcp:.mcp.json#docs'],
      ['test/server', 'review', 'mcp-unpinned', 'mcp:.mcp.json#docs'],
      ['test/config-need-cursor', 'review', 'mcp', 'invalid-json:.cursor/mcp.json'],
      ['test/config-need-vscode', 'review', 'mcp', 'mcp:.vscode/mcp.json#docs'],
    ]);
  });
});
