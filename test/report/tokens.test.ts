import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, EffectiveModel } from '../../src/agents/types.js';
import type { ScanResult } from '../../src/core/engine.js';
import type {
  ContextAgent,
  LoadEntry,
  LoadPlan,
  StartDirectoryTotals,
} from '../../src/platforms/load/types.js';
import { formatTokensMarkdown } from '../../src/report/tokens-markdown.js';
import { formatTokensText, MAX_TOKEN_ROWS } from '../../src/report/tokens-text.js';
import { formatTokensJson, tokenSummary } from '../../src/report/tokens-view.js';
import { contextReport, entry, plan, size, skip } from '../helpers/context.js';
import { emptyResult } from './fixtures.js';
import { hasEscOrBel, unsafeCodePoints } from './safety.js';

const schema: unknown = JSON.parse(
  readFileSync(new URL('../../schemas/report.schema.json', import.meta.url), 'utf8'),
);
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);

/** A subagent entry as the plans write it: `subagent:<file>`, with what its call starts with. */
function call(path: string, name: string, tokens: number, id = `subagent:${path}`): LoadEntry {
  return entry('subagent', path, {
    id,
    name,
    size: size(40),
    ownContext: {
      size: size(tokens * 4),
      parts: [{ kind: 'prompt', size: size(tokens * 4), certainty: 'documented', evidence: [] }],
      notVisible: [],
    },
  });
}

function definition(
  agent: ContextAgent,
  file: string,
  effective: EffectiveModel,
  role = '',
): AgentDefinition {
  return {
    id: `agent:${file}${role}@${agent}`,
    file,
    line: 1,
    agent,
    status: 'loads',
    effective,
    tools: 'inherited',
    certainty: 'documented',
    evidence: [],
    digest: '0',
  };
}

function result(
  plans: readonly LoadPlan[],
  definitions: readonly AgentDefinition[] = [],
): ScanResult {
  return {
    ...emptyResult,
    agents: { definitions, settings: [] },
    context: contextReport(plans),
  };
}

/** A start directory's totals: `[agent, characters, unverified]` per agent. */
function directory(
  cwd: string,
  rows: readonly (readonly [ContextAgent, number, boolean])[],
): StartDirectoryTotals {
  return {
    cwd,
    agents: rows.map(([agent, chars, unverified]) => ({
      agent,
      startup: size(chars),
      unverified,
    })),
  };
}

const claude = plan('claude-code', {
  entries: [
    entry('instructions', 'CLAUDE.md', { position: 1, size: size(400) }),
    entry('skill', '.claude/skills/api/SKILL.md', {
      position: 2,
      name: 'api',
      size: size(60),
      deferred: size(800),
    }),
    call('.claude/agents/reviewer.md', 'reviewer', 900),
    call('.claude/agents/helper.md', 'helper', 300),
  ],
});
const codex = plan('codex', {
  entries: [
    entry('instructions', 'AGENTS.md', { position: 1, size: size(200), certainty: 'unverified' }),
    call('.codex/config.toml', 'checker', 300, 'subagent:.codex/config.toml#checker'),
  ],
});
const definitions = [
  definition('claude-code', '.claude/agents/reviewer.md', {
    value: 'sonnet',
    source: 'definition',
  }),
  definition('claude-code', '.claude/agents/helper.md', {
    value: 'opus',
    source: 'session',
    file: '.claude/settings.json',
  }),
  definition('codex', '.codex/config.toml', { source: 'not-visible' }, '#checker'),
];

