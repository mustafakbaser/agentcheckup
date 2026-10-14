import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG, resolveConfig } from '../../src/core/config.js';
import { buildArtifacts, scanSnapshot } from '../../src/core/engine.js';
import type { AnyRule, RuleMeta } from '../../src/core/types.js';
import { defineRule } from '../../src/rules/define.js';
import { lint, snapshotFrom } from '../helpers/lint.js';

const SOURCE = {
  title: 'test',
  url: 'https://example.com',
  checked: '2026-10-14',
  status: 'verified',
} as const;

function meta(overrides: Partial<RuleMeta> = {}): RuleMeta {
  return {
    id: 'test/every-file',
    title: 'Every file is reported',
    rationale: 'Test rule.',
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['agents-md', 'claude-md', 'skill'],
    platforms: ['codex', 'claude-code'],
    sources: [SOURCE],
    since: '2026.10',
    ...overrides,
  };
}

/** Reports every artifact it sees, at a span covering the word "bad" if present. */
const everyFile: AnyRule = defineRule({
  meta: meta(),
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const index = artifact.decoded.text.indexOf('bad');
      context.report({
        artifact,
        message: `Saw ${artifact.path}.`,
        ...(index === -1 ? {} : { span: { offset: index, length: 3 } }),
      });
    }
  },
});

const throwing: AnyRule = defineRule({
  meta: meta({ id: 'test/throws' }),
  defaultOptions: undefined,
  check() {
    throw new Error('boom');
  },
});

describe('buildArtifacts', () => {
  it('classifies, decodes and sorts candidate files', () => {
    const artifacts = buildArtifacts(
      snapshotFrom({ 'b/AGENTS.md': 'x', 'AGENTS.md': 'y', 'README.md': 'z' }),
      EMPTY_CONFIG,
    );
    expect(artifacts.map((artifact) => [artifact.path, artifact.kind])).toEqual([
      ['AGENTS.md', 'agents-md'],
      ['b/AGENTS.md', 'agents-md'],
    ]);
  });

  it('folds a symlink alias into the real file when both were read', () => {
    const artifacts = buildArtifacts(
      snapshotFrom(
        {
          '.agents/skills/x/SKILL.md': 'skill',
          '.claude/skills/x/SKILL.md': 'skill',
        },
        { symlinks: { '.claude/skills/x/SKILL.md': '.agents/skills/x/SKILL.md' } },
      ),
      EMPTY_CONFIG,
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      path: '.agents/skills/x/SKILL.md',
      aliases: ['.claude/skills/x/SKILL.md'],
    });
  });

  it('keeps an alias whose real file was not read', () => {
    const artifacts = buildArtifacts(
      snapshotFrom({ 'CLAUDE.md': '# shared' }, { symlinks: { 'CLAUDE.md': 'shared/notes.md' } }),
      EMPTY_CONFIG,
    );
    expect(artifacts.map((artifact) => artifact.path)).toEqual(['CLAUDE.md']);
  });

  it('applies config ignore globs', () => {
    const artifacts = buildArtifacts(
      snapshotFrom({ 'AGENTS.md': 'a', 'fixtures/AGENTS.md': 'b' }),
      resolveConfig({ ignore: ['fixtures/**'] }),
    );
    expect(artifacts.map((artifact) => artifact.path)).toEqual(['AGENTS.md']);
  });
});

describe('scanSnapshot', () => {
  it('runs rules, sorts findings and scores the result', () => {
    const result = lint({ 'z/AGENTS.md': 'bad', 'AGENTS.md': 'ok' }, { rules: [everyFile] });
    expect(result.findings.map((finding) => finding.path)).toEqual(['AGENTS.md', 'z/AGENTS.md']);
    expect(result.findings[1]?.range).toEqual({
      start: { line: 1, column: 1 },
      end: { line: 1, column: 4 },
    });
    expect(result.summary).toEqual({ errors: 0, warnings: 2, infos: 0, suppressed: 0 });
    expect(result.score.score).toBe(92);
    expect(result.rules.map((rule) => rule.id)).toContain('test/every-file');
  });

  it('skips rules whose platforms are not targeted', () => {
    const result = lint({ 'AGENTS.md': 'x' }, { rules: [everyFile], targets: ['cursor'] });
    expect(result.findings).toEqual([]);
    expect(result.targets).toEqual(['cursor']);
  });

  it('honors severity overrides and "off" per path', () => {
    const result = lint(
      { 'AGENTS.md': 'x', 'legacy/AGENTS.md': 'y' },
      {
        rules: [everyFile],
        config: {
          rules: { 'test/every-file': 'error' },
          overrides: [{ files: ['legacy/**'], rules: { 'test/every-file': 'off' } }],
        },
      },
    );
    expect(result.findings.map((finding) => [finding.path, finding.severity])).toEqual([
      ['AGENTS.md', 'error'],
    ]);
  });

  it('isolates a crashing rule and reports it', () => {
    const result = lint({ 'AGENTS.md': 'x' }, { rules: [throwing, everyFile] });
    expect(result.ruleFailures).toEqual([{ ruleId: 'test/throws', message: 'boom' }]);
    expect(result.findings).toHaveLength(1);
  });

  it('warns about unknown rule ids in the config', () => {
    const result = lint(
      { 'AGENTS.md': 'x' },
      { rules: [everyFile], config: { rules: { 'test/typo': 'off' } } },
    );
    expect(result.configWarnings).toEqual(['Unknown rule "test/typo" in configuration.']);
  });

  it('gives identical findings on identical lines distinct, stable fingerprints', () => {
    const twice: AnyRule = defineRule({
      meta: meta({ id: 'test/twice' }),
      defaultOptions: undefined,
      check(context) {
        for (const artifact of context.artifacts) {
          context.report({ artifact, message: 'one' });
          context.report({ artifact, message: 'one' });
        }
      },
    });
    const first = lint({ 'AGENTS.md': 'same' }, { rules: [twice] });
    const second = lint({ 'AGENTS.md': 'same' }, { rules: [twice] });
    const fingerprints = first.findings.map((finding) => finding.fingerprint);
    expect(new Set(fingerprints).size).toBe(2);
    expect(second.findings.map((finding) => finding.fingerprint)).toEqual(fingerprints);
  });

  it('produces no score for a tree without agent configuration', () => {
    const result = scanSnapshot(snapshotFrom({ 'README.md': '# hi' }), { rules: [everyFile] });
    expect(result.score.score).toBeNull();
    expect(result.artifacts).toEqual([]);
  });
});

