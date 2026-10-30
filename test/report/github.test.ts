import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import type { PolicyViolation } from '../../src/policy/types.js';
import { gateRows } from '../../src/report/gate.js';
import { formatGithub } from '../../src/report/github.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { withContext } from '../helpers/context.js';
import { cleanResult, emptyResult, finding, makeResult, richResult, RULES } from './fixtures.js';
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
    // Ranked by severity, so matched by location and rule.
    expect(parsed).toHaveLength(active.length + hostileResult.ruleFailures.length);
    active.forEach((finding) => {
      const tag = finding.fix === undefined ? '' : ` (fix: ${finding.fix.class})`;
      const command = parsed.find(
        (each) =>
          each.properties['file'] === forTerminal(finding.path) &&
          each.properties['line'] === String(finding.range.start.line) &&
          each.properties['title'] === forTerminal(`${finding.ruleId}${tag}`),
      )!;
      expect(Object.keys(command.properties)).toEqual([
        'file',
        'line',
        'col',
        'endLine',
        'endColumn',
        'title',
      ]);
      expect(command.data).toBe(forTerminal(finding.message, { multiline: true }));
    });
    expect(parsed.map((command) => command.command)).not.toContain('stop-commands');
    expect(parsed.map((command) => command.command)).not.toContain('add-mask');
  });

  it('maps severities to error, warning and notice and positions to properties', () => {
    const output = lines(formatGithub(richResult, { level: 'compact' }));
    expect(output[1]).toMatch(/^::error file=AGENTS\.md,line=12,col=3,endLine=12,endColumn=9,/);
    expect(output[3]).toBe(
      '::warning file=.cursor/rules/style.mdc,line=2,col=1,endLine=2,endColumn=18,title=cursor/conflicting-activation (fix%3A safe)::`alwaysApply: true` overrides `globs`, so the rule loads in every chat.',
    );
    expect(output[5]).toMatch(/^::notice file=AGENTS\.md,line=1,col=1,endLine=1,endColumn=1,/);
  });

  it('reports rule failures as error annotations, first', () => {
    expect(lines(formatGithub(richResult))[0]).toBe(
      "::error title=agentcheckup internal error::Rule mcp/unknown-server-field failed to run, so results are incomplete: Cannot read properties of undefined (reading 'type')",
    );
    expect(lines(formatGithub(hostileResult))[0]).toBe(
      '::error title=agentcheckup internal error::Rule risk/crashy failed to run, so results are incomplete: boom%0A::error::fake<U+001B>[2J',
    );
  });

  it('ranks findings by severity, risk first, then in report order', () => {
    const findings = [
      finding(RULES.claudeOnlyImport, 'a.md', 'info a'),
      finding(RULES.fileTooLarge, 'a.md', 'warn a'),
      finding(RULES.brokenImport, 'b.md', 'error b'),
      finding(RULES.remoteScript, 'c.md', 'risk warn c'),
      finding(RULES.brokenImport, 'a.md', 'error a'),
      finding(RULES.hiddenUnicode, 'z.md', 'risk error z'),
    ];
    const data = lines(formatGithub(makeResult({ findings }), { level: 'compact' })).map(
      (line) => parseWorkflowCommand(line).data,
    );
    expect(data).toEqual(['risk error z', 'error b', 'error a', 'risk warn c', 'warn a', 'info a']);
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

describe('formatGithub within the annotations GitHub shows', () => {
  // GitHub shows the first 10 errors, 10 warnings and 10 notices of a step.
  const base = withContext(richResult);
  const broken = Array.from({ length: 12 }, (_, index) => ({
    ...finding(RULES.brokenImport, `docs/${String(index).padStart(2, '0')}.md`, `Broken ${index}`),
    baseline: 'new' as const,
  }));
  const violation: PolicyViolation = {
    id: 'v1',
    check: 'mcp-not-allowed',
    entry: 'npm:x',
    path: '.mcp.json',
    line: 3,
    message: 'MCP server "x" is not allowed.',
    fails: true,
  };
  const crowded: ScanResult = {
    ...base,
    findings: [...broken, ...base.findings],
    ruleFailures: [{ ruleId: 'x/crashy', message: 'boom' }],
    policy: {
      name: 'acme',
      sha256: '0'.repeat(64),
      mode: 'enforce',
      insideScanRoot: false,
      checks: 1,
      violations: [violation],
      notes: [],
    },
  };
  const output = lines(formatGithub(crowded));

  it('puts the rule failure, the gate hits and the failing violation among the first ten errors', () => {
    const shown = output.filter((line) => line.startsWith('::error ')).slice(0, 10);
    expect(shown[0]).toContain('title=agentcheckup internal error');
    const gateRowCount = gateRows(base.baseline!).length;
    expect(shown.filter((line) => line.includes('title=Needs review'))).toHaveLength(gateRowCount);
    expect(shown.filter((line) => line.includes('title=policy%3A mcp-not-allowed'))).toHaveLength(
      1,
    );
    expect(output.filter((line) => line.startsWith('::error ')).length).toBeGreaterThan(10);
  });

  it('says how many are only in the log, in a notice GitHub shows', () => {
    const notices = output.filter((line) => line.startsWith('::notice '));
    const errors = output.filter((line) => line.startsWith('::error ')).length;
    expect(notices[0]).toBe(
      `::notice title=agentcheckup annotations::GitHub shows 10 annotations of each type per step, so ${String(errors - 10)} errors from agentcheckup are only in the log. The ones that fail the run come first, then the findings by severity.`,
    );
    expect(lines(formatGithub(base)).join('\n')).not.toContain('agentcheckup annotations');
  });

  it('counts the notice itself when the notices are full too', () => {
    const notes = Array.from({ length: 10 }, (_, index) =>
      finding(RULES.claudeOnlyImport, `n${String(index)}.md`, `Note ${index}`),
    );
    const many = makeResult({
      findings: [
        ...notes,
        ...Array.from({ length: 11 }, () => finding(RULES.fileTooLarge, 'a.md', 'w')),
      ],
    });
    const notice = lines(formatGithub(many)).find((line) =>
      line.includes('agentcheckup annotations'),
    );
    expect(notice).toContain('so 1 warning and 1 notice from agentcheckup are only in the log.');
    const one = makeResult({
      findings: Array.from({ length: 11 }, () => finding(RULES.fileTooLarge, 'a.md', 'w')),
    });
    expect(lines(formatGithub(one)).at(-1)).toContain(
      'so 1 warning from agentcheckup is only in the log.',
    );
    const lots = makeResult({
      findings: Array.from({ length: 1210 }, () => finding(RULES.fileTooLarge, 'a.md', 'w')),
    });
    expect(lines(formatGithub(lots)).at(-1)).toContain(
      'so 1,200 warnings from agentcheckup are only in the log.',
    );
  });

  it('leaves a single finding as it was', () => {
    const single = makeResult({ findings: [finding(RULES.brokenImport, 'CLAUDE.md', 'Broken.')] });
    expect(formatGithub(single, { level: 'compact' })).toBe(
      '::error file=CLAUDE.md,line=1,col=1,endLine=1,endColumn=1,title=instructions/broken-import::Broken.\n',
    );
  });
});
