import { describe, expect, it } from 'vitest';
import { scanSnapshot } from '../../../src/core/engine.js';
import { builtinRules } from '../../../src/rules/index.js';
import {
  type RepoContextFacts,
  renderContextSection,
  scanForSummary,
} from '../../../scripts/corpus/context-stats.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

const AGENTS = '# Project\n\nRun `pnpm test` before you push.\n';
const CLAUDE = '# Claude Code\n\nUse plan mode for migrations.\n';
const MCP = JSON.stringify({
  mcpServers: {
    browser: { command: 'npx', args: ['-y', '@acme/browser-mcp'] },
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'] },
    docs: { type: 'http', url: 'https://docs.example.com/mcp' },
  },
});
const SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'scripts/guard.sh' }] }],
  },
});

function facts(files: FileMap, extras: SnapshotExtras = {}): RepoContextFacts {
  const { facts: result } = scanForSummary(
    snapshotFrom(files, { ...extras, paths: ['.git/', ...(extras.paths ?? [])] }),
  );
  expect(result.crash).toBeUndefined();
  return result;
}

describe('scanForSummary', () => {
  it('returns the findings scanSnapshot returns', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE, '.mcp.json': MCP });
    const { result } = scanForSummary(snapshot);
    const expected = scanSnapshot(snapshot, { rules: builtinRules, trustDirectives: false });
    expect(result.findings).toEqual(expected.findings);
    expect(result.score).toEqual(expected.score);
  });

  it('records a root AGENTS.md that Claude Code skips for a CLAUDE.md', () => {
    const repo = facts({ 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE });
    expect(repo.rootAgentsMd).toBe(true);
    expect(repo.claudeSkipsRootAgentsMd).toBe(true);
    expect(repo.skippingAgents).toEqual(['claude-code']);
    expect(repo.skipCodes).toEqual(['shadowed-by-claude-md']);
    expect(repo.startupInstructions).toEqual({
      'claude-code': ['CLAUDE.md'],
      codex: ['AGENTS.md'],
      cursor: ['AGENTS.md', 'CLAUDE.md'],
      'copilot-cli': ['AGENTS.md', 'CLAUDE.md'],
      'copilot-vscode': ['AGENTS.md', 'CLAUDE.md'],
      'copilot-cloud': ['AGENTS.md', 'CLAUDE.md'],
      gemini: [],
      windsurf: ['AGENTS.md', 'CLAUDE.md'],
      cline: ['AGENTS.md'],
    });
    expect(repo.instructionTokens.codex).toBe(Math.ceil(AGENTS.length / 4));
  });

  it('does not count an AGENTS.md that Claude Code reads through a symlinked CLAUDE.md', () => {
    const repo = facts(
      { 'AGENTS.md': AGENTS, 'CLAUDE.md': AGENTS },
      { symlinks: { 'CLAUDE.md': 'AGENTS.md' } },
    );
    expect(repo.claudeSkipsRootAgentsMd).toBe(false);
    expect(repo.skippingAgents).toEqual([]);
  });

  it('does not count an AGENTS.md that every agent reads', () => {
    const repo = facts({ 'AGENTS.md': AGENTS });
    expect(repo.claudeSkipsRootAgentsMd).toBe(false);
    expect(repo.startupInstructions['claude-code']).toEqual(['AGENTS.md']);
    expect(repo.startupInstructions.codex).toEqual(['AGENTS.md']);
    expect(repo.startupInstructions.cursor).toEqual(['AGENTS.md']);
  });

  it('counts MCP servers by pin and hooks that fail open', () => {
    const repo = facts({
      'CLAUDE.md': CLAUDE,
      '.mcp.json': MCP,
      '.claude/settings.json': SETTINGS,
      'scripts/guard.sh': '#!/bin/sh\nexit 0\n',
    });
    expect(repo.mcpServers).toBe(3);
    expect(repo.localServers).toBe(2);
    expect(repo.remoteServers).toBe(1);
    expect(repo.unpinnedServers).toBe(1);
    expect(repo.hooks).toBe(1);
    expect(repo.failOpenHooks).toBe(1);
  });

  it('finds a Codex chain over the byte limit in a working directory, not in a skill', () => {
    const big = `# Rules\n\n${'- Keep handlers small.\n'.repeat(1600)}`;
    const inSkill = facts({
      'AGENTS.md': AGENTS,
      '.agents/skills/react/SKILL.md': '---\nname: react\ndescription: React rules.\n---\n',
      '.agents/skills/react/AGENTS.md': big,
    });
    expect(inSkill.codexOverBudget).toEqual({ root: false, anyDirectory: false });

    const nested = facts({ 'AGENTS.md': AGENTS, 'services/AGENTS.md': big });
    expect(nested.codexOverBudget).toEqual({ root: false, anyDirectory: true });
  });
});

describe('renderContextSection', () => {
  const repos = [
    facts({ 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE, '.mcp.json': MCP }),
    facts({ 'AGENTS.md': AGENTS }),
    facts({ 'secret-project/README.md': '# nothing for agents\n' }),
  ];

  it('adds up counts across repositories', () => {
    const text = renderContextSection(repos);
    // Gemini CLI reads only GEMINI.md without context.fileName, so it loads none of these.
    expect(text).toContain('| The agents load different instructions | 2 of 2 |');
    expect(text).toContain('| Some agent loads no instructions at all | 2 of 2 |');
    expect(text).toContain('| Devin Local skips one | 0 |');
    expect(text).toContain('| Gemini CLI: instructions | 0 | 0 | 0 | 0 |');
    expect(text.split('\n')[0]).toMatch(
      /^What Claude Code, Codex, Cursor, .* Devin Local and Cline load /,
    );
    expect(text).not.toContain('three');
    expect(text).toContain(
      '| Claude Code skips the root `AGENTS.md` and reads a `CLAUDE.md` instead | 1 of 2 |',
    );
    expect(text).toContain('| Unpinned local MCP servers | 1 | 1 |');
    expect(text).toContain('| Loader crashes | 0 |');
  });

  it('names no repository, path or server', () => {
    const text = renderContextSection(repos);
    for (const name of ['secret-project', 'browser', 'github', 'docs.example.com', '.mcp.json']) {
      expect(text).not.toContain(name);
    }
  });

  it('is deterministic and independent of repository order', () => {
    expect(renderContextSection([...repos].reverse())).toBe(renderContextSection(repos));
  });

  it('plans and shows only the agents selected with --agents', () => {
    const files = { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE };
    const snapshot = snapshotFrom(files, { paths: ['.git/'] });
    const { facts: codex } = scanForSummary(snapshot, undefined, ['codex']);
    expect(codex.crash).toBeUndefined();
    expect(codex.startupInstructions).toEqual({ codex: ['AGENTS.md'] });
    // Claude Code is not planned, so its skip of AGENTS.md is not counted.
    expect(codex.skippingAgents).toEqual([]);
    expect(codex.claudeSkipsRootAgentsMd).toBe(false);
    const text = renderContextSection([codex], ['codex']);
    expect(text).toContain('| Codex skips one | 0 |');
    expect(text).not.toContain('Claude Code skips one');
    expect(text).not.toContain('Cursor: instructions');
  });
});
