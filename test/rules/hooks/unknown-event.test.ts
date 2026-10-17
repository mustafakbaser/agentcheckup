import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  CURSOR_EVENTS,
  GEMINI_EVENTS,
} from '../../../src/rules/hooks/events.js';
import { describeUnknownEvent, unknownEventRule } from '../../../src/rules/hooks/unknown-event.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'hooks/unknown-event';
const rules = [unknownEventRule];
const HOOK = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }];

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('hooks/unknown-event', () => {
  it('reports a wrong-case Claude Code event and names the right spelling', () => {
    const text = json({ hooks: { preToolUse: HOOK, PostToolUse: HOOK } });
    expect(run({ '.claude/settings.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.claude/settings.json',
        message:
          '"preToolUse" is not a Claude Code hook event; it is spelled "PreToolUse". Claude Code skips these hooks with a Settings Warning.',
        range: rangeOf(text, '"preToolUse"'),
      },
    ]);
  });

  it('names events that belong to another agent and suggests near misses', () => {
    const text = json({
      hooks: { BeforeTool: HOOK, beforeShellExecution: HOOK, PostToolUsed: HOOK, OnSave: HOOK },
    });
    expect(run({ '.claude/settings.local.json': text }).map((finding) => finding.message)).toEqual([
      '"BeforeTool" is a Gemini CLI hook event, not a Claude Code one. Claude Code skips these hooks with a Settings Warning.',
      '"beforeShellExecution" is a Cursor hook event, not a Claude Code one. Claude Code skips these hooks with a Settings Warning.',
      '"PostToolUsed" is not a Claude Code hook event (did you mean "PostToolUse"?). Claude Code skips these hooks with a Settings Warning.',
      '"OnSave" is not a Claude Code hook event. Claude Code skips these hooks with a Settings Warning.',
    ]);
  });

  it('checks Cursor, Codex and Gemini CLI files with their own event lists', () => {
    const cursor = json({
      version: 1,
      hooks: { PreToolUse: [{ command: 'x' }], beforeShellExecution: [{ command: 'y' }] },
    });
    expect(run({ '.cursor/hooks.json': cursor }).map((finding) => finding.message)).toEqual([
      '"PreToolUse" is not a Cursor hook event; it is spelled "preToolUse". Cursor never fires such an event, so these hooks never run.',
    ]);
    const codex = json({ hooks: { Notification: HOOK, Interrupt: HOOK } });
    expect(run({ '.codex/hooks.json': codex }).map((finding) => finding.message)).toEqual([
      '"Notification" is a Claude Code hook event, not a Codex one. Codex ignores them without a warning, so these hooks never run.',
    ]);
    const gemini = json({
      hooks: {
        enabled: true,
        disabled: ['x'],
        notifications: true,
        BeforeTool: HOOK,
        PreToolUse: HOOK,
      },
    });
    expect(run({ '.gemini/settings.json': gemini }).map((finding) => finding.message)).toEqual([
      '"PreToolUse" is a Claude Code hook event, not a Gemini CLI one. Gemini CLI skips these hooks with an "Invalid hook event name" warning.',
    ]);
  });

  it('reports a Codex event outside the "hooks" object', () => {
    const text = json({ description: 'team hooks', PreToolUse: HOOK, hooks: { Stop: HOOK } });
    expect(run({ '.codex/hooks.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.codex/hooks.json',
        message:
          'Event "PreToolUse" is outside the "hooks" object. Codex allows only "description" and "hooks" at the top level, so it skips the whole file and none of its hooks run.',
        range: rangeOf(text, '"PreToolUse"'),
      },
    ]);
  });

  it('accepts every documented event on each platform', () => {
    const map = (events: readonly string[]) =>
      Object.fromEntries(events.map((event) => [event, HOOK]));
    expect(
      run({
        '.claude/settings.json': json({ hooks: map(CLAUDE_EVENTS) }),
        '.codex/hooks.json': json({ hooks: map(CODEX_EVENTS) }),
        '.cursor/hooks.json': json({ version: 1, hooks: map(CURSOR_EVENTS) }),
        '.gemini/settings.json': json({ hooks: map(GEMINI_EVENTS) }),
      }),
    ).toEqual([]);
  });

  it('ignores files without a hooks object and untargeted platforms', () => {
    expect(
      run({
        '.claude/settings.json': json({ hooks: [] }),
        'a/.claude/settings.json': json({ model: 'x' }),
      }),
    ).toEqual([]);
    const text = json({ hooks: { preToolUse: HOOK } });
    expect(run({ '.claude/settings.json': text }, ['cursor'])).toEqual([]);
    expect(run({ '.claude/settings.json': '{"hooks": {' })).toEqual([]);
  });

  it("checks Devin Local's hook files, and reports another letter case as information", () => {
    const v1 = json({ BeforeCommit: HOOK, pretooluse: HOOK, Stop: HOOK });
    const config = json({ hooks: { pre_run_command: HOOK, SessionEnd: HOOK } });
    expect(
      run({
        '.devin/hooks.v1.json': v1,
        '.devin/config.local.json': config,
        // Cascade's file, whose snake_case events are not checked.
        '.devin/hooks.json': json({ hooks: { pre_read_code: HOOK } }),
      }).map((finding) => [finding.path, finding.severity, finding.message]),
    ).toEqual([
      [
        '.devin/config.local.json',
        'error',
        '"pre_run_command" is not a Devin Local hook event. Devin Local never fires such an event, so these hooks never run.',
      ],
      [
        '.devin/hooks.v1.json',
        'error',
        '"BeforeCommit" is not a Devin Local hook event. Devin Local never fires such an event, so these hooks never run.',
      ],
      [
        '.devin/hooks.v1.json',
        'info',
        '"pretooluse" is not a Devin Local hook event; it is spelled "PreToolUse". Devin Local documents event names in this spelling only and does not say whether it matches another, so these hooks may never run.',
      ],
    ]);
    expect(run({ '.devin/hooks.v1.json': v1 }, ['claude-code'])).toEqual([]);
  });

  it('does not compute suggestions for very long names', () => {
    expect(describeUnknownEvent('codex', 'x'.repeat(100))).toBe(
      `"${'x'.repeat(60)}…" is not a Codex hook event. Codex ignores them without a warning, so these hooks never run.`,
    );
  });
});

describe('hooks/unknown-event in Codex config.toml', () => {
  it('reports an unknown inline event, with guidance instead of a fix', () => {
    const text = [
      '[[hooks.preToolUse]]',
      '[[hooks.preToolUse.hooks]]',
      'type = "command"',
      'command = "true"',
      '',
    ].join('\n');
    const result = lint({ '.codex/config.toml': text }, { rules });
    expect(findings(result, ID)).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.codex/config.toml',
        message:
          '"preToolUse" is not a Codex hook event; it is spelled "PreToolUse". Codex ignores them without a warning, so these hooks never run.',
        range: rangeOf(text, 'preToolUse'),
      },
    ]);
    expect(result.findings[0]?.fix).toBeUndefined();
    expect(result.findings[0]?.guidance).toBe('rename the event to "PreToolUse"');
  });

  it('does not report hooks.state, known events or events outside the hooks table', () => {
    const text = [
      'PreToolUse = "a top-level key, not a hook"',
      '[[hooks.Stop]]',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "true"',
      '[hooks.state."stop:1"]',
      'enabled = true',
      '',
    ].join('\n');
    expect(run({ '.codex/config.toml': text })).toEqual([]);
  });
});
