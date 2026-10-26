import { describe, expect, it } from 'vitest';
import {
  compareWithBaseline,
  GATE_CLASSES,
  parseGateClasses,
  rebaseResult,
  scan,
  scanSnapshot,
  scanWithContext,
  SECURITY_GATE_CLASSES,
  stripPathBase,
  SUPPORTED_SCHEMA_VERSIONS,
  validateBaseline,
  builtinRules,
} from '../../src/index.js';
import { snapshotFrom } from '../helpers/lint.js';

const MCP = (servers: string): string => `{ "mcpServers": { ${servers} } }\n`;
const PINNED = '"github": { "command": "npx", "args": ["-y", "@acme/github-mcp@1.2.3"] }';
const UNPINNED = '"browser": { "command": "npx", "args": ["-y", "@acme/browser-mcp"] }';

describe('the programmatic baseline API', () => {
  it('compares a scan with a baseline it validated, as the CLI does', () => {
    const base = scanWithContext(snapshotFrom({ 'AGENTS.md': '# A\n', '.mcp.json': MCP(PINNED) }), {
      rules: builtinRules,
    });
    // A report written to disk and read back is plain JSON.
    const checked = validateBaseline(JSON.parse(JSON.stringify(base)));
    if (!checked.ok) throw new Error(checked.message);

    const head = scanSnapshot(
      snapshotFrom({ 'AGENTS.md': '# A\n', '.mcp.json': MCP(`${PINNED}, ${UNPINNED}`) }),
      { rules: builtinRules },
    );
    const gate = parseGateClasses('security');
    if (!gate.ok) throw new Error(gate.message);
    expect(gate.classes).toEqual([...SECURITY_GATE_CLASSES].sort());
    expect(GATE_CLASSES.filter((name) => !gate.classes.includes(name))).toEqual(['models']);

    const { diff, findings } = compareWithBaseline(head, checked.baseline, { gate: gate.classes });
    expect(diff.inventory.added).toEqual(['mcp:.mcp.json#browser']);
    expect(diff.gate.hits.map((hit) => hit.class)).toEqual(['mcp', 'mcp-unpinned']);
    expect(findings.every((finding) => finding.baseline !== undefined)).toBe(true);
  });

  it('rejects what is not a report', () => {
    expect(validateBaseline({ schemaVersion: 99 })).toMatchObject({
      ok: false,
      reason: 'unsupported-schema',
    });
    expect(validateBaseline('x')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([1]);
  });

  it('rebases paths and strips them again', () => {
    const result = scanSnapshot(snapshotFrom({ 'AGENTS.md': '# A\n' }), { rules: builtinRules });
    const rebased = rebaseResult(result, 'repo');
    expect(rebased.artifacts[0]?.path).toBe('repo/AGENTS.md');
    expect(stripPathBase(rebased).artifacts[0]?.path).toBe('AGENTS.md');
    expect(typeof scan).toBe('function');
  });
});
