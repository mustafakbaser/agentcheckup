import { describe, expect, it } from 'vitest';
import { firstWords, ROOT, scriptWord } from '../../../src/rules/hooks/command.js';
import { scriptMissingRule } from '../../../src/rules/hooks/script-missing.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'hooks/script-missing';
const rules = [scriptMissingRule];

function claude(handler: Record<string, unknown>, event = 'PreToolUse') {
  return json({
    hooks: { [event]: [{ matcher: 'Bash', hooks: [{ type: 'command', ...handler }] }] },
  });
}

function run(files: Record<string, string>, options: Partial<LintOptions> = {}) {
  return findings(lint(files, { rules, ...options }), ID);
}

const CLAUDE_CONSEQUENCE =
  'The hook fails on every run; Claude Code reports a hook error and continues without it.';

describe('hooks/script-missing', () => {
  it('reports a missing script under $CLAUDE_PROJECT_DIR', () => {
    const text = claude({ command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh' });
    expect(run({ '.claude/settings.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.claude/settings.json',
        message: `Hook runs ".claude/hooks/check.sh", which does not exist. ${CLAUDE_CONSEQUENCE}`,
        range: rangeOf(text, '"\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/check.sh"'),
      },
    ]);
  });

  it('does not report a script that exists, or one in an unlisted directory', () => {
    const text = claude({ command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/check.sh --strict' });
    expect(run({ '.claude/settings.json': text }, { paths: ['.claude/hooks/check.sh'] })).toEqual(
      [],
    );
    const vendored = claude({ command: 'node node_modules/lint-hook/cli.js' });
    expect(
      run({ '.claude/settings.json': vendored }, { opaqueDirectories: ['node_modules/'] }),
    ).toEqual([]);
  });

  it('resolves interpreter arguments and nested projects', () => {
    const files = {
      'pkg/.claude/settings.json': claude({
        command: 'python3 "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.py"',
      }),
      '.claude/settings.json': claude({ command: 'node .claude/hooks/format.mjs' }, 'PostToolUse'),
    };
    expect(run(files).map((finding) => [finding.path, finding.message.split(',')[0]])).toEqual([
      ['.claude/settings.json', 'Hook runs ".claude/hooks/format.mjs"'],
      ['pkg/.claude/settings.json', 'Hook runs "pkg/.claude/hooks/guard.py"'],
    ]);
  });

  it('does not report a relative Claude Code script that exists in a subdirectory', () => {
    const text = claude({ command: 'bash scripts/check.sh' });
    expect(run({ '.claude/settings.json': text }, { paths: ['app/scripts/check.sh'] })).toEqual([]);
    expect(run({ '.claude/settings.json': text })).toHaveLength(1);
  });

  it('handles Claude Code exec form', () => {
    const direct = claude({ command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh', args: [] });
    expect(run({ '.claude/settings.json': direct })[0]?.range).toEqual(
      rangeOf(direct, '"${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh"'),
    );
    const viaNode = claude({
      command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/x.js', '--fast'],
    });
    expect(run({ '.claude/settings.json': viaNode })[0]?.range).toEqual(
      rangeOf(viaNode, '"${CLAUDE_PROJECT_DIR}/.claude/hooks/x.js"'),
    );
    const options = claude({ command: 'node', args: ['--import', 'tsx', 'x.ts'] });
    const plain = claude({ command: 'prettier', args: ['--write'] });
    const unknownVariable = claude({ command: 'node', args: ['${HOME}/x.js'] });
    expect(
      run({
        'a/.claude/settings.json': options,
        'b/.claude/settings.json': plain,
        'c/.claude/settings.json': unknownVariable,
      }),
    ).toEqual([]);
  });

  it('says when onFailure blocks the action', () => {
    const text = claude({
      command: '$CLAUDE_PROJECT_DIR/.claude/hooks/policy.sh',
      onFailure: 'block',
    });
    expect(run({ '.claude/settings.json': text })[0]?.message).toBe(
      'Hook runs ".claude/hooks/policy.sh", which does not exist. The hook fails on every run, and because of "onFailure": "block", Claude Code blocks the action every time.',
    );
  });

  it('claims blocking only where onFailure applies', () => {
    const message = (event: string, extra: Record<string, unknown> = {}) =>
      run({
        '.claude/settings.json': claude(
          { command: '$CLAUDE_PROJECT_DIR/.claude/hooks/policy.sh', onFailure: 'block', ...extra },
          event,
        ),
      })[0]?.message.split('. The hook fails on every run')[1];
    const blocks =
      ', and because of "onFailure": "block", Claude Code blocks the action every time.';
    const continues = '; Claude Code reports a hook error and continues without it.';
    expect(message('UserPromptSubmit')).toBe(blocks);
    expect(message('PermissionRequest')).toBe(
      ', and because of "onFailure": "block", Claude Code denies the permission request every time.',
    );
    // onFailure has no effect on these events or on background hooks; PostToolUse cannot block.
    for (const event of ['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle', 'PostToolUse']) {
      expect(message(event)).toBe(continues);
    }
    expect(message('PreToolUse', { async: true })).toBe(continues);
    expect(message('PreToolUse', { asyncRewake: true })).toBe(continues);
  });

  it('does not report commands it cannot resolve with certainty', () => {
    const commands = [
      'jq -r .tool_input.command',
      'npx prettier --write "$CLAUDE_FILE_PATHS"',
      '$HOME/bin/hook.sh',
      '~/bin/hook.sh',
      '/usr/local/bin/hook',
      './scripts/*.sh',
      'bash -c "echo hi"',
      'FOO=1 ./hook.sh',
      '"$CLAUDE_PROJECT_DIR"/../../outside.sh',
      '`pwd`/hook.sh',
      "'unterminated",
      'python3 -m hooks.check',
      'node',
      '.\\hooks\\check.ps1',
    ];
    const files = Object.fromEntries(
      commands.map((command, i) => [`p${i}/.claude/settings.json`, claude({ command })]),
    );
    expect(run(files)).toEqual([]);
    expect(run({ '.claude/settings.json': claude({ command: 'x', type: 'prompt' }) })).toEqual([]);
  });

  it('resolves Cursor project hooks against the project root', () => {
    const text = json({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: '.cursor/hooks/audit.sh' }],
        afterFileEdit: [
          { command: '"$CURSOR_PROJECT_DIR/.cursor/hooks/format.sh"', failClosed: true },
        ],
      },
    });
    expect(run({ '.cursor/hooks.json': text }).map((finding) => finding.message)).toEqual([
      'Hook runs ".cursor/hooks/audit.sh", which does not exist. The hook fails on every run, and Cursor continues without it.',
      'Hook runs ".cursor/hooks/format.sh", which does not exist. The hook fails on every run, and because of "failClosed": true, Cursor blocks the action every time.',
    ]);
  });

  it('resolves only the git top-level form in a repository-root Codex file', () => {
    const text = json({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: '"$(git rev-parse --show-toplevel)/.codex/hooks/guard.sh"',
              },
              { type: 'command', command: '.codex/hooks/relative.sh' },
            ],
          },
        ],
      },
    });
    expect(
      run({ '.codex/hooks.json': text }, { paths: ['.git/'] }).map((finding) => finding.message),
    ).toEqual([
      'Hook runs ".codex/hooks/guard.sh", which does not exist. The hook fails on every run, and Codex continues without it.',
    ]);
    expect(run({ '.codex/hooks.json': text })).toEqual([]);
    expect(run({ 'sub/.codex/hooks.json': text }, { paths: ['.git/'] })).toEqual([]);
  });

  it('does not check hooks under event names the platform never fires', () => {
    const text = json({
      version: 1,
      hooks: { PreToolUse: [{ command: '.cursor/hooks/audit.sh' }] },
    });
    expect(run({ '.cursor/hooks.json': text })).toEqual([]);
  });

  it('does not check Gemini CLI hooks or untargeted platforms', () => {
    const gemini = claude({ command: '$GEMINI_PROJECT_DIR/.gemini/hooks/x.sh' }, 'BeforeTool');
    expect(run({ '.gemini/settings.json': gemini })).toEqual([]);
    const text = claude({ command: '$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh' });
    expect(run({ '.claude/settings.json': text }, { targets: ['cursor'] })).toEqual([]);
  });
});

