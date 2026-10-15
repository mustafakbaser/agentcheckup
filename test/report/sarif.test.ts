import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { ruleDocsUrl } from '../../src/core/meta.js';
import type { Finding } from '../../src/core/types.js';
import {
  FINGERPRINT_KEY,
  formatSarif,
  MAX_RESULTS,
  pathToUri,
  ruleName,
  type SarifLog,
  toSarif,
} from '../../src/report/sarif.js';
import {
  at,
  cleanResult,
  emptyResult,
  finding,
  makeResult,
  richResult,
  RULES,
} from './fixtures.js';
import { NEW_FINGERPRINTS, withContext, withHostileContext } from '../helpers/context.js';
import { hostileResult } from './hostile.js';
import { unsafeCodePoints } from './safety.js';

const sarifSchema = JSON.parse(
  readFileSync(new URL('../schemas/sarif-2.1.0.json', import.meta.url), 'utf8'),
) as object;
// The vendored schema is draft-07 and uses `format`; formats are not what is under test here.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(sarifSchema);

const FIXTURES: readonly [string, ScanResult][] = [
  ['clean', cleanResult],
  ['empty', emptyResult],
  ['rich', richResult],
  ['hostile', hostileResult],
  ['baseline', withContext(richResult)],
  ['hostile-baseline', withHostileContext(hostileResult)],
];

describe('formatSarif with a baseline', () => {
  it('sets baselineState from each finding', () => {
    const results = toSarif(withContext(richResult)).runs[0].results;
    expect(results.map((result) => result.baselineState)).toEqual(
      richResult.findings.map((item) =>
        NEW_FINGERPRINTS.has(item.fingerprint) ? 'new' : 'unchanged',
      ),
    );
    expect(results.filter((result) => result.baselineState === 'new')).toHaveLength(2);
  });

  it('leaves it out without a baseline', () => {
    expect(formatSarif(richResult)).not.toContain('baselineState');
  });

  it('marks new findings of rules newer than the baseline with a newRule property', () => {
    const result = withContext(richResult);
    const newer: ScanResult = {
      ...result,
      baseline: {
        ...result.baseline!,
        against: {
          version: '0.1.0',
          ruleset: '2026.09',
          sameRuleset: false,
          newRules: ['instructions/broken-import', 'risk/no-findings'],
        },
      },
    };
    const results = toSarif(newer).runs[0].results;
    expect(
      results.filter((item) => item.properties?.newRule === true).map((item) => item.ruleId),
    ).toEqual(['instructions/broken-import']);
    expect(validate(JSON.parse(formatSarif(newer)))).toBe(true);
    expect(formatSarif(result)).not.toContain('newRule');
  });
});

function parse(result: ScanResult): SarifLog {
  return JSON.parse(formatSarif(result)) as SarifLog;
}

function run(result: ScanResult) {
  return parse(result).runs[0];
}