describe('tokenSummary', () => {
  it('sums up each plan, and lists the calls largest first with their models', () => {
    const summary = tokenSummary(result([claude, codex], definitions));
    expect(
      summary?.agents.map((row) => [row.agent, row.listings, row.subagents, row.unverified]),
    ).toEqual([
      // The skill's and both subagents' listing: 60 + 40 + 40 characters.
      ['claude-code', 35, 2, false],
      ['codex', 10, 1, true],
    ]);
    // Equal calls by agent order, then path; a Codex role's model through its role id.
    expect(summary?.calls.map((item) => [item.agent, item.name, item.tokens, item.model])).toEqual([
      ['claude-code', 'reviewer', 900, { value: 'sonnet', source: 'definition' }],
      ['claude-code', 'helper', 300, { value: 'opus', source: 'session' }],
      ['codex', 'checker', 300, { source: 'not-visible' }],
    ]);
    expect(summary?.directories).toBeUndefined();
  });

  it('ranks the start directories by their largest total, and marks unverified ones', () => {
    const report = result([claude, codex]);
    const scan: ScanResult = {
      ...report,
      context: {
        ...report.context!,
        directories: {
          planned: [
            directory('a', [['claude-code', 400, false]]),
            directory('b', [
              ['codex', 4000, true],
              ['claude-code', 800, false],
            ]),
          ],
          notPlanned: 3,
        },
      },
    };
    const summary = tokenSummary(scan);
    expect(summary?.agents.map((row) => row.cwd)).toEqual(['', '']);
    expect(
      summary?.directories?.map((row) => [
        row.cwd,
        row.largest,
        row.agents.map(
          (cell) => `${cell.agent} ${String(cell.startup)}${cell.unverified ? '?' : ''}`,
        ),
      ]),
    ).toEqual([
      ['b', 1000, ['claude-code 200', 'codex 1000?']],
      ['a', 100, ['claude-code 100']],
    ]);
    expect(summary?.directoriesNotPlanned).toBe(3);
    expect(formatTokensText(scan)).toMatch(/\n {2}b +200 +1,000\?\n/);
  });

  it('counts a skill the model selects as part of the listings, with its certainty', () => {
    const cursor = plan('cursor', {
      entries: [
        entry('skill', '.agents/skills/s1/SKILL.md', {
          trigger: 'model-selected',
          name: 's1',
          size: size(64),
          certainty: 'unverified',
        }),
      ],
      totals: { startup: size(64), onDemand: size(0) },
    });
    expect(tokenSummary(result([cursor]))?.agents).toMatchObject([
      { agent: 'cursor', startup: 16, listings: 16, unverified: true },
    ]);
  });

  it('lists every call: one it cannot measure, one that may run instead, and one it measures in part', () => {
    const claude = plan('claude-code', {
      entries: [
        entry('subagent', '.claude/agents/merged.md', {
          id: 'subagent:.claude/agents/merged.md',
          name: 'merged',
          certainty: 'unverified',
        }),
        entry('subagent', '.claude/agents/partly.md', {
          id: 'subagent:.claude/agents/partly.md',
          name: 'partly',
          size: size(40),
          ownContext: {
            size: size(400),
            parts: [{ kind: 'prompt', size: size(400), certainty: 'documented', evidence: [] }],
            unmeasured: ['.claude/skills/huge/SKILL.md'],
            notVisible: [],
          },
        }),
      ],
      skipped: [
        skip('subagent', '.claude/agents/twin.md', 'shadowed-by-preferred', {
          id: 'subagent:.claude/agents/twin.md',
          name: 'partly',
          certainty: 'unverified',
          ownContext: {
            size: size(8000),
            parts: [{ kind: 'prompt', size: size(8000), certainty: 'documented', evidence: [] }],
            notVisible: [],
          },
        }),
      ],
    });
    const scan = result(
      [claude],
      [
        definition('claude-code', '.claude/agents/partly.md', {
          value: 'opus',
          source: 'definition',
        }),
      ],
    );
    expect(
      tokenSummary(scan)?.calls.map((call) => [
        call.path,
        call.tokens,
        call.unverified,
        call.mayRun ?? false,
      ]),
    ).toEqual([
      ['.claude/agents/merged.md', undefined, true, false],
      ['.claude/agents/twin.md', 2000, true, true],
      ['.claude/agents/partly.md', 100, false, false],
    ]);
    const text = formatTokensText(scan);
    expect(text).toMatch(/not measured\? +Claude Code +merged/);
    expect(text).toMatch(/2,000\? +Claude Code +partly \(if it loads\)/);
    expect(text).toMatch(/100\+ +Claude Code +partly +opus/);
    expect(text).toContain('+ = the call starts with more: files the scan did not read');
    const report = JSON.parse(formatTokensJson(scan)) as unknown;
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('says when a model is not a value the agent documents', () => {
    const cursor = plan('cursor', { entries: [call('.cursor/agents/r.md', 'r', 10)] });
    const report = result(
      [cursor],
      [
        {
          ...definition('cursor', '.cursor/agents/r.md', { value: 'opus', source: 'definition' }),
          model: { value: 'opus', form: 'not-documented', line: 1 },
        },
      ],
    );
    expect(formatTokensText(report)).toMatch(/Cursor +r +opus \(not documented\)/);
  });

  it('is undefined without load plans, and the JSON report then has no summary', () => {
    expect(tokenSummary(emptyResult)).toBeUndefined();
    expect(JSON.parse(formatTokensJson(emptyResult))).not.toHaveProperty('tokens');
  });

  it('writes JSON the report schema accepts', () => {
    const report = JSON.parse(formatTokensJson(result([claude, codex], definitions))) as unknown;
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('formatTokensText and formatTokensMarkdown', () => {
  const hostile = 'evil\u001b[31m|`x`\nname‮';
  const many = plan('claude-code', {
    entries: [
      ...Array.from({ length: MAX_TOKEN_ROWS + 2 }, (_, i) =>
        call(`.claude/agents/a${String(i).padStart(2, '0')}.md`, `agent${String(i)}`, 100 + i),
      ),
      call('.claude/agents/hostile.md', hostile, 5000),
    ],
  });

  it('shows the largest calls first, a few, and cleans every name from the repository', () => {
    const text = formatTokensText(result([many]));
    expect(unsafeCodePoints(text, { newline: true })).toEqual([]);
    expect(hasEscOrBel(text)).toBe(false);
    const lines = text.split('\n');
    const first = lines.findIndex((line) => line.includes('.claude/agents/hostile.md'));
    expect(lines[first - 1]).toMatch(/≈tokens +Agent +Subagent +Model +File$/);
    expect(text).toContain(`… and ${String(MAX_TOKEN_ROWS + 3 - MAX_TOKEN_ROWS)} more calls`);
    expect(text).toContain('model not visible');

    const markdown = formatTokensMarkdown(result([many]));
    expect(markdown).toContain(
      `Showing ${String(MAX_TOKEN_ROWS)} of ${String(MAX_TOKEN_ROWS + 3)} calls.`,
    );
    // A name cannot break the table: one row, its pipe and backticks escaped.
    const row = markdown.split('\n').find((line) => line.includes('hostile\\.md'));
    expect(row?.split(' | ')).toHaveLength(5);
    expect(hasEscOrBel(markdown)).toBe(false);
  });

  it('writes ASCII decorations with --ascii, and marks unverified startup context', () => {
    const text = formatTokensText(result([codex], definitions), { ascii: true });
    expect(text).toContain('~tokens = characters / 4\n');
    // AGENTS.md (200 characters) and the role's listing (40): ≈60, unverified.
    expect(text.split('\n')).toContain('  Codex       60?        10          0          1');
    expect(text).toContain('? = unverified');
    // Every UTF-16 code unit below 0x80: ASCII only.
    expect(
      Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).every(
        (unit) => unit < 0x80,
      ),
    ).toBe(true);
    expect(formatTokensText(result([claude], definitions))).not.toContain('? = unverified');
  });

  it('says how many start directories were not planned', () => {
    const report = result([claude]);
    const withDirectories: ScanResult = {
      ...report,
      context: {
        ...report.context!,
        directories: { planned: [directory('a', [['claude-code', 400, false]])], notPlanned: 7 },
      },
    };
    expect(formatTokensText(withDirectories)).toMatch(/\n {2}a +100\n/);
    expect(formatTokensText(withDirectories)).toContain(
      '7 more directories hold agent configuration; plan one with agentcheckup tokens --cwd <dir>',
    );
    expect(formatTokensMarkdown(withDirectories)).toContain(
      '7 more directories hold agent configuration; plan one with `agentcheckup tokens --cwd <dir>`.',
    );
  });

  it('writes nothing without load plans', () => {
    expect(formatTokensText(emptyResult)).toBe('');
    expect(formatTokensMarkdown(emptyResult)).toBe('');
  });
});
