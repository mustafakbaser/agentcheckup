/**
 * Labels the context formatters share (src/report/context-view.ts) for agents and skip codes,
 * including the agents whose loaders are not turned on yet.
 */
import { describe, expect, it } from 'vitest';
import { type ScanResult, scanWithContext } from '../../src/core/engine.js';
import { PLATFORM_IDS } from '../../src/core/types.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type ContextAgent,
  type OwnContext,
  type SkipCode,
} from '../../src/platforms/load/types.js';
import { formatContextMarkdown } from '../../src/report/context-markdown.js';
import { formatContextText } from '../../src/report/context-text.js';
import {
  AGENT_COLUMNS,
  AGENT_NAMES,
  contextView,
  SKIP_LABELS,
} from '../../src/report/context-view.js';
import { builtinRules } from '../../src/rules/index.js';
import { contextReport, entry, plan, skip, size } from '../helpers/context.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { emptyResult } from './fixtures.js';

describe('agent labels', () => {
  it('names every agent once, and every Copilot surface after Copilot', () => {
    const names = ALL_CONTEXT_AGENTS.map((agent) => AGENT_NAMES[agent]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.startsWith('Copilot'))).toEqual([
      'Copilot CLI',
      'Copilot in VS Code',
      'Copilot cloud agent',
    ]);
    expect(AGENT_NAMES.windsurf).toBe('Devin Local');
  });

  it('groups short column labels by platform, with a surface only where a platform has several', () => {
    for (const agent of ALL_CONTEXT_AGENTS) {
      const shared = ALL_CONTEXT_AGENTS.filter(
        (other) => CONTEXT_PLATFORM[other] === CONTEXT_PLATFORM[agent],
      );
      const sameGroup = ALL_CONTEXT_AGENTS.filter(
        (other) => AGENT_COLUMNS[other].group === AGENT_COLUMNS[agent].group,
      );
      expect(sameGroup).toEqual(shared);
      expect(AGENT_COLUMNS[agent].surface === undefined).toBe(shared.length === 1);
    }
    expect(ALL_CONTEXT_AGENTS.map((agent) => AGENT_COLUMNS[agent].surface ?? '')).toEqual([
      '',
      '',
      '',
      'CLI',
      'VSC',
      'Cloud',
      '',
      '',
      '',
    ]);
  });
});

