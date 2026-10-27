import { describe, expect, it } from 'vitest';
import { rebaseResult, stripPathBase } from '../../src/core/rebase.js';
import type { AgentDefinition, ModelSetting } from '../../src/agents/types.js';
import type { ScanResult } from '../../src/core/engine.js';
import type { FileChange, Fix } from '../../src/core/types.js';
import { withContext } from '../helpers/context.js';
import { richResult as rich } from '../report/fixtures.js';
import { hostileResult } from '../report/hostile.js';

const full = withContext(rich);

/** Every path a fix changes, in its alternatives too. */
function fixPaths(fix: Fix | undefined): string[] {
  if (fix === undefined) return [];
  const paths = (change: FileChange): string[] =>
    change.kind === 'rename' ? [change.from, change.to] : [change.path];
  return [...fix.changes.flatMap(paths), ...(fix.alternatives ?? []).flatMap(fixPaths)];
}

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
        ...fixPaths(finding.fix),
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
    // A subagent's preloaded skill and memory file are paths too.
    const reviewer = claude.entries.find((item) => item.role === 'subagent')?.ownContext;
    expect(reviewer?.parts.map((part) => part.path)).toEqual([
      undefined,
      undefined,
      'repo/.claude/skills/docs/SKILL.md',
    ]);
    expect(reviewer?.memory?.path).toBe('repo/.claude/agent-memory/reviewer/MEMORY.md');
    expect(claude.outOfScope[0]?.path).toBe('repo/.claude/skills/deploy/scripts/run.md');
    expect(claude.limits.map((limit) => [limit.subject, limit.label])).toEqual([
      ['repo/packages/api', 'skills listing'],
      ['repo/.claude/skills/deploy/SKILL.md', undefined],
    ]);
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

  it('rebases the paths a fix changes, in alternatives too, and leaves its text alone', () => {
    const fixed = hostileResult.findings.find((finding) => finding.fix?.alternatives);
    const rebased = rebaseResult(hostileResult, 'repo').findings.find(
      (finding) => finding.fingerprint === fixed?.fingerprint && finding.fix?.alternatives,
    );
    expect(fixPaths(fixed?.fix)).toHaveLength(5);
    expect(fixPaths(rebased?.fix)).toEqual(fixPaths(fixed?.fix).map((path) => `repo/${path}`));
    const text = (fix: Fix | undefined) => [
      fix?.id,
      fix?.title,
      fix?.notes,
      fix?.warning,
      fix?.changes.map((change) =>
        change.kind === 'edit' ? change.edits : change.kind === 'create' ? change.text : undefined,
      ),
      fix?.alternatives?.map((alternative) => alternative.title),
    ];
    expect(text(rebased?.fix)).toEqual(text(fixed?.fix));
    expect(rebased?.guidance).toBe(fixed?.guidance);
    expect(stripPathBase(rebaseResult(hostileResult, 'repo'))).toEqual(hostileResult);
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

describe('agent definitions and model settings', () => {
  const definition: AgentDefinition = {
    id: 'agent:.claude/agents/reviewer.md@claude-code',
    file: '.claude/agents/reviewer.md',
    line: 2,
    agent: 'claude-code',
    name: 'reviewer',
    status: 'shadowed',
    reason: 'another definition has the same name',
    shadowedBy: '.cursor/agents/reviewer.md',
    model: { value: 'opus', form: 'alias', line: 4 },
    effective: {
      value: 'haiku',
      source: 'setting',
      file: '.claude/settings.json',
      overridden: {
        key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
        file: '.claude/settings.local.json',
      },
    },
    tools: 'inherited',
    certainty: 'documented',
    evidence: ['claudeSubagents'],
    digest: 'd',
  };
  const setting: ModelSetting = {
    id: 'model:.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
    agent: 'claude-code',
    file: '.claude/settings.json',
    line: 3,
    key: 'env.CLAUDE_CODE_SUBAGENT_MODEL',
    value: 'haiku',
    applies: 'subagents',
    digest: 's',
  };
  const withAgents: ScanResult = {
    ...full,
    agents: { definitions: [definition], settings: [setting] },
    baseline: {
      ...full.baseline!,
      agents: {
        added: [definition.id],
        removed: [],
        changed: [{ id: setting.id, fields: ['value'] }],
      },
    },
  };

  it('rebases their files, ids and the files they name, and leaves text alone', () => {
    const rebased = rebaseResult(withAgents, 'repo');
    expect(rebased.agents).toEqual({
      definitions: [
        {
          ...definition,
          id: 'agent:repo/.claude/agents/reviewer.md@claude-code',
          file: 'repo/.claude/agents/reviewer.md',
          shadowedBy: 'repo/.cursor/agents/reviewer.md',
          effective: {
            ...definition.effective,
            file: 'repo/.claude/settings.json',
            overridden: {
              key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
              file: 'repo/.claude/settings.local.json',
            },
          },
        },
      ],
      settings: [
        {
          ...setting,
          id: 'model:repo/.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
          file: 'repo/.claude/settings.json',
        },
      ],
    });
    expect(rebased.baseline?.agents).toEqual({
      added: ['agent:repo/.claude/agents/reviewer.md@claude-code'],
      removed: [],
      changed: [
        {
          id: 'model:repo/.claude/settings.json#env.CLAUDE_CODE_SUBAGENT_MODEL',
          fields: ['value'],
        },
      ],
    });
    expect(stripPathBase(rebased)).toEqual(withAgents);
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
