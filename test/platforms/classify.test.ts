import { describe, expect, it } from 'vitest';
import {
  classify,
  classifyFile,
  isCandidateBasename,
  READERS,
} from '../../src/platforms/classify.js';
import { ARTIFACT_KINDS } from '../../src/core/types.js';

describe('classify', () => {
  it.each([
    ['AGENTS.md', 'agents-md'],
    ['packages/api/AGENTS.md', 'agents-md'],
    ['AGENTS.override.md', 'agents-override-md'],
    ['CLAUDE.md', 'claude-md'],
    ['.claude/CLAUDE.md', 'claude-md'],
    ['CLAUDE.local.md', 'claude-local-md'],
    ['.claude/rules/testing.md', 'claude-rule'],
    ['.claude/rules/frontend/react.md', 'claude-rule'],
    ['.claude/agents/reviewer.md', 'claude-agent'],
    ['.claude/commands/deploy.md', 'claude-command'],
    ['.claude/settings.json', 'claude-settings'],
    ['.claude/settings.local.json', 'claude-settings'],
    ['.claude-plugin/plugin.json', 'claude-plugin-manifest'],
    ['.mcp.json', 'mcp-json'],
    ['.claude/skills/deploy/SKILL.md', 'skill'],
    ['.agents/skills/pdf/SKILL.md', 'skill'],
    ['skills/pdf/SKILL.md', 'skill'],
    ['.codex/hooks.json', 'codex-hooks'],
    ['.cursor/rules/style.mdc', 'cursor-rule'],
    ['.cursor/rules/nested/style.mdc', 'cursor-rule'],
    ['.cursor/rules/style.md', 'cursor-rule-md'],
    ['.cursorrules', 'cursor-legacy-rules'],
    ['.cursor/hooks.json', 'cursor-hooks'],
    ['.cursor/mcp.json', 'cursor-mcp'],
    ['.github/copilot-instructions.md', 'copilot-instructions'],
    ['.github/instructions/ts.instructions.md', 'copilot-path-instructions'],
    ['docs/ts.instructions.md', 'copilot-path-instructions'],
    ['GEMINI.md', 'gemini-md'],
    ['.gemini/settings.json', 'gemini-settings'],
    ['.windsurf/rules/style.md', 'windsurf-rule'],
    ['.devin/rules/style.md', 'windsurf-rule'],
    ['.windsurfrules', 'windsurf-legacy-rules'],
    ['.clinerules/style.md', 'cline-rule'],
    ['.cline/rules/style.md', 'cline-rule'],
  ] as const)('classifies %s as %s', (path, kind) => {
    expect(classify(path)).toEqual({ kind });
  });

  it.each([
    'README.md',
    'docs/guide.md',
    'package.json',
    'src/agents.ts',
    'AGENTS.md.bak',
    'NOTAGENTS.md',
    '.cursor/rules',
  ])('ignores %s', (path) => {
    expect(classify(path)).toBeUndefined();
  });

  it.each([
    ['Agents.md', 'agents-md', 'AGENTS.md'],
    ['docs/Claude.md', 'claude-md', 'docs/CLAUDE.md'],
    ['skills/x/skill.md', 'skill', 'skills/x/SKILL.md'],
    ['Gemini.md', 'gemini-md', 'GEMINI.md'],
  ] as const)('flags case mismatch for %s', (path, kind, expected) => {
    expect(classify(path)).toEqual({ kind, caseMismatch: { expected } });
  });

  it('declares readers for every artifact kind', () => {
    for (const kind of ARTIFACT_KINDS) expect(READERS[kind]).toBeDefined();
    expect(READERS['cursor-rule-md']).toEqual(['windsurf']);
  });

  it('classifies a file the walker read for an import as imported-file, unless a pattern matches', () => {
    expect(classifyFile({ path: 'README.md', imported: true })).toEqual({ kind: 'imported-file' });
    expect(classifyFile({ path: 'docs/AGENTS.md', imported: true })).toEqual({ kind: 'agents-md' });
    expect(classifyFile({ path: 'README.md' })).toBeUndefined();
    expect(classifyFile({ path: 'CLAUDE.md' })).toEqual({ kind: 'claude-md' });
  });

  it('pre-filters candidate base names cheaply', () => {
    expect(isCandidateBasename('AGENTS.md')).toBe(true);
    expect(isCandidateBasename('rule.mdc')).toBe(true);
    expect(isCandidateBasename('.cursorrules')).toBe(true);
    expect(isCandidateBasename('.windsurfrules')).toBe(true);
    expect(isCandidateBasename('index.ts')).toBe(false);
  });
});

