import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { HOOKS_NOT_ENFORCED } from '../../src/policy/evaluate.js';
import type { PolicyCheck, PolicyReport, PolicyViolation } from '../../src/policy/types.js';
import { formatGithub } from '../../src/report/github.js';
import { formatJson, toJsonReport } from '../../src/report/json.js';
import { formatMarkdown } from '../../src/report/markdown.js';
import { policyAnnotations } from '../../src/report/policy-github.js';
import { toJsonPolicy } from '../../src/report/policy-json.js';
import { policySection } from '../../src/report/policy-markdown.js';
import { POLICY_FINGERPRINT_KEY, policySarif } from '../../src/report/policy-sarif.js';
import { renderPolicy } from '../../src/report/policy-stylish.js';
import { formatSarif, type SarifLog } from '../../src/report/sarif.js';
import { formatStylish, plainStyle } from '../../src/report/stylish.js';
import { withContext } from '../helpers/context.js';
import { richResult } from './fixtures.js';
import { HOSTILE, HOSTILE_ALL, hostileResult } from './hostile.js';
import {
  commandLines,
  hasEscOrBel,
  parseWorkflowCommand,
  tagStyle,
  unsafeCodePoints,
} from './safety.js';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const SHA256 = 'e69b0fe7a008c4f1d2b3a4958677e8f9a0b1c2d3e4f5061728394a5b6c7d8e9f';

const HOOK_MESSAGE = `The policy requires a Claude Code PreToolUse hook with matcher "Bash" that runs "scripts/hooks/guard.sh", and none is configured. ${HOOKS_NOT_ENFORCED}`;

/** One violation of each kind of subject: a server, a grant, a hook, a budget, a file. */
const VIOLATIONS: readonly PolicyViolation[] = [
  {
    id: 'mcp-not-allowed:mcp:.mcp.json#fetch@0123456789abcdef',
    check: 'mcp-not-allowed',
    entry: 'npm:mcp-fetch-server',
    path: '.mcp.json',
    line: 4,
    message:
      'MCP server "fetch" runs npm package mcp-fetch-server, which the policy does not allow.',
    baseline: 'new',
    fails: true,
  },
  {
    id: 'denied-tool:perm:.claude/settings.json#permissions.allow=Bash(curl:*)@fedcba9876543210',
    check: 'denied-tool',
    entry: 'curl',
    path: '.claude/settings.json',
    line: 3,
    agent: 'claude-code',
    message:
      'permissions.allow "Bash(curl:*)" lets Claude Code run curl without asking; the policy denies curl.',
    baseline: 'unchanged',
    fails: false,
  },
  {
    id: 'hook-missing:{"agent":"claude-code","event":"PreToolUse","matcher":"Bash","script":"scripts/hooks/guard.sh"}',
    check: 'hook-missing',
    entry: 'claude-code PreToolUse matcher "Bash" script scripts/hooks/guard.sh',
    agent: 'claude-code',
    message: HOOK_MESSAGE,
    baseline: 'new',
    fails: true,
  },
  {
    id: 'startup-budget:claude-code',
    check: 'startup-budget',
    entry: 'claude-code',
    agent: 'claude-code',
    message: 'Claude Code loads ≈9,840 tokens at session start in ./ (policy limit ≈8,000).',
    baseline: 'unchanged',
    fails: false,
  },
  {
    id: 'unanalyzed-config:.codex/config.toml',
    check: 'unanalyzed-config',
    entry: '.codex/config.toml',
    path: '.codex/config.toml',
    message:
      'agentcheckup does not parse TOML, so what it configures cannot be checked against the policy.',
    baseline: 'new',
    fails: true,
  },
];

const policy: PolicyReport = {
  name: 'acme agent policy',
  sha256: SHA256,
  mode: 'enforce',
  insideScanRoot: false,
  checks: 7,
  violations: VIOLATIONS,
  notes: [],
};

/** The rich report compared with a baseline, checked against the policy. */
const withPolicy: ScanResult = { ...withContext(richResult), policy };

/** Without a baseline: no violation is new or unchanged, and every one fails. */
const plainPolicy: ScanResult = {
  ...richResult,
  policy: {
    ...policy,
    violations: VIOLATIONS.map(({ baseline: _baseline, ...violation }) => ({
      ...violation,
      fails: true,
    })),
  },
};