describe('formatSarif', () => {
  it.each(FIXTURES)('%s validates against the SARIF 2.1.0 schema', (_, result) => {
    const valid = validate(parse(result));
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('matches the snapshot', async () => {
    await expect(formatSarif(richResult)).toMatchFileSnapshot('__snapshots__/sarif.rich.txt');
  });

  it('is deterministic and equals the object form', () => {
    expect(formatSarif(richResult)).toBe(formatSarif(richResult));
    expect(parse(richResult)).toEqual(JSON.parse(JSON.stringify(toSarif(richResult))));
    expect(formatSarif(richResult)).not.toContain('TimeUtc');
  });

  it('describes the tool and the run for GitHub', () => {
    const log = parse(richResult);
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(log.runs).toHaveLength(1);
    const { driver } = log.runs[0].tool;
    expect(driver).toMatchObject({
      name: 'agentcheckup',
      version: '1.4.0',
      semanticVersion: '1.4.0',
      informationUri: 'https://github.com/mustafakbaser/agentcheckup',
    });
    expect(log.runs[0].automationDetails).toEqual({ id: 'agentcheckup/' });
    expect(log.runs[0].columnKind).toBe('utf16CodeUnits');
    expect(log.runs[0].properties).toEqual({
      score: 49,
      grade: 'F',
      capped: true,
      ruleset: '2026.10',
      scoreFormula: 1,
    });
    expect(run(emptyResult).properties).toMatchObject({ score: null, grade: null });
  });

  it('omits semanticVersion when the version is not SemVer', () => {
    const driver = run({ ...cleanResult, tool: { name: 'agentcheckup', version: 'dev build' } })
      .tool.driver;
    expect(driver.version).toBe('dev build');
    expect(driver).not.toHaveProperty('semanticVersion');
  });
});

describe('rules', () => {
  const rules = run(richResult).tool.driver.rules;
  const byId = (id: string) => rules.find((rule) => rule.id === id)!;

  it('lists every rule that ran, in order, with a PascalCase name', () => {
    expect(rules.map((rule) => rule.id)).toEqual(richResult.rules.map((rule) => rule.id));
    expect(byId('instructions/broken-import').name).toBe('InstructionsBrokenImport');
    expect(ruleName('a.b/c-d_e')).toBe('ABCDE');
    expect(ruleName('---')).toBe('Rule');
  });

  it('fills descriptions, help and levels', () => {
    const rule = byId('instructions/broken-import');
    expect(rule.shortDescription.text).toBe('Imported file does not exist');
    expect(rule.fullDescription.text).toBe(
      'Claude Code silently skips @path imports that do not resolve, so the instructions in them never load. See memory imports (https://docs.anthropic.com/en/docs/claude-code/memory#imports).',
    );
    expect(rule.helpUri).toBe(ruleDocsUrl('instructions/broken-import'));
    expect(rule.help.text).toContain(`Documentation: ${ruleDocsUrl('instructions/broken-import')}`);
    expect(rule.help.markdown).toContain('`@path` imports');
    expect(rule.help.markdown).toContain(
      '- [Claude Code memory documentation](https://docs.anthropic.com/en/docs/claude-code/memory) (checked 2026-10-01)',
    );
    expect(rule.defaultConfiguration.level).toBe('error');
    expect(byId('budget/file-too-large').defaultConfiguration.level).toBe('warning');
    expect(byId('clarity/missing-overview').defaultConfiguration.level).toBe('note');
  });

  it('tags rules with category and platforms; risk rules are security rules with a severity', () => {
    expect(byId('instructions/broken-import').properties).toEqual({
      tags: ['correctness', 'claude-code'],
    });
    expect(byId('risk/hidden-unicode').properties).toEqual({
      tags: [
        'risk',
        'security',
        'claude-code',
        'codex',
        'cursor',
        'copilot',
        'gemini',
        'windsurf',
        'cline',
      ],
      'security-severity': '8.0',
    });
    expect(byId('risk/remote-script').properties['security-severity']).toBe('5.0');
    const infoRisk = run(makeResult({ rules: [{ ...RULES.remoteScript, severity: 'info' }] })).tool
      .driver.rules[0]!;
    expect(infoRisk.properties).not.toHaveProperty('security-severity');
  });

  it('keeps GitHub limits: 20 tags, 1,024-character descriptions, no empty strings', () => {
    const huge = {
      ...RULES.brokenImport,
      title: 't'.repeat(2000),
      rationale: '   ',
    };
    const rule = run(makeResult({ rules: [huge] })).tool.driver.rules[0]!;
    expect(rule.shortDescription.text).toHaveLength(1025);
    expect(rule.fullDescription.text.length).toBeLessThanOrEqual(1025);
    expect(rule.fullDescription.text.trim()).not.toBe('');
  });

  it('adds a placeholder for a finding whose rule metadata is missing', () => {
    const result = makeResult({
      rules: [RULES.brokenImport],
      findings: [finding(RULES.fileTooLarge, 'CLAUDE.md', 'Too big')],
    });
    const sarif = run(result);
    expect(sarif.tool.driver.rules.map((rule) => rule.id)).toEqual([
      'instructions/broken-import',
      'budget/file-too-large',
    ]);
    expect(sarif.results[0]!.ruleIndex).toBe(1);
    expect(validate(parse(result))).toBe(true);
  });
});

describe('results', () => {
  const sarif = run(richResult);

  it('has one result per finding, pointing at its rule', () => {
    expect(sarif.results).toHaveLength(richResult.findings.length);
    for (const result of sarif.results) {
      expect(sarif.tool.driver.rules[result.ruleIndex]!.id).toBe(result.ruleId);
    }
    expect(sarif.results.map((result) => result.level)).toEqual([
      'warning',
      'note',
      'error',
      'warning',
      'warning',
      'error',
      'note',
      'warning',
    ]);
  });

  it('locates results with relative URIs and full regions', () => {
    const broken = sarif.results[5]!;
    expect(broken.locations).toEqual([
      {
        physicalLocation: {
          artifactLocation: { uri: 'CLAUDE.md', uriBaseId: '%SRCROOT%' },
          region: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 22 },
        },
      },
    ]);
    expect(broken.partialFingerprints).toEqual({ [FINGERPRINT_KEY]: '6f708192a3b4c5:1' });
    expect(broken.relatedLocations).toEqual([
      {
        id: 1,
        physicalLocation: { artifactLocation: { uri: 'docs/', uriBaseId: '%SRCROOT%' } },
        message: { text: 'Closest existing directory' },
      },
    ]);
    expect(sarif.results[6]!.relatedLocations).toHaveLength(4);
    expect(sarif.results[6]!.relatedLocations![1]).toMatchObject({
      id: 2,
      physicalLocation: { region: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 12 } },
    });
  });

  it('marks suppressed findings: inline directives in source, configuration externally', () => {
    expect(sarif.results[3]!.suppressions).toEqual([
      { kind: 'inSource', justification: 'Documented install step, reviewed 2026-10' },
    ]);
    expect(sarif.results[7]!.suppressions).toEqual([
      { kind: 'external', justification: 'Generated file' },
    ]);
    expect(sarif.results[0]).not.toHaveProperty('suppressions');
  });

  it('clamps invalid ranges and falls back for empty messages', () => {
    const result = makeResult({
      rules: [RULES.fileTooLarge],
      findings: [
        finding(RULES.fileTooLarge, 'a.md', '  ', {
          range: { start: { line: 5, column: 10 }, end: { line: 3, column: 2 } },
          related: [{ path: 'b.md', message: '' }],
        }),
      ],
    });
    const [only] = run(result).results;
    expect(only!.locations[0]!.physicalLocation.region).toEqual({
      startLine: 5,
      startColumn: 10,
      endLine: 5,
      endColumn: 10,
    });
    expect(only!.message.text).toBe('budget/file-too-large');
    expect(only!.relatedLocations![0]!.message!.text).toBe('Related location');
    expect(validate(parse(result))).toBe(true);
  });

  it('caps related locations at 100', () => {
    const related = Array.from({ length: 150 }, (_, index) => ({
      path: `r${index}.md`,
      message: 'here',
    }));
    const result = makeResult({
      findings: [finding(RULES.fileTooLarge, 'a.md', 'x', { related })],
    });
    expect(run(result).results[0]!.relatedLocations).toHaveLength(100);
  });

  it(`caps results at ${MAX_RESULTS}, keeping the most severe, in order`, () => {
    const warnings: Finding[] = Array.from({ length: MAX_RESULTS + 3 }, (_, index) =>
      finding(RULES.fileTooLarge, 'a.md', `w${index}`, { range: at(index + 1, 1) }),
    );
    const errors = [1, 2, 3, 4, 5].map((index) =>
      finding(RULES.brokenImport, 'z.md', `e${index}`, { range: at(index, 1) }),
    );
    const sarif = run(makeResult({ findings: [...warnings, ...errors] }));
    expect(sarif.results).toHaveLength(MAX_RESULTS);
    expect(sarif.results.filter((result) => result.level === 'error')).toHaveLength(5);
    expect(sarif.results.at(-1)!.message.text).toBe('e5');
    expect(sarif.results.at(-6)!.message.text).toBe(`w${MAX_RESULTS - 6}`);
    expect(sarif.invocations[0].toolExecutionNotifications).toEqual([
      {
        level: 'warning',
        message: { text: `8 results omitted: GitHub accepts at most ${MAX_RESULTS} per run.` },
      },
    ]);
  });
});

