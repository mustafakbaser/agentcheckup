import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, AgentsReport, ModelSetting } from '../../src/agents/types.js';
import type { ScanResult } from '../../src/core/engine.js';
import { rebaseResult } from '../../src/core/rebase.js';
import { formatAgentsMarkdown } from '../../src/report/agents-markdown.js';
import { formatAgentsText } from '../../src/report/agents-text.js';
import { cleanResult } from './fixtures.js';
import { HOSTILE, HOSTILE_ALL } from './hostile.js';
import { ansiStyle, hasEscOrBel, hostileText, stripKnownSgr, unsafeCodePoints } from './safety.js';

function definition(
  file: string,
  agent: AgentDefinition['agent'],
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    id: `agent:${file}@${agent}`,
    file,
    line: 2,
    agent,
    name: 'reviewer',
    status: 'loads',
    effective: { source: 'not-visible' },
    tools: 'inherited',
    certainty: 'documented',
    evidence: [],
    digest: 'd',
    ...overrides,
  };
}

const settings: ModelSetting[] = [
  {
    id: 'model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
    agent: 'claude-code',
    file: '.claude/settings.json',
    line: 3,
    key: 'env.CLAUDE_CODE_SUBAGENT_MODEL',
    value: 'haiku',
    applies: 'subagents',
    forced: true,
    digest: 's',
  },
  {
    id: 'model:.codex/config.toml#model',
    agent: 'codex',
    file: '.codex/config.toml',
    line: 1,
    key: 'model',
    value: 'gpt-6.1',
    applies: 'session',
    digest: 's',
  },
];

