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
  codexDefaults: verified(
    'Codex source: defaults.toml (project_doc_max_bytes = 32768, project_root_markers)',
    'https://github.com/openai/codex/blob/main/codex-rs/config/defaults.toml',
  ),
  codexFindUp: verified(
    'Codex source: find_up.rs (nearest ancestor with a project root marker)',
    'https://github.com/openai/codex/blob/main/codex-rs/file-system/src/find_up.rs',
  ),
  codexConfigBasic: verified(
    'Codex: Config basics',
    'https://learn.chatgpt.com/docs/config-file/config-basic',
  ),
  codexConfigAdvanced: verified(
    'Codex: Advanced configuration',
    'https://learn.chatgpt.com/docs/config-file/config-advanced',
  ),
  codexMcp: verified('Codex: MCP', 'https://learn.chatgpt.com/docs/extend/mcp'),
  codexSkills: verified('Codex: Build skills', 'https://learn.chatgpt.com/docs/build-skills'),
  codexSkillParser: verified(
    'Codex source: SKILL.md frontmatter parser (parser.rs)',
    'https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs',
  ),
  codexSkillLoader: verified(
    'Codex source: skill loader (default name from the directory)',
    'https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/host.rs',
  ),
  codexSkillDiscovery: verified(
    'Codex source: skill discovery (exact SKILL.md name, recursive scan)',
    'https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/discovery.rs',
  ),
  codexSkillLimits: verified(
    'Codex source: skill scan limits (MAX_SCAN_DEPTH = 6, MAX_SKILLS_DIRS_PER_ROOT = 2000)',
    'https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/mod.rs',
  ),
  codexSkillRoots: verified(
    'Codex source: skill roots (.agents/skills up to the project root, project config folders)',
    'https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs',
  ),
  codexReadFileText: verified(
    'Codex source: read_file_text decodes UTF-8 without removing a byte order mark',
    'https://github.com/openai/codex/blob/main/codex-rs/file-system/src/lib.rs',
  ),
  codexHooks: verified('Codex: Hooks', 'https://learn.chatgpt.com/docs/hooks'),
  codexHookConfig: verified(
    'Codex source: hook_config.rs (event names, hooks.json schema)',
    'https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs',
  ),
  codexHookDiscovery: verified(
    'Codex source: hooks/src/engine/discovery.rs (parse errors, timeouts)',
    'https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs',
  ),
  cursorRules: verified('Cursor: Rules', 'https://cursor.com/docs/rules'),
  cursorRulesHelp: verified('Cursor Help: Rules', 'https://cursor.com/help/customization/rules'),
  cursorSkills: verified('Cursor: Skills', 'https://cursor.com/docs/skills'),
  cursorThirdPartyHooks: {
    title: 'Cursor: Third-party hooks',
    url: 'https://cursor.com/docs/reference/third-party-hooks',
    checked: '2026-10-15',
    status: 'verified',
  },
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
