/**
 * The `permissions` and `requiredPlugins` of Devin Local's `.devin/config.json` and
 * `.devin/config.local.json` in the inventory, and the gate over them: added `allow` entries and
 * required plugins trip `permissions`, as removed `deny` and `ask` entries do (docs/adr/0017).
 */
import { describe, expect, it } from 'vitest';
import { compareWithBaseline, SECURITY_GATE_CLASSES } from '../../src/core/baseline.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import { analyze, scanSnapshot } from '../../src/core/engine.js';
import { buildInventory } from '../../src/inventory/build.js';
import { devinBroadPermission, devinPluginSource } from '../../src/platforms/windsurf-rules.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

const CONFIG = '.devin/config.json';
const LOCAL = '.devin/config.local.json';

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function permissionsOf(files: FileMap): string[] {
  return buildInventory(analyze(snapshotFrom(files), {})).permissions.map(
    (item) =>
      `${item.file}:${item.line} ${item.key}=${item.value}${item.broad ? ' broad' : ''} ${item.platforms.join(',')}`,
  );
}

function scan(files: FileMap) {
  return scanSnapshot(snapshotFrom(files), { rules: [] });
}

function gate(base: FileMap, head: FileMap) {
  const parsed = validateBaseline(JSON.parse(JSON.stringify(scan(base))));
  if (!parsed.ok) throw new Error(parsed.message);
  return compareWithBaseline(scan(head), parsed.baseline, { gate: SECURITY_GATE_CLASSES }).diff.gate
    .hits;
}

const summaries = (base: FileMap, head: FileMap): string[] =>
  gate(base, head).map((hit) => `${hit.change} ${hit.summary}`);

describe('Devin Local permissions in the inventory', () => {
  it('lists every allow, ask and deny entry of both files, with the broad ones marked', () => {
    expect(
      permissionsOf({
        [CONFIG]: [
          '{',
          '  // Comments are allowed in Devin config files.',
          '  "permissions": {',
          '    "allow": ["Read(src/**)", "Exec(*)", "mcp__*", 3],',
          '    "ask": ["Write(**)"],',
          '    "deny": ["exec"]',
          '  },',
          '  "read_config_from": { "claude": false }',
          '}',
        ].join('\n'),
        [LOCAL]: json({ permissions: { allow: ['Exec(docker compose)'] } }),
      }),
    ).toEqual([
      // Sorted by id: file, key and value.
      '.devin/config.json:4 permissions.allow=Exec(*) broad windsurf',
      '.devin/config.json:4 permissions.allow=Read(src/**) windsurf',
      '.devin/config.json:4 permissions.allow=mcp__* broad windsurf',
      '.devin/config.json:5 permissions.ask=Write(**) broad windsurf',
      '.devin/config.json:6 permissions.deny=exec broad windsurf',
      '.devin/config.local.json:4 permissions.allow=Exec(docker compose) windsurf',
    ]);
  });

  it('lists nothing for a file without permissions, or with lists of another shape', () => {
    expect(
      permissionsOf({
        [CONFIG]: json({ read_config_from: { cursor: false } }),
        [LOCAL]: json({ permissions: { allow: 'Exec(git)', deny: { a: 1 } } }),
        'pkg/.devin/config.json': json({ permissions: ['Exec(git)'] }),
      }),
    ).toEqual([]);
  });

  it('lists the plugins a .devin/config.json requires, and not the optional or forbidden ones', () => {
    expect(
      permissionsOf({
        [CONFIG]: json({
          requiredPlugins: [
            'acme/secure-base',
            { source: 'github', repo: 'acme/audit-logging', sha: '3f2a9c1' },
            { source: 'git-subdir', url: 'https://gitlab.com/acme/all.git', path: 'plugins/x' },
            { source: 'url', url: 'https://gitlab.com/acme/extra.git', ref: 'v2' },
            { source: 'github' },
            '',
          ],
          optionalPlugins: ['acme/deploy-tools'],
          forbiddenPlugins: ['*'],
        }),
        // The plugins page names `.devin/config.json` only.
        [LOCAL]: json({ requiredPlugins: ['acme/local-only'] }),
      }),
    ).toEqual([
      '.devin/config.json:4 requiredPlugins=acme/audit-logging (sha 3f2a9c1) windsurf',
      '.devin/config.json:3 requiredPlugins=acme/secure-base windsurf',
      '.devin/config.json:9 requiredPlugins=https://gitlab.com/acme/all.git#plugins/x windsurf',
      '.devin/config.json:14 requiredPlugins=https://gitlab.com/acme/extra.git (ref v2) windsurf',
    ]);
  });

  it('never shows a credential in a plugin URL or a permission value', () => {
    const items = permissionsOf({
      [CONFIG]: json({
        permissions: { allow: ['Fetch(https://user:hunter2@api.example.com/*)'] },
        requiredPlugins: ['https://oauth2:glpat-abcdefghij1234567890@gitlab.com/acme/x.git'],
      }),
    });
    expect(items).toHaveLength(2);
    expect(items.join('\n')).not.toContain('hunter2');
    expect(items.join('\n')).not.toContain('glpat-abcdefghij1234567890');
  });
});