describe('invocations', () => {
  it('reports success and no notifications for a clean run', () => {
    expect(run(cleanResult).invocations).toEqual([{ executionSuccessful: true }]);
  });

  it('reports rule failures, skipped files, symlinks and configuration warnings', () => {
    const [invocation] = run(richResult).invocations;
    expect(invocation.executionSuccessful).toBe(false);
    const notifications = invocation.toolExecutionNotifications!;
    expect(notifications[0]).toEqual({
      level: 'error',
      message: {
        text: "Rule mcp/unknown-server-field failed: Cannot read properties of undefined (reading 'type')",
      },
      associatedRule: { id: 'mcp/unknown-server-field' },
    });
    expect(notifications[1]!.message.text).toBe(
      '4 files not checked (too large: 1, binary: 1, file limit reached: 2).',
    );
    expect(notifications[1]!.locations).toHaveLength(4);
    expect(notifications[2]!.message.text).toBe(
      '2 symlinks not followed (points outside the scan root: 1, broken: 1).',
    );
    expect(invocation.toolConfigurationNotifications).toEqual([
      {
        level: 'warning',
        message: { text: 'Unknown rule "instructions/typo-rule" in configuration.' },
      },
    ]);
  });

  it('links a failure to its rule when the rule is listed', () => {
    const result = makeResult({
      rules: [RULES.brokenImport],
      ruleFailures: [{ ruleId: 'instructions/broken-import', message: 'boom' }],
    });
    expect(run(result).invocations[0].toolExecutionNotifications![0]!.associatedRule).toEqual({
      id: 'instructions/broken-import',
      index: 0,
    });
  });
});