describe('classify: hook, MCP and settings files of Copilot, VS Code, Devin Local and Codex', () => {
  it.each([
    ['.github/hooks/policy.json', 'copilot-hooks'],
    ['pkg/.github/hooks/policy.json', 'copilot-hooks'],
    ['.github/mcp.json', 'copilot-mcp'],
    ['.vscode/mcp.json', 'vscode-mcp'],
    ['.github/copilot/settings.json', 'copilot-settings'],
    ['.github/copilot/settings.local.json', 'copilot-settings'],
    ['.devin/config.json', 'devin-config'],
    ['.devin/config.local.json', 'devin-config'],
    ['.devin/mcp_config.json', 'devin-mcp'],
    ['.devin/mcp_config.local.json', 'devin-mcp'],
    ['.devin/hooks.v1.json', 'devin-hooks'],
    ['.devin/hooks.json', 'devin-hooks'],
    ['.codex/config.toml', 'codex-config'],
    ['services/api/.codex/config.toml', 'codex-config'],
  ] as const)('classifies %s as %s', (path, kind) => {
    expect(classify(path)).toEqual({ kind });
  });

  it.each([
    '.github/hooks/nested/policy.json',
    '.github/hooks/readme.md',
    '.github/copilot/config.json',
    '.vscode/settings.json',
    '.devin/hooks.v2.json',
    '.devin/mcp.json',
    '.windsurf/hooks.json',
    'mcp.json',
    '.codex/config.toml.md',
  ])('does not classify %s', (path) => {
    expect(classify(path)).toBeUndefined();
  });

  it('lets the walker read config.toml, which only .codex/config.toml classifies', () => {
    expect(isCandidateBasename('config.toml')).toBe(true);
    expect(isCandidateBasename('Config.TOML')).toBe(true);
    expect(isCandidateBasename('pyproject.toml')).toBe(false);
    expect(isCandidateBasename('hooks.v1.json')).toBe(true);
    expect(classify('config.toml')).toBeUndefined();
    expect(classify('.cargo/config.toml')).toBeUndefined();
  });
});

describe('classify: what Cline treats as rules', () => {
  it.each([
    ['.clinerules/workflows/release.md', 'cline-workflow'],
    ['.clinerules/workflows/team/release.md', 'cline-workflow'],
    ['.cline/workflows/release.md', 'cline-workflow'],
    ['pkg/.clinerules/workflows/release.md', 'cline-workflow'],
    ['.clinerules/style.md', 'cline-rule'],
    ['.clinerules/backend/api.md', 'cline-rule'],
    ['.cline/rules/style.md', 'cline-rule'],
    // Only the folders of .clinerules are excluded, not those of .cline/rules.
    ['.cline/rules/hooks/notes.md', 'cline-rule'],
    ['.clinerules/skills/deploy/SKILL.md', 'skill'],
  ] as const)('classifies %s as %s', (path, kind) => {
    expect(classify(path)).toEqual({ kind });
  });

  it.each([
    '.clinerules/hooks/README.md',
    '.clinerules/skills/deploy/reference.md',
    '.cline/hooks/notes.md',
    '.cline/skills/deploy/reference.md',
    '.cline/notes.md',
  ])('does not classify %s, which Cline does not read as a rule', (path) => {
    expect(classify(path)).toBeUndefined();
  });
});

describe('classify: directory roles win over file names', () => {
  it.each([
    ['.claude/rules/CLAUDE.md', 'claude-rule'],
    ['.claude/agents/CLAUDE.md', 'claude-agent'],
    ['.claude/commands/CLAUDE.md', 'claude-command'],
    ['.claude/CLAUDE.md', 'claude-md'],
  ] as const)('classifies %s as %s', (path, kind) => {
    expect(classify(path)?.kind).toBe(kind);
  });
});

describe('classify: case variants only where they were plausibly meant', () => {
  it.each([
    ['docs/realtime/gemini.md'],
    ['docs/src/ai/agents.md'],
    ['docs/generated/sqlite-schema/skill.md'],
    ['public/acceptance/skill.md'],
  ])('ignores the documentation page %s', (path) => {
    expect(classify(path)).toBeUndefined();
  });

  it.each([
    ['agents.md', 'agents-md'],
    ['gemini.md', 'gemini-md'],
    ['.claude/skills/deploy/skill.md', 'skill'],
    ['packages/api/Agents.md', 'agents-md'],
  ] as const)('still flags %s', (path, kind) => {
    expect(classify(path)?.kind).toBe(kind);
    expect(classify(path)?.caseMismatch).toBeDefined();
  });
});
