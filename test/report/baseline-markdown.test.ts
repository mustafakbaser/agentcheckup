/**
 * The baseline section of the Markdown report: the table of session-start context per agent and
 * what the change makes each agent miss. The fixture tests scan a base and a head tree from
 * test/fixtures/baseline-markdown/ and compare them the way `--baseline` does, through the JSON
 * report; the other tests use hand-built plans and deltas for the cases a scan rarely produces.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECURITY_GATE_CLASSES, compareWithBaseline } from '../../src/core/baseline.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import type { PlanDelta } from '../../src/core/baseline-types.js';
import { type ContextScanResult, scanWithContext, type ScanResult } from '../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import type { LimitUsage, LoadPlan } from '../../src/platforms/load/types.js';
import { formatBaselineMarkdown } from '../../src/report/baseline-markdown.js';
import { formatJson } from '../../src/report/json.js';
import { formatMarkdown } from '../../src/report/markdown.js';
import { builtinRules } from '../../src/rules/index.js';
import {
  baselineDiff,
  contextReport,
  entry,
  itemDiff,
  plan,
  planDelta,
  size,
} from '../helpers/context.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { makeResult } from './fixtures.js';

const OPTIONS = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false } as const;
const FIXTURE = fileURLToPath(new URL('../fixtures/baseline-markdown', import.meta.url));
const TABLE_HEADER = '| Agent | Before | After | Change | Limits |';
const MISS_HEADING = '### What this change makes each agent miss';

/** A fixture tree as the walker reads it, inside a git repository as Codex expects. */
async function tree(name: 'base' | 'head'): Promise<Snapshot> {
  const walked = await walk(join(FIXTURE, name));
  return {
    ...walked,
    paths: new Set([...walked.paths, '.git/']),
    opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
  };
}

/** The head scanned with `--baseline`: the base goes through its JSON report, as in CI. */
function compared(base: ContextScanResult, head: ContextScanResult): ScanResult {
  const parsed = validateBaseline(JSON.parse(formatJson(base)));
  if (!parsed.ok) throw new Error(parsed.message);
  const comparison = compareWithBaseline(head, parsed.baseline, { gate: SECURITY_GATE_CLASSES });
  return { ...head, findings: comparison.findings, baseline: comparison.diff };
}

function scanFiles(files: FileMap): ContextScanResult {
  return scanWithContext(snapshotFrom(files, { paths: ['.git/HEAD'] }), OPTIONS);
}

/** From the baseline heading up to the findings: the section a pull request comment shows. */
function section(output: string): string {
  const start = output.indexOf('### Agent configuration changes');
  const end = output.indexOf('### Findings');
  return output.slice(start, end < 0 ? undefined : end);
}

/** The rows of the Markdown table under `header`. */
function rows(output: string, header: string): string[] {
  const lines = output.split('\n');
  const start = lines.indexOf(header);
  if (start < 0) return [];
  const found: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('| ')) break;
    found.push(line);
  }
  return found;
}

/** Pipes that split table cells: not preceded by a backslash. */
function cellSeparators(row: string): number {
  let count = 0;
  for (let index = 0; index < row.length; index++) {
    if (row.charAt(index) === '\\') index++;
    else if (row.charAt(index) === '|') count++;
  }
  return count;
}

/** The cells of a table row whose cells hold no escaped pipe. */
function cells(row: string): string[] {
  return row.slice(2, -2).split(' | ');
}

