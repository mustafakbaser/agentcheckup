import type { RuleSource } from '../core/types.js';

/**
 * Canonical evidence for rules and loaders. Every rule cites at least one of these, and load
 * plans cite them by key. src/rules/sources.ts re-exports this table and documents how it is
 * maintained.
 */
const CHECKED = '2026-10-14';

const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

export const SOURCES = {
  agentSkillsSpec: verified('Agent Skills specification', 'https://agentskills.io/specification'),
  skillsRefValidator: verified(
    'agentskills skills-ref reference validator',
    'https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py',
  ),
  claudeSkills: verified('Claude Code: Skills', 'https://code.claude.com/docs/en/skills'),
  claudeApiSkills: verified(
    'Claude API: Agent Skills overview',
    'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview',
  ),
  claudeMemory: verified(
    'Claude Code: Memory (CLAUDE.md)',
    'https://code.claude.com/docs/en/memory',
  ),
  claudeSettings: verified('Claude Code: Settings', 'https://code.claude.com/docs/en/settings'),
  claudeHooks: verified('Claude Code: Hooks', 'https://code.claude.com/docs/en/hooks'),
  claudeMcp: verified('Claude Code: MCP', 'https://code.claude.com/docs/en/mcp'),
  claudeSubagents: verified('Claude Code: Subagents', 'https://code.claude.com/docs/en/sub-agents'),
  claudePlugins: verified(
    'Claude Code: Plugins reference',
    'https://code.claude.com/docs/en/plugins-reference',
  ),
  codexAgentsMd: verified(
    'Codex: AGENTS.md',
    'https://learn.chatgpt.com/docs/agent-configuration/agents-md',
  ),
  codexAgentsMdSource: verified(
    'Codex source: agents_md.rs',
    'https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs',
  ),
  codexSkills: verified('Codex: Build skills', 'https://learn.chatgpt.com/docs/build-skills'),
  codexHooks: verified('Codex: Hooks', 'https://learn.chatgpt.com/docs/hooks'),
  cursorRules: verified('Cursor: Rules', 'https://cursor.com/docs/rules'),
  cursorSkills: verified('Cursor: Skills', 'https://cursor.com/docs/skills'),
  cursorHooks: verified('Cursor: Hooks', 'https://cursor.com/docs/hooks'),
  cursorMcp: verified('Cursor: MCP', 'https://cursor.com/docs/mcp'),
  copilotRepoInstructions: verified(
    'GitHub Copilot: Repository custom instructions',
    'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions',
  ),
  copilotSkills: verified(
    'GitHub Copilot: About agent skills',
    'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills',
  ),
  geminiMd: verified('Gemini CLI: GEMINI.md', 'https://geminicli.com/docs/cli/gemini-md/'),
  geminiImports: verified(
    'Gemini CLI: Memory import processor',
    'https://geminicli.com/docs/reference/memport/',
  ),
  geminiHooks: verified('Gemini CLI: Hooks', 'https://geminicli.com/docs/hooks/'),
  geminiMcp: verified('Gemini CLI: MCP servers', 'https://geminicli.com/docs/tools/mcp-server/'),
  windsurfRules: verified(
    'Devin Desktop (Windsurf): Memories and rules',
    'https://docs.devin.ai/desktop/cascade/memories',
  ),
  clineRules: verified('Cline: Rules', 'https://docs.cline.bot/customization/cline-rules'),
  agentsMd: verified('AGENTS.md open format', 'https://agents.md/'),
  unicodeTagSmuggling: verified(
    'Unicode Technical Standard #39: Security mechanisms',
    'https://www.unicode.org/reports/tr39/',
  ),
} as const satisfies Record<string, RuleSource>;
