import { describe, expect, it } from 'vitest';
import { GEMINI_LEGACY_SETTINGS_KEYS } from '../../../src/platforms/gemini.js';
import { settingsKeyIgnoredRule } from '../../../src/rules/gemini/settings-key-ignored.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'gemini/settings-key-ignored';
const rules = [settingsKeyIgnoredRule];
const PATH = '.gemini/settings.json';

function guidanceOf(files: Record<string, string>): (string | undefined)[] {
  return lint(files, { rules }).findings.map((finding) => finding.guidance);
}

describe('gemini/settings-key-ignored', () => {
  it('reports a top-level contextFileName and names the files Gemini CLI no longer reads', () => {
    const text = json({ contextFileName: ['AGENTS.md', 'GEMINI.md', 'CONTEXT.md'] });
    expect(findings(lint({ [PATH]: text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: PATH,
        message:
          'Gemini CLI ignores the top-level "contextFileName", a key from its old settings format: since version 0.24 it reads context file names only from "context.fileName", so it loads GEMINI.md but not "AGENTS.md" and "CONTEXT.md".',
        range: rangeOf(text, '"contextFileName"'),
      },
    ]);
    expect(guidanceOf({ [PATH]: text })).toEqual(['move the value to "context.fileName"']);
  });

  it('reports other keys of the old format with their nested place', () => {
    const text =
      '{\n  // comments are allowed\n  "theme": "GitHub",\n  "excludeTools": ["run_shell_command"]\n}\n';
    expect(findings(lint({ [PATH]: text }, { rules }), ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: PATH,
        message:
          'Gemini CLI ignores the top-level "theme", a key from its old settings format: since version 0.24 it reads this setting only as "ui.theme".',
        range: rangeOf(text, '"theme"'),
      },
      {
        ruleId: ID,
        severity: 'warn',
        path: PATH,
        message:
          'Gemini CLI ignores the top-level "excludeTools", a key from its old settings format: since version 0.24 it reads this setting only as "tools.exclude".',
        range: rangeOf(text, '"excludeTools"'),
      },
    ]);
  });

  it('asks to remove an old key whose nested place the file already sets', () => {
    const text = json({ contextFileName: 'AGENTS.md', context: { fileName: 'AGENTS.md' } });
    const result = findings(lint({ [PATH]: text }, { rules }), ID);
    expect(result.map((f) => f.message)).toEqual([
      'Gemini CLI ignores the top-level "contextFileName", a key from its old settings format: since version 0.24 it reads this setting only as "context.fileName".',
    ]);
    expect(guidanceOf({ [PATH]: text })).toEqual([
      'remove "contextFileName"; this file already sets "context.fileName"',
    ]);
    // GEMINI.md alone: nothing is lost, the key still has no effect.
    const gemini = findings(
      lint({ [PATH]: json({ contextFileName: 'GEMINI.md' }) }, { rules }),
      ID,
    );
    expect(gemini.map((f) => f.message)).toEqual([
      'Gemini CLI ignores the top-level "contextFileName", a key from its old settings format: since version 0.24 it reads this setting only as "context.fileName".',
    ]);
  });

  it('reports a nested settings file too, since a session started there reads it', () => {
    const text = json({ sandbox: true });
    expect(findings(lint({ 'pkg/.gemini/settings.json': text }, { rules }), ID)).toHaveLength(1);
  });

  it('does not report current keys, nested keys, other files or untargeted runs', () => {
    const current = json({
      context: { fileName: ['AGENTS.md'], includeDirectories: ['../shared'] },
      mcpServers: { docs: { httpUrl: 'https://docs.example.com/mcp' } },
      model: { name: 'gemini-2.5-pro' },
      telemetry: { enabled: false },
      extensions: { disabled: [] },
      ui: { theme: 'GitHub' },
      tools: { exclude: ['run_shell_command'] },
      security: { folderTrust: { enabled: true } },
      unknownKey: true,
    });
    expect(findings(lint({ [PATH]: current }, { rules }), ID)).toEqual([]);
    const legacy = json({ contextFileName: 'AGENTS.md', theme: 'GitHub' });
    expect(
      findings(
        lint({ '.claude/settings.json': legacy, '.cursor/mcp.json': legacy }, { rules }),
        ID,
      ),
    ).toEqual([]);
    expect(findings(lint({ [PATH]: legacy }, { rules, targets: ['claude-code'] }), ID)).toEqual([]);
    // A file that does not parse is json/invalid-syntax's; one that is not an object has no keys.
    expect(findings(lint({ [PATH]: '{ "theme": ' }, { rules }), ID)).toEqual([]);
    expect(findings(lint({ [PATH]: '["theme"]' }, { rules }), ID)).toEqual([]);
  });

  it('lists only old keys whose nested place the current schema has', () => {
    for (const [key, target] of Object.entries(GEMINI_LEGACY_SETTINGS_KEYS)) {
      expect(target.split('.').length, key).toBeGreaterThan(1);
      expect(['mcpServers', 'model', 'extensions', 'telemetry']).not.toContain(key);
    }
    expect(GEMINI_LEGACY_SETTINGS_KEYS['contextFileName']).toBe('context.fileName');
    expect(Object.keys(GEMINI_LEGACY_SETTINGS_KEYS)).toHaveLength(56);
  });
});
