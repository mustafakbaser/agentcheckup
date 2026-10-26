import { describe, expect, it } from 'vitest';
import type { AgentDefinition, ModelSetting } from '../../src/agents/types.js';
import type { GateHit } from '../../src/core/baseline-types.js';
import { gateChangeCount, gateLocations, gateRows, noGateChanges } from '../../src/report/gate.js';
import { sampleBaseline, withContext } from '../helpers/context.js';
import { richResult } from './fixtures.js';

const diff = (hits: GateHit[]) => ({
  ...sampleBaseline,
  gate: { classes: ['permissions' as const], hits },
});

describe('gateRows', () => {
  it('labels a permission mode as set or changed, never as widened', () => {
    const mode = (change: GateHit['change'], value: string): GateHit => ({
      class: 'permissions',
      id: `perm:.claude/agents/a.md#permissionMode=${value}`,
      change,
      summary: `permissionMode set to ${value}`,
      kind: 'mode',
    });
    expect(
      gateRows(diff([mode('added', 'plan'), mode('changed', 'acceptEdits')])).map(
        (row) => row.label,
      ),
    ).toEqual(['Permission mode changed', 'Permission mode set']);
    const allow: GateHit = {
      class: 'permissions',
      id: 'perm:.claude/settings.json#permissions.allow=Bash',
      change: 'added',
      summary: 'permissions.allow adds Bash',
    };
    expect(gateRows(diff([allow])).map((row) => row.label)).toEqual(['Permission widened']);
    const agent: GateHit = { ...allow, id: 'perm:.claude/settings.json#agent=a', kind: 'agent' };
    expect(gateRows(diff([agent])).map((row) => row.label)).toEqual(['Session agent set']);
  });
});

const definitionHit = (change: GateHit['change'], name: string): GateHit => ({
  class: 'models',
  id: `agent:.claude/agents/${name}.md@claude-code`,
  change,
  summary: `New agent definition ${name} for Claude Code (model opus)`,
});
const settingHit: GateHit = {
  class: 'models',
  id: 'model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
  change: 'changed',
  summary: 'env.CLAUDE_CODE_SUBAGENT_MODEL set to opus for Claude Code (was haiku)',
  kind: 'model-setting',
};
const hookHit: GateHit = {
  class: 'hooks',
  id: 'hook:.claude/settings.json#Stop:00000000',
  change: 'added',
  summary: 'New hook Stop → ./notify.sh',
};

describe('model changes', () => {
  it('labels agent definitions and model settings', () => {
    expect(
      gateRows(diff([definitionHit('added', 'a'), definitionHit('changed', 'b'), settingHit])).map(
        (row) => row.label,
      ),
    ).toEqual(['New agent definition', 'Agent definition changed', 'Model setting changed']);
  });

  it('counts model changes apart from security-relevant ones', () => {
    const rows = (hits: GateHit[]) => gateRows(diff(hits));
    expect(gateChangeCount(rows([hookHit]))).toBe('1 security-relevant change');
    expect(gateChangeCount(rows([definitionHit('added', 'a'), settingHit]))).toBe(
      '2 model changes',
    );
    expect(gateChangeCount(rows([hookHit, definitionHit('added', 'a')]))).toBe(
      '1 security-relevant change and 1 model change',
    );
  });

  it('says which classes found nothing', () => {
    expect(noGateChanges(['hooks', 'mcp'])).toBe('No security-relevant changes need review');
    expect(noGateChanges(['models'])).toBe('No model changes need review');
    expect(noGateChanges(['hooks', 'models'])).toBe(
      'No security-relevant or model changes need review',
    );
  });

  it('locates a definition and a setting where the report lists them', () => {
    const definition = {
      id: 'agent:.claude/agents/a.md@claude-code',
      file: '.claude/agents/a.md',
      line: 2,
    } as AgentDefinition;
    const setting = {
      id: settingHit.id,
      file: '.claude/settings.json',
      line: 4,
    } as ModelSetting;
    const locate = gateLocations({
      ...withContext(richResult),
      agents: { definitions: [definition], settings: [setting] },
    });
    expect(locate(definitionHit('added', 'a'))).toEqual({ file: '.claude/agents/a.md', line: 2 });
    expect(locate(settingHit)).toEqual({ file: '.claude/settings.json', line: 4 });
    expect(locate(definitionHit('added', 'gone'))).toBeUndefined();
  });
});

describe('gateLocations', () => {
  it('finds the declaring file and line of an item or a finding, and nothing else', () => {
    const result = withContext(richResult);
    const locate = gateLocations(result);
    const [item] = result.inventory.permissions;
    if (item === undefined) throw new Error('expected a permission item');
    expect(locate({ class: 'permissions', id: item.id, change: 'added', summary: '' })).toEqual({
      file: item.file,
      line: item.line,
    });
    expect(
      locate({ class: 'hooks', id: 'hook:gone#Stop:00000000', change: 'added', summary: '' }),
    ).toBeUndefined();
    const [finding] = result.findings;
    if (finding === undefined) throw new Error('expected a finding');
    expect(
      locate({ class: 'unicode', id: finding.fingerprint, change: 'added', summary: '' }),
    ).toEqual({ file: finding.path, line: finding.range.start.line });
  });
});
