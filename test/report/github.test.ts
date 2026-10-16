import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { gateRows } from '../../src/report/gate.js';
import { formatGithub } from '../../src/report/github.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { withContext } from '../helpers/context.js';
import { cleanResult, emptyResult, richResult } from './fixtures.js';
import { hostileResult } from './hostile.js';
import { parseWorkflowCommand, unsafeCodePoints } from './safety.js';

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
];

/** `::<command> <properties without ':'>::<data>`: exactly one data section per line. */
const COMMAND_LINE = /^::(?:error|warning|notice) [^\n\r:]*::[^\n\r]*$/;

function lines(output: string): string[] {
  return output === '' ? [] : output.replace(/\n$/, '').split('\n');
}

describe('formatGithub', () => {
  it('prints nothing when there is nothing to annotate', () => {
    expect(formatGithub(cleanResult)).toBe('');
    expect(formatGithub(emptyResult)).toBe('');
  });

  // `compact` is the output from before fixes, with the fix class in the title.
  it.each(['rich', 'hostile'] as const)('%s matches the snapshot', async (name) => {
    const result = name === 'rich' ? richResult : hostileResult;
    await expect(formatGithub(result, { level: 'compact' })).toMatchFileSnapshot(
      `__snapshots__/github.${name}.txt`,
    );
    await expect(formatGithub(result)).toMatchFileSnapshot(
      `__snapshots__/github.${name}-default.txt`,
    );
  });

  it.each(FIXTURES)('%s: every line is one well-formed annotation command', (_, result) => {
    for (const level of ['compact', 'default', 'verbose'] as const) {
      const output = formatGithub(result, { level });
      const expected =
        result.findings.filter((finding) => !finding.suppressed).length +
        result.ruleFailures.length;
      expect(lines(output)).toHaveLength(expected);
      for (const line of lines(output)) {
        expect(line).toMatch(COMMAND_LINE);
        expect(unsafeCodePoints(line, { tab: true })).toEqual([]);
      }
    }
  });

  it('round-trips through the runner parser to the sanitized values', () => {
    const active = hostileResult.findings.filter((finding) => !finding.suppressed);
    const parsed = lines(formatGithub(hostileResult, { level: 'compact' })).map(
      parseWorkflowCommand,
    );
    active.forEach((finding, index) => {
      const command = parsed[index]!;
      expect(Object.keys(command.properties)).toEqual([
        'file',
        'line',
        'col',
        'endLine',
        'endColumn',
        'title',
      ]);
      expect(command.properties['file']).toBe(forTerminal(finding.path));
      const tag = finding.fix === undefined ? '' : ` (fix: ${finding.fix.class})`;
      expect(command.properties['title']).toBe(forTerminal(`${finding.ruleId}${tag}`));
      expect(command.properties['line']).toBe(String(finding.range.start.line));
      expect(command.data).toBe(forTerminal(finding.message, { multiline: true }));
    });
    expect(parsed.map((command) => command.command)).not.toContain('stop-commands');
    expect(parsed.map((command) => command.command)).not.toContain('add-mask');
  });

  it('maps severities to error, warning and notice and positions to properties', () => {
    const output = lines(formatGithub(richResult, { level: 'compact' }));
    expect(output[0]).toBe(
      '::warning file=.cursor/rules/style.mdc,line=2,col=1,endLine=2,endColumn=18,title=cursor/conflicting-activation (fix%3A safe)::`alwaysApply: true` overrides `globs`, so the rule loads in every chat.',
    );
    expect(output[1]).toMatch(/^::notice file=AGENTS\.md,line=1,col=1,endLine=1,endColumn=1,/);
    expect(output[2]).toMatch(/^::error file=AGENTS\.md,line=12,col=3,endLine=12,endColumn=9,/);
  });

  it('reports rule failures as error annotations', () => {
    expect(lines(formatGithub(richResult)).at(-1)).toBe(
      "::error title=agentcheckup internal error::Rule mcp/unknown-server-field failed to run, so results are incomplete: Cannot read properties of undefined (reading 'type')",
    );
    expect(lines(formatGithub(hostileResult)).at(-1)).toBe(
      '::error title=agentcheckup internal error::Rule risk/crashy failed to run, so results are incomplete: boom%0A::error::fake<U+001B>[2J',
    );
  });
});

describe('formatGithub with a baseline', () => {
  const result = withContext(richResult);
  const output = lines(formatGithub(result));

  it('annotates new findings only, then each change that trips the gate', () => {
    const fresh = result.findings.filter(
      (finding) => !finding.suppressed && finding.baseline === 'new',
    );
    const rows = gateRows(result.baseline!);
    expect(fresh.length).toBeGreaterThan(0);
    expect(output).toHaveLength(fresh.length + rows.length + result.ruleFailures.length);
    for (const line of output) {
      expect(line).toMatch(COMMAND_LINE);
      expect(unsafeCodePoints(line, { tab: true })).toEqual([]);
    }
    const gate = output.filter((line) => line.includes('title=Needs review'));
    expect(gate).toHaveLength(rows.length);
    // On the declaring file and line when the inventory has the item.
    expect(gate[0]).toBe(
      '::error file=.cursor/mcp.json,line=2,title=Needs review%3A New MCP server%2C not pinned::stdio, npx -y @acme/browser-mcp, not pinned',
    );
  });

  it('puts a gate hit whose item it cannot find on no file', () => {
    const lost = formatGithub({ ...result, inventory: { ...result.inventory, permissions: [] } });
    expect(lost).toContain(
      '::error title=Needs review%3A Permission widened::permissions.allow adds Bash(curl:*)',
    );
  });

  it('warns about a baseline from another ruleset', () => {
    const older = formatGithub({
      ...result,
      baseline: {
        ...result.baseline!,
        against: {
          version: '0.0.0',
          ruleset: '2026.09\n::stop-commands::x',
          sameRuleset: false,
          newRules: [],
        },
      },
    });
    expect(lines(older)).toContain(
      '::warning title=agentcheckup baseline::The baseline was written with ruleset 2026.09%0A::stop-commands::x, so findings from rules it did not run count as new.',
    );
  });
});