describe('firstWords', () => {
  const syntax = { rootVariables: ['CLAUDE_PROJECT_DIR'], gitTopLevel: false };

  it('splits quoted and escaped words and stops at operators', () => {
    expect(firstWords('a\\ b "c d" \'e f\' g', syntax).map((word) => word.text)).toEqual([
      'a b',
      'c d',
      'e f',
    ]);
    expect(firstWords('x.sh; rm -rf /', syntax).map((word) => word.text)).toEqual(['x.sh']);
    expect(firstWords('"${CLAUDE_PROJECT_DIR}/x" y', syntax)[0]).toEqual({
      text: `${ROOT}/x`,
      resolvable: true,
    });
    expect(firstWords('"$OTHER/x"', syntax)[0]?.resolvable).toBe(false);
    expect(firstWords('"unterminated', syntax)[0]?.resolvable).toBe(false);
    expect(firstWords('"a\\"b"', syntax)[0]?.text).toBe('a"b');
    expect(firstWords('a$CLAUDE_PROJECT_DIR', syntax)[0]?.resolvable).toBe(false);
    expect(firstWords('${CLAUDE_PROJECT_DIR', syntax)[0]?.resolvable).toBe(false);
    expect(firstWords('   ', syntax)).toEqual([]);
  });

  it('picks the script word', () => {
    const pick = (command: string) => scriptWord(firstWords(command, syntax))?.text;
    expect(pick('bash ./x.sh')).toBe('./x.sh');
    expect(pick('python3 check.py')).toBe('check.py');
    expect(pick('python3 check')).toBeUndefined();
    expect(pick('./bin/run')).toBe('./bin/run');
    expect(pick('run-hook')).toBeUndefined();
    expect(pick('')).toBeUndefined();
  });
});
