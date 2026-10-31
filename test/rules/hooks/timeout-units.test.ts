import { describe, expect, it } from 'vitest';
import {
  describeTimeout,
  looksLikeMilliseconds,
  timeoutUnitsRule,
} from '../../../src/rules/hooks/timeout-units.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'hooks/timeout-units';
const rules = [timeoutUnitsRule];

function nested(timeout: unknown, event = 'PreToolUse') {
  return {
    hooks: { [event]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x', timeout }] }] },
  };
}

function gemini(timeout: unknown) {
  return nested(timeout, 'BeforeTool');
}

describe('hooks/timeout-units', () => {
  it('reports a millisecond-looking value in Claude Code settings', () => {
    const text = json(nested(5000));
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.claude/settings.json',
        message:
          'Hook timeout is 5,000 seconds (about 83 minutes), because Claude Code reads "timeout" in seconds. If you meant 5,000 milliseconds, write 5.',
        range: rangeOf(text, '5000'),
      },
    ]);
  });

  it('reports seconds in Gemini CLI settings', () => {
    const text = json(gemini(30));
    expect(findings(lint({ '.gemini/settings.json': text }, { rules }), ID)[0]?.message).toBe(
      'Hook timeout is 30 milliseconds (0.03 seconds), because Gemini CLI reads "timeout" in milliseconds. If you meant 30 seconds, write 30000.',
    );
    expect(
      findings(lint({ '.gemini/settings.json': json(gemini(0.5)) }, { rules }), ID)[0]?.message,
    ).toContain('Hook timeout is 0.5 milliseconds (0.0005 seconds),');
  });

  it("checks Devin Local's own hook files, which read seconds", () => {
    const own = json({
      PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: 'x', timeout: 5000 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'y', timeout: 30 }] }],
    });
    const result = lint(
      { '.devin/hooks.v1.json': own, '.devin/config.json': json(nested(10_000)) },
      { rules },
    );
    expect(findings(result, ID).map((f) => [f.path, f.message])).toEqual([
      [
        '.devin/config.json',
        'Hook timeout is 10,000 seconds (about 3 hours), because Devin Local reads "timeout" in seconds. If you meant 10,000 milliseconds, write 10.',
      ],
      [
        '.devin/hooks.v1.json',
        'Hook timeout is 5,000 seconds (about 83 minutes), because Devin Local reads "timeout" in seconds. If you meant 5,000 milliseconds, write 5.',
      ],
    ]);
    expect(result.findings.map((f) => f.fix?.id)).toEqual([
      'hooks/timeout-units#to-seconds',
      'hooks/timeout-units#to-seconds',
    ]);
    expect(
      findings(lint({ '.devin/hooks.v1.json': own }, { rules, targets: ['claude-code'] }), ID),
    ).toEqual([]);
  });

  it('checks Cursor and Codex files', () => {
    const cursor = json({
      version: 1,
      hooks: { beforeShellExecution: [{ command: 'x', timeout: 10000 }] },
    });
    expect(findings(lint({ '.cursor/hooks.json': cursor }, { rules }), ID)[0]?.message).toMatch(
      /^Hook timeout is 10,000 seconds \(about 3 hours\), because Cursor reads/,
    );
    expect(
      findings(lint({ '.codex/hooks.json': json(nested(600_000)) }, { rules }), ID)[0]?.message,
    ).toMatch(
      /\(about 7 days\), because Codex reads "timeout" in seconds\. If you meant 600,000 milliseconds, write 600\.$/,
    );
  });

  it('does not report plausible values', () => {
    const files: Record<string, string> = {};
    [30, 600, 1200, 1800, 3600, 999, 7200].forEach((value, i) => {
      files[`p${i}/.claude/settings.json`] = json(nested(value));
    });
    [1000, 5000, 60000, 0, -5, 'fast'].forEach((value, i) => {
      files[`g${i}/.gemini/settings.json`] = json(gemini(value));
    });
    expect(findings(lint(files, { rules }), ID)).toEqual([]);
  });

  it('classifies values and skips non-finite ones', () => {
    expect([1000, 1500, 30000, 86400, 1800, 3600, 999].map(looksLikeMilliseconds)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(describeTimeout('claude-code', Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(describeTimeout('codex', 1500)).toBe(
      'Hook timeout is 1,500 seconds (about 25 minutes), because Codex reads "timeout" in seconds. If you meant 1,500 milliseconds, write 2.',
    );
  });

  it('skips hooks under unknown events, which never run', () => {
    const text = json({
      hooks: { preToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: 5000 }] }] },
    });
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)).toEqual([]);
  });

  it('respects targets', () => {
    expect(
      findings(
        lint({ '.claude/settings.json': json(nested(5000)) }, { rules, targets: ['gemini'] }),
        ID,
      ),
    ).toEqual([]);
  });
});

describe('hooks/timeout-units in Codex config.toml', () => {
  const hook = (timeout: string) =>
    `[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "x"\ntimeout = ${timeout}\n`;

  it('reports a timeout that looks like milliseconds, without a fix', () => {
    const text = hook('5000');
    const result = lint({ '.codex/config.toml': text }, { rules });
    expect(findings(result, ID).map(({ severity, range }) => [severity, range])).toEqual([
      ['warn', rangeOf(text, '5000')],
    ]);
    expect(result.findings[0]?.fix).toBeUndefined();
  });

  it('does not report a timeout in seconds', () => {
    expect(findings(lint({ '.codex/config.toml': hook('30') }, { rules }), ID)).toEqual([]);
    expect(findings(lint({ '.codex/config.toml': hook('3_600') }, { rules }), ID)).toEqual([]);
  });
});
