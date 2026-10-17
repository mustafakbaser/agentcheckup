/**
 * Labels the context formatters share (src/report/context-view.ts) for agents and skip codes,
 * including the agents whose loaders are not turned on yet.
 */
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type SkipCode,
} from '../../src/platforms/load/types.js';
import { formatContextText } from '../../src/report/context-text.js';
import { AGENT_COLUMNS, AGENT_NAMES, SKIP_LABELS } from '../../src/report/context-view.js';
import { contextReport, entry, plan, skip, size } from '../helpers/context.js';
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
