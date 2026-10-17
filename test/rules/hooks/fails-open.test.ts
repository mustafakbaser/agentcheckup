import { describe, expect, it } from 'vitest';
import { failsOpenRule } from '../../../src/rules/hooks/fails-open.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'hooks/fails-open';
const rules = [failsOpenRule];

function nested(event: string, handlers: Record<string, unknown>[]) {
  return json({ hooks: { [event]: [{ matcher: 'Bash', hooks: handlers }] } });
}

describe('hooks/fails-open', () => {
  it('notes a Claude Code PreToolUse hook without onFailure', () => {
    const text = nested('PreToolUse', [{ type: 'command', command: '.claude/hooks/policy.sh' }]);
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'info',
        path: '.claude/settings.json',
        message:
          'If this PreToolUse hook crashes, cannot start or times out, Claude Code lets the tool call proceed. If the hook enforces a policy, set "onFailure": "block" (Claude Code v2.1.295 or later).',
        range: rangeOf(text, '".claude/hooks/policy.sh"'),
      },
    ]);
  });

  it('skips Claude Code hooks that block on failure, run async, or cannot fail closed', () => {
    const text = nested('PreToolUse', [
      { type: 'command', command: 'a', onFailure: 'block' },
      { type: 'command', command: 'b', async: true },
      { type: 'command', command: 'c', asyncRewake: true },
      { type: 'mcp_tool', server: 's', tool: 't' },
      { type: 'prompt', prompt: 'Is this safe?' },
    ]);
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)).toEqual([]);
    const post = nested('PostToolUse', [{ type: 'command', command: 'x' }]);
    expect(findings(lint({ '.claude/settings.json': post }, { rules }), ID)).toEqual([]);
  });

  it('points at the url of an HTTP hook', () => {
    const text = nested('PreToolUse', [{ type: 'http', url: 'https://policy.tools.dev/check' }]);
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)[0]?.range).toEqual(
      rangeOf(text, '"https://policy.tools.dev/check"'),
    );
  });

  it('covers Cursor, Codex and Gemini CLI', () => {
    const cursor = json({
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: 'a' },
          { command: 'b', failClosed: true },
          { type: 'prompt', prompt: 'p' },
        ],
        afterFileEdit: [{ command: 'c' }],
      },
    });
    expect(
      findings(lint({ '.cursor/hooks.json': cursor }, { rules }), ID).map(
        (finding) => finding.message,
      ),
    ).toEqual([
      'If this beforeShellExecution hook crashes, times out or exits with an error other than code 2, Cursor lets the tool call proceed. If the hook enforces a policy, set "failClosed": true.',
    ]);
    const codex = nested('PreToolUse', [{ type: 'command', command: 'x' }]);
    expect(findings(lint({ '.codex/hooks.json': codex }, { rules }), ID)[0]?.message).toBe(
      'If this PreToolUse hook fails or times out, Codex lets the tool call proceed and has no setting to block instead. If the hook enforces a policy, catch errors in the script and exit with code 2 and a reason on stderr.',
    );
    const gemini = nested('BeforeTool', [{ type: 'command', command: 'x' }]);
    expect(findings(lint({ '.gemini/settings.json': gemini }, { rules }), ID)[0]?.message).toBe(
      'If this BeforeTool hook exits with an error other than code 2, Gemini CLI shows a warning and runs the tool anyway. If the hook enforces a policy, catch errors in the script and exit with code 2.',
    );
    const after = nested('AfterTool', [{ type: 'command', command: 'x' }]);
    expect(findings(lint({ '.gemini/settings.json': after }, { rules }), ID)).toEqual([]);
  });

  it('respects targets', () => {
    const text = nested('PreToolUse', [{ type: 'command', command: 'x' }]);
    expect(
      findings(lint({ '.claude/settings.json': text }, { rules, targets: ['codex'] }), ID),
    ).toEqual([]);
  });
});

describe('hooks/fails-open in Codex config.toml', () => {
  it('notes a PreToolUse command hook declared inline', () => {
    const text = [
      '[[hooks.PreToolUse]]',
      'matcher = "Bash"',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = ".codex/hooks/policy.sh"',
      '',
    ].join('\n');
    const result = lint({ '.codex/config.toml': text }, { rules });
    expect(findings(result, ID)).toEqual([
      {
        ruleId: ID,
        severity: 'info',
        path: '.codex/config.toml',
        message:
          'If this PreToolUse hook fails or times out, Codex lets the tool call proceed and has no setting to block instead. If the hook enforces a policy, catch errors in the script and exit with code 2 and a reason on stderr.',
        range: rangeOf(text, '".codex/hooks/policy.sh"'),
      },
    ]);
    expect(result.findings[0]?.fix).toBeUndefined();
  });

  it('does not note hooks of events that cannot block a tool call', () => {
    const text = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "x"\n';
    expect(findings(lint({ '.codex/config.toml': text }, { rules }), ID)).toEqual([]);
  });
});
