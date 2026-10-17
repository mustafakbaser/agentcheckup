import { describe, expect, it } from 'vitest';
import type { Finding, Fix } from '../../../src/core/types.js';
import type { FixRun, PlannedFix } from '../../../src/fix/index.js';
import {
  compareFindings,
  consistencyViolations,
  decisionsOf,
  droppedFixViolations,
  type FindingKey,
  idempotencyViolations,
  percentile,
  type RepoReplay,
  renderReplay,
  replayRepo,
  ruleCrashViolations,
  tallyByRule,
} from '../../../scripts/corpus/fix-replay.js';
import { snapshotFrom } from '../../helpers/lint.js';

const key = (
  ruleId: string,
  path: string,
  fingerprint: string,
  severity: FindingKey['severity'] = 'warn',
): FindingKey => ({ ruleId, path, severity, fingerprint });

function fixOf(id: string, cls: Fix['class'] = 'safe', path = 'AGENTS.md'): Fix {
  return { id, class: cls, title: `Fix ${id}`, changes: [{ kind: 'edit', path, edits: [] }] };
}

function planned(
  ruleId: string,
  fix: Fix,
  findings: readonly string[],
  status: PlannedFix['status'] = 'planned',
  reason?: Extract<PlannedFix, { status: 'skipped' }>['reason'],
): PlannedFix {
  if (status === 'skipped') {
    return { fix, ruleId, findings, effects: [], status, reason: reason ?? 'conflict' };
  }
  return { fix, ruleId, findings, effects: [], status };
}

function finding(ruleId: string, path: string, fingerprint: string, fix?: Fix): Finding {
  return {
    ruleId,
    severity: 'warn',
    category: 'correctness',
    message: 'm',
    path,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    related: [],
    platforms: [],
    fingerprint,
    ...(fix === undefined ? {} : { fix }),
  };
}

function run(
  findings: readonly Finding[],
  parts: Partial<Pick<FixRun, 'applied' | 'skipped' | 'deferred'>>,
): Pick<FixRun, 'before' | 'applied' | 'skipped' | 'deferred'> {
  return {
    before: { findings } as unknown as FixRun['before'],
    applied: parts.applied ?? [],
    skipped: parts.skipped ?? [],
    deferred: parts.deferred ?? [],
  };
}

function replay(repo: string, parts: Partial<RepoReplay> = {}): RepoReplay {
  return {
    repo,
    ms: 10,
    rounds: 1,
    files: 1,
    decisions: [],
    violations: [],
    introducedInfos: [],
    ...parts,
  };
}

describe('compareFindings', () => {
  it('reports nothing when every claimed finding is gone and nothing is new', () => {
    const before = [key('a/x', 'A.md', 'f1'), key('a/x', 'A.md', 'f2'), key('b/y', 'B.md', 'f3')];
    const after = [key('a/x', 'A.md', 'g2'), key('b/y', 'B.md', 'g3')];
    const result = compareFindings('acme/app', before, after, new Map(), [
      { ruleId: 'a/x', findings: ['f1'] },
    ]);
    expect(result).toEqual({ violations: [], introducedInfos: [] });
  });

  it('maps paths through renames', () => {
    const before = [key('c/z', 'r/x.md', 'f1'), key('c/w', 'r/x.md', 'f2')];
    const after = [key('c/w', 'r/x.mdc', 'g2')];
    const renames = new Map([['r/x.md', 'r/x.mdc']]);
    const result = compareFindings('acme/app', before, after, renames, [
      { ruleId: 'c/z', findings: ['f1'] },
    ]);
    expect(result.violations).toEqual([]);
  });

  it('reports a claimed finding that is still there', () => {
    const before = [key('a/x', 'A.md', 'f1')];
    const after = [key('a/x', 'A.md', 'g1')];
    const result = compareFindings('acme/app', before, after, new Map(), [
      { ruleId: 'a/x', findings: ['f1', 'unknown'] },
    ]);
    expect(result.violations).toEqual([
      {
        repo: 'acme/app',
        kind: 'unresolved',
        ruleId: 'a/x',
        path: 'A.md',
        reason: '1 of 1 warn finding(s) of a/x the applied fixes carry are still there',
      },
    ]);
  });

  it('reports new errors and warnings, and lists new infos apart', () => {
    const before = [key('a/x', 'A.md', 'f1')];
    const after = [
      key('a/x', 'A.md', 'g1', 'error'),
      key('d/v', 'D.md', 'g2', 'info'),
      key('d/v', 'D.md', 'g3', 'info'),
    ];
    const result = compareFindings('acme/app', before, after, new Map(), []);
    expect(result.violations).toEqual([
      {
        repo: 'acme/app',
        kind: 'introduced',
        ruleId: 'a/x',
        path: 'A.md',
        reason: '1 new error(s)',
      },
    ]);
    expect(result.introducedInfos).toEqual([
      { ruleId: 'd/v', path: 'D.md', severity: 'info' },
      { ruleId: 'd/v', path: 'D.md', severity: 'info' },
    ]);
  });
});