describe('inline directives', () => {
  const at = (line: string) => `# Title\n${line}\nbad here\n`;

  it('suppresses the next line when a reason is given', () => {
    const result = lint(
      { 'AGENTS.md': at('<!-- agentcheck-disable-next-line test/every-file -- intentional -->') },
      { rules: [everyFile] },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.suppressed).toEqual({ kind: 'inline', reason: 'intentional' });
    expect(result.summary.suppressed).toBe(1);
    expect(result.score.score).toBe(100);
  });

  it('reports and ignores a directive without a reason', () => {
    const result = lint(
      { 'AGENTS.md': at('<!-- agentcheck-disable-next-line test/every-file -->') },
      { rules: [everyFile] },
    );
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual([
      'directive/missing-reason',
      'test/every-file',
    ]);
  });

  it('reports unknown rule ids and unused directives', () => {
    const result = lint(
      {
        'AGENTS.md': '<!-- agentcheck-disable-next-line test/nope -- r -->\nfine\n',
        'CLAUDE.md': '<!-- agentcheck-disable-file test/every-file -- r -->\n',
      },
      { rules: [everyFile], targets: ['claude-code'] },
    );
    const ids = result.findings.filter((finding) => !finding.suppressed).map((f) => f.ruleId);
    expect(ids).toContain('directive/unknown-rule');
    expect(ids).toContain('directive/unused');
  });

  it('supports file scope and YAML comments in frontmatter', () => {
    const skill =
      '---\nname: x\n# agentcheck-disable-file test/every-file -- generated\n---\nbad\n';
    const result = lint({ 'skills/x/SKILL.md': skill }, { rules: [everyFile] });
    expect(result.findings.every((finding) => finding.suppressed)).toBe(true);
  });

  it('ignores directives in untrusted mode', () => {
    const result = lint(
      { 'AGENTS.md': at('<!-- agentcheck-disable-next-line test/every-file -- r -->') },
      { rules: [everyFile], trustDirectives: false },
    );
    expect(result.findings.filter((finding) => finding.suppressed)).toEqual([]);
  });

  it('does not treat directives inside code blocks as directives', () => {
    const result = lint(
      {
        'AGENTS.md':
          '```md\n<!-- agentcheck-disable-file test/every-file -- example -->\n```\nbad\n',
      },
      { rules: [everyFile] },
    );
    expect(result.findings.filter((finding) => finding.suppressed)).toEqual([]);
  });
});

describe('fingerprints at scale', () => {
  it('stays fast with thousands of findings on one very long line', () => {
    const many: AnyRule = defineRule({
      meta: meta({ id: 'test/many' }),
      defaultOptions: undefined,
      check(context) {
        for (const artifact of context.artifacts) {
          for (let i = 0; i < 5000; i++) {
            context.report({ artifact, message: 'x', span: { offset: i * 30, length: 1 } });
          }
        }
      },
    });
    const started = performance.now();
    const result = lint({ 'AGENTS.md': 'word '.repeat(40_000) }, { rules: [many] });
    expect(result.findings).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('scan-wide markdown budget', () => {
  const markdownRule: AnyRule = defineRule({
    meta: meta({ id: 'test/markdown' }),
    defaultOptions: undefined,
    check(context) {
      for (const artifact of context.artifacts) {
        const { analysis } = context.markdown(artifact);
        if (!analysis.complete) context.report({ artifact, message: 'partial' });
      }
    },
  });

  it('stops analyzing once the budget is spent, and says so', () => {
    const files = { 'a/AGENTS.md': 'x'.repeat(100), 'b/AGENTS.md': 'y'.repeat(100) };
    const snapshot = snapshotFrom(files);
    const result = scanSnapshot(snapshot, { rules: [markdownRule], markdownBudget: 150 });
    expect(result.findings.map((finding) => finding.path)).toEqual(['b/AGENTS.md']);
    const full = scanSnapshot(snapshot, { rules: [markdownRule] });
    expect(full.findings).toEqual([]);
  });

  it('also stops on the line budget, which tracks parse memory', () => {
    const files = { 'a/AGENTS.md': 'line\n'.repeat(10), 'b/AGENTS.md': 'line\n'.repeat(10) };
    const snapshot = snapshotFrom(files);
    const result = scanSnapshot(snapshot, { rules: [markdownRule], markdownLineBudget: 15 });
    expect(result.findings.map((finding) => finding.path)).toEqual(['b/AGENTS.md']);
  });
});
