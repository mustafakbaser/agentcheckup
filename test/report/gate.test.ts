import { describe, expect, it } from 'vitest';
import type { GateHit } from '../../src/core/baseline-types.js';
import { gateLocations, gateRows } from '../../src/report/gate.js';
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