describe('decisionsOf', () => {
  it('counts applied, skipped and deferred fixes, and finds demoted ones', () => {
    const safe = fixOf('r/a#x', 'safe');
    const findings = [
      finding('r/a', 'A.md', 'f1', safe),
      finding('r/b', 'B.md', 'f2', fixOf('r/b#y', 'review')),
    ];
    const decisions = decisionsOf(
      run(findings, {
        applied: [
          planned('r/a', { ...safe, class: 'review' }, ['f1']),
          planned('r/b', fixOf('r/b#y', 'review'), ['f2']),
        ],
        skipped: [planned('r/c', fixOf('r/c#z'), ['f3'], 'skipped', 'limit')],
        deferred: [planned('r/d', fixOf('r/d#w'), ['f4'], 'skipped', 'conflict')],
      }),
    );
    expect(decisions).toEqual([
      { ruleId: 'r/a', fixId: 'r/a#x', outcome: 'applied', demoted: true },
      { ruleId: 'r/b', fixId: 'r/b#y', outcome: 'applied', demoted: false },
      { ruleId: 'r/c', fixId: 'r/c#z', outcome: 'skipped', reason: 'limit', demoted: false },
      { ruleId: 'r/d', fixId: 'r/d#w', outcome: 'deferred', reason: 'conflict', demoted: false },
    ]);
  });
});

describe('violations of a run', () => {
  const findings = [finding('r/a', 'A.md', 'f1'), finding('r/b', 'B.md', 'f2')];

  it('reports fixes verification dropped and fixes the planner refused, not other skips', () => {
    const violations = droppedFixViolations(
      'acme/app',
      run(findings, {
        skipped: [
          planned('r/a', fixOf('r/a#x'), ['f1'], 'skipped', 'verification-failed'),
          planned('r/b', fixOf('r/b#y', 'review', 'B.md'), ['gone'], 'skipped', 'refused-path'),
          planned('r/c', fixOf('r/c#z'), ['f3'], 'skipped', 'limit'),
        ],
      }),
    );
    expect(violations).toEqual([
      {
        repo: 'acme/app',
        kind: 'verification-failed',
        ruleId: 'r/a',
        path: 'A.md',
        reason: 'r/a#x (safe): Fix r/a#x',
      },
      {
        repo: 'acme/app',
        kind: 'refused-path',
        ruleId: 'r/b',
        path: 'B.md',
        reason: 'r/b#y (review): Fix r/b#y',
      },
    ]);
  });

  it('reports every fix a second run plans, and nothing for an empty second run', () => {
    expect(idempotencyViolations('acme/app', run(findings, {}))).toEqual([]);
    const violations = idempotencyViolations(
      'acme/app',
      run(findings, {
        applied: [planned('r/a', fixOf('r/a#x'), ['f1'])],
        skipped: [planned('r/b', fixOf('r/b#y'), ['f2'], 'skipped', 'refused-path')],
      }),
    );
    expect(
      violations.map((violation) => [violation.kind, violation.path, violation.reason]),
    ).toEqual([
      ['not-idempotent', 'A.md', 'a second run plans r/a#x (safe): Fix r/a#x'],
      ['not-idempotent', 'B.md', 'a second run plans r/b#y (safe): Fix r/b#y [refused-path]'],
    ]);
  });

  it('reports mismatches and loader crashes on the fixed copy', () => {
    expect(consistencyViolations('acme/app', { report: { mismatches: [], allowed: {} } })).toEqual(
      [],
    );
    const violations = consistencyViolations('acme/app', {
      report: {
        mismatches: [
          {
            kind: 'skip-without-finding',
            ruleId: 'cursor/md-file-ignored',
            agent: 'cursor',
            path: '.cursor/rules/x.md',
            cwd: '',
            code: 'not-mdc',
          },
        ],
        allowed: {},
      },
      crash: 'boom',
    });
    expect(violations).toEqual([
      {
        repo: 'acme/app',
        kind: 'inconsistent',
        ruleId: 'cursor/md-file-ignored',
        path: '.cursor/rules/x.md',
        reason: 'skip-without-finding for cursor (not-mdc) in the plan at .',
      },
      {
        repo: 'acme/app',
        kind: 'inconsistent',
        ruleId: '',
        path: '',
        reason: 'a loader threw: boom',
      },
    ]);
  });

  it('reports only rules that crash after fixing but did not before', () => {
    expect(
      ruleCrashViolations(
        'acme/app',
        [{ ruleId: 'r/a' }],
        [
          { ruleId: 'r/a', message: 'old' },
          { ruleId: 'r/b', message: 'new' },
        ],
      ),
    ).toEqual([{ repo: 'acme/app', kind: 'rule-crash', ruleId: 'r/b', path: '', reason: 'new' }]);
  });
});

