import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyze, runRules } from '../../src/core/engine.js';
import { decode } from '../../src/core/text.js';
import type { AnyRule, Artifact, Fix } from '../../src/core/types.js';
import { applyPlan } from '../../src/fix/apply.js';
import {
  insertLine,
  jsonInsertProperty,
  prependFrontmatter,
  renameFile,
} from '../../src/fix/edits.js';
import type { FixSelection } from '../../src/fix/index.js';
import { planFixes } from '../../src/fix/plan.js';
import { encodeText } from '../../src/fix/text.js';
import { fixRounds, MAX_WRITTEN_FILE_BYTES } from '../../src/fix/verify.js';
import * as api from '../../src/index.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { ALL_CLASSES, SAFE_ONLY, testRule, textOf } from './helpers.js';

const text = (artifact: Artifact): string => artifact.decoded.text;
const lines = (artifact: Artifact): string[] => text(artifact).split(/\r?\n/);

function fix(id: string, changes: Fix['changes'], cls: Fix['class'] = 'safe'): Fix {
  return { id, class: cls, title: id, changes };
}

/** AGENTS.md must start with a heading: inserts `# Rules` as line 1. */
const heading = testRule({
  id: 'test/heading',
  check(context, artifact) {
    if (text(artifact).startsWith('# ')) return;
    context.report({
      artifact,
      message: 'No heading.',
      fix: fix('test/heading#insert', [insertLine(artifact, 0, '# Rules')]),
    });
  },
});

/** A heading must be followed by an empty line. An info, so the heading fix may cause it. */
const blankAfterHeading = testRule({
  id: 'test/blank',
  severity: 'info',
  check(context, artifact) {
    const [first, second] = lines(artifact);
    if (first?.startsWith('# ') !== true || second === undefined || second.trim() === '') return;
    if (lines(artifact).length === 2 && second === '') return;
    context.report({
      artifact,
      message: 'No empty line after the heading.',
      span: { offset: 0, length: 1 },
      fix: fix('test/blank#insert', [insertLine(artifact, 1, '')]),
    });
  },
});

function run(
  files: FileMap,
  rules: readonly AnyRule[],
  selection: FixSelection = SAFE_ONLY,
  maxRounds?: number,
) {
  return fixRounds(snapshotFrom(files), { rules }, selection, maxRounds);
}