describe('pathToUri', () => {
  it('percent-encodes each segment and keeps slashes', () => {
    expect(pathToUri('.cursor/rules/style.mdc')).toBe('.cursor/rules/style.mdc');
    expect(pathToUri('docs/my file#1?.md')).toBe('docs/my%20file%231%3F.md');
    expect(pathToUri('c:/100%/ünï.md')).toBe('c%3A/100%25/%C3%BCn%C3%AF.md');
    expect(pathToUri('a\u001b[2J/\uD800.md')).toBe('a%1B%5B2J/%EF%BF%BD.md');
  });
});

describe('hostile input', () => {
  const output = formatSarif(hostileResult);
  const sarif = (JSON.parse(output) as SarifLog).runs[0];

  it('contains no raw control or invisible characters', () => {
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
  });

  it('neutralizes message text and encodes URIs', () => {
    const texts = sarif.results.map((result) => result.message.text);
    for (const text of texts) {
      expect(unsafeCodePoints(text, { tab: true })).toEqual([]);
      expect(text).not.toMatch(/(?<!\\)[[\]]/);
    }
    expect(texts[0]).toBe(
      'invoice<U+202E>txt.exe and <U+202A>embed<U+202C> <U+200E><U+200F><U+061C>',
    );
    expect(sarif.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
      'docs/AGENTS%E2%80%AEdm.md',
    );
    expect(sarif.results[4]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
      'notes%0A%3A%3Astop-commands%3A%3Ax/AGENTS.md',
    );
  });
});
