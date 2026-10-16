import { describe, expect, it } from 'vitest';
import { failsOpenRule } from '../../../src/rules/hooks/fails-open.js';
import { scriptMissingRule } from '../../../src/rules/hooks/script-missing.js';
import { convertedTimeout, timeoutUnitsRule } from '../../../src/rules/hooks/timeout-units.js';
import { unknownEventRule } from '../../../src/rules/hooks/unknown-event.js';
import {
  applied,
  checkGolden,
  findingsOf,
  fixesOf,
  goldenCases,
  runFixes,
  selectionFor,
} from '../json/golden-fixes.js';
import { json } from '../json/helpers.js';

const SHARED = { symlinks: { '.claude/settings.local.json': '.claude/settings.json' } };

function nested(event: string, handlers: Record<string, unknown>[]): string {
  return json({ hooks: { [event]: [{ matcher: 'Bash', hooks: handlers }] } });
}

describe('hooks/timeout-units fixes', () => {
  const ID = 'hooks/timeout-units';
  const rules = [timeoutUnitsRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('converts to whole seconds rounded up, or to whole milliseconds', () => {
    expect(convertedTimeout('claude-code', 5000)).toBe(5);
    expect(convertedTimeout('codex', 1500)).toBe(2);
    expect(convertedTimeout('cursor', 86_400)).toBe(87);
    expect(convertedTimeout('gemini', 30)).toBe(30_000);
    expect(convertedTimeout('gemini', 1.1)).toBe(1100);
  });

  it('changes only the number token', () => {
    const text = nested('PreToolUse', [{ type: 'command', command: 'x', timeout: 5e3 }]).replace(
      '5000',
      '5e3',
    );
    const [fix] = fixesOf({ '.claude/settings.json': text }, rules, ID);
    expect(applied({ '.claude/settings.json': text }, fix, '.claude/settings.json')).toBe(
      text.replace('5e3', '5'),
    );
  });

  it('does not offer a timeout that would round to zero', () => {
    const text = json({
      hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'x', timeout: 0.0001 }] }] },
    });
    const found = findingsOf({ '.gemini/settings.json': text }, rules, ID);
    expect(found).toHaveLength(1);
    expect(found[0]?.fix).toBeUndefined();
  });

  it('does not fix a file that other paths link to', () => {
    const text = nested('PreToolUse', [{ type: 'command', command: 'x', timeout: 5000 }]);
    const [finding] = findingsOf(
      { '.claude/settings.json': text, '.claude/settings.local.json': text },
      rules,
      ID,
      SHARED,
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toContain('other paths link to this file');
  });
});

describe('hooks/fails-open fixes', () => {
  const ID = 'hooks/fails-open';
  const rules = [failsOpenRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('replaces an onFailure value other than "block" on an HTTP hook', () => {
    const text =
      '{"hooks": {"PreToolUse": [{"hooks": [{"type": "http", "url": "https://p.dev", "onFailure": "continue"}]}]}}';
    const [fix] = fixesOf({ '.claude/settings.json': text }, rules, ID);
    expect(applied({ '.claude/settings.json': text }, fix, '.claude/settings.json')).toBe(
      text.replace('"continue"', '"block"'),
    );
  });

  it('leaves Codex and Gemini CLI hooks to the user: they have no such setting', () => {
    const codex = nested('PreToolUse', [{ type: 'command', command: 'x' }]);
    const [finding] = findingsOf({ '.codex/hooks.json': codex }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    const gemini = json({
      hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    expect(fixesOf({ '.gemini/settings.json': gemini }, rules, ID)).toEqual([undefined]);
  });

  it('is a review fix that changes the hook, so fix rounds report a gate effect', () => {
    const files = {
      '.claude/settings.json': nested('PreToolUse', [{ type: 'command', command: 'npm test' }]),
    };
    expect(runFixes(files, selectionFor(ID, { classes: ['safe'] })).applied).toEqual([]);
    const run = runFixes(files, selectionFor(ID));
    expect(run.applied[0]?.fix.class).toBe('review');
    expect(run.applied[0]?.effects).toContainEqual(
      expect.objectContaining({ kind: 'gate', class: 'hooks', change: 'changed' }),
    );
  });
});

describe('hooks/unknown-event fixes', () => {
  const ID = 'hooks/unknown-event';
  const rules = [unknownEventRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('renames only to an event the message names, and never onto an existing one', () => {
    const owner = json({ hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    expect(fixesOf({ '.claude/settings.json': owner }, rules, ID)).toEqual([undefined]);
    const far = json({ hooks: { OnSave: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    expect(fixesOf({ '.claude/settings.json': far }, rules, ID)).toEqual([undefined]);
    const taken = json({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'a' }] }],
        stop: [{ hooks: [{ type: 'command', command: 'b' }] }],
      },
    });
    const [finding] = findingsOf({ '.claude/settings.json': taken }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe('move these hooks into the existing "Stop" entry');
  });

  it('leaves a Codex event outside "hooks" to the user, with a manual step', () => {
    const text = json({ PreToolUse: [], hooks: {} });
    const [finding] = findingsOf({ '.codex/hooks.json': text }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe(
      'move "PreToolUse" and its hooks into the top-level "hooks" object',
    );
  });

  it('activates the hooks, so the fix is never safe', () => {
    const files = {
      '.claude/settings.json': json({
        hooks: { stop: [{ hooks: [{ type: 'command', command: 'npm test' }] }] },
      }),
    };
    expect(runFixes(files, selectionFor(ID, { classes: ['safe'] })).applied).toEqual([]);
    const run = runFixes(files, selectionFor(ID));
    expect(run.applied[0]?.effects).toContainEqual(
      expect.objectContaining({ kind: 'gate', class: 'hooks', change: 'added' }),
    );
  });
});

describe('hooks/script-missing guidance', () => {
  it('names the missing script in a manual step', () => {
    const text = nested('PreToolUse', [
      { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh' },
    ]);
    const [finding] = findingsOf(
      { '.claude/settings.json': text },
      [scriptMissingRule],
      'hooks/script-missing',
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe(
      'create ".claude/hooks/check.sh", correct the path in the hook command, or remove the hook',
    );
    // A script that exists is not reported.
    expect(
      findingsOf(
        { '.claude/settings.json': text, '.claude/hooks/check.sh': '#!/bin/sh\n' },
        [scriptMissingRule],
        'hooks/script-missing',
      ),
    ).toEqual([]);
  });
});