const definitions: AgentDefinition[] = [
  definition('.claude/agents/reviewer.md', 'claude-code', {
    model: { value: 'opus', form: 'alias', line: 4 },
    effective: {
      value: 'haiku',
      source: 'setting',
      file: '.claude/settings.json',
      overridden: { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE', file: '.claude/settings.json' },
    },
    effort: { value: 'high', line: 5 },
  }),
  definition('.claude/agents/reviewer.md', 'cursor', {
    status: 'shadowed',
    reason: 'another definition has the same name',
    shadowedBy: '.cursor/agents/reviewer.md',
    model: { value: 'opus', form: 'not-documented', line: 4 },
  }),
  definition('.claude/agents/planner.md', 'claude-code', {
    name: 'planner',
    model: { value: 'inherit', form: 'inherit', line: 4 },
    effective: { value: 'sonnet', source: 'session', file: '.claude/settings.json' },
  }),
  definition('.github/agents/team/d.agent.md', 'copilot-cli', {
    name: 'team--d',
    model: { value: ['Claude Sonnet 4.5', 'GPT-5 (copilot)'], form: 'name', line: 3 },
    effective: { value: ['Claude Sonnet 4.5', 'GPT-5 (copilot)'], source: 'definition' },
    certainty: 'unverified',
  }),
  definition('.gemini/agents/broken.md', 'gemini', {
    name: 'broken',
    status: 'skipped',
    reason: 'no description',
  }),
  definition('.codex/config.toml', 'codex', {
    id: 'agent:.codex/config.toml#remote@codex',
    name: 'remote',
    status: 'unknown',
    reason: 'its config_file is not a file agentcheckup reads',
    certainty: 'unverified',
  }),
];

const withAgents = (agents: AgentsReport): ScanResult => ({ ...cleanResult, agents });
const result = withAgents({ definitions, settings });

describe('formatAgentsText', () => {
  it('lists each file, each agent that reads it, the model and why it does not load', () => {
    expect(formatAgentsText(result)).toBe(
      [
        '6 agent definitions in 5 files (3 loaded, 1 skipped, 1 shadowed, 1 may not load)',
        '',
        '.claude/agents/planner.md',
        '  Claude Code  planner   inherit → sonnet (session model, .claude/settings.json)',
        '.claude/agents/reviewer.md',
        '  Claude Code  reviewer  opus → haiku (subagent setting, .claude/settings.json); its own is ignored: .claude/settings.json sets env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE · effort high',
        '  Cursor       reviewer  opus (not a value Cursor documents) · shadowed by .cursor/agents/reviewer.md',
        '.codex/config.toml',
        '  Codex        remote    no model → set outside the repository · may not load: its config_file is not a file agentcheckup reads ?',
        '.gemini/agents/broken.md',
        '  Gemini CLI   broken    skipped: no description',
        '.github/agents/team/d.agent.md',
        '  Copilot CLI  team--d   Claude Sonnet 4.5, GPT-5 (copilot) ?',
        '',
        'Model settings',
        '  .claude/settings.json:3  env.CLAUDE_CODE_SUBAGENT_MODEL = haiku  Claude Code subagents, forced',
        '  .codex/config.toml:1     model = gpt-6.1                         Codex sessions',
        '',
        'Not visible here: the model a call passes, user and managed settings, and the environment. "Set outside the repository" marks a model chosen there.',
        '? = unverified: neither documentation nor source code confirms it',
        '',
      ].join('\n'),
    );
  });

  it('marks what needs a look in color, and only that', () => {
    const output = formatAgentsText(result, { style: ansiStyle });
    expect(output).toContain('\u001b[33mopus (not a value Cursor documents) · shadowed by');
    expect(output).toContain('\u001b[33mskipped: no description');
    expect(output).not.toContain('\u001b[33minherit');
    expect(stripKnownSgr(output)).toBe(formatAgentsText(result));
  });

  it('shows paths relative to the scanned directory, and names it', () => {
    const output = formatAgentsText(rebaseResult(result, 'packages/api'));
    expect(output.startsWith('Paths are relative to packages/api\n\n6 agent definitions')).toBe(
      true,
    );
    expect(output).toContain('\n.claude/agents/reviewer.md\n');
    expect(output).toContain('(subagent setting, .claude/settings.json)');
    expect(output).not.toContain('packages/api/.');
  });

  it('uses ASCII decorations on request', () => {
    const output = formatAgentsText(result, { ascii: true });
    expect(output).toContain('inherit -> sonnet');
    expect(output).toContain('effort high');
    expect(output).toContain(' - shadowed by');
    expect(output).not.toMatch(/[→·…]/);
  });

  it('says when there is nothing, and lists settings without definitions', () => {
    expect(formatAgentsText(cleanResult)).toBe(
      'No agent definitions or model settings in this report.\n',
    );
    expect(formatAgentsText(withAgents({ definitions: [], settings }))).toMatch(
      /^No agent definitions\n\nModel settings\n/,
    );
  });

  it('gives the same output whatever order the input lists are in', () => {
    const reversed = withAgents({
      definitions: [...definitions].reverse(),
      settings: [...settings].reverse(),
    });
    expect(formatAgentsText(reversed)).toBe(formatAgentsText(result));
    expect(formatAgentsMarkdown(reversed)).toBe(formatAgentsMarkdown(result));
  });
});

describe('formatAgentsMarkdown', () => {
  it('writes a table of definitions and one of settings', () => {
    const output = formatAgentsMarkdown(result);
    expect(output).toContain(
      '## Agent definitions\n\n6 agent definitions in 5 files (3 loaded, 1 skipped, 1 shadowed, 1 may not load).\n\n' +
        '| File | Agent | Name | Model | Status |\n| :--- | :---- | :--- | :---- | :----- |\n',
    );
    expect(output).toContain(
      '| \\.gemini/agents/broken\\.md | Gemini CLI | broken |  | **skipped\\: no description** |\n',
    );
    expect(output).toContain(
      '| team\\-\\-d | Claude Sonnet 4\\.5, GPT\\-5 \\(copilot\\) | loads ? |',
    );
    expect(output).toContain(
      '| \\.codex/config\\.toml:1 | model | gpt\\-6\\.1 | Codex sessions |\n',
    );
    expect(
      output.endsWith('_? = unverified: neither documentation nor source code confirms it._\n'),
    ).toBe(true);
  });

  it('stops each table at maxRows and says how many it left out', () => {
    const output = formatAgentsMarkdown(result, { maxRows: 2 });
    expect(output).toContain('Showing 2 of 6 definitions.');
    expect(output.match(/^\| \\\.claude\/agents/gm)).toHaveLength(2);
  });
});

describe('agents output safety', () => {
  const hostile = withAgents({
    definitions: [
      definition(`evil${HOSTILE.osc52Clipboard}/.claude/agents/x.md`, 'claude-code', {
        name: HOSTILE_ALL,
        model: { value: HOSTILE.fakeError, form: 'not-documented', line: 2 },
        effective: { value: HOSTILE.bidiOverride, source: 'setting', file: HOSTILE.stopCommands },
        effort: { value: HOSTILE.html, line: 3 },
      }),
      definition('notes\n::error::x/.cursor/agents/y.md', 'cursor', {
        status: 'shadowed',
        reason: 'another definition has the same name',
        shadowedBy: HOSTILE.addMask,
      }),
    ],
    settings: [
      { ...settings[0]!, file: HOSTILE.tablePipes, key: HOSTILE.links, value: HOSTILE.mentions },
    ],
  });

  it('text: no ESC, BEL, unsafe code point, trailing blank or workflow command', () => {
    for (const options of [{}, { ascii: true }, { style: ansiStyle }] as const) {
      const output = formatAgentsText(hostile, options);
      const plain = 'style' in options ? stripKnownSgr(output) : output;
      expect(hasEscOrBel(plain)).toBe(false);
      expect(unsafeCodePoints(plain, { newline: true })).toEqual([]);
      expect(plain).not.toMatch(/[ \t]$/m);
      expect(plain.split('\n').filter((line) => line.trimStart().startsWith('::'))).toEqual([]);
    }
  });

  it('markdown: no raw HTML, no table break, no mention', () => {
    const output = formatAgentsMarkdown(hostile);
    expect(output).not.toMatch(/<(?:img|script)/i);
    expect(output).not.toMatch(/(?<!\\)@octocat/);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    // Every row of a table has its header's columns: unescaped pipes are only cell borders.
    const borders = (line: string): number => line.split(/(?<!\\)\|/).length;
    for (const block of output.split('\n\n')) {
      const rows = block.split('\n').filter((line) => line.startsWith('|'));
      expect(rows.every((row) => borders(row) === borders(rows[0] ?? ''))).toBe(true);
    }
  });

  it('survives any text in every field', () => {
    fc.assert(
      fc.property(hostileText, hostileText, hostileText, (name, model, file) => {
        const input = withAgents({
          definitions: [
            definition(`${file}/a.md`, 'claude-code', {
              name,
              model: { value: model, form: 'not-documented', line: 1 },
            }),
          ],
          settings: [{ ...settings[0]!, value: model, key: name }],
        });
        const output = formatAgentsText(input);
        expect(hasEscOrBel(output)).toBe(false);
        expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
        expect(output.split('\n').some((line) => line.trimStart().startsWith('::'))).toBe(false);
        const markdown = formatAgentsMarkdown(input);
        expect(unsafeCodePoints(markdown, { newline: true })).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});