const auditPolicy: ScanResult = {
  ...richResult,
  policy: {
    ...policy,
    mode: 'audit',
    insideScanRoot: true,
    violations: VIOLATIONS.map(({ baseline: _baseline, ...violation }) => ({
      ...violation,
      fails: false,
    })),
    notes: [
      { id: 'audit-mode', message: 'Audit mode: violations are reported but never fail the run.' },
      {
        id: 'policy-inside-scan-root',
        message:
          'The policy file is inside the scanned directory, so a change under review can edit it. In CI, read the policy from the base commit or a central repository.',
      },
    ],
  },
};

const cleanPolicy: ScanResult = {
  ...richResult,
  policy: {
    ...policy,
    violations: [],
    notes: [{ id: 'hooks-not-enforced', message: HOOKS_NOT_ENFORCED }],
  },
};

/** Hostile text in every untrusted policy field: the name, paths, messages, entries, ids. */
const hostilePolicy: ScanResult = {
  ...hostileResult,
  policy: {
    name: `pipes | and \`ticks\` ${HOSTILE.bidiOverride}\n## fake heading ${HOSTILE.osc52Clipboard}`,
    sha256: '`|<b>x</b>\n::error::sha',
    mode: 'enforce',
    insideScanRoot: false,
    checks: 7,
    violations: [
      {
        id: `mcp-not-allowed:mcp:${HOSTILE.stopCommands}`,
        check: 'mcp-not-allowed',
        entry: HOSTILE.tablePipes,
        path: `evil${HOSTILE.fakeError}/.mcp.json`,
        line: 2,
        message: `MCP server "${HOSTILE_ALL}" runs a package, which the policy does not allow.`,
        fails: true,
      },
      {
        id: 'hook-missing:x',
        check: 'hook-missing',
        entry: HOSTILE.html,
        message: `${HOSTILE.addMask} ${HOSTILE.links} ${HOOKS_NOT_ENFORCED}`,
        fails: true,
      },
      {
        id: 'x',
        // A check this version does not know is never written as trusted text.
        check: '`evil` | [x](javascript:alert(1))' as PolicyCheck,
        entry: 'x',
        path: `docs/${HOSTILE.bidiIsolates}.json`,
        message: `${HOSTILE.markdownSyntax} ${HOSTILE.mentions} ${HOSTILE.issueRefs}`,
        fails: false,
      },
    ],
    notes: [{ id: 'note', message: `${HOSTILE.carriageReturn} ${HOSTILE.percentEscapes}` }],
  },
};

const FIXTURES: readonly [string, ScanResult][] = [
  ['baseline', withPolicy],
  ['plain', plainPolicy],
  ['audit', auditPolicy],
  ['clean', cleanPolicy],
  ['hostile', hostilePolicy],
];

const lines = (output: string): string[] =>
  output === '' ? [] : output.replace(/\n$/, '').split('\n');

