import { describe, expect, it } from 'vitest';
import { rebaseResult, stripPathBase } from '../../src/core/rebase.js';
import type { ScanResult } from '../../src/core/engine.js';
import { withContext } from '../helpers/context.js';
import { richResult as rich } from '../report/fixtures.js';

const full = withContext(rich);

describe('rebaseResult', () => {
  it('returns the same object for an empty prefix', () => {
    expect(rebaseResult(rich, '')).toBe(rich);
    expect(rebaseResult(rich, '.')).toBe(rich);
  });

  it('prefixes every path, and only paths', () => {
    const rebased: ScanResult = rebaseResult(rich, 'packages/app/');
    const paths = [
      ...rebased.artifacts.map((artifact) => artifact.path),
      ...rebased.findings.flatMap((finding) => [
        finding.path,
        ...finding.related.map((related) => related.path),
      ]),
      ...rebased.score.artifacts.map((artifact) => artifact.path),
      ...rebased.skipped.map((entry) => entry.path),
      ...rebased.unresolvedSymlinks.map((entry) => entry.path),
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith('packages/app/')).toBe(true);
    expect(rebased.findings.map((finding) => finding.message)).toEqual(
      rich.findings.map((finding) => finding.message),
    );
    expect(rebased.score.score).toBe(rich.score.score);
  });

  it('records the prefix in pathBase, composing repeated rebases', () => {
    expect(rebaseResult(rich, 'packages/app/').pathBase).toBe('packages/app');
    expect(rebaseResult(rebaseResult(rich, 'app'), 'packages').pathBase).toBe('packages/app');
    expect(rebaseResult(rebaseResult(rich, 'app'), 'packages')).toEqual(
      rebaseResult(rich, 'packages/app'),
    );
  });

  it('rebases plan, inventory and baseline paths and the ids that embed them', () => {
    const rebased = rebaseResult(full, 'repo');
    const plans = rebased.context?.plans ?? [];
    const claude = plans[0]!;
    expect(claude.cwd).toBe('repo/packages/api');
    expect(plans[2]?.cwd).toBe('repo');
    expect(claude.entries[1]).toMatchObject({
      id: 'import:repo/AGENTS.md',
      path: 'repo/AGENTS.md',
      realPath: 'repo/AGENTS.md',
      via: ['repo/CLAUDE.md'],
    });
    expect(claude.skipped[1]?.id).toBe('mcp-server:repo/.mcp.json#docs');
    expect(claude.outOfScope[0]?.path).toBe('repo/.claude/skills/deploy/scripts/run.md');
    expect(claude.limits[0]?.subject).toBe('repo/.claude/skills/deploy/SKILL.md');
    expect(plans[1]?.incomplete).toEqual(['unparsed:repo/.codex/config.toml']);
    expect(rebased.context?.matrix?.rows[0]?.path).toBe('repo/.agents/skills/release-notes');

    const inventory = rebased.inventory;
    expect(inventory.mcpServers[2]).toMatchObject({
      id: 'mcp:repo/.mcp.json#github',
      file: 'repo/.mcp.json',
    });
    expect(inventory.permissions[0]?.id).toBe(
      'perm:repo/.claude/settings.json#permissions.allow=Bash(curl:*)',
    );
    expect(inventory.incomplete).toEqual(['repo/.codex/config.toml']);

    const baseline = rebased.baseline!;
    expect(baseline.findings.resolved.map((entry) => entry.path)).toEqual([
      'repo/CLAUDE.md',
      'repo/docs/old.md',
    ]);
    expect(baseline.inventory.removed).toEqual(['mcp:repo/.mcp.json#legacy']);
    expect(baseline.context[1]?.limits[0]?.subject).toBe('repo/packages/api');
    expect(baseline.context[0]?.entries.added).toEqual([
      'instructions:repo/packages/api/CLAUDE.md',
    ]);
  });

  it('keeps load entries linked to their inventory items', () => {
    const rebased = rebaseResult(full, 'repo');
    const ids = new Set([
      ...rebased.inventory.mcpServers.map((item) => item.id),
      ...rebased.inventory.hooks.map((item) => item.id),
    ]);
    const links = (rebased.context?.plans ?? []).flatMap((item) =>
      item.entries.flatMap((value) => (value.inventoryId === undefined ? [] : [value.inventoryId])),
    );
    expect(links.length).toBeGreaterThan(2);
    for (const link of links) expect(ids.has(link)).toBe(true);
    const hits = rebased.baseline!.gate.hits;
    for (const hit of hits.filter((value) => value.class !== 'unicode')) {
      expect(
        ids.has(hit.id) || hit.id.startsWith('perm:repo/') || hit.id.startsWith('env:repo/'),
      ).toBe(true);
    }
  });

  it('leaves text that is not a repository path alone', () => {
    const rebased = rebaseResult(full, 'repo');
    const api = rebased.context?.plans[0]?.entries.find(
      (value) => value.path === 'repo/.claude/rules/api.md',
    );
    expect(api?.patterns).toEqual(['src/api/**']);
    expect(rebased.context?.plans[0]?.hidden).toEqual(full.context?.plans[0]?.hidden);
    expect(rebased.inventory.hooks[0]?.script).toBe('scripts/hooks/guard.sh');
    expect(rebased.inventory.mcpServers[2]?.args).toEqual(full.inventory.mcpServers[2]?.args);
    expect(rebased.baseline?.gate.hits.find((hit) => hit.class === 'unicode')?.id).toBe(
      '3c4d5e6f708192:1',
    );
    expect(rebased.baseline?.gate.hits.map((hit) => hit.summary)).toEqual(
      full.baseline?.gate.hits.map((hit) => hit.summary),
    );
  });
});

describe('stripPathBase', () => {
  it('undoes rebaseResult', () => {
    for (const prefix of ['repo', 'packages/app', 'a#b/c:d']) {
      expect(stripPathBase(rebaseResult(full, prefix))).toEqual(full);
      expect(stripPathBase(rebaseResult(rich, prefix))).toEqual(rich);
    }
  });

  it('returns results without a base as they are', () => {
    expect(stripPathBase(rich)).toBe(rich);
    expect(stripPathBase({ ...rich, pathBase: '' }).pathBase).toBe('');
  });

  it('leaves paths outside the base alone', () => {
    const odd: ScanResult = { ...rich, pathBase: 'elsewhere' };
    const stripped = stripPathBase(odd);
    expect(stripped.findings.map((finding) => finding.path)).toEqual(
      rich.findings.map((finding) => finding.path),
    );
    expect(stripped.pathBase).toBeUndefined();
  });
});
