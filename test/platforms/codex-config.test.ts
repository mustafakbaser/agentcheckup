import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { parseToml } from '../../src/parse/toml.js';
import {
  codexDocSettings,
  codexFallbackNames,
  codexHooksSetting,
  codexIgnoredKeys,
  codexProjectConfig,
  codexServerProblem,
} from '../../src/platforms/codex-config.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

function configOf(files: FileMap, directories: readonly string[]) {
  return codexProjectConfig(analyze(snapshotFrom(files), {}), directories);
}

function doc(text: string) {
  const parsed = parseToml(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed;
}

const RULE_DEFAULT = { value: 32_768, origin: 'default' as const };

describe('codexProjectConfig', () => {
  const files = {
    '.codex/config.toml': 'a = 1\n[t]\nx = 1\ny = 1\n[s]\nz = 1\n',
    'pkg/.codex/config.toml': 'a = 2\n[t]\ny = 2\n',
    'pkg/sub/.codex/config.toml': 's = "replaced"\n',
  };

  it('takes each value from the closest layer that sets it', () => {
    const config = configOf(files, ['', 'pkg', 'pkg/sub']);
    expect(config.layers.map((layer) => layer.path)).toEqual([
      '.codex/config.toml',
      'pkg/.codex/config.toml',
      'pkg/sub/.codex/config.toml',
    ]);
    expect(config.setting(['a'])).toMatchObject({ value: 2, layer: { directory: 'pkg' } });
    expect(config.setting(['t', 'x'])).toMatchObject({ value: 1, layer: { directory: '' } });
    expect({ ...config.table(['t']) }).toEqual({ x: 1, y: 2 });
    // A closer layer that replaces a table with a value hides the keys below it.
    expect(config.setting(['s', 'z'])).toBeUndefined();
    expect(config.table(['s'])).toBeUndefined();
    expect(config.setting(['missing'])).toBeUndefined();
  });

  it('reads only the directories it is given, and is built once per list', () => {
    const view = analyze(snapshotFrom(files), {});
    expect(codexProjectConfig(view, ['']).setting(['a'])?.value).toBe(1);
    expect(codexProjectConfig(view, ['', 'pkg'])).toBe(codexProjectConfig(view, ['', 'pkg']));
  });

  it('lists layers it could not read', () => {
    const config = configOf(
      {
        '.codex/config.toml': '[a\n',
        'b/.codex/config.toml': Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x3d, 0, 0x31, 0),
      },
      ['', 'b', 'c'],
    );
    expect(config.problems.map((problem) => [problem.kind, problem.path])).toEqual([
      ['invalid', '.codex/config.toml'],
      ['unparsed', 'b/.codex/config.toml'],
    ]);
    const unread = codexProjectConfig(
      analyze(snapshotFrom({}, { paths: ['.codex/config.toml'] }), {}),
      [''],
    );
    expect(unread.problems).toEqual([
      { kind: 'unread', directory: '', path: '.codex/config.toml' },
    ]);
  });
});

describe('codexDocSettings', () => {
  it('prefers a positive integer and a list of names from the repository', () => {
    const config = configOf(
      {
        '.codex/config.toml':
          'project_doc_max_bytes = 4096\nproject_doc_fallback_filenames = ["CLAUDE.md"]\n',
      },
      [''],
    );
    expect(codexDocSettings(config, RULE_DEFAULT)).toEqual({
      maxBytes: { value: 4096, origin: 'repository', path: '.codex/config.toml' },
      fallbackNames: { value: ['CLAUDE.md'], origin: 'repository', path: '.codex/config.toml' },
    });
  });

  it('falls back to the rule option or the default for values Codex would reject', () => {
    for (const text of [
      'project_doc_max_bytes = 0\nproject_doc_fallback_filenames = "CLAUDE.md"\n',
      'project_doc_max_bytes = 1.5\nproject_doc_fallback_filenames = [1]\n',
      'project_doc_max_bytes = "4096"\n',
      '',
    ]) {
      const config = configOf({ '.codex/config.toml': text }, ['']);
      expect(codexDocSettings(config, { value: 99, origin: 'rule-option' }), text).toEqual({
        maxBytes: { value: 99, origin: 'rule-option' },
        fallbackNames: { value: [], origin: 'default' },
      });
    }
  });

  it('cleans fallback names as Codex does', () => {
    expect(
      codexFallbackNames([
        '',
        '.',
        '..',
        'a/b.md',
        'x\u0000',
        'AGENTS.md',
        'CLAUDE.md',
        'CLAUDE.md',
        'A.md',
      ]),
    ).toEqual(['CLAUDE.md', 'A.md']);
  });
});

describe('codexHooksSetting', () => {
  it('reads features.hooks, then its deprecated alias', () => {
    const setting = (text: string) =>
      codexHooksSetting(configOf({ '.codex/config.toml': text }, ['']))?.value;
    expect(setting('[features]\nhooks = false\n')).toBe(false);
    expect(setting('[features]\ncodex_hooks = false\n')).toBe(false);
    expect(setting('[features]\nhooks = true\ncodex_hooks = false\n')).toBe(true);
    expect(setting('[features]\nhooks = "no"\n')).toBeUndefined();
    expect(setting('')).toBeUndefined();
  });
});

describe('codexIgnoredKeys', () => {
  it('lists denylisted, removed, pre-project and user-only keys', () => {
    const keys = codexIgnoredKeys(
      doc(
        [
          'profile = "x"',
          'model = "o3"',
          'otel = { exporter = "none" }',
          'project_root_markers = []',
          '[features]',
          'respect_system_proxy = true',
          'hooks = true',
          '[features.multi_agent_v2]',
          'message_board_remote = "x"',
          '[hooks.state.a]',
          'enabled = true',
          '',
        ].join('\n'),
      ),
    );
    expect(keys.map((item) => [item.path.join('.'), item.reason])).toEqual([
      ['profile', 'removed'],
      ['otel', 'removed'],
      ['project_root_markers', 'before-project'],
      ['features.respect_system_proxy', 'removed'],
      ['features.multi_agent_v2.message_board_remote', 'removed'],
      ['hooks.state', 'user-only'],
    ]);
    expect(codexIgnoredKeys(doc('model = "o3"\n[hooks]\n'))).toEqual([]);
  });
});

describe('codexServerProblem', () => {
  const problem = (text: string) => codexServerProblem(doc(text).value as never);
  it('follows the checks of mcp_types.rs, in their order', () => {
    expect(problem('command = "x"')).toBeUndefined();
    expect(problem('url = "https://x"')).toBeUndefined();
    expect(problem('enabled = true')).toEqual({ kind: 'no-transport' });
    expect(problem('command = "x"\nurl = "https://x"\nbearer_token = "t"')).toEqual({
      kind: 'unsupported-field',
      field: 'url',
      transport: 'stdio',
    });
    expect(problem('command = "x"\nbearer_token = "t"')).toMatchObject({ field: 'bearer_token' });
    expect(problem('url = "https://x"\nbearer_token = "t"')).toEqual({
      kind: 'unsupported-field',
      field: 'bearer_token',
      transport: 'streamable_http',
    });
    expect(problem('url = "https://x"\nargs = []\ncwd = "."')).toMatchObject({ field: 'args' });
    expect(problem('url = "https://x"\nhttp_headers_helper = "h"')).toBeUndefined();
  });
});
