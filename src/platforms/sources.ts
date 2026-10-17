import type { RuleSource } from '../core/types.js';

/**
 * Canonical evidence for rules and loaders. Every rule cites at least one of these, and load
 * plans cite them by key. src/rules/sources.ts re-exports this table and documents how it is
 * maintained.
 */
const CHECKED = '2026-10-14';

/**
 * Sources for the Copilot, Gemini CLI, Devin Local and Cline loaders and for Codex
 * `config.toml`. Source code was read at openai/codex ce0323f, google-gemini/gemini-cli
 * ed96fae and cline/cline a42df8c; links point to the `main` branch, as the others do.
 */
const COVERAGE_CHECKED = '2026-10-17';

const verified = (title: string, url: string, checked = CHECKED): RuleSource => ({
  title,
  url,
  checked,
  status: 'verified',
});

export const SOURCES = {
  agentSkillsSpec: verified('Agent Skills specification', 'https://agentskills.io/specification'),
  skillsRefValidator: verified(
    'agentskills skills-ref reference validator',
    'https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py',
  ),
  claudeSkills: verified(
    'Claude Code: Skills',
    'https://code.claude.com/docs/en/skills',
    '2026-10-17',
  ),
  claudeApiSkills: verified(
    'Claude API: Agent Skills overview',
    'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview',
  ),
  claudeMemory: verified(
    'Claude Code: Memory (CLAUDE.md)',
    'https://code.claude.com/docs/en/memory',
  ),
  claudeSettings: verified('Claude Code: Settings', 'https://code.claude.com/docs/en/settings'),
  claudeSettingsReference: verified(
    'Claude Code: All settings',
    'https://code.claude.com/docs/en/settings-reference',
    '2026-10-15',
  ),
  claudeEnvVars: verified(
    'Claude Code: Environment variables',
    'https://code.claude.com/docs/en/env-vars',
    '2026-10-15',
  ),
  claudeNetworkConfig: verified(
    'Claude Code: Enterprise network configuration',
    'https://code.claude.com/docs/en/network-config',
    '2026-10-15',
  ),
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
  codexConfigReference: verified(
    'Codex: Configuration reference',
    'https://learn.chatgpt.com/docs/config-file/config-reference',
    COVERAGE_CHECKED,
  ),
  codexMcpTypes: verified(
    'Codex source: mcp_types.rs (transport from command or url, startup timeouts)',
    'https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs',
    COVERAGE_CHECKED,
  ),
  codexConfigLoader: verified(
    'Codex source: config loader (.codex/config.toml from the project root down, parse errors, project key denylist)',
    'https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs',
    COVERAGE_CHECKED,
  ),
  codexHookState: verified(
    'Codex source: config_rules.rs (hooks.state only from user and session layers)',
    'https://github.com/openai/codex/blob/main/codex-rs/hooks/src/config_rules.rs',
    COVERAGE_CHECKED,
  ),
  tomlSpec: verified('TOML v1.0.0', 'https://toml.io/en/v1.0.0', COVERAGE_CHECKED),
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
  copilotInstructionsSupport: verified(
    'GitHub Copilot: Support for different types of custom instructions',
    'https://docs.github.com/en/copilot/reference/custom-instructions-support',
    COVERAGE_CHECKED,
  ),
  copilotCliInstructions: verified(
    'GitHub Copilot CLI: Add custom instructions',
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions',
    COVERAGE_CHECKED,
  ),
  copilotCodeReview: verified(
    'GitHub Copilot: Customize code review',
    'https://docs.github.com/en/copilot/tutorials/customize-code-review',
    COVERAGE_CHECKED,
  ),
  copilotAddSkills: verified(
    'GitHub Copilot: Add skills',
    'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills',
    COVERAGE_CHECKED,
  ),
  copilotHooks: verified(
    'GitHub Copilot: About hooks',
    'https://docs.github.com/en/copilot/concepts/agents/hooks',
    COVERAGE_CHECKED,
  ),
  copilotHooksReference: verified(
    'GitHub Copilot: Hooks reference',
    'https://docs.github.com/en/copilot/reference/hooks-reference',
    COVERAGE_CHECKED,
  ),
  copilotCloudMcp: verified(
    'GitHub Copilot cloud agent: Configure MCP servers',
    'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers',
    COVERAGE_CHECKED,
  ),
  copilotCliMcp: verified(
    'GitHub Copilot CLI: Add MCP servers',
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers',
    COVERAGE_CHECKED,
  ),
  vscodeInstructions: verified(
    'VS Code: Custom instructions',
    'https://code.visualstudio.com/docs/agent-customization/custom-instructions',
    COVERAGE_CHECKED,
  ),
  vscodeSkills: verified(
    'VS Code: Agent skills',
    'https://code.visualstudio.com/docs/agent-customization/agent-skills',
    COVERAGE_CHECKED,
  ),
  vscodeHooks: verified(
    'VS Code: Hooks',
    'https://code.visualstudio.com/docs/agent-customization/hooks',
    COVERAGE_CHECKED,
  ),
  vscodeHooksReference: verified(
    'VS Code: Hooks reference',
    'https://code.visualstudio.com/docs/agents/reference/hooks-reference',
    COVERAGE_CHECKED,
  ),
  vscodeMcp: verified(
    'VS Code: MCP configuration reference',
    'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
    COVERAGE_CHECKED,
  ),
  geminiMd: verified('Gemini CLI: GEMINI.md', 'https://geminicli.com/docs/cli/gemini-md/'),
  geminiImports: verified(
    'Gemini CLI: Memory import processor',
    'https://geminicli.com/docs/reference/memport/',
  ),
  geminiHooks: verified('Gemini CLI: Hooks', 'https://geminicli.com/docs/hooks/'),
  geminiMcp: verified('Gemini CLI: MCP servers', 'https://geminicli.com/docs/tools/mcp-server/'),
  geminiSkills: verified(
    'Gemini CLI: Agent skills',
    'https://geminicli.com/docs/cli/skills/',
    COVERAGE_CHECKED,
  ),
  geminiTrustedFolders: verified(
    'Gemini CLI: Trusted folders',
    'https://geminicli.com/docs/cli/trusted-folders/',
    COVERAGE_CHECKED,
  ),
  geminiConfiguration: verified(
    'Gemini CLI: Configuration',
    'https://geminicli.com/docs/reference/configuration/',
    COVERAGE_CHECKED,
  ),
  geminiAntigravity: verified(
    'Google for Developers: Transitioning Gemini CLI to Antigravity CLI',
    'https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/',
    COVERAGE_CHECKED,
  ),
  geminiCliConfigSource: verified(
    'Gemini CLI source: cli/src/config/config.ts (context.fileName sets the context file names)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts',
    COVERAGE_CHECKED,
  ),
  geminiSettingsSource: verified(
    'Gemini CLI source: settings.ts (workspace settings of the working directory)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts',
    COVERAGE_CHECKED,
  ),
  geminiMemoryToolSource: verified(
    'Gemini CLI source: memoryTool.ts (GEMINI.md is the default context file name)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/memoryTool.ts',
    COVERAGE_CHECKED,
  ),
  geminiDiscoverySource: verified(
    'Gemini CLI source: memoryDiscovery.ts (context files from the root down)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts',
    COVERAGE_CHECKED,
  ),
  geminiImportSource: verified(
    'Gemini CLI source: memoryImportProcessor.ts (import depth 5, path traversal)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts',
    COVERAGE_CHECKED,
  ),
  geminiSkillLoaderSource: verified(
    'Gemini CLI source: skillLoader.ts (SKILL.md one level deep, name and description required)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts',
    COVERAGE_CHECKED,
  ),
  windsurfRules: verified(
    'Devin Desktop (Windsurf): Memories and rules',
    'https://docs.devin.ai/desktop/cascade/memories',
  ),
  devinLocal: verified(
    'Devin Desktop: Devin Local',
    'https://docs.devin.ai/desktop/devin-local',
    COVERAGE_CHECKED,
  ),
  devinCliRules: verified(
    'Devin CLI: Rules',
    'https://docs.devin.ai/cli/extensibility/rules',
    COVERAGE_CHECKED,
  ),
  devinReadConfigFrom: verified(
    'Devin CLI: read_config_from',
    'https://docs.devin.ai/cli/reference/configuration/read-config-from',
    COVERAGE_CHECKED,
  ),
  devinCliSkills: verified(
    'Devin CLI: Skills',
    'https://docs.devin.ai/cli/extensibility/skills/overview',
    COVERAGE_CHECKED,
  ),
  devinCliHooks: verified(
    'Devin CLI: Hooks',
    'https://docs.devin.ai/cli/extensibility/hooks/overview',
    COVERAGE_CHECKED,
  ),
  devinCliHookEvents: verified(
    'Devin CLI: Lifecycle hooks',
    'https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks',
    COVERAGE_CHECKED,
  ),
  devinCliMcp: verified(
    'Devin CLI: MCP configuration',
    'https://docs.devin.ai/cli/extensibility/mcp/configuration',
    COVERAGE_CHECKED,
  ),
  clineRules: verified('Cline: Rules', 'https://docs.cline.bot/customization/cline-rules'),
  clineConfig: verified(
    'Cline: Configuration',
    'https://docs.cline.bot/getting-started/config',
    COVERAGE_CHECKED,
  ),
  clineSkills: verified(
    'Cline: Skills',
    'https://docs.cline.bot/customization/skills',
    COVERAGE_CHECKED,
  ),
  clineHooks: verified(
    'Cline: Hooks',
    'https://docs.cline.bot/customization/hooks',
    COVERAGE_CHECKED,
  ),
  clinePlugins: verified(
    'Cline SDK: Plugins',
    'https://docs.cline.bot/sdk/plugins',
    COVERAGE_CHECKED,
  ),
  clineMcp: verified(
    'Cline: MCP overview',
    'https://docs.cline.bot/mcp/mcp-overview',
    COVERAGE_CHECKED,
  ),
  clineRulesSource: verified(
    'Cline source: cline-rules.ts (workflows, hooks and skills in .clinerules are not rules)',
    'https://github.com/cline/cline/blob/main/apps/vscode/src/core/context/instructions/user-instructions/cline-rules.ts',
    COVERAGE_CHECKED,
  ),
  clineInstructionLoaderSource: verified(
    'Cline source: user-instruction-config-loader.ts (.md, .markdown and .txt rules; root AGENTS.md)',
    'https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts',
    COVERAGE_CHECKED,
  ),
  clinePathsSource: verified(
    'Cline source: storage/paths.ts (rule folders, root AGENTS.md, workflow folders)',
    'https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts',
    COVERAGE_CHECKED,
  ),
  agentsMd: verified('AGENTS.md open format', 'https://agents.md/'),
  nodeCliEnv: verified(
    'Node.js: Command-line API, environment variables',
    'https://nodejs.org/api/cli.html',
    '2026-10-15',
  ),
  ldSo: verified(
    'ld.so(8): Linux manual page',
    'https://man7.org/linux/man-pages/man8/ld.so.8.html',
    '2026-10-15',
  ),
  unicodeTagSmuggling: verified(
    'Unicode Technical Standard #39: Security mechanisms',
    'https://www.unicode.org/reports/tr39/',
  ),
} as const satisfies Record<string, RuleSource>;
