/**
 * What skips tell a report beyond their reason: the size of what the agent misses
 * (`SkippedLoad.size`, set by the loaders where the file was read) and the class of the fix that
 * removes the skip (`SkippedLoad.fix`, set when plans are assembled into a context report).
 */
import { describe, expect, it } from 'vitest';
import { scanWithContext } from '../../../src/core/engine.js';
import { codePointLength, utf8ByteLength } from '../../../src/core/measure.js';
import { PLATFORM_IDS, type Finding, type Fix } from '../../../src/core/types.js';
import { buildContextReport, withFixClasses } from '../../../src/platforms/load/index.js';
import type {
  ContextAgent,
  LoadPlan,
  Size,
  SkippedLoad,
} from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { plan, skip } from '../../helpers/context.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';
import { finding, rule } from '../../report/fixtures.js';

function plansOf(files: FileMap, cwd = ''): LoadPlan[] {
  const result = scanWithContext(snapshotFrom(files, { paths: ['.git/HEAD'] }), {
    rules: builtinRules,
    targets: PLATFORM_IDS,
    trustDirectives: false,
    cwd,
  });
  return [...result.context.plans];
}

function skipOf(
  plans: readonly LoadPlan[],
  agent: ContextAgent,
  path: string,
): SkippedLoad | undefined {
  return plans.find((item) => item.agent === agent)?.skipped.find((item) => item.path === path);
}

/** The size of `text` the way the loaders count it: UTF-8 bytes, code points, ceil(chars / 4). */
function sizeOf(text: string): Size {
  const chars = codePointLength(text);
  return { bytes: utf8ByteLength(text), chars, tokens: Math.ceil(chars / 4) };
}

describe('SkippedLoad.size', () => {
  const agents = 'Use pnpm. Run the tests before you commit. Ünïcödé counts as code points.\n';
  const style = '# Style\n\nPrefer small functions.\n';
  const skill = '---\nname: release-notes\n---\n\nWrite release notes from the changelog.\n';
  const plans = plansOf({
    'AGENTS.md': agents,
    'CLAUDE.md': '# Project\n',
    '.cursor/rules/style.md': style,
    '.agents/skills/release-notes/SKILL.md': skill,
  });

  it('is what the agent would receive from a file it skips', () => {
    const claude = skipOf(plans, 'claude-code', 'AGENTS.md');
    expect(claude?.code).toBe('shadowed-by-claude-md');
    expect(claude?.size).toEqual(sizeOf(agents));
    const cursor = skipOf(plans, 'cursor', '.cursor/rules/style.md');
    expect(cursor?.code).toBe('not-mdc');
    expect(cursor?.size).toEqual(sizeOf(style));
    const codex = skipOf(plans, 'codex', '.agents/skills/release-notes/SKILL.md');
    expect(codex?.code).toBe('no-description');
    expect(codex?.size).toEqual(sizeOf(skill));
  });

  it('is absent where the loader cannot tell: MCP servers, missing imports, blank files', () => {
    const other = plansOf({
      'CLAUDE.md': '# Project\n\n@docs/setup.md\n',
      'AGENTS.md': '   \n',
      '.mcp.json': '{ "mcpServers": { "docs": { "url": "https://docs.example.com/mcp" } } }\n',
    });
    const server = skipOf(other, 'claude-code', '.mcp.json');
    expect(server?.code).toBe('url-without-type');
    expect(server?.size).toBeUndefined();
    const missing = skipOf(other, 'claude-code', 'CLAUDE.md');
    expect(missing?.code).toBe('import-unresolved');
    expect(missing?.size).toBeUndefined();
    const blank = skipOf(other, 'codex', 'AGENTS.md');
    expect(blank?.code).toBe('blank-file');
    expect(blank?.size).toBeUndefined();
  });

  it('covers case mismatches, overrides and files past the Codex byte budget', () => {
    const shadowed = 'Shadowed by the override.\n';
    const cased = plansOf({
      'agents.md': 'Lower case.\n',
      'pkg/AGENTS.override.md': 'Override.\n',
      'pkg/AGENTS.md': shadowed,
    });
    expect(skipOf(cased, 'cursor', 'agents.md')?.size).toEqual(sizeOf('Lower case.\n'));
    expect(skipOf(cased, 'claude-code', 'agents.md')?.size).toEqual(sizeOf('Lower case.\n'));

    const nested = plansOf(
      {
        'AGENTS.md': 'Root.\n',
        'pkg/AGENTS.override.md': 'Override.\n',
        'pkg/AGENTS.md': shadowed,
      },
      'pkg',
    );
    const override = skipOf(nested, 'codex', 'pkg/AGENTS.md');
    expect(override?.code).toBe('shadowed-by-override');
    expect(override?.size).toEqual(sizeOf(shadowed));

    const big = `${'x'.repeat(40_000)}\n`;
    const dropped = 'Dropped after the cut.\n';
    const budget = plansOf({ 'AGENTS.md': big, 'pkg/AGENTS.md': dropped }, 'pkg');
    const cut = skipOf(budget, 'codex', 'pkg/AGENTS.md');
    expect(cut?.code).toBe('over-byte-budget');
    expect(cut?.size).toEqual(sizeOf(dropped));
  });
});

