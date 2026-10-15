import { describe, expect, it } from 'vitest';
import {
  forbiddenNameCharacter,
  isReservedName,
  pluginManifestRule,
} from '../../../src/rules/settings/plugin-manifest.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';
import { json, rangeOf } from '../json/helpers.js';

const ID = 'settings/plugin-manifest';
const rules = [pluginManifestRule];
const MANIFEST = 'deploy/.claude-plugin/plugin.json';

function run(manifest: string, options: Partial<LintOptions> = {}) {
  return findings(lint({ [MANIFEST]: manifest }, { rules, ...options }), ID);
}

describe('settings/plugin-manifest', () => {
  it('accepts a valid manifest whose paths exist', () => {
    const text = json({
      name: 'deploy-tools',
      homepage: 'https://tools.dev/deploy',
      skills: ['./extra-skills/', '.'],
      commands: { status: { source: './commands/status.md' }, about: { content: 'Explain.' } },
      agents: ['./agents/reviewer.md'],
      hooks: ['./config/hooks.json', { PostToolUse: [] }],
      mcpServers: ['https://tools.dev/server.mcpb', { api: { command: 'node' } }],
      experimental: {
        themes: './themes/',
        monitors: [{ name: 'm', command: 'x', description: 'd' }],
      },
    });
    const paths = [
      'deploy/extra-skills/',
      'deploy/commands/status.md',
      'deploy/agents/reviewer.md',
      'deploy/config/hooks.json',
      'deploy/themes/',
    ];
    expect(run(text, { paths })).toEqual([]);
  });

  it('reports a missing name for the whole file', () => {
    expect(run(json({ version: '1.0.0' }))).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: MANIFEST,
        message:
          'Plugin manifest has no "name", the only required field, so Claude Code reports an invalid manifest and the plugin cannot be installed.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
    expect(run(json({ name: 42 }))[0]?.message).toMatch(
      /^Plugin "name" is empty or not a string, so Claude Code reports an invalid manifest\b/,
    );
    expect(run(json({ name: '' }))[0]?.message).toMatch(
      /^Plugin "name" is empty or not a string, so Claude Code reports an invalid manifest\b/,
    );
    expect(run(json(['deploy-tools']))[0]?.message).toMatch(
      /^Plugin manifest is not a JSON object, so Claude Code reports an invalid manifest\b/,
    );
  });

  it('reports names Claude Code rejects', () => {
    const text = json({ name: 'deploy tools' });
    expect(run(text)).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: MANIFEST,
        message:
          'Plugin name "deploy tools" contains a space, which Claude Code does not allow in a name, so the plugin cannot be installed.',
        range: rangeOf(text, '"deploy tools"'),
      },
    ]);
    expect(
      [
        'a@b',
        'a:b',
        'a/b',
        'a\\b',
        `a${String.fromCharCode(7)}b`,
        `a${String.fromCharCode(0x202e)}b`,
      ].map(forbiddenNameCharacter),
    ).toEqual([
      '"@"',
      '":"',
      'a path separator',
      'a path separator',
      'the control character U+0007',
      'the bidirectional formatting character U+202E',
    ]);
  });

  it('warns about names that are not kebab-case or that are reserved', () => {
    expect(
      run(json({ name: 'DeployTools_v2' })).map((finding) => [finding.severity, finding.message]),
    ).toEqual([
      [
        'warn',
        'Plugin name "DeployTools_v2" is not kebab-case, and "claude plugin validate" warns about it. Use lowercase words joined by hyphens, such as "deploy-tools-v2".',
      ],
    ]);
    expect(
      run(json({ name: 'claude-tools' })).map((finding) => [finding.severity, finding.message]),
    ).toEqual([
      [
        'warn',
        'Plugin name "claude-tools" is reserved because it passes as one of Anthropic\'s own plugins. "claude plugin validate" reports an error and "claude plugin init" and "claude plugin tag" refuse it, though Claude Code still installs and loads the plugin.',
      ],
    ]);
    expect(run(json({ name: 'Claude_Tools' }))).toHaveLength(2);
  });

  it('applies the reserved-name check like claude plugin validate', () => {
    const reserved = [
      'claude',
      'Anthropic',
      'claude-code',
      'claude--mods',
      'anthropics-x',
      'cc-plugin-y',
      'official-claude-tools',
      'tools-anthropic-official',
      'Claude.Tools',
    ];
    const allowed = [
      'deploy-tools',
      'mcp-for-claude',
      'claudette',
      'official-tools',
      'my-anthropic-notes',
    ];
    expect(reserved.filter((name) => !isReservedName(name))).toEqual([]);
    expect(allowed.filter(isReservedName)).toEqual([]);
  });

  it('reports component paths that break the path rules', () => {
    const text = json({
      name: 'deploy-tools',
      commands: 'commands/deploy.md',
      agents: ['./../shared/reviewer.md', './agents/missing.md'],
      outputStyles: './styles/',
    });
    expect(
      run(text, { paths: ['deploy/styles/'] }).map((finding) => [finding.message, finding.range]),
    ).toEqual([
      [
        'Component path "commands/deploy.md" in "commands" does not start with "./", so the manifest fails validation.',
        rangeOf(text, '"commands/deploy.md"'),
      ],
      [
        'Component path "./../shared/reviewer.md" in "agents" contains "..". Claude Code does not load a path outside the plugin directory, and "claude plugin validate" reports a path traversal error.',
        rangeOf(text, '"./../shared/reviewer.md"'),
      ],
      [
        'Component path "./agents/missing.md" in "agents" does not exist, so Claude Code does not load it ("agents path not found").',
        rangeOf(text, '"./agents/missing.md"'),
      ],
    ]);
  });

  it('checks command sources and experimental paths, and skips unlisted directories', () => {
    const text = json({
      name: 'deploy-tools',
      commands: { status: { source: './commands/status.md' } },
      experimental: { monitors: './monitors/custom.json' },
      workflows: './node_modules/wf/',
    });
    expect(
      run(text, { opaqueDirectories: ['deploy/node_modules/'] }).map((finding) => finding.message),
    ).toEqual([
      'Component path "./commands/status.md" in "commands" does not exist, so Claude Code does not load it ("commands path not found").',
      'Component path "./monitors/custom.json" in "monitors" does not exist, so Claude Code does not load it ("monitors path not found").',
    ]);
  });

  it('reports a homepage that is not a URL', () => {
    const text = json({ name: 'deploy-tools', homepage: 'tools.dev/deploy' });
    expect(run(text)[0]?.message).toBe(
      '"homepage" value "tools.dev/deploy" is not a valid URL, so Claude Code does not load the plugin.',
    );
  });

  it('ignores invalid JSON and untargeted runs', () => {
    expect(run('{ "name": ')).toEqual([]);
    expect(run(json({}), { targets: ['codex'] })).toEqual([]);
  });
});