describe('summary', () => {
  const replays = [
    replay('acme/b', {
      ms: 30,
      decisions: [
        { ruleId: 'r/a', fixId: 'r/a#x', outcome: 'applied', demoted: true },
        {
          ruleId: 'r/b',
          fixId: 'r/b#y',
          outcome: 'skipped',
          reason: 'verification-failed',
          demoted: false,
        },
      ],
      violations: [
        { repo: 'acme/b', kind: 'verification-failed', ruleId: 'r/b', path: 'B.md', reason: 'why' },
      ],
      introducedInfos: [{ ruleId: 'r/i', path: 'I.md', severity: 'info' }],
    }),
    replay('acme/a', {
      ms: 10,
      decisions: [
        { ruleId: 'r/a', fixId: 'r/a#x', outcome: 'applied', demoted: false },
        { ruleId: 'r/a', fixId: 'r/a#x', outcome: 'deferred', reason: 'conflict', demoted: false },
        { ruleId: 'r/b', fixId: 'r/b#y', outcome: 'skipped', reason: 'limit', demoted: false },
      ],
    }),
  ];

  it('groups fixes by rule', () => {
    expect(tallyByRule(replays)).toEqual([
      {
        ruleId: 'r/a',
        planned: 3,
        applied: 2,
        skipped: {},
        deferred: 1,
        demoted: 1,
        verificationFailures: 0,
        violations: 0,
      },
      {
        ruleId: 'r/b',
        planned: 2,
        applied: 0,
        skipped: { 'verification-failed': 1, limit: 1 },
        deferred: 0,
        demoted: 0,
        verificationFailures: 1,
        violations: 1,
      },
    ]);
  });

  it('prints the table, reasons, infos, times and each violation', () => {
    const { text, violations } = renderReplay(replays);
    expect(violations).toBe(1);
    expect(text).toContain('5 fixes planned, 2 applied, 2 skipped, 1 deferred, 1 demoted');
    expect(text).toContain('1 verification failures');
    expect(text).toMatch(/^r\/a +3 +2 +0 +1 +1 +0$/m);
    expect(text).toContain('  r/b: verification-failed 1');
    expect(text).toContain('New infos in the fixed copies (allowed): r/i 1.');
    expect(text).toContain('Slowest: acme/b 30 ms, acme/a 10 ms.');
    expect(text).toContain('  verification-failed  acme/b  r/b  B.md  why');
  });

  it('prints no violation for a clean replay', () => {
    const { text, violations } = renderReplay([replay('acme/a')]);
    expect(violations).toBe(0);
    expect(text).toContain('Violations: none.');
    expect(text).toContain('No fixes planned.');
  });

  it('takes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
  });
});

describe('replayRepo', () => {
  it('applies the fixes of a small repository with no violation', () => {
    const snapshot = snapshotFrom(
      {
        'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
        'CLAUDE.md': '# Claude notes\n\nUse the staging database for manual tests.\n',
        '.cursor/rules/x.md': 'Prefer named exports in TypeScript files.\n',
        '.mcp.json':
          '{\n  "mcpServers": {\n    "docs": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}\n',
      },
      { paths: ['.git/'] },
    );
    const { replay: result, before } = replayRepo('acme/demo', snapshot);
    expect(result.violations).toEqual([]);
    expect(result.files).toBe(3);
    expect(result.decisions.map((decision) => [decision.fixId, decision.outcome]).sort()).toEqual([
      ['cursor/md-file-ignored#always-apply', 'applied'],
      ['instr/agents-md-ignored-by-claude#import', 'applied'],
      ['mcp/url-without-type#http', 'applied'],
    ]);
    expect(before?.findings.length).toBeGreaterThan(0);
  });

  it('changes nothing in a repository without fixable findings', () => {
    const snapshot = snapshotFrom(
      { 'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n' },
      { paths: ['.git/'] },
    );
    const { replay: result } = replayRepo('acme/clean', snapshot);
    expect(result).toMatchObject({ files: 0, decisions: [], violations: [], introducedInfos: [] });
  });
});
