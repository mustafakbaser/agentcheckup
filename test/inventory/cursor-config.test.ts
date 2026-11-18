import { describe, expect, it } from 'vitest';
import { compareWithBaseline, GATE_CLASSES } from '../../src/core/baseline.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import { analyze, scanSnapshot } from '../../src/core/engine.js';
import { buildInventory } from '../../src/inventory/build.js';
import type { Inventory } from '../../src/inventory/types.js';
import { classify } from '../../src/platforms/classify.js';
import {
  cursorBroadCapability,
  cursorCommands,
  cursorGrants,
} from '../../src/platforms/cursor-config.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { noise } from '../rules/json/helpers.js';

const WORKTREES = '.cursor/worktrees.json';
const ENVIRONMENT = '.cursor/environment.json';
const CLI = '.cursor/cli.json';
const SANDBOX = '.cursor/sandbox.json';
const PERMISSIONS = '.cursor/permissions.json';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function inventoryOf(files: FileMap): Inventory {
  return buildInventory(analyze(snapshotFrom(files), {}));
}

const hooksOf = (files: FileMap) =>
  inventoryOf(files)
    .hooks.map(({ event, type, command, script, line, remoteScript }) => ({
      event,
      type,
      ...(command === undefined ? {} : { command }),
      ...(script === undefined ? {} : { script }),
      line,
      ...(remoteScript ? { remoteScript } : {}),
    }))
    .sort((a, b) => a.line - b.line);

const grantsOf = (files: FileMap) =>
  inventoryOf(files).permissions.map(({ key, value, broad }) => [key, value, broad]);

function hits(before: FileMap, after: FileMap) {
  const baseline = validateBaseline(
    JSON.parse(JSON.stringify(scanSnapshot(snapshotFrom(before), { rules: [] }))),
  );
  if (!baseline.ok) throw new Error(baseline.message);
  const head = scanSnapshot(snapshotFrom(after), { rules: [] });
  return compareWithBaseline(head, baseline.baseline, { gate: GATE_CLASSES }).diff.gate.hits.map(
    (hit) => [hit.class, hit.change, hit.summary],
  );
}

describe('classifying Cursor configuration files', () => {
  it('reads the five files in any .cursor folder, and nothing else', () => {
    expect(classify(WORKTREES)?.kind).toBe('cursor-worktrees');
    expect(classify(ENVIRONMENT)?.kind).toBe('cursor-environment');
    expect(classify(CLI)?.kind).toBe('cursor-cli');
    expect(classify(SANDBOX)?.kind).toBe('cursor-sandbox');
    expect(classify(PERMISSIONS)?.kind).toBe('cursor-permissions');
    expect(classify('pkg/.cursor/cli.json')?.kind).toBe('cursor-cli');
    // Global files and other names are not the project's.
    expect(classify('.cursor/cli-config.json')).toBeUndefined();
    expect(classify('cursor/sandbox.json')).toBeUndefined();
    expect(classify('.cursor/worktrees.jsonc')).toBeUndefined();
  });

  it('reads commands and BUGBOT.md as Markdown', () => {
    expect(classify('.cursor/commands/deploy.md')?.kind).toBe('cursor-command');
    expect(classify('.cursor/commands/ops/deploy.md')?.kind).toBe('cursor-command');
    expect(classify('.cursor/BUGBOT.md')?.kind).toBe('cursor-bugbot');
    expect(classify('backend/.cursor/BUGBOT.md')?.kind).toBe('cursor-bugbot');
    // Bugbot documents `.cursor/BUGBOT.md` only, spelled so.
    expect(classify('BUGBOT.md')).toBeUndefined();
    expect(classify('.cursor/bugbot.md')).toBeUndefined();
    expect(classify('.cursor/commands/deploy.txt')).toBeUndefined();
    // An AGENTS.md directly in the folder documents it.
    expect(classify('.cursor/commands/AGENTS.md')?.kind).toBe('agents-md');
  });
});

