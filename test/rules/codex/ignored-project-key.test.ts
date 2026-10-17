import { describe, expect, it } from 'vitest';
import { CODEX_PROJECT_DENYLIST } from '../../../src/platforms/codex-config.js';
import { ignoredProjectKeyRule } from '../../../src/rules/codex/ignored-project-key.js';
import { findings, lint } from '../../helpers/lint.js';
import { rangeOf } from '../json/helpers.js';

const ID = 'codex/ignored-project-key';
const rules = [ignoredProjectKeyRule];
const FILE = '.codex/config.toml';

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

const lines = (...items: string[]): string => `${items.join('\n')}\n`;

describe('codex/ignored-project-key', () => {
  it('reports a key Codex removes from project config files', () => {
    const text = lines('model = "o3"', 'model_provider = "acme"', 'notify = ["say", "done"]');
    expect(run({ [FILE]: text })).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: FILE,
        message:
          'Codex removes "model_provider" from project config files and warns at startup ("Ignored unsupported project-local config keys"), so it has no effect here.',
        range: rangeOf(text, 'model_provider'),
      },
      {
        ruleId: ID,
        severity: 'warn',
        path: FILE,
        message:
          'Codex removes "notify" from project config files and warns at startup ("Ignored unsupported project-local config keys"), so it has no effect here.',
        range: rangeOf(text, 'notify'),
      },
    ]);
  });

  it('reports every key of the denylist, however the table is spelled', () => {
    for (const key of CODEX_PROJECT_DENYLIST) {
      expect(run({ [FILE]: `${key} = "x"\n` }), key).toHaveLength(1);
    }
    const text = lines('[profiles.fast]', 'model = "o4-mini"', '[profiles.deep]', 'model = "o3"');
    expect(run({ [FILE]: text }).map((found) => found.range)).toEqual([rangeOf(text, 'profiles')]);
  });

  it('reports keys read before project files and hooks.state', () => {
    const text = lines(
      'project_root_markers = [".hg"]',
      '[projects."/home/me/repo"]',
      'trust_level = "trusted"',
      '[hooks.state."pre:1"]',
      'enabled = true',
      '[features]',
      'credential_masking = false',
      '[tui.keymap.chat]',
      'next_permission_mode = "ctrl-p"',
    );
    expect(
      run({ [FILE]: text }).map((found) => found.message.split(' ').slice(0, 3).join(' ')),
    ).toEqual([
      'Codex reads "project_root_markers"',
      'Codex reads "projects"',
      'Codex reads "hooks.state",',
      'Codex removes "features.credential_masking"',
      'Codex removes "tui.keymap.chat.next_permission_mode"',
    ]);
  });

  it('accepts the keys Codex reads from a project file', () => {
    const text = lines(
      'model = "o3"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'project_doc_max_bytes = 65536',
      '[features]',
      'hooks = true',
      'shell_snapshot = true',
      '[mcp_servers.docs]',
      'command = "npx"',
      '[[hooks.PreToolUse]]',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "true"',
      '[notes]',
      'profiles = "not the top-level key"',
    );
    expect(run({ [FILE]: text })).toEqual([]);
  });

  it('runs only for Codex, and not on TOML it cannot parse', () => {
    expect(run({ [FILE]: 'notify = ["x"]\n' }, ['cursor'])).toEqual([]);
    expect(run({ [FILE]: 'notify = ["x"\n' })).toEqual([]);
  });
});
