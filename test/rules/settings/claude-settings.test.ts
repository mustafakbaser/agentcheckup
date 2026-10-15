import { describe, expect, it } from 'vitest';
import { autoApproveProjectMcpRule } from '../../../src/rules/settings/auto-approve-project-mcp.js';
import { ignoredPermissionModeRule } from '../../../src/rules/settings/ignored-permission-mode.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

describe('settings/ignored-permission-mode', () => {
  const ID = 'settings/ignored-permission-mode';
  const rules = [ignoredPermissionModeRule];

  it('reports bypassPermissions and auto in project and local settings', () => {
    const text = json({
      permissions: { allow: ['Bash(pnpm test)'], defaultMode: 'bypassPermissions' },
    });
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.claude/settings.json',
        message:
          '"defaultMode": "bypassPermissions" has no effect here: since v2.1.257, Claude Code ignores "auto" and "bypassPermissions" in project and local settings. Set it in ~/.claude/settings.json or managed settings, or pass --permission-mode.',
        range: rangeOf(text, '"bypassPermissions"'),
      },
    ]);
    const local = json({ permissions: { defaultMode: 'auto' } });
    expect(findings(lint({ '.claude/settings.local.json': local }, { rules }), ID)).toHaveLength(1);
  });

  it('does not report other modes or malformed values', () => {
    const files = {
      'a/.claude/settings.json': json({ permissions: { defaultMode: 'acceptEdits' } }),
      'b/.claude/settings.json': json({ permissions: { defaultMode: 'plan' } }),
      'c/.claude/settings.json': json({ permissions: 'bypassPermissions' }),
      'd/.claude/settings.json': json({ defaultMode: 'bypassPermissions' }),
      'e/.claude/settings.json': json(['bypassPermissions']),
      'f/.claude/settings.json': json({ permissions: { defaultMode: ['auto'] } }),
    };
    expect(findings(lint(files, { rules }), ID)).toEqual([]);
    const text = json({ permissions: { defaultMode: 'auto' } });
    expect(
      findings(lint({ '.claude/settings.json': text }, { rules, targets: ['cursor'] }), ID),
    ).toEqual([]);
  });
});

describe('settings/auto-approve-project-mcp', () => {
  const ID = 'settings/auto-approve-project-mcp';
  const rules = [autoApproveProjectMcpRule];

  it('reports enableAllProjectMcpServers: true', () => {
    const text = json({ enableAllProjectMcpServers: true });
    expect(findings(lint({ '.claude/settings.json': text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.claude/settings.json',
        message:
          '"enableAllProjectMcpServers": true approves every server in this project\'s .mcp.json without a prompt, including servers that later commits add. List trusted servers in "enabledMcpjsonServers" instead.',
        range: rangeOf(text, '"enableAllProjectMcpServers"'),
      },
    ]);
  });

  it('does not report false, strings, or the per-server allowlist', () => {
    const files = {
      'a/.claude/settings.json': json({ enableAllProjectMcpServers: false }),
      'b/.claude/settings.json': json({ enableAllProjectMcpServers: 'true' }),
      'c/.claude/settings.json': json({ enabledMcpjsonServers: ['github'] }),
    };
    expect(findings(lint(files, { rules }), ID)).toEqual([]);
  });
});
