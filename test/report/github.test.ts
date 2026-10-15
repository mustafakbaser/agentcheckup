import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { formatGithub } from '../../src/report/github.js';
import { forTerminal } from '../../src/report/sanitize.js';
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

  it.each(['rich', 'hostile'] as const)('%s matches the snapshot', async (name) => {
    const result = name === 'rich' ? richResult : hostileResult;
    await expect(formatGithub(result)).toMatchFileSnapshot(`__snapshots__/github.${name}.txt`);
  });

  it.each(FIXTURES)('%s: every line is one well-formed annotation command', (_, result) => {
    const output = formatGithub(result);
    const expected =
      result.findings.filter((finding) => !finding.suppressed).length + result.ruleFailures.length;
    expect(lines(output)).toHaveLength(expected);
    for (const line of lines(output)) {
      expect(line).toMatch(COMMAND_LINE);
      expect(unsafeCodePoints(line, { tab: true })).toEqual([]);
    }
  });

  it('round-trips through the runner parser to the sanitized values', () => {
    const active = hostileResult.findings.filter((finding) => !finding.suppressed);
    const parsed = lines(formatGithub(hostileResult)).map(parseWorkflowCommand);
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
      expect(command.properties['title']).toBe(forTerminal(finding.ruleId));
      expect(command.properties['line']).toBe(String(finding.range.start.line));
      expect(command.data).toBe(forTerminal(finding.message, { multiline: true }));
    });
    expect(parsed.map((command) => command.command)).not.toContain('stop-commands');
    expect(parsed.map((command) => command.command)).not.toContain('add-mask');
  });

  it('maps severities to error, warning and notice and positions to properties', () => {
    const output = lines(formatGithub(richResult));
    expect(output[0]).toBe(
      '::warning file=.cursor/rules/style.mdc,line=2,col=1,endLine=2,endColumn=18,title=cursor/conflicting-activation::`alwaysApply: true` overrides `globs`, so the rule loads in every chat.',
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