describe('skip labels', () => {
  it('gives every skip code its own reason', () => {
    const labels = Object.values(SKIP_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('heads a plan with the agent name and explains the new skip codes', () => {
    const codes: readonly SkipCode[] = [
      'wrong-location',
      'no-apply-to',
      'shadowed-by-preferred',
      'disabled',
      'never-active',
      'invalid-toml',
    ];
    const gemini = plan('gemini', {
      entries: [entry('instructions', 'GEMINI.md', { position: 1, size: size(400) })],
      skipped: codes.map((code, index) => skip('rule', `rules/${String(index)}.md`, code)),
    });
    const result: ScanResult = { ...emptyResult, context: contextReport([gemini]) };
    const output = formatContextText(result);
    expect(output.split('\n')[0]).toBe('Gemini CLI context · ./');
    for (const code of codes) expect(output).toContain(SKIP_LABELS[code]);
    // A skip without a rule shows no rule id, so the reasons stand alone.
    expect(output).not.toContain('undefined');
  });
});

describe('assumption phrases', () => {
  /** The Assumes phrases of each agent's plan for a repository with `files`. */
  function phrases(files: FileMap): Map<ContextAgent, readonly string[]> {
    const result = scanWithContext(snapshotFrom(files, { paths: ['.git/HEAD'] }), {
      rules: builtinRules,
      targets: PLATFORM_IDS,
      trustDirectives: false,
      agents: CONTEXT_AGENTS,
    });
    return new Map(contextView(result).plans.map((view) => [view.agent, view.assumptions]));
  }

  it('phrases every assumption the loaders state, defaults and repository values alike', () => {
    const defaults = phrases({ 'AGENTS.md': 'Rules.\n' });
    for (const [agent, texts] of defaults) {
      for (const text of texts) expect(`${agent}: ${text}`).not.toContain(' = ');
    }
    expect(defaults.get('copilot-cli')).toEqual(['trusted folder']);
    // VS Code's default harness is Copilot; the plan models the Local one.
    expect(defaults.get('copilot-vscode')).toEqual([
      'Local agent harness (assumed)',
      "VS Code's default Copilot harness not modeled",
      'instruction files on (assumed)',
      'AGENTS.md on (default)',
      'nested AGENTS.md files off (default)',
      'CLAUDE.md on (assumed)',
      'Claude Code hooks off (assumed)',
      'trusted workspace',
    ]);
    // The heading names the surface already.
    expect(defaults.get('copilot-cloud')).toEqual([]);
    expect(defaults.get('gemini')).toEqual([
      'context file GEMINI.md (default)',
      'folder trust off (default)',
      'access through paid API key or Gemini Code Assist license',
    ]);
    expect(defaults.get('windsurf')).toEqual([
      'Devin Local, not Cascade',
      'Restricted Mode off (default)',
      'AGENTS.md standard files imported (default)',
      'Claude Code files imported (default)',
      'Copilot files imported (default)',
      'Cursor files imported (default)',
      'Windsurf files imported (default)',
    ]);
    expect(defaults.get('cline')).toEqual([
      'VS Code extension',
      'rule toggles from frontmatter, none in extension state (default)',
    ]);

    const configured = phrases({
      'AGENTS.md': 'Rules.\n',
      '.gemini/settings.json': '{ "context": { "fileName": ["AGENTS.md"] } }\n',
      '.devin/config.json': '{ "read_config_from": { "cursor": false } }\n',
    });
    expect(configured.get('gemini')?.[0]).toBe(
      'context files AGENTS.md and GEMINI.md (from the repository)',
    );
    expect(configured.get('windsurf')).toContain('Cursor files not imported (from the repository)');
  });

  it('keeps a value it has no words for as key = value', () => {
    const output = formatContextText({
      ...emptyResult,
      context: contextReport([
        plan('copilot-cli', {
          entries: [entry('instructions', 'AGENTS.md', { position: 1, size: size(8) })],
          assumptions: [
            { key: 'copilot.surface', value: 'jetbrains', origin: 'default', evidence: [] },
            { key: 'copilot-cli.future', value: 3, origin: 'default', evidence: [] },
          ],
        }),
      ]),
    });
    expect(output).toContain('\nAssumes surface jetbrains, copilot-cli.future = 3 (default)\n');
  });
});

describe('subagents listing', () => {
  const files: FileMap = {
    'CLAUDE.md': 'Rules.\n',
    '.claude/agents/reviewer.md':
      '---\nname: reviewer\ndescription: Reviews code.\n---\nYou review code.\n',
    '.claude/agents/planner.md': '---\nname: planner\ndescription: Plans work.\n---\nPlan it.\n',
  };

  function scanned(map: FileMap): ScanResult {
    return scanWithContext(snapshotFrom(map, { paths: ['.git/HEAD'] }), {
      rules: builtinRules,
      trustDirectives: false,
      targets: PLATFORM_IDS,
      agents: ['claude-code'],
    });
  }

  it('shows the names and descriptions the model picks from as one startup row', () => {
    const output = formatContextText(scanned(files));
    // 39 characters of names and descriptions, ≈6 + ≈5 tokens, as the skills listing row adds
    // its entries: one row, without a position.
    const lines = output.split('\n');
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {5}Subagents listing \(2 subagents, names and descriptions\) +39 +10$/,
      ),
    );
    // The listing is not the files: a subagent's own prompt is not in the session's context,
    // it is in the calls below.
    const startup = lines.slice(lines.findIndex((line) => line.startsWith('At session start')));
    const table = startup.slice(0, startup.indexOf(''));
    expect(table.some((line) => line.trim().startsWith('.claude/agents/'))).toBe(false);
    expect(lines).toContain('Subagent calls, each in a context window of its own');
    const markdown = formatContextMarkdown(scanned(files));
    expect(markdown).toContain('Subagents listing (2 subagents, names and descriptions)');
  });

  it("says on the row when the listing passes Claude Code's startup warning", () => {
    const listed = (used: number) =>
      plan('claude-code', {
        entries: [entry('subagent', '.claude/agents/a.md', { name: 'a', size: size(80) })],
        limits: [
          {
            key: 'claude-code.agent_descriptions_tokens',
            label: 'subagents listing',
            unit: 'tokens',
            limit: 15_000,
            used,
            subject: '',
            effect: 'advice',
            evidence: [],
          },
        ],
      });
    const label = (used: number) =>
      formatContextText({ ...emptyResult, context: contextReport([listed(used)]) })
        .split('\n')
        .find((line) => line.includes('Subagents listing'));
    expect(label(15_001)).toContain(
      'Subagents listing (1 subagent, names and descriptions, past the 15,000-token startup warning)',
    );
    expect(label(15_000)).not.toContain('warning');
  });

  it('has no row without a listed subagent', () => {
    const output = formatContextText(scanned({ 'CLAUDE.md': 'Rules.\n' }));
    expect(output).not.toContain('Subagents listing');
  });
});

describe('subagent calls', () => {
  const own = (overrides: Partial<OwnContext>): OwnContext => ({
    size: size(400),
    parts: [{ kind: 'prompt', size: size(400), certainty: 'documented', evidence: [] }],
    notVisible: [],
    ...overrides,
  });

  it('shows a subagent it cannot measure as a call, and names what it did not read', () => {
    const claude = plan('claude-code', {
      entries: [
        entry('subagent', '.claude/agents/merged.md', { name: 'merged', certainty: 'unverified' }),
        entry('subagent', '.claude/agents/keeper.md', {
          name: 'keeper',
          size: size(20),
          ownContext: own({
            parts: [
              { kind: 'prompt', size: size(40), certainty: 'documented', evidence: [] },
              { kind: 'listing', size: size(80), certainty: 'documented', evidence: [] },
              {
                kind: 'memory',
                path: '.claude/agent-memory/keeper/MEMORY.md',
                size: size(400),
                certainty: 'documented',
                evidence: [],
              },
            ],
            unmeasured: ['.claude/skills/huge/SKILL.md'],
            memory: {
              scope: 'project',
              path: '.claude/agent-memory/keeper/MEMORY.md',
              exists: true,
            },
          }),
        }),
      ],
    });
    const [view] = contextView({ ...emptyResult, context: contextReport([claude]) }).plans;
    expect(
      view?.calls.map((row) => [
        row.path,
        row.size?.tokens,
        row.parts.map((part) => part.label),
        row.notes,
        row.unverified,
      ]),
    ).toEqual([
      [
        '.claude/agents/keeper.md',
        100,
        ['prompt', 'skills listing', 'memory'],
        ['not measured, so the call starts with more: .claude/skills/huge/SKILL.md'],
        false,
      ],
      [
        '.claude/agents/merged.md',
        undefined,
        [],
        ['not measured: agentcheckup cannot read what it starts with'],
        true,
      ],
    ]);
    const text = formatContextText({ ...emptyResult, context: contextReport([claude]) });
    expect(text).toMatch(/\.claude\/agents\/merged\.md +not measured \?\n/);
  });

  it('notes the preloads a call does not get and the memory it is not measured with', () => {
    const claude = plan('claude-code', {
      entries: [
        entry('subagent', '.claude/agents/a.md', {
          name: 'a',
          size: size(20),
          ownContext: own({
            notLoaded: [
              { name: 'x', reason: 'not-found' },
              { name: 'y', reason: 'not-model-invocable' },
              { name: 'z', reason: 'off' },
            ],
            overLimit: 1_200,
            memory: { scope: 'project', path: '.claude/agent-memory/a/MEMORY.md', exists: false },
            notVisible: ['tools', 'environment'],
          }),
        }),
        entry('subagent', '.claude/agents/b.md', {
          name: 'b',
          size: size(20),
          ownContext: own({
            parts: [
              { kind: 'skill', name: 'api', size: size(80), certainty: 'unverified', evidence: [] },
            ],
            overLimit: 1,
            memory: { scope: 'user' },
            notVisible: ['task'],
          }),
        }),
      ],
    });
    const [view] = contextView({ ...emptyResult, context: contextReport([claude]) }).plans;
    expect(
      view?.calls.map((row) => [row.parts.map((part) => part.label), row.notes, row.unverified]),
    ).toEqual([
      [
        ['prompt'],
        [
          "not preloaded: x (not in this session's skills), y (the model cannot invoke it), z (turned off), and 1,200 skills past the first 32",
          'memory .claude/agent-memory/a/MEMORY.md, none yet',
        ],
        false,
      ],
      [
        ['skill api'],
        ['not preloaded: 1 skill past the first 32', "memory in the user's scope, not visible"],
        true,
      ],
    ]);
    // Every plan's hidden parts once, in a fixed order.
    expect(view?.callsHidden).toEqual([
      'environment details',
      'the task message',
      'tool definitions',
    ]);
  });
});