describe('fixRounds', () => {
  it('applies a fix, verifies it and reports its effect', () => {
    const result = run({ 'AGENTS.md': 'Use pnpm.\n' }, [heading]);
    expect(result.rounds).toBe(1);
    expect(result.applied.map((item) => [item.fix.id, item.status])).toEqual([
      ['test/heading#insert', 'planned'],
    ]);
    expect(result.applied[0]?.findings).toEqual(
      result.before.findings.map((finding) => finding.fingerprint),
    );
    expect(textOf(result.snapshot, 'AGENTS.md')).toBe('# Rules\nUse pnpm.\n');
    expect(result.verification).toEqual({ resolved: 1, remaining: 0, introduced: [] });
    expect(result.files).toEqual([
      {
        path: 'AGENTS.md',
        op: 'edit',
        before: new TextEncoder().encode('Use pnpm.\n'),
        after: new TextEncoder().encode('# Rules\nUse pnpm.\n'),
      },
    ]);
    const codex = result.applied[0]?.effects.find(
      (effect) => effect.kind === 'tokens' && effect.agent === 'codex',
    );
    expect(codex).toMatchObject({ kind: 'tokens', cwd: '' });
    if (codex?.kind === 'tokens') expect(codex.after).toBeGreaterThan(codex.before);
    expect(result.after.findings).toEqual([]);
  });

  it('runs again when a fix enables another, up to the round limit', () => {
    const files = { 'AGENTS.md': 'Use pnpm.\n' };
    const result = run(files, [heading, blankAfterHeading]);
    expect(result.rounds).toBe(2);
    expect(result.applied.map((item) => item.ruleId)).toEqual(['test/heading', 'test/blank']);
    expect(textOf(result.snapshot, 'AGENTS.md')).toBe('# Rules\n\nUse pnpm.\n');
    expect(result.verification).toEqual({ resolved: 1, remaining: 0, introduced: [] });

    const once = run(files, [heading, blankAfterHeading], SAFE_ONLY, 1);
    expect(once.rounds).toBe(1);
    expect(once.skipped.map((item) => [item.ruleId, item.status, item.reason])).toEqual([
      ['test/blank', 'skipped', 'limit'],
    ]);
    expect(once.verification.introduced.map((finding) => finding.ruleId)).toEqual(['test/blank']);
  });

  it('drops a fix that leaves its finding, and one that adds a warning', () => {
    const stubborn = testRule({
      id: 'test/stubborn',
      check(context, artifact) {
        if (!text(artifact).includes('STUBBORN')) return;
        context.report({
          artifact,
          message: 'Stubborn.',
          fix: fix('test/stubborn#append', [insertLine(artifact, 0, 'still here')]),
        });
      },
    });
    const shout = testRule({
      id: 'test/shout',
      check(context, artifact) {
        if (text(artifact).includes('SHOUT')) context.report({ artifact, message: 'Shouting.' });
      },
    });
    const noisy = testRule({
      id: 'test/noisy',
      appliesTo: ['claude-md'],
      check(context, artifact) {
        if (text(artifact).includes('quiet')) return;
        context.report({
          artifact,
          message: 'Not quiet.',
          fix: fix('test/noisy#append', [insertLine(artifact, 0, 'quiet SHOUT')]),
          guidance: 'make it quiet by hand',
        });
      },
    });
    const shoutInClaude = testRule({
      id: 'test/shout-claude',
      appliesTo: ['claude-md'],
      check(context, artifact) {
        if (text(artifact).includes('SHOUT')) context.report({ artifact, message: 'Shouting.' });
      },
    });
    const result = run({ 'AGENTS.md': 'STUBBORN\n', 'CLAUDE.md': '# Claude\n' }, [
      stubborn,
      shout,
      noisy,
      shoutInClaude,
    ]);
    expect(result.skipped.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/stubborn', 'verification-failed'],
      ['test/noisy', 'verification-failed'],
    ]);
    expect(result.applied).toEqual([]);
    expect(result.snapshot.files).toEqual(
      snapshotFrom({ 'AGENTS.md': 'STUBBORN\n', 'CLAUDE.md': '# Claude\n' }).files,
    );
    expect(result.files).toEqual([]);
    expect(result.manual).toEqual([
      { ruleId: 'test/noisy', path: 'CLAUDE.md', line: 1, guidance: 'make it quiet by hand' },
    ]);
    expect(result.verification).toEqual({ resolved: 0, remaining: 2, introduced: [] });
  });

  describe('gate demotion', () => {
    const server = testRule({
      id: 'test/server',
      appliesTo: ['mcp-json'],
      platforms: ['claude-code'],
      check(context, artifact) {
        const doc = context.json(artifact);
        if (!doc.ok || doc.valueSpan(['mcpServers', 'docs']) !== undefined) return;
        const change = jsonInsertProperty(artifact, ['mcpServers'], 'docs', {
          command: 'npx',
          args: ['-y', '@acme/docs-mcp@1.0.0'],
        });
        if (change === undefined) return;
        context.report({
          artifact,
          message: 'No docs server.',
          fix: fix('test/server#add', [change]),
        });
      },
    });
    const files = { '.mcp.json': '{\n  "mcpServers": {}\n}\n' };

    it('demotes a safe fix that adds an MCP server to review', () => {
      const result = run(files, [server], ALL_CLASSES);
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.fix.class).toBe('review');
      expect(result.applied[0]?.effects).toContainEqual(
        expect.objectContaining({
          kind: 'gate',
          class: 'mcp',
          id: 'mcp:.mcp.json#docs',
          change: 'added',
        }),
      );
      expect(textOf(result.snapshot, '.mcp.json')).toBe(
        '{\n  "mcpServers": {"docs": {"command": "npx", "args": ["-y", "@acme/docs-mcp@1.0.0"]}}\n}\n',
      );
    });

    it('skips it when only safe fixes are selected', () => {
      const result = run(files, [server], SAFE_ONLY);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toMatchObject({
        status: 'skipped',
        reason: 'verification-failed',
        fix: { class: 'review' },
      });
      expect(result.skipped[0]?.effects.some((effect) => effect.kind === 'gate')).toBe(true);
      expect(result.snapshot.files).toEqual(snapshotFrom(files).files);
    });
  });

  it('defers the loser of a conflict to the next round', () => {
    const importing = (id: string, line: string) =>
      testRule({
        id,
        check(context, artifact) {
          if (lines(artifact).includes(line)) return;
          context.report({
            artifact,
            message: `No ${line}.`,
            span: { offset: 0, length: Math.max(1, lines(artifact)[0]?.length ?? 1) },
            fix: fix(`${id}#insert`, [insertLine(artifact, 0, line)]),
          });
        },
      });
    const rules = [importing('test/b', '@b.md'), importing('test/a', '@a.md')];
    const files = { 'AGENTS.md': '# Rules\n' };
    const result = run(files, rules);
    expect(result.rounds).toBe(2);
    expect(result.applied.map((item) => item.ruleId)).toEqual(['test/a', 'test/b']);
    expect(textOf(result.snapshot, 'AGENTS.md')).toBe('@b.md\n@a.md\n# Rules\n');
    // The round-2 fix names the finding of the first scan.
    const original = result.before.findings.find((finding) => finding.ruleId === 'test/b');
    expect(result.applied[1]?.findings).toEqual([original?.fingerprint]);
    expect(result.deferred).toEqual([]);

    const once = run(files, rules, SAFE_ONLY, 1);
    expect(once.deferred.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/b', 'conflict'],
    ]);
    expect(once.conflicts).toHaveLength(1);
    expect(once.conflicts[0]).toMatchObject({ kind: 'same-offset-inserts', path: 'AGENTS.md' });
    expect(once.conflicts[0]?.loser).toBe(once.deferred[0]);
    expect(once.conflicts[0]?.winner).toBe(once.applied[0]);
  });

  it('reports conflicts among fixes the last round enabled', () => {
    const below = (id: string, line: string) =>
      testRule({
        id,
        severity: 'info',
        check(context, artifact) {
          if (!text(artifact).startsWith('# ') || lines(artifact).includes(line)) return;
          context.report({
            artifact,
            message: `No ${line}.`,
            fix: fix(`${id}#insert`, [insertLine(artifact, 1, line)]),
          });
        },
      });
    const result = run(
      { 'AGENTS.md': 'Use pnpm.\n' },
      [heading, below('test/y', 'y'), below('test/x', 'x')],
      SAFE_ONLY,
      1,
    );
    expect(result.applied.map((item) => item.ruleId)).toEqual(['test/heading']);
    expect(result.skipped.map((item) => [item.ruleId, item.reason])).toEqual([['test/x', 'limit']]);
    expect(result.deferred.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/y', 'conflict'],
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.winner).toBe(result.skipped[0]);
    expect(result.conflicts[0]?.loser).toBe(result.deferred[0]);
  });

  it('reports a created file that a later round renames as created', () => {
    const create = testRule({
      id: 'test/create-rule',
      check(context, artifact) {
        if (context.snapshot.paths.has('.cursor/rules/')) return;
        context.report({
          artifact,
          message: 'No Cursor rule.',
          fix: fix('test/create-rule#add', [
            { kind: 'create', path: '.cursor/rules/style.md', text: 'Use tabs.\n' },
          ]),
        });
      },
    });
    const extension = testRule({
      id: 'test/extension',
      severity: 'info',
      appliesTo: ['cursor-rule-md'],
      check(context, artifact) {
        context.report({
          artifact,
          message: 'Not .mdc.',
          fix: fix('test/extension#rename', [renameFile(artifact, '.cursor/rules/style.mdc')]),
        });
      },
    });
    const result = run({ 'AGENTS.md': '# Rules\n' }, [create, extension]);
    expect(result.rounds).toBe(2);
    expect(result.files.map((file) => [file.op, file.path])).toEqual([
      ['create', '.cursor/rules/style.mdc'],
    ]);
  });

  it('keeps the fixes that verify together when a pair fails only in combination', () => {
    const mark = (id: string, path: string, line: string) =>
      testRule({
        id,
        appliesTo: [path === 'AGENTS.md' ? 'agents-md' : 'claude-md'],
        check(context, artifact) {
          if (artifact.path !== path || lines(artifact).includes(line)) return;
          context.report({
            artifact,
            message: `No ${line}.`,
            fix: fix(`${id}#insert`, [insertLine(artifact, 0, line)]),
          });
        },
      });
    const both = testRule({
      id: 'test/both',
      check(context, artifact) {
        const all = context.allArtifacts.map((item) => text(item)).join('');
        if (all.includes('MARK-A') && all.includes('MARK-B'))
          context.report({ artifact, message: 'Both.' });
      },
    });
    const result = run({ 'AGENTS.md': 'a\n', 'CLAUDE.md': 'c\n' }, [
      mark('test/a', 'AGENTS.md', 'MARK-A'),
      mark('test/b', 'CLAUDE.md', 'MARK-B'),
      both,
    ]);
    expect(result.applied.map((item) => item.ruleId)).toEqual(['test/a']);
    expect(result.skipped.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/b', 'verification-failed'],
    ]);
    expect(result.after.findings.map((finding) => finding.ruleId)).toEqual(['test/b']);
  });

  it('follows a rename through later rounds and reports one combined change', () => {
    const extension = testRule({
      id: 'test/extension',
      appliesTo: ['cursor-rule-md'],
      platforms: ['cursor'],
      check(context, artifact) {
        context.report({
          artifact,
          message: 'Not .mdc.',
          fix: fix('test/extension#rename', [
            renameFile(artifact, artifact.path.replace(/\.md$/, '.mdc')),
          ]),
        });
      },
    });
    const frontmatter = testRule({
      id: 'test/frontmatter',
      severity: 'info',
      appliesTo: ['cursor-rule'],
      platforms: ['cursor'],
      check(context, artifact) {
        const change = prependFrontmatter(artifact, context.frontmatter(artifact), [
          { key: 'alwaysApply', value: true },
        ]);
        if (change === undefined) return;
        context.report({
          artifact,
          message: 'No frontmatter.',
          fix: fix('test/frontmatter#add', [change]),
        });
      },
    });
    const before = new TextEncoder().encode('Use tabs.\r\n');
    const result = run({ '.cursor/rules/style.md': before }, [extension, frontmatter]);
    expect(result.rounds).toBe(2);
    expect(result.files).toEqual([
      {
        path: '.cursor/rules/style.mdc',
        op: 'rename',
        from: '.cursor/rules/style.md',
        before,
        after: new TextEncoder().encode('---\r\nalwaysApply: true\r\n---\r\nUse tabs.\r\n'),
      },
    ]);
    expect(result.verification).toEqual({ resolved: 1, remaining: 0, introduced: [] });
  });

  it('reports created files', () => {
    const create = testRule({
      id: 'test/create',
      check(context, artifact) {
        if (context.snapshot.paths.has('CLAUDE.md')) return;
        context.report({
          artifact,
          message: 'No CLAUDE.md.',
          fix: fix(
            'test/create#claude',
            [{ kind: 'create', path: 'CLAUDE.md', text: '@AGENTS.md\n' }],
            'review',
          ),
        });
      },
    });
    const result = run({ 'AGENTS.md': '# Rules\n' }, [create], ALL_CLASSES);
    expect(result.files).toEqual([
      { path: 'CLAUDE.md', op: 'create', after: new TextEncoder().encode('@AGENTS.md\n') },
    ]);
    const claude = result.applied[0]?.effects.find(
      (effect) => effect.kind === 'tokens' && effect.agent === 'claude-code',
    );
    expect(claude).toBeDefined();
  });

  it('skips a fix that writes a file over the size limit', () => {
    const huge = testRule({
      id: 'test/huge',
      check(context, artifact) {
        if (text(artifact).length > 100) return;
        context.report({
          artifact,
          message: 'Too small.',
          fix: fix('test/huge#grow', [insertLine(artifact, 0, 'x'.repeat(MAX_WRITTEN_FILE_BYTES))]),
        });
      },
    });
    const result = run({ 'AGENTS.md': '# Rules\n' }, [huge]);
    expect(result.skipped.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/huge', 'limit'],
    ]);
    expect(result.applied).toEqual([]);
  });

  it('keeps refused paths and manual steps of the last plan', () => {
    const elsewhere = testRule({
      id: 'test/elsewhere',
      check(context, artifact) {
        context.report({
          artifact,
          message: 'Elsewhere.',
          fix: fix('test/elsewhere#edit', [
            { kind: 'edit', path: 'docs/x.md', edits: [{ offset: 0, length: 0, text: 'x' }] },
          ]),
        });
      },
    });
    const result = run({ 'AGENTS.md': '# Rules\n' }, [elsewhere]);
    expect(result.skipped.map((item) => [item.ruleId, item.reason])).toEqual([
      ['test/elsewhere', 'refused-path'],
    ]);
    expect(result.manual.map((step) => step.guidance)).toEqual([
      'docs/x.md was not read by the scan; make this change by hand',
    ]);
  });

  it('accepts 1 to 3 rounds', () => {
    for (const rounds of [0, 4, 1.5]) {
      expect(() => run({ 'AGENTS.md': '# A\n' }, [heading], SAFE_ONLY, rounds)).toThrow(RangeError);
    }
  });

  it('changes nothing on a second run, in every encoding and line ending', () => {
    const content = fc
      .tuple(
        fc.array(fc.constantFrom('# Title', 'Use pnpm.', '', '  indented', '- item', 'Ünïcode ✓'), {
          maxLength: 5,
        }),
        fc.constantFrom('\n', '\r\n'),
        fc.boolean(),
        fc.constantFrom(
          ['utf-8', false],
          ['utf-8', true],
          ['utf-16le', true],
          ['utf-16be', true],
        ) as fc.Arbitrary<['utf-8' | 'utf-16le' | 'utf-16be', boolean]>,
      )
      .map(([parts, eol, final, [encoding, bom]]) => ({
        bytes: encodeText(parts.join(eol) + (final ? eol : ''), encoding, bom),
        encoding,
        bom,
      }));
    fc.assert(
      fc.property(content, ({ bytes, encoding, bom }) => {
        const rules = [heading, blankAfterHeading];
        const first = run({ 'AGENTS.md': bytes }, rules);
        const second = fixRounds(first.snapshot, { rules }, SAFE_ONLY);
        expect(second.applied).toEqual([]);
        expect(second.files).toEqual([]);
        expect(second.snapshot).toBe(first.snapshot);
        const decoded = decode(first.snapshot.files[0]?.bytes ?? new Uint8Array());
        expect([decoded.encoding, decoded.hasBom]).toEqual([encoding, bom]);
        expect(first.after.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);

        // Planning again on the applied plan's result finds nothing left: applying twice is
        // applying once.
        const snapshot = snapshotFrom({ 'AGENTS.md': bytes });
        const analysis = analyze(snapshot);
        const plan = planFixes(analysis, runRules(analysis, { rules: [heading] }), SAFE_ONLY);
        const once = applyPlan(snapshot, plan);
        const again = analyze(once);
        const replan = planFixes(again, runRules(again, { rules: [heading] }), SAFE_ONLY);
        expect(replan.fixes).toEqual([]);
        expect(applyPlan(once, replan)).toBe(once);
      }),
      { numRuns: 40 },
    );
  });

  it('runs from the public API with the built-in rules', () => {
    const snapshot = snapshotFrom({
      'AGENTS.md': '# Rules\n',
      'CLAUDE.md': '# Claude\n\n@docs/missing.md\n',
    });
    // One rule's fixes, so that fixes other rules add later do not change this test.
    const selection = { ...ALL_CLASSES, ruleIds: new Set(['instr/agents-md-ignored-by-claude']) };
    const result = api.fixRounds(snapshot, { rules: api.builtinRules }, selection);
    expect(result.rounds).toBe(1);
    expect(result.applied.map((item) => item.fix.id)).toEqual([
      'instr/agents-md-ignored-by-claude#import',
    ]);
    expect(textOf(result.snapshot, 'CLAUDE.md')).toBe(
      '@AGENTS.md\n\n# Claude\n\n@docs/missing.md\n',
    );
    expect(result.verification).toEqual({
      resolved: 1,
      remaining: result.before.findings.filter((finding) => !finding.suppressed).length - 1,
      introduced: [],
    });
    expect(result.verification.remaining).toBeGreaterThan(0);
    expect(api.applyPlan(snapshot, { fixes: result.applied }).files).toEqual(result.snapshot.files);
    expect(api.MAX_ROUNDS).toBe(3);
    expect(api.MAX_FIXES).toBe(1000);
    expect(api.MAX_WRITTEN_FILE_BYTES).toBe(1024 * 1024);
  });
});
