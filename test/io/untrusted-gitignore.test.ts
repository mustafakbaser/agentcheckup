/**
 * WalkOptions.scanIgnoredAgentConfig (`--untrusted`): a scanned repository's own .gitignore must
 * not hide agent configuration it commits anyway (`git add -f .mcp.json`), because agents load it.
 * Everything else keeps the .gitignore behavior of a trusted scan.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { scanSnapshot } from '../../src/core/engine.js';
import { PLATFORM_IDS } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import { builtinRules } from '../../src/rules/index.js';
import {
  filePaths,
  link,
  makeTempDir,
  removeTempDirs,
  symlinksSupported,
  writeTree,
} from './helpers.js';

afterEach(removeTempDirs);

const UNTRUSTED = { scanIgnoredAgentConfig: true } as const;

describe('walk: .gitignore and agent configuration in untrusted mode', () => {
  it('lists and reads ignored agent configuration, and records it', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '.mcp.json\n.claude/\nCLAUDE.local.md\nnotes.md\n',
      '.mcp.json': '{"mcpServers":{}}',
      '.claude/settings.json': '{"hooks":{}}',
      '.claude/hooks/guard.sh': 'exit 0',
      'CLAUDE.local.md': 'personal',
      'notes.md': 'ordinary',
      'AGENTS.md': 'kept',
    });

    const snapshot = await walk(root, UNTRUSTED);

    expect(filePaths(snapshot)).toEqual([
      '.claude/settings.json',
      '.mcp.json',
      'AGENTS.md',
      'CLAUDE.local.md',
    ]);
    expect([...(snapshot.gitignoredConfig ?? [])]).toEqual([
      '.claude/',
      '.claude/hooks/',
      '.claude/settings.json',
      '.mcp.json',
      'CLAUDE.local.md',
    ]);
    // What is not agent configuration stays ignored, below an ignored config directory too.
    expect([...snapshot.ignoredFiles]).toEqual(['.claude/hooks/guard.sh', 'notes.md']);
    expect(snapshot.paths.has('.claude/hooks/')).toBe(true);
    expect(snapshot.paths.has('notes.md')).toBe(false);
    expect([...snapshot.opaqueDirectories]).toEqual([]);
    expect(snapshot.gitignoreApplied).toBe(true);
  });

  it('keeps the trusted behavior by default', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '.mcp.json\n.claude/\nCLAUDE.local.md\n',
      '.mcp.json': '{}',
      '.claude/settings.json': '{}',
      'CLAUDE.local.md': 'personal',
    });

    const snapshot = await walk(root);

    expect(filePaths(snapshot)).toEqual([]);
    expect(snapshot.gitignoredConfig).toBeUndefined();
    expect([...snapshot.ignoredFiles]).toEqual(['.mcp.json', 'CLAUDE.local.md']);
    expect([...snapshot.opaqueDirectories]).toEqual(['.claude/']);
  });

  it('keeps ordinary ignored files and directories hidden, and the hard excludes', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'secret/\n*.log\ndocs/private.md\nnode_modules/\n.claude/worktrees/\n',
      'secret/notes.md': 'hidden',
      'debug.log': 'hidden',
      'docs/private.md': 'hidden',
      'docs/public.md': 'listed',
      'node_modules/pkg/.claude/settings.json': '{}',
      '.claude/worktrees/feature/CLAUDE.md': 'a checkout',
      '.claude/settings.json': '{}',
    });

    const snapshot = await walk(root, UNTRUSTED);

    expect(filePaths(snapshot)).toEqual(['.claude/settings.json']);
    expect([...snapshot.ignoredFiles]).toEqual(['debug.log', 'docs/private.md']);
    expect([...snapshot.opaqueDirectories]).toEqual([
      '.claude/worktrees/',
      'node_modules/',
      'secret/',
    ]);
    // Hard-excluded directories are listed but never entered, ignored or not.
    expect([...(snapshot.gitignoredConfig ?? [])]).toEqual(['.claude/worktrees/']);
  });

  it('leaves ignored ordinary directories and import targets hidden (docs: Limitations)', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'packages/\ndocs/\n',
      'packages/x/.claude/settings.json': '{"permissions":{"allow":["Bash"]}}',
      'CLAUDE.md': '@docs/guide.md\n',
      'docs/guide.md': 'Guide.\n',
    });

    const untrusted = await walk(root, UNTRUSTED);
    expect(filePaths(untrusted)).toEqual(['CLAUDE.md']);
    expect([...untrusted.opaqueDirectories]).toEqual(['docs/', 'packages/']);

    // --no-gitignore scans everything.
    const everything = await walk(root, { ...UNTRUSTED, respectGitignore: false });
    expect(filePaths(everything)).toEqual([
      'CLAUDE.md',
      'docs/guide.md',
      'packages/x/.claude/settings.json',
    ]);
  });

  it('descends into nested ignored configuration directories', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': 'packages/app/.cursor/\n',
      'packages/app/.gitignore': '.claude\nskills/\n',
      'packages/app/.cursor/mcp.json': '{"mcpServers":{}}',
      'packages/app/.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\n',
      'packages/app/.claude/skills/deploy/scripts/run.sh': 'echo',
      'packages/app/.claude/rules/style.md': 'rule',
      'packages/app/skills/review/SKILL.md': '---\nname: review\n---\n',
    });

    const snapshot = await walk(root, UNTRUSTED);

    expect(filePaths(snapshot)).toEqual([
      'packages/app/.claude/rules/style.md',
      'packages/app/.claude/skills/deploy/SKILL.md',
      'packages/app/.cursor/mcp.json',
      'packages/app/skills/review/SKILL.md',
    ]);
    expect([...snapshot.ignoredFiles]).toEqual([
      'packages/app/.claude/skills/deploy/scripts/run.sh',
    ]);
    expect(snapshot.gitignoredConfig?.has('packages/app/.claude/skills/deploy/scripts/')).toBe(
      true,
    );
    expect([...snapshot.opaqueDirectories]).toEqual([]);
  });

  it.skipIf(!symlinksSupported)(
    'follows an ignored link to configuration inside the root',
    async () => {
      const root = await makeTempDir();
      await writeTree(root, {
        '.gitignore': '.claude\n.mcp.json\n/notes.md\n',
        'shared/claude/settings.json': '{}',
        'shared/mcp.json': '{}',
        'shared/notes.md': 'x',
      });
      await link(root, '.claude', 'shared/claude');
      await link(root, '.mcp.json', 'shared/mcp.json');
      await link(root, 'notes.md', 'shared/notes.md');

      const snapshot = await walk(root, UNTRUSTED);

      expect(snapshot.files.map((file) => [file.path, file.symlinkTarget])).toEqual([
        ['.claude/settings.json', 'shared/claude/settings.json'],
        ['.mcp.json', 'shared/mcp.json'],
      ]);
      expect([...(snapshot.gitignoredConfig ?? [])]).toEqual([
        '.claude/',
        '.claude/settings.json',
        '.mcp.json',
      ]);
      expect([...snapshot.ignoredFiles]).toEqual(['notes.md']);
    },
  );

  it('lets the PR gate see an ignored MCP server, without a false not-ignored finding', async () => {
    const root = await makeTempDir();
    await writeTree(root, {
      '.gitignore': '.mcp.json\nCLAUDE.local.md\n',
      '.mcp.json': '{"mcpServers":{"evil":{"command":"npx","args":["-y","evil-mcp"]}}}',
      'CLAUDE.local.md': 'Personal notes.\n',
    });
    const options = { rules: builtinRules, targets: PLATFORM_IDS, trustDirectives: false };

    const trusted = scanSnapshot(await walk(root), options);
    const untrusted = scanSnapshot(await walk(root, UNTRUSTED), options);

    expect(trusted.inventory.mcpServers).toEqual([]);
    expect(untrusted.inventory.mcpServers.map((server) => server.id)).toEqual([
      'mcp:.mcp.json#evil',
    ]);
    const ruleIds = untrusted.findings.map((finding) => finding.ruleId);
    expect(ruleIds).not.toContain('settings/local-file-not-ignored');
  });
});
