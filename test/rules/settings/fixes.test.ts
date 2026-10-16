import { describe, expect, it } from 'vitest';
import { autoApproveProjectMcpRule } from '../../../src/rules/settings/auto-approve-project-mcp.js';
import { ignoredPermissionModeRule } from '../../../src/rules/settings/ignored-permission-mode.js';
import { localFileNotIgnoredRule } from '../../../src/rules/settings/local-file-not-ignored.js';
import { pluginManifestRule } from '../../../src/rules/settings/plugin-manifest.js';
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

const SETTINGS = '.claude/settings.json';

describe('settings/ignored-permission-mode fixes', () => {
  const ID = 'settings/ignored-permission-mode';
  const rules = [ignoredPermissionModeRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('removes defaultMode as the first property of a single-line object', () => {
    const text = '{"permissions": {"defaultMode": "auto", "allow": ["Read"]}}';
    const [fix] = fixesOf({ [SETTINGS]: text }, rules, ID);
    expect(applied({ [SETTINGS]: text }, fix, SETTINGS)).toBe(
      '{"permissions": {"allow": ["Read"]}}',
    );
  });

  it('does not report or fix a mode Claude Code applies', () => {
    const text = json({ permissions: { defaultMode: 'acceptEdits' } });
    expect(findingsOf({ [SETTINGS]: text }, rules, ID)).toEqual([]);
  });

  it('is a review fix: older Claude Code versions applied bypassPermissions', () => {
    const files = { [SETTINGS]: json({ permissions: { defaultMode: 'bypassPermissions' } }) };
    expect(runFixes(files, selectionFor(ID, { classes: ['safe'] })).applied).toEqual([]);
    expect(runFixes(files, selectionFor(ID)).applied[0]?.fix.notes?.[0]).toContain('v2.1.257');
  });
});

describe('settings/auto-approve-project-mcp fixes', () => {
  const ID = 'settings/auto-approve-project-mcp';
  const rules = [autoApproveProjectMcpRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it("reads the .mcp.json of the settings file's own project", () => {
    const files = {
      'apps/web/.claude/settings.json': json({ enableAllProjectMcpServers: true }),
      'apps/web/.mcp.json': json({ mcpServers: { web: { command: 'x' } } }),
      '.mcp.json': json({ mcpServers: { root: { command: 'y' } } }),
    };
    const [fix] = fixesOf(files, rules, ID);
    expect(applied(files, fix, 'apps/web/.claude/settings.json')).toBe(
      '{\n  "enabledMcpjsonServers": ["web"]\n}\n',
    );
  });

  it('leaves the change to the user when it cannot list the servers safely', () => {
    const settings = json({ enableAllProjectMcpServers: true });
    const cases: Record<string, string>[] = [
      // .mcp.json does not parse.
      { [SETTINGS]: settings, '.mcp.json': '{"mcpServers": ' },
      // A server name with a line break would be copied into settings.
      { [SETTINGS]: settings, '.mcp.json': json({ mcpServers: { 'a\nb': { command: 'x' } } }) },
      // The settings already list servers.
      { [SETTINGS]: json({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ['a'] }) },
    ];
    for (const files of cases) {
      const [finding] = findingsOf(files, rules, ID);
      expect(finding?.fix, JSON.stringify(files)).toBeUndefined();
      expect(finding?.guidance).toBeDefined();
    }
    const unlisted = findingsOf({ [SETTINGS]: settings }, rules, ID, {
      opaqueDirectories: [],
      paths: [],
      gitignoreApplied: true,
    });
    expect(unlisted[0]?.fix).toBeDefined();
  });

  it('does not report false or missing values', () => {
    expect(
      findingsOf({ [SETTINGS]: json({ enableAllProjectMcpServers: false }) }, rules, ID),
    ).toEqual([]);
  });
});

describe('settings/local-file-not-ignored guidance', () => {
  const ID = 'settings/local-file-not-ignored';
  const rules = [localFileNotIgnoredRule];

  it('prints the .gitignore entry and git rm --cached, and never offers a fix', () => {
    const [finding] = findingsOf({ 'CLAUDE.local.md': '# Notes\n' }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe(
      'add the line "CLAUDE.local.md" to the root .gitignore (it matches the file in every directory); if git already tracks the file, also run git rm --cached CLAUDE.local.md',
    );
  });

  it('never prints a command for a path a shell would split or expand', () => {
    const [finding] = findingsOf({ 'my notes/CLAUDE.local.md': '# Notes\n' }, rules, ID);
    expect(finding?.guidance).toContain('run git rm --cached on the file (quote its path)');
    expect(finding?.guidance).not.toContain('my notes');
  });

  it('does not report a file that a .gitignore covers', () => {
    expect(
      findingsOf({ 'AGENTS.md': '# Rules\n' }, rules, ID, { ignoredFiles: ['CLAUDE.local.md'] }),
    ).toEqual([]);
  });
});

describe('settings/plugin-manifest fixes', () => {
  const ID = 'settings/plugin-manifest';
  const rules = [pluginManifestRule];
  const MANIFEST = 'plugin/.claude-plugin/plugin.json';

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('adds "./" only to a path that then exists', () => {
    const text = json({ name: 'p', commands: ['commands/missing.md'], agents: '/abs/agent.md' });
    expect(fixesOf({ [MANIFEST]: text }, rules, ID)).toEqual([undefined, undefined]);
  });

  it('makes the "./" fix a review fix when the plugin can start processes', () => {
    const files = {
      [MANIFEST]: json({ name: 'p', commands: ['commands/a.md'] }),
      'plugin/commands/a.md': '# A\n',
      'plugin/hooks/hooks.json': json({ hooks: {} }),
    };
    const [fix] = fixesOf(files, rules, ID);
    expect(fix?.class).toBe('review');
    const inline = {
      [MANIFEST]: json({ name: 'p', skills: 'skills', mcpServers: { s: { command: 'x' } } }),
      'plugin/skills/a/SKILL.md': '---\nname: a\ndescription: A skill.\n---\n',
    };
    expect(fixesOf(inline, rules, ID).map((item) => item?.class)).toEqual(['review']);
  });

  it('renames only to a valid, unreserved ASCII kebab-case name', () => {
    const name = (value: string) =>
      fixesOf({ '.claude-plugin/plugin.json': json({ name: value }) }, rules, ID);
    expect(name('Claude_Tools').every((fix) => fix === undefined)).toBe(true);
    expect(name('Déploy Tools')).toEqual([undefined]);
    expect(name('deploy-tools')).toEqual([]);
  });

  it('does not fix a manifest that other paths link to', () => {
    const text = json({ name: 'MyPlugin' });
    const [finding] = findingsOf(
      { '.claude-plugin/plugin.json': text, 'mirror/.claude-plugin/plugin.json': text },
      rules,
      ID,
      { symlinks: { 'mirror/.claude-plugin/plugin.json': '.claude-plugin/plugin.json' } },
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toContain('other paths link to this file');
  });
});