/** `|` cell separators, not counting escaped ones. */
function cellSeparators(row: string): number {
  let count = 0;
  for (let index = 0; index < row.length; index++) {
    if (row.charAt(index) === '\\') index++;
    else if (row.charAt(index) === '|') count++;
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

describe('Markdown', () => {
  it.each(FIXTURES)('%s: the policy section matches the snapshot', async (name, result) => {
    await expect(`${policySection(result).join('\n')}\n`).toMatchFileSnapshot(
      `__snapshots__/policy-markdown.${name}.txt`,
    );
  });

  it('places the section before the summary of changes since the baseline', () => {
    const output = formatMarkdown(withPolicy);
    const section = output.indexOf('### Policy: acme agent policy');
    expect(section).toBeGreaterThan(output.indexOf('| Errors |'));
    expect(section).toBeLessThan(output.indexOf('### Agent configuration changes'));
    expect(section).toBeLessThan(output.indexOf('### Findings'));
  });

  it('says how many violations fail, and how many are new', () => {
    const section = policySection(withPolicy).join('\n');
    expect(section).toContain(
      '**3 of 5 violations fail the run.** 3 new, 2 unchanged since the baseline.',
    );
    expect(section).toContain('Mode `enforce` · sha256 `e69b0fe7a008` · 7 checks');
    expect(policySection(plainPolicy).join('\n')).toContain('**5 violations fail the run.**\n');
    expect(policySection(auditPolicy).join('\n')).toContain(
      '**5 violations, none fails the run.**',
    );
    expect(policySection(cleanPolicy).join('\n')).toContain('**No violations.**');
  });

  it('says "Configured, not enforced" for a missing hook, even in a cut message, and for configured ones', () => {
    for (const result of [withPolicy, cleanPolicy]) {
      const section = policySection(result).join('\n');
      expect(section.split('Configured, not enforced').length - 1).toBe(1);
    }
    const long = `The policy requires a Claude Code PreToolUse hook with matcher "${'x'.repeat(400)}", and none is configured. ${HOOKS_NOT_ENFORCED}`;
    const result: ScanResult = {
      ...richResult,
      policy: { ...policy, violations: [{ ...VIOLATIONS[2]!, message: long }] },
    };
    const row = policySection(result).find((line) => line.includes('`hook-missing`')) ?? '';
    expect(row).toContain('x… Configured, not enforced\\: hooks fail open');
    const line = renderPolicy(result, { style: plainStyle, ascii: false }).find((text) =>
      text.endsWith('hook-missing'),
    );
    expect(line).toContain('Configured, not enforced: hooks fail open');
  });

  it('lists failing violations first, then the others', () => {
    const rows = policySection(withPolicy).filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Location') && !line.startsWith('| :'),
    );
    expect(rows.map((row) => row.split(' | ').at(-1))).toEqual([
      '**new**, fails |',
      '**new**, fails |',
      '**new**, fails |',
      'unchanged, reported |',
      'unchanged, reported |',
    ]);
  });

  it.each(FIXTURES)('%s: every row has four cells, and no raw HTML or links', (_, result) => {
    const output = formatMarkdown(result);
    const section = policySection(result);
    for (const row of section.filter((line) => line.startsWith('| '))) {
      expect(cellSeparators(row)).toBe(5);
    }
    expect(section.join('\n')).not.toContain('<');
    expect(output).not.toMatch(/@[\p{L}\p{N}]/u);
    expect(output).not.toMatch(/(?<!&)#\d/);
    expect(output).not.toMatch(/javascript:/i);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    // The heading is one line: a newline in the policy name cannot start a heading of its own.
    expect(section.filter((line) => line.startsWith('#'))).toHaveLength(1);
  });

  it('is absent without a policy', () => {
    expect(policySection(richResult)).toEqual([]);
    expect(formatMarkdown(richResult)).not.toContain('### Policy');
  });
});

// ---------------------------------------------------------------------------------------------
// Stylish
// ---------------------------------------------------------------------------------------------

describe('stylish', () => {
  it.each(FIXTURES)('%s: the policy block matches the snapshot', async (name, result) => {
    await expect(
      `${renderPolicy(result, { style: plainStyle, ascii: false }).join('\n')}\n`,
    ).toMatchFileSnapshot(`__snapshots__/policy-stylish.${name}.txt`);
  });

  it('styles the block and has an ASCII form', async () => {
    await expect(
      `${renderPolicy(withPolicy, { style: tagStyle, ascii: false }).join('\n')}\n`,
    ).toMatchFileSnapshot('__snapshots__/policy-stylish.styled.txt');
    const ascii = renderPolicy(withPolicy, { style: plainStyle, ascii: true }).join('\n');
    // ASCII decorations; messages keep their own text, such as ≈.
    expect(ascii).not.toMatch(/[·…—✔✖]/u);
    expect(ascii).toContain('x 3 of 5 violations fail the run - 3 new');
  });

  it('comes after the findings and before the summary', () => {
    const output = formatStylish(withPolicy, { style: plainStyle });
    const block = output.indexOf('Policy acme agent policy');
    expect(block).toBeGreaterThan(output.indexOf('CLAUDE.md'));
    expect(block).toBeLessThan(output.indexOf('Agent config score'));
  });

  it.each(FIXTURES)('%s: writes no escape sequence or invisible character', (_, result) => {
    const output = formatStylish(result, { style: plainStyle });
    expect(hasEscOrBel(output)).toBe(false);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    expect(commandLines(output)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

const COMMAND_LINE = /^::(?:error|warning|notice) [^\n\r:]*::[^\n\r]*$/;

describe('GitHub annotations', () => {
  it.each(FIXTURES)('%s: the annotations match the snapshot', async (name, result) => {
    await expect(`${policyAnnotations(result).join('\n')}\n`).toMatchFileSnapshot(
      `__snapshots__/policy-github.${name}.txt`,
    );
  });

  it('annotates violations that fail or that the baseline did not have, titled by check', () => {
    const parsed = policyAnnotations(withPolicy).map(parseWorkflowCommand);
    expect(parsed.map(({ command, properties }) => [command, properties])).toEqual([
      ['error', { file: '.mcp.json', line: '4', title: 'policy: mcp-not-allowed' }],
      ['error', { title: 'policy: hook-missing' }],
      ['error', { file: '.codex/config.toml', title: 'policy: unanalyzed-config' }],
    ]);
    expect(parsed[0]!.data).toBe(
      'MCP server "fetch" runs npm package mcp-fetch-server, which the policy does not allow.\n' +
        'Policy: "acme agent policy" (sha256 e69b0fe7a008)\n' +
        'Docs: https://github.com/mustafakbaser/agentcheckup/blob/main/docs/policy.md#mcp-not-allowed',
    );
    expect(parsed[1]!.data).toContain(`none is configured. ${HOOKS_NOT_ENFORCED}\nPolicy:`);
  });

  it('annotates every violation as a warning in audit mode', () => {
    const commands = policyAnnotations(auditPolicy).map(
      (line) => parseWorkflowCommand(line).command,
    );
    expect(commands).toEqual([...VIOLATIONS.map(() => 'warning'), 'notice', 'notice']);
  });

  it.each(FIXTURES)('%s: every line is one well-formed command', (_, result) => {
    for (const line of lines(formatGithub(result))) {
      expect(line).toMatch(COMMAND_LINE);
      expect(unsafeCodePoints(line, { tab: true })).toEqual([]);
    }
  });

  it('keeps hostile text inside its own annotation', () => {
    const parsed = policyAnnotations(hostilePolicy).map(parseWorkflowCommand);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]!.properties['file']).toBe('evilline one⏎::error::fake annotation/.mcp.json');
    expect(parsed[2]!.properties['title']).toBe('policy: `evil` | [x](javascript:alert(1))');
    for (const { data } of parsed) expect(data).not.toMatch(/^::/m);
  });
});

// ---------------------------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------------------------

const sarifSchema = JSON.parse(
  readFileSync(new URL('../schemas/sarif-2.1.0.json', import.meta.url), 'utf8'),
) as object;
const sarifAjv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validateSarif = sarifAjv.compile(sarifSchema);

const runOf = (result: ScanResult): SarifLog['runs'][0] =>
  (JSON.parse(formatSarif(result)) as SarifLog).runs[0];

describe('SARIF', () => {
  it.each(FIXTURES)('%s validates against the SARIF 2.1.0 schema', (_, result) => {
    const valid = validateSarif(JSON.parse(formatSarif(result)));
    expect(valid, sarifAjv.errorsText(validateSarif.errors)).toBe(true);
  });

  it.each(FIXTURES)('%s: the policy part matches the snapshot', async (name, result) => {
    await expect(`${JSON.stringify(policySarif(result, 0), null, 2)}\n`).toMatchFileSnapshot(
      `__snapshots__/policy-sarif.${name}.txt`,
    );
  });

  it('reports violations with a file as results of policy rules, after the findings', () => {
    const run = runOf(withPolicy);
    const policyResults = run.results.filter((result) => result.properties?.policy === true);
    expect(run.results.slice(0, richResult.findings.length).map((result) => result.ruleId)).toEqual(
      richResult.findings.map((finding) => finding.ruleId),
    );
    expect(
      policyResults.map((result) => [result.ruleId, result.level, result.baselineState]),
    ).toEqual([
      ['policy/mcp-not-allowed', 'error', 'new'],
      ['policy/denied-tool', 'warning', 'unchanged'],
      ['policy/unanalyzed-config', 'error', 'new'],
    ]);
    for (const result of policyResults) {
      expect(run.tool.driver.rules[result.ruleIndex]!.id).toBe(result.ruleId);
      expect(result.locations).toHaveLength(1);
      expect(Object.keys(result.partialFingerprints)).toEqual([POLICY_FINGERPRINT_KEY]);
    }
    expect(policyResults[0]!.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: '.mcp.json', uriBaseId: '%SRCROOT%' },
      region: { startLine: 4 },
    });
  });

  it('lists a rule descriptor for each check with violations', () => {
    const rules = runOf(withPolicy).tool.driver.rules.filter((rule) =>
      rule.id.startsWith('policy/'),
    );
    expect(rules.map((rule) => [rule.id, rule.name])).toEqual([
      ['policy/mcp-not-allowed', 'PolicyMcpNotAllowed'],
      ['policy/denied-tool', 'PolicyDeniedTool'],
      ['policy/hook-missing', 'PolicyHookMissing'],
      ['policy/startup-budget', 'PolicyStartupBudget'],
      ['policy/unanalyzed-config', 'PolicyUnanalyzedConfig'],
    ]);
    expect(rules[0]!.helpUri).toBe(
      'https://github.com/mustafakbaser/agentcheckup/blob/main/docs/policy.md#mcp-not-allowed',
    );
  });

  it('reports violations without a file as notifications, since code scanning needs a file', () => {
    const run = runOf(withPolicy);
    const notifications = run.invocations[0].toolExecutionNotifications ?? [];
    const policyNotes = notifications.filter((note) =>
      note.associatedRule?.id.startsWith('policy/'),
    );
    expect(policyNotes.map((note) => [note.associatedRule?.id, note.level])).toEqual([
      ['policy/hook-missing', 'error'],
      ['policy/startup-budget', 'warning'],
    ]);
    for (const note of policyNotes) {
      expect(run.tool.driver.rules[note.associatedRule!.index!]!.id).toBe(note.associatedRule!.id);
    }
    expect(run.results.every((result) => result.locations.length > 0)).toBe(true);
  });

  it('neutralizes hostile text and skips checks it does not know', () => {
    const output = formatSarif(hostilePolicy);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    const run = runOf(hostilePolicy);
    const results = run.results.filter((result) => result.properties?.policy === true);
    expect(results.map((result) => result.ruleId)).toEqual(['policy/mcp-not-allowed']);
    expect(results[0]!.message.text).not.toMatch(/(?<!\\)[[\]]/);
  });

  it('adds nothing without a policy', () => {
    expect(policySarif(richResult, 0)).toEqual({ rules: [], results: [], notifications: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

const reportSchema = JSON.parse(
  readFileSync(new URL('../../schemas/report.schema.json', import.meta.url), 'utf8'),
) as object;
const ajv2020 = new Ajv2020({ strict: true, allErrors: true });
const validateReport = ajv2020.compile(reportSchema);

describe('JSON', () => {
  it.each(FIXTURES.filter(([name]) => name !== 'hostile'))(
    '%s validates against schemas/report.schema.json and round-trips',
    (_, result) => {
      const value = JSON.parse(formatJson(result)) as unknown;
      expect(validateReport(value), ajv2020.errorsText(validateReport.errors)).toBe(true);
      expect(value).toEqual(result);
    },
  );

  it('matches the snapshot, with a fixed key order', async () => {
    await expect(`${JSON.stringify(toJsonPolicy(policy), null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/policy-json.txt',
    );
    const reordered = {
      ...policy,
      violations: policy.violations.map(
        (violation) =>
          Object.fromEntries(
            Object.entries({ ...violation, debug: true }).reverse(),
          ) as unknown as PolicyViolation,
      ),
    };
    expect(toJsonReport({ ...richResult, policy: reordered }).policy).toEqual(policy);
  });

  it('keeps hostile text losslessly, escaping what must not be shown raw', () => {
    const output = formatJson(hostilePolicy);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    expect((JSON.parse(output) as ScanResult).policy).toEqual(hostilePolicy.policy);
  });

  it('the schema rejects bad policy values', () => {
    type Json = Record<string, unknown>;
    const report = (): Json => JSON.parse(formatJson(withPolicy)) as Json;
    const violation = (value: Json): Json =>
      ((value['policy'] as Json)['violations'] as Json[])[0]!;
    const cases: ((value: Json) => void)[] = [
      (value) => ((value['policy'] as Json)['sha256'] = 'abc'),
      (value) => ((value['policy'] as Json)['mode'] = 'warn'),
      (value) => ((value['policy'] as Json)['extra'] = 1),
      (value) => delete (value['policy'] as Json)['notes'],
      (value) => (violation(value)['check'] = 'mcp'),
      (value) => (violation(value)['fails'] = 'yes'),
      (value) => (violation(value)['baseline'] = 'old'),
      (value) => (violation(value)['line'] = 0),
      (value) => (violation(value)['ruleId'] = 'policy/mcp-not-allowed'),
    ];
    expect(validateReport(report())).toBe(true);
    for (const mutate of cases) {
      const value = report();
      mutate(value);
      expect(validateReport(value), mutate.toString()).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Violations are not findings
// ---------------------------------------------------------------------------------------------

describe('violations and findings', () => {
  it('never become findings or change the score in any format', () => {
    const without = withContext(richResult);
    const parse = (result: ScanResult): ScanResult => JSON.parse(formatJson(result)) as ScanResult;
    expect(parse(withPolicy).findings).toEqual(parse(without).findings);
    expect(parse(withPolicy).score).toEqual(parse(without).score);
    expect(parse(withPolicy).summary).toEqual(parse(without).summary);
    expect(runOf(withPolicy).properties).toEqual(runOf(without).properties);
    const summary = (output: string): string => output.slice(output.lastIndexOf('problems'));
    expect(summary(formatStylish(withPolicy, { style: plainStyle }))).toBe(
      summary(formatStylish(without, { style: plainStyle })),
    );
  });
});