describe('the gate over Devin Local permissions', () => {
  const config = (value: object, file = CONFIG): FileMap => ({ [file]: json(value) });

  it('trips on added allow entries and required plugins, and on removed deny and ask entries', () => {
    expect(
      summaries(
        config({
          permissions: {
            allow: ['Read(src/**)'],
            deny: ['Exec(rm)', 'Exec(sudo)'],
            ask: ['Write(**)'],
          },
          requiredPlugins: ['acme/secure-base'],
          optionalPlugins: ['acme/deploy-tools'],
          forbiddenPlugins: ['*'],
        }),
        config({
          permissions: {
            allow: ['Read(src/**)', 'Exec(*)', 'Exec(git status)'],
            deny: ['Exec(sudo)'],
          },
          requiredPlugins: [
            'acme/secure-base',
            { source: 'github', repo: 'acme/audit', ref: 'v2' },
          ],
          optionalPlugins: ['acme/deploy-tools', 'acme/extra'],
          forbiddenPlugins: [],
        }),
      ),
    ).toEqual([
      'added permissions.allow adds Exec(*) (broad)',
      'added permissions.allow adds Exec(git status)',
      'removed permissions.ask entry removed: Write(**)',
      'removed permissions.deny entry removed: Exec(rm)',
      'added requiredPlugins adds acme/audit (ref v2)',
    ]);
  });

  it('trips on a new pin of a required plugin', () => {
    const pinned = (sha: string): FileMap =>
      config({ requiredPlugins: [{ source: 'github', repo: 'acme/audit', sha }] });
    expect(summaries(pinned('aaa111'), pinned('bbb222'))).toEqual([
      'added requiredPlugins adds acme/audit (sha bbb222)',
    ]);
  });

  it('trips on an allow entry in .devin/config.local.json', () => {
    expect(summaries(config({}), config({ permissions: { allow: ['Write(**)'] } }, LOCAL))).toEqual(
      ['added permissions.allow adds Write(**) (broad)'],
    );
  });

  it('does not trip on added deny or ask entries, removed allow entries or plugin lists that install nothing', () => {
    expect(
      summaries(
        config({ permissions: { allow: ['Exec(git)'] }, requiredPlugins: ['acme/a'] }),
        config({
          permissions: { allow: [], deny: ['exec'], ask: ['mcp__*'] },
          requiredPlugins: [],
          optionalPlugins: ['acme/b'],
          forbiddenPlugins: ['acme/*'],
        }),
      ),
    ).toEqual([]);
  });

  it('does not trip for a deny entry moved to .devin/config.local.json', () => {
    expect(
      summaries(config({ permissions: { deny: ['Exec(rm)'] } }), {
        ...config({}),
        ...config({ permissions: { deny: ['Exec(rm)'] } }, LOCAL),
      }),
    ).toEqual([]);
  });

  it('fails closed on a permission list or required plugin of a shape the docs do not describe', () => {
    for (const head of [
      { permissions: 'allow everything' },
      { permissions: { allow: 'Exec(*)' } },
      { permissions: { allow: ['Exec(git)', 3] } },
      { requiredPlugins: 'acme/audit' },
      { requiredPlugins: [{ source: 'github' }] },
    ]) {
      const hits = gate(config({}), config(head));
      expect(
        hits.some((hit) => hit.class === 'permissions' && hit.kind === 'not-analyzed'),
        JSON.stringify(head),
      ).toBe(true);
    }
    // Well-formed lists and the plugin lists Devin does not install are read in full.
    expect(
      gate(
        config({}),
        config({ permissions: { deny: ['exec'] }, optionalPlugins: [3], forbiddenPlugins: 'x' }),
      ),
    ).toEqual([]);
  });
});

describe('devinBroadPermission and devinPluginSource', () => {
  it('names the documented rules that match everything of their kind', () => {
    expect(
      ['exec', 'Exec(*)', 'edit', 'Write(**)', 'Write(/**)', 'Write(~/**)', 'mcp__*'].map(
        devinBroadPermission,
      ),
    ).toEqual([
      'runs any shell command',
      'runs any shell command',
      'edits any file',
      'writes any file below the working directory',
      'writes any file',
      'writes any file in the home directory',
      'calls any MCP tool',
    ]);
    for (const narrow of [
      'Exec(git)',
      'Read(**)',
      'Write(src/**)',
      'mcp__github__*',
      'read',
      'Exec',
    ]) {
      expect(devinBroadPermission(narrow), narrow).toBeUndefined();
    }
  });

  it('reads the dependency forms of the plugins page', () => {
    expect(devinPluginSource('acme/x')).toBe('acme/x');
    expect(devinPluginSource({ source: 'github', repo: 'acme/x' })).toBe('acme/x');
    expect(devinPluginSource({ source: 'url', url: 'git@github.com:acme/x.git' })).toBe(
      'git@github.com:acme/x.git',
    );
    expect(
      devinPluginSource({ source: 'git-subdir', url: 'u', path: 'p', sha: 's', ref: 'r' }),
    ).toBe('u#p (sha s)');
    // A path without `git-subdir` is not a subfolder source.
    expect(devinPluginSource({ source: 'github', repo: 'acme/x', path: 'p' })).toBe('acme/x');
    for (const none of [null, 3, '  ', [], {}, { repo: 4 }]) {
      expect(devinPluginSource(none)).toBeUndefined();
    }
  });
});