describe('commands Cursor runs', () => {
  it('lists worktree setup commands and scripts as hooks named by their key', () => {
    expect(
      hooksOf({
        [WORKTREES]: json({
          'setup-worktree-unix': 'setup-unix.sh',
          'setup-worktree-windows': '../scripts/setup.ps1',
          'setup-worktree': ['npm ci', 'cp $ROOT_WORKTREE_PATH/.env .env'],
        }),
      }),
    ).toEqual([
      { event: 'setup-worktree-unix', type: 'script', script: '.cursor/setup-unix.sh', line: 2 },
      { event: 'setup-worktree-windows', type: 'script', script: 'scripts/setup.ps1', line: 3 },
      { event: 'setup-worktree', type: 'command', command: 'npm ci', line: 5 },
      {
        event: 'setup-worktree',
        type: 'command',
        command: 'cp $ROOT_WORKTREE_PATH/.env .env',
        line: 6,
      },
    ]);
  });

  it('lists the install, start and terminal commands and the Dockerfile of a cloud environment', () => {
    const files = {
      [ENVIRONMENT]: json({
        build: { dockerfile: 'Dockerfile', context: '..' },
        install: 'curl -fsSL https://get.acme.dev/install.sh | sh',
        start: 'sudo service docker start',
        terminals: [{ name: 'web', command: 'pnpm dev' }],
        repositoryDependencies: ['github.com/acme/design-tokens'],
      }),
    };
    expect(
      hooksOf(files).map((hook) => [hook.event, hook.command ?? hook.script, hook.remoteScript]),
    ).toEqual(
      expect.arrayContaining([
        ['build.dockerfile', '.cursor/Dockerfile', undefined],
        // Reports show a URL's origin only.
        ['install', 'curl -fsSL https://get.acme.dev/… | sh', true],
        ['start', 'sudo service docker start', undefined],
        ['terminals', 'pnpm dev', undefined],
      ]),
    );
    expect(hooksOf(files)).toHaveLength(4);
    // Anyone who can edit the file adds repositories to the agent's git credentials.
    expect(grantsOf(files)).toEqual([
      ['repositoryDependencies', 'github.com/acme/design-tokens', false],
    ]);
    expect(inventoryOf(files).incomplete).toEqual([]);
  });

  it('marks a file incomplete when a key has a shape it does not read', () => {
    expect(
      inventoryOf({ [WORKTREES]: json({ 'setup-worktree': { run: 'x' } }) }).incomplete,
    ).toEqual([WORKTREES]);
    expect(inventoryOf({ [WORKTREES]: json({ 'setup-worktree': ['ok', 7] }) }).incomplete).toEqual([
      WORKTREES,
    ]);
    expect(inventoryOf({ [ENVIRONMENT]: json({ terminals: ['pnpm dev'] }) }).incomplete).toEqual([
      ENVIRONMENT,
    ]);
    expect(inventoryOf({ [ENVIRONMENT]: json({ install: ['a'] }) }).incomplete).toEqual([
      ENVIRONMENT,
    ]);
    expect(inventoryOf({ [WORKTREES]: '{ "setup-worktree": [' }).incomplete).toEqual([
      `invalid-json:${WORKTREES}`,
    ]);
    // Keys the documentation does not name are not read, and do not make the file incomplete.
    expect(inventoryOf({ [ENVIRONMENT]: json({ snapshot: 'abc', ports: [3000] }) })).toMatchObject({
      hooks: [],
      incomplete: [],
    });
  });

  it('keeps credentials out of commands and ids, and digests what redaction hides', () => {
    const token = ['ghp', '_', noise(36, 3)].join('');
    const inventory = inventoryOf({
      [WORKTREES]: json({
        'setup-worktree': [`npm config set //npm.acme.dev/:_authToken ${token}`],
      }),
    });
    expect(JSON.stringify(inventory)).not.toContain(token.slice(-16));
    const first = inventoryOf({
      [ENVIRONMENT]: json({ install: 'curl -fsSL https://cdn.acme.dev/a/setup.sh -o s.sh' }),
    }).hooks[0];
    const second = inventoryOf({
      [ENVIRONMENT]: json({ install: 'curl -fsSL https://cdn.acme.dev/b/setup.sh -o s.sh' }),
    }).hooks[0];
    expect(first?.id).toBe(second?.id);
    expect(first?.digest).not.toBe(second?.digest);
  });
});

