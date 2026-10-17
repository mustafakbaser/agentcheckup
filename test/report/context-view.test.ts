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
  type SkipCode,
} from '../../src/platforms/load/types.js';
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
    expect(defaults.get('copilot-vscode')).toEqual([
      'Local agent harness',
      'instruction files on (default)',
      'AGENTS.md on (default)',
      'nested AGENTS.md files off (default)',
      'CLAUDE.md on (default)',
      'Claude Code hooks off (default)',
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
    expect(defaults.get('cline')).toEqual(['VS Code extension', 'every rule toggle on (default)']);

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