describe('SkippedLoad.fix', () => {
  const md = rule('cursor/md-file-ignored', 'loading', 'error');
  const fix = (fixClass: Fix['class']): Fix => ({
    id: `cursor/md-file-ignored#${fixClass}`,
    class: fixClass,
    title: 'Rename to .mdc',
    changes: [{ kind: 'rename', from: 'a.md', to: 'a.mdc' }],
  });
  const cursor = plan('cursor', {
    skipped: [
      skip('rule', 'a.md', 'not-mdc', { ruleId: 'cursor/md-file-ignored' }),
      skip('rule', 'b.md', 'not-mdc', { ruleId: 'cursor/md-file-ignored' }),
      skip('rule', 'c.md', 'not-mdc', { ruleId: 'cursor/md-file-ignored', fix: 'safe' }),
      skip('rule', 'd.md', 'not-mdc', { ruleId: 'cursor/md-file-ignored' }),
      skip('rule', 'e.md', 'not-read', { fix: 'safe' }),
    ],
  });
  const findings: Finding[] = [
    finding(md, 'a.md', 'x', { fix: fix('safe') }),
    // Two findings of the rule on one file: the skip is gone only when both are applied.
    finding(md, 'b.md', 'x', { fix: fix('safe') }),
    finding(md, 'b.md', 'y', { fix: fix('review') }),
    // A suppressed finding is never fixed.
    finding(md, 'd.md', 'x', { fix: fix('safe'), suppressed: { kind: 'config', reason: 'r' } }),
    // Another rule on the same file does not count.
    finding(rule('instr/empty-file', 'loading', 'warn'), 'c.md', 'x', { fix: fix('safe') }),
  ];

  it('is the class of the fix on the finding of the same rule and path', () => {
    const classes = withFixClasses(cursor, findings).skipped.map((item) => item.fix ?? '-');
    expect(classes).toEqual(['safe', 'review', '-', '-', '-']);
  });

  it('is set when plans are assembled with findings, and kept without them', () => {
    const report = buildContextReport({ agents: ['cursor'], plans: [cursor], findings });
    expect(report.plans[0]?.skipped.map((item) => item.fix ?? '-')).toEqual([
      'safe',
      'review',
      '-',
      '-',
      '-',
    ]);
    const kept = buildContextReport({ agents: ['cursor'], plans: [cursor] });
    expect(kept.plans[0]?.skipped.map((item) => item.fix ?? '-')).toEqual([
      '-',
      '-',
      'safe',
      '-',
      'safe',
    ]);
  });

  it('is absent in a real scan until a rule attaches fixes', () => {
    const plans = plansOf({ 'AGENTS.md': 'Rules.\n', 'CLAUDE.md': '# Project\n' });
    expect(plans.flatMap((item) => item.skipped).some((item) => item.fix !== undefined)).toBe(
      false,
    );
  });
});