describe('baseline Markdown of a pull request', async () => {
  const base = scanWithContext(await tree('base'), OPTIONS);
  const head = scanWithContext(await tree('head'), OPTIONS);
  const result = compared(base, head);
  const output = formatMarkdown(result);

  it('matches the snapshot', async () => {
    await expect(section(output)).toMatchFileSnapshot(
      '__snapshots__/baseline-markdown.pull-request.txt',
    );
  });

  it('shows session-start context per agent, before and after, in agent order', () => {
    const table = rows(output, TABLE_HEADER);
    expect(table.map((row) => cells(row)[0])).toEqual([
      'Claude Code',
      'Codex',
      'Cursor',
      'Copilot CLI',
      'Copilot in VS Code',
      'Copilot cloud agent',
      'Gemini CLI',
      'Devin Local',
      'Cline',
    ]);
    // Gemini CLI reads GEMINI.md, which neither tree has, so only its row is unchanged.
    for (const row of table) {
      const [agent, before, after, change] = cells(row);
      expect(before).toMatch(/^≈[\d,]+ tokens, \d+ files?$/);
      expect(after).toMatch(/^≈[\d,]+ tokens, \d+ files?$/);
      expect(change).toMatch(agent === 'Gemini CLI' ? /^unchanged$/ : /^≈\+[\d,]+ tokens/);
    }
    // The always-applied testing.mdc is one more file at Cursor's session start.
    expect(cells(table[2]!)[3]).toMatch(/, \+1 file$/);
    expect(cells(table[1]!)[4]).toMatch(/^AGENTS\\\.md chain [\d,]+ of 32,768 bytes \(\d+%\)$/);
  });

  it('lists what the change makes Cursor miss: it ignores .md rule files', () => {
    expect(rows(output, '| Agent | Not loaded | Why | Fix |')).toEqual([
      '| Cursor | \\.cursor/rules/x\\.md | only \\.mdc files are read here (≈26 tokens) | safe |',
    ]);
    expect(output.indexOf(MISS_HEADING)).toBeGreaterThan(output.indexOf(TABLE_HEADER));
    expect(output).not.toContain('### What each agent misses');
  });

  it('puts the same table in the baseline section of the context command', () => {
    const standalone = formatBaselineMarkdown(result);
    expect(rows(standalone, TABLE_HEADER)).toEqual(rows(output, TABLE_HEADER));
  });
});

describe('baseline Markdown without a change', async () => {
  const base = scanWithContext(await tree('base'), OPTIONS);
  const output = formatMarkdown(compared(base, base));

  it('reports every plan unchanged and nothing missed', () => {
    const table = rows(output, TABLE_HEADER);
    expect(table).toHaveLength(9);
    for (const row of table) {
      const [, before, after, change] = cells(row);
      expect(after).toBe(before);
      expect(change).toBe('unchanged');
    }
    expect(output).toContain('**No security-relevant changes need review.**');
    expect(output).toContain('Findings: no new findings, 0 resolved.');
    expect(output).not.toContain('agent miss');
  });
});

describe('baseline Markdown with hostile names', () => {
  const HOSTILE_NAME = 'a|b`c\nd';

  it('escapes a skipped path in the miss section', () => {
    const files: FileMap = { 'AGENTS.md': '# Project\n\nRun the tests.\n' };
    const output = formatMarkdown(
      compared(
        scanFiles(files),
        scanFiles({ ...files, [`.cursor/rules/${HOSTILE_NAME}.md`]: 'Use tabs.\n' }),
      ),
    );
    const row = rows(output, '| Agent | Not loaded | Why | Fix |')[0]!;
    expect(row).toContain('| \\.cursor/rules/a\\|b\\`c⏎d\\.md | only \\.mdc files are read here');
    expect(cellSeparators(row)).toBe(5);
    expect(output).not.toContain('a|b');
    expect(output).not.toContain('b`c');
  });

  it('escapes a plan directory and a limit name in the context table', () => {
    const cwd = `pkg/${HOSTILE_NAME}`;
    const hostilePlan = plan('codex', {
      cwd,
      entries: [entry('instructions', `${cwd}/AGENTS.md`, { position: 1, size: size(40) })],
      limits: [usage({ subject: cwd, label: `**${HOSTILE_NAME}**`, used: 40, limit: 400 })],
    });
    const output = formatMarkdown({
      ...makeResult({}),
      context: contextReport([hostilePlan]),
      baseline: baselineDiff({ context: [planDelta('codex', 10, 10, { cwd })] }),
    });
    const [row] = rows(output, TABLE_HEADER);
    expect(row).toBe(
      '| Codex (pkg/a\\|b\\`c⏎d) | ≈10 tokens, 1 file | ≈10 tokens, 1 file | unchanged | ' +
        '\\*\\*a\\|b\\`c⏎d\\*\\* 40 of 400 bytes (10%) |',
    );
    expect(cellSeparators(row!)).toBe(6);
  });
});

function usage(overrides: Partial<LimitUsage>): LimitUsage {
  return {
    key: 'codex.project_doc_max_bytes',
    unit: 'bytes',
    limit: 32_768,
    used: 0,
    subject: '',
    effect: 'truncates',
    evidence: [],
    ...overrides,
  };
}

/** The one table row for a Codex plan at the root with `delta` against it. */
function rowFor(delta: PlanDelta, codex: LoadPlan | undefined): string {
  const output = formatMarkdown({
    ...makeResult({}),
    ...(codex === undefined ? {} : { context: contextReport([codex]) }),
    baseline: baselineDiff({ context: [delta] }),
  });
  const table = rows(output, TABLE_HEADER);
  expect(table).toHaveLength(1);
  return table[0]!;
}

