import { describe, expect, it } from 'vitest';
import { clineHookFile, mayBeClineHookFile } from '../../src/platforms/cline-hooks.js';

describe('clineHookFile', () => {
  it('reads the files both surfaces run in .clinerules/hooks', () => {
    expect(clineHookFile('.clinerules/hooks/PreToolUse')).toEqual({
      event: 'PreToolUse',
      cli: true,
      vscode: 'unix',
      vscodeEvent: true,
      runs: true,
    });
    expect(clineHookFile('.clinerules/hooks/TaskStart.ps1')).toMatchObject({
      event: 'TaskStart',
      cli: true,
      vscode: 'windows',
      runs: true,
    });
    expect(clineHookFile('apps/web/.clinerules/hooks/TaskCancel')).toMatchObject({
      event: 'TaskCancel',
      vscode: 'unix',
    });
  });

  it('reads the files only the CLI runs: .cline/hooks, other letter cases and extensions', () => {
    for (const path of [
      '.cline/hooks/PreToolUse',
      '.clinerules/hooks/pretooluse.sh',
      '.clinerules/hooks/PreToolUse.py',
      '.clinerules/hooks/ pretooluse .ts',
    ]) {
      const hook = clineHookFile(path);
      expect(hook, path).toMatchObject({ event: 'PreToolUse', cli: true, runs: true });
      expect(hook?.vscode, path).toBeUndefined();
    }
  });

  it('sees events only one surface runs, and PreCompact, which neither runs', () => {
    expect(clineHookFile('.clinerules/hooks/TaskResume')).toMatchObject({
      cli: true,
      vscode: 'unix',
      vscodeEvent: false,
      runs: true,
    });
    expect(clineHookFile('.clinerules/hooks/PreCompact')).toMatchObject({
      event: 'PreCompact',
      cli: false,
      vscodeEvent: false,
      runs: false,
    });
  });

  it('takes no other file for a hook', () => {
    for (const path of [
      '.clinerules/hooks/README.md',
      '.clinerules/hooks/PreToolUse.SH',
      '.clinerules/hooks/PreToolUse.rb',
      '.clinerules/hooks/nested/PreToolUse',
      '.clinerules/Hooks/PreToolUse',
      '.ClineRules/hooks/PreToolUse',
      '.clinerules/PreToolUse',
      'hooks/PreToolUse',
      '.cline/plugins/hooks/PreToolUse',
    ]) {
      expect(clineHookFile(path), path).toBeUndefined();
      expect(mayBeClineHookFile(path), path).toBe(false);
    }
    expect(mayBeClineHookFile('.clinerules/hooks/PreToolUse')).toBe(true);
  });
});