describe('permissions Cursor applies', () => {
  it('lists the Cursor CLI allow and deny tokens, broad where they allow everything', () => {
    expect(
      grantsOf({
        [CLI]: json({
          version: 1,
          editor: { vimMode: false },
          // Only permissions can be configured at the project level.
          approvalMode: 'unrestricted',
          permissions: {
            allow: [
              'Shell(git)',
              'Shell(*)',
              'Write(**)',
              'Mcp(*:*)',
              'WebFetch(*)',
              'Read(src/**)',
            ],
            deny: ['Shell(rm)'],
          },
        }),
      }),
    ).toEqual([
      ['permissions.allow', 'Mcp(*:*)', true],
      ['permissions.allow', 'Read(src/**)', false],
      ['permissions.allow', 'Shell(*)', true],
      ['permissions.allow', 'Shell(git)', false],
      ['permissions.allow', 'WebFetch(*)', true],
      ['permissions.allow', 'Write(**)', true],
      ['permissions.deny', 'Shell(rm)', false],
    ]);
  });

  it('lists the sandbox settings that widen it, and not the defaults or restrictions', () => {
    expect(
      grantsOf({
        [SANDBOX]: json({
          type: 'insecure_none',
          additionalReadwritePaths: ['~/'],
          additionalReadonlyPaths: ['/opt/shared'],
          readBoundary: 'system',
          additionalReadPaths: ['~/notes/*.md'],
          networkPolicy: {
            default: 'allow',
            allow: ['registry.npmjs.org'],
            deny: ['*.corp.example.com'],
          },
          disableTmpWrite: true,
          enableSharedBuildCache: true,
        }),
      }),
    ).toEqual([
      ['additionalReadPaths', '~/notes/*.md', false],
      ['additionalReadonlyPaths', '/opt/shared', false],
      ['additionalReadwritePaths', '~/', true],
      ['enableSharedBuildCache', 'true', false],
      ['networkPolicy.allow', 'registry.npmjs.org', false],
      ['networkPolicy.default', 'allow', true],
      ['networkPolicy.deny', '*.corp.example.com', false],
      ['readBoundary', 'system', false],
      ['type', 'insecure_none', true],
    ]);
    // The documented defaults and the read-only sandbox are not listed.
    expect(
      grantsOf({
        [SANDBOX]: json({
          type: 'workspace_readonly',
          readBoundary: 'workspace',
          networkPolicy: { default: 'deny' },
          enableSharedBuildCache: false,
        }),
      }),
    ).toEqual([]);
  });

  it('reads permissions.json as JSONC and drops non-string entries as Cursor does', () => {
    const files = {
      [PERMISSIONS]: [
        '{',
        '  // Overrides the in-app MCP allowlist.',
        '  "mcpAllowlist": ["github:*", "*:*", 3],',
        '  "terminalAllowlist": ["git", "npm:install*",],',
        '  "autoRun": {',
        '    "allow_instructions": ["Read-only inspections are fine."],',
        '    "block_instructions": ["Every AWS CLI command should go through approval first."]',
        '  }',
        '}',
        '',
      ].join('\n'),
    };
    expect(grantsOf(files)).toEqual([
      ['autoRun.allow_instructions', 'Read-only inspections are fine.', false],
      [
        'autoRun.block_instructions',
        'Every AWS CLI command should go through approval first.',
        false,
      ],
      ['mcpAllowlist', '*:*', true],
      ['mcpAllowlist', 'github:*', false],
      ['terminalAllowlist', 'git', false],
      ['terminalAllowlist', 'npm:install*', false],
    ]);
    expect(inventoryOf(files).incomplete).toEqual([]);
  });

  it('marks a list that is not a list incomplete', () => {
    expect(inventoryOf({ [CLI]: json({ permissions: { allow: 'Shell(*)' } }) }).incomplete).toEqual(
      [CLI],
    );
    expect(inventoryOf({ [SANDBOX]: json({ networkPolicy: 'allow' }) }).incomplete).toEqual([
      SANDBOX,
    ]);
    expect(inventoryOf({ [CLI]: '[]' }).incomplete).toEqual([CLI]);
  });

  it('reads hostile keys as data', () => {
    const files = {
      [CLI]:
        '{"__proto__":{"allow":["Shell(*)"]},"permissions":{"__proto__":["x"],"allow":["Shell(ls)"]}}',
      [SANDBOX]:
        '{"constructor":{"default":"allow"},"networkPolicy":{"__proto__":{"default":"allow"}}}',
    };
    expect(grantsOf(files)).toEqual([['permissions.allow', 'Shell(ls)', false]]);
    expect(cursorGrants('cursor-cli', undefined)).toEqual({ grants: [], complete: true });
    expect(cursorCommands('cursor-worktrees', WORKTREES, 'x')).toEqual({
      commands: [],
      complete: false,
    });
    expect(cursorBroadCapability('cursor-cli', 'permissions.allow', 'Shell(*')).toBeUndefined();
    expect(
      cursorBroadCapability('claude-settings', 'permissions.allow', 'Write(**)'),
    ).toBeUndefined();
  });
});