describe('the session-start context table', () => {
  const agents = entry('instructions', 'AGENTS.md', { position: 1, size: size(40) });
  const docs = entry('import', 'docs/a.md', { position: 2, size: size(40) });
  const server = entry('mcp-server', '.mcp.json', { name: 'x', trigger: 'startup' });
  const listed = entry('skill', '.agents/skills/a/SKILL.md', { size: size(8) });

  it('counts the files before from what the change added or moved to session start', () => {
    const codex = plan('codex', { entries: [agents, docs, server, listed] });
    expect(
      rowFor(planDelta('codex', 10, 20, { entries: itemDiff({ added: [docs.id] }) }), codex),
    ).toBe('| Codex | ≈10 tokens, 1 file | ≈20 tokens, 2 files | ≈+10 tokens, +1 file | — |');
    const moved = itemDiff({ changed: [{ id: docs.id, fields: ['trigger'] }] });
    expect(rowFor(planDelta('codex', 10, 20, { entries: moved }), codex)).toContain(
      '| ≈10 tokens, 1 file | ≈20 tokens, 2 files | ≈+10 tokens, +1 file |',
    );
    // A removed MCP server or skill was never a file in the prompt.
    const removed = itemDiff({ removed: ['mcp-server:.mcp.json#y', 'skill:.agents/b/SKILL.md'] });
    expect(rowFor(planDelta('codex', 30, 20, { entries: removed }), codex)).toContain(
      '| ≈30 tokens, 2 files | ≈20 tokens, 2 files | ≈-10 tokens |',
    );
  });

  it('leaves the files before out when a removed or moved entry may have been one', () => {
    const codex = plan('codex', { entries: [agents] });
    const removed = itemDiff({ removed: ['instructions:OLD.md'] });
    expect(rowFor(planDelta('codex', 10, 10, { entries: removed }), codex)).toBe(
      '| Codex | ≈10 tokens | ≈10 tokens, 1 file | ≈0 tokens | — |',
    );
    const away = itemDiff({ changed: [{ id: 'rule:r.md', fields: ['trigger'] }] });
    expect(rowFor(planDelta('codex', 20, 10, { entries: away }), codex)).toBe(
      '| Codex | ≈20 tokens | ≈10 tokens, 1 file | ≈-10 tokens | — |',
    );
    expect(rowFor(planDelta('codex', 10, 10), undefined)).toBe(
      '| Codex | ≈10 tokens | ≈10 tokens | unchanged | — |',
    );
  });

  it('shows crossed limits, then the fullest group limits, never rounding across a limit', () => {
    const limits = [
      usage({ label: 'AGENTS.md chain', used: 32_769 }),
      usage({ key: 'codex.skills_listing', unit: 'chars', label: 'skills listing', used: 7 }),
      usage({ key: 'codex.skills_scan_depth', unit: 'levels', subject: '.agents', used: 2 }),
      usage({ key: 'a.edge', label: 'edge', used: 32_700 }),
      usage({ key: 'b.unset', label: 'unset', limit: null, used: 9 }),
      usage({ key: 'c.empty', label: 'empty', used: 0 }),
    ];
    const codex = plan('codex', { entries: [agents], limits });
    const crossed = planDelta('codex', 10, 10, {
      entries: itemDiff(),
      limits: [
        {
          key: 'codex.project_doc_max_bytes',
          subject: '',
          label: 'AGENTS.md chain',
          before: 30_000,
          after: 32_769,
          limit: 32_768,
        },
      ],
    });
    expect(cells(rowFor(crossed, codex))[4]).toBe(
      '**AGENTS\\.md chain 32,769 of 32,768 bytes (101%), now over** · ' +
        'edge 32,700 of 32,768 bytes (99%) · ' +
        'skills listing 7 of 32,768 characters (under 1%)',
    );
    const more = plan('codex', {
      entries: [agents],
      limits: [...limits, usage({ key: 'd.full', label: 'full', used: 32_768 })],
    });
    expect(cells(rowFor(crossed, more))[4]).toBe(
      '**AGENTS\\.md chain 32,769 of 32,768 bytes (101%), now over** · ' +
        'full 32,768 of 32,768 bytes (100%) · edge 32,700 of 32,768 bytes (99%) · and 1 more',
    );
  });
});