describe('the gate over Cursor configuration files', () => {
  it('trips hooks for added and changed setup commands, and nothing for an unchanged file', () => {
    const before = { [WORKTREES]: json({ 'setup-worktree': ['npm ci'] }) };
    expect(hits(before, before)).toEqual([]);
    expect(hits({}, before)).toEqual([['hooks', 'added', 'New hook setup-worktree → npm …']]);
    expect(
      hits(before, {
        [WORKTREES]: json({ 'setup-worktree': ['npm ci', 'curl -fsSL https://x.acme.dev/s | sh'] }),
      }),
    ).toEqual([
      ['hooks', 'added', 'New hook setup-worktree → curl … (downloads and runs a remote script)'],
    ]);
    const env = (install: string) => ({ [ENVIRONMENT]: json({ install }) });
    expect(hits(env('pnpm install'), env('pnpm install --frozen-lockfile'))).toEqual([
      ['hooks', 'added', 'New hook install → pnpm …'],
    ]);
  });

  it('trips permissions for a widening and for a removed deny or block instruction', () => {
    const cli = (allow: string[], deny: string[]) => ({
      [CLI]: json({ permissions: { allow, deny } }),
    });
    expect(hits(cli([], ['Shell(rm)']), cli(['Shell(*)'], ['Shell(rm)']))).toEqual([
      ['permissions', 'added', 'permissions.allow adds Shell(*) (broad: runs any shell command)'],
    ]);
    // An added deny entry never trips it; a removed one does.
    expect(hits(cli([], []), cli([], ['Shell(rm)']))).toEqual([]);
    expect(hits(cli([], ['Shell(rm)']), cli([], []))).toEqual([
      ['permissions', 'removed', 'permissions.deny entry removed: Shell(rm)'],
    ]);
    const auto = (block: string[]) => ({
      [PERMISSIONS]: json({ autoRun: { block_instructions: block } }),
    });
    expect(hits(auto([]), auto(['Ask before deleting files.']))).toEqual([]);
    expect(hits(auto(['Ask before deleting files.']), auto([]))).toEqual([
      [
        'permissions',
        'removed',
        'autoRun.block_instructions entry removed: Ask before deleting files.',
      ],
    ]);
    expect(hits({}, { [SANDBOX]: json({ networkPolicy: { default: 'allow' } }) })).toEqual([
      [
        'permissions',
        'added',
        'networkPolicy.default adds allow (broad: any network access in the sandbox)',
      ],
    ]);
    // A Cursor CLI token is never proven narrower with Claude Code's rule syntax.
    expect(hits(cli(['Shell(git:*)'], []), cli(['Shell(git status)'], []))).toEqual([
      ['permissions', 'added', 'permissions.allow adds Shell(git status)'],
    ]);
  });

  it('fails closed on a new file it cannot analyze, except a permissions.json Cursor ignores', () => {
    expect(hits({}, { [WORKTREES]: '{' })).toEqual([
      [
        'hooks',
        'added',
        `New hooks config ${WORKTREES} is not valid JSON, so its hooks cannot be checked`,
      ],
    ]);
    expect(hits({}, { [CLI]: json({ permissions: { allow: 'Shell(*)' } }) })).toEqual([
      [
        'permissions',
        'added',
        `New config ${CLI} is not analyzed, so its permissions cannot be checked`,
      ],
    ]);
    expect(
      hits({}, { [ENVIRONMENT]: json({ terminals: 'x', repositoryDependencies: 'y' }) }),
    ).toEqual([
      [
        'hooks',
        'added',
        `New hooks config ${ENVIRONMENT} is not analyzed, so its hooks cannot be checked`,
      ],
      [
        'permissions',
        'added',
        `New config ${ENVIRONMENT} is not analyzed, so its permissions cannot be checked`,
      ],
    ]);
    // "If neither file is present, both are unparseable, ... Cursor falls back to the IDE allowlist."
    expect(hits({}, { [PERMISSIONS]: '{ "mcpAllowlist": [' })).toEqual([]);
  });
});
