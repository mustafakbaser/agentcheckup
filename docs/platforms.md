# What coding agents read

Last verified: 2026-10-30 for the Copilot CLI's rules, commands, skills and repository settings, Copilot hooks, VS Code's agent harnesses, Cursor and Devin Desktop; 2026-10-27 for what a Claude Code subagent starts with and Claude Code's skill listing; 2026-10-26 for custom agents and subagents; 2026-10-17 for GitHub Copilot, Gemini CLI, Cline and Codex `config.toml`; 2026-10-14 for the rest

This page lists the configuration files that seven coding agents read, where each agent looks for them, in what order, and which limits apply. Every fact links to the vendor documentation or source code it comes from. Anything we could not confirm is marked **Unverified**.

How to read this page:

- "source" links point to the agent's source code. Use them where the documentation is silent or disagrees.
- "—" in a table means the agent's documentation does not mention the file.
- Paths are relative to the repository root unless they start with `~` or `/`.

`agentcheckup context` turns this page into load plans for nine agents: Claude Code, Codex, Cursor, GitHub Copilot as three agents (Copilot CLI, Copilot in VS Code and the Copilot cloud agent, because each surface reads different files), Gemini CLI, Devin Local (the default agent of Devin Desktop, id `windsurf`) and Cline. See [What each agent loads](context.md).

For a setup that shares one configuration across all seven agents, see [One configuration for every agent](portability.md). The custom agents and subagents each agent reads, and the models they run on, are in [Agent definitions and models](agents.md).

## Summary

| File                                              | Claude Code                                                                                                                           | Codex                                                                                                                                      | Cursor                                                                                                       | GitHub Copilot                                                                                                                                                                                                    | Gemini CLI                                                                                                                                                    | Devin Desktop (Windsurf)                                                                                                                                                                        | Cline                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                                       | Only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` is in the working directory or above (v2.1.277+) [docs][cc-memory] | Yes: `~/.codex`, then one file per directory from the project root to the working directory [docs][codex-agents-md]                        | Yes: root and subdirectories [docs][cursor-rules]                                                            | Yes: nearest file wins (GitHub.com); root to working directory (CLI); workspace root (VS Code) [docs][gh-repo-instructions] [CLI][gh-cli-instructions] [VS Code][vscode-instructions]                             | Only if listed in `context.fileName` [docs][gemini-md]                                                                                                        | Yes: root file always on, subdirectory files scoped to their directory [docs][devin-customizations]                                                                                             | Yes: project root only, and `~/.agents/AGENTS.md` [docs][cline-rules] [source][cline-src-paths]                                |
| `CLAUDE.md`                                       | Yes: managed, `~/.claude/`, working directory and above; subdirectories on demand [docs][cc-memory]                                   | Only as a `project_doc_fallback_filenames` entry [docs][codex-agents-md]                                                                   | Yes: project root, always applied [docs][cursor-rules-help]                                                  | Yes: root file (GitHub.com); also `.claude/CLAUDE.md` (CLI); also `.claude/CLAUDE.md` and `CLAUDE.local.md` (VS Code) [docs][gh-repo-instructions] [CLI][gh-cli-instructions] [VS Code][vscode-instructions]      | Only if listed in `context.fileName` [docs][gemini-md]                                                                                                        | Devin Local: yes, and `~/.claude/CLAUDE.md` [docs][devin-cli-rules]                                                                                                                             | —                                                                                                                              |
| `GEMINI.md`                                       | —                                                                                                                                     | Only as a `project_doc_fallback_filenames` entry [docs][codex-agents-md]                                                                   | —                                                                                                            | Yes: root file (GitHub.com); standard locations (CLI) [docs][gh-repo-instructions] [CLI][gh-cli-instructions]                                                                                                     | Yes: `~/.gemini/`, workspace and parents, then just in time; also when `context.fileName` names other files [docs][gemini-md] [source][gemini-src-memorytool] | —                                                                                                                                                                                               | —                                                                                                                              |
| Rule files                                        | `.claude/rules/**/*.md`, `~/.claude/rules/` [docs][cc-memory]                                                                         | — (Codex "rules" control commands) [docs][codex-rules]                                                                                     | `.cursor/rules/**/*.mdc`; `.md` files there are ignored [docs][cursor-rules]                                 | `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`; CLI and VS Code also `.claude/rules/` [docs][gh-repo-instructions] [CLI][gh-cli-ref] [VS Code][vscode-instructions]               | —                                                                                                                                                             | `.devin/rules/*.md`, `.windsurf/rules/*.md`; Devin Local also `.cursor/rules/` [docs][devin-customizations] [Local][devin-cli-rules]                                                            | `.clinerules/` except its `workflows/`, `hooks/` and `skills/`, `.cline/rules/` [docs][cline-rules] [source][cline-src-rules]  |
| Single-file legacy rules                          | —                                                                                                                                     | —                                                                                                                                          | `.cursorrules`: legacy, "will be deprecated" [help][cursor-rules-help]                                       | —                                                                                                                                                                                                                 | —                                                                                                                                                             | `.windsurfrules` [docs][devin-customizations]                                                                                                                                                   | `.cursorrules`, `.windsurfrules`; a `.clinerules` file [docs][cline-rules] [source][cline-src-loader]                          |
| Skills (`SKILL.md`)                               | `.claude/skills/`, `~/.claude/skills/`; not `.agents/` [docs][cc-skills] [memory][cc-memory]                                          | `.agents/skills/` from the working directory up to the repository root, `~/.agents/skills/`, `/etc/codex/skills` [docs][codex-skills]      | `.agents/`, `.cursor/`, `.claude/` and `.codex/` `skills/`, in the project and in `~/` [docs][cursor-skills] | `.github/`, `.claude/` and `.agents/` `skills/`; `~/.copilot/skills/`, `~/.agents/skills/` [docs][gh-skills]                                                                                                      | `.gemini/skills/`, `.agents/skills/`, in the project and in `~/` [docs][gemini-skills]                                                                        | `.devin/`, `.windsurf/` and `.agents/` `skills/`; Devin Local also imports `.claude/` and `.github/` `skills/` [docs][devin-customizations] [Local][devin-cli-import]                           | `.cline/`, `.clinerules/`, `.claude/` and `.agents/` `skills/`; `~/.cline/skills/` [docs][cline-skills] [config][cline-config] |
| Custom agents and subagents                       | `.claude/agents/**/*.md`, `~/.claude/agents/` [docs][cc-subagents]                                                                    | `.codex/agents/**/*.toml`, roles in `.codex/config.toml` [docs][codex-subagents]                                                           | `.cursor/agents/`, `.claude/agents/`, `.codex/agents/` (Markdown) [docs][cursor-subagents]                   | `.github/agents/`: VS Code the folder itself, CLI subfolders too, cloud agent `*.agent.md`; VS Code and CLI also `.claude/agents/` [VS Code][vscode-custom-agents] [CLI][gh-cli-agents] [cloud][gh-custom-agents] | `.gemini/agents/*.md` [docs][gemini-subagents]                                                                                                                | Devin Local: `.devin/agents/`, `.agents/agents/` (experimental) [docs][devin-cli-subagents]                                                                                                     | —                                                                                                                              |
| Imports in instruction files                      | `@path`, up to 4 hops [docs][cc-memory]                                                                                               | None [source][codex-src-agents-md]                                                                                                         | None; `@file` in a rule is a pointer [docs][cursor-rules]                                                    | CLI: `@path` [docs][gh-cli-instructions]                                                                                                                                                                          | `@path`, up to 5 levels [docs][gemini-memport]                                                                                                                | —                                                                                                                                                                                               | —                                                                                                                              |
| MCP config in the repository                      | `.mcp.json` [docs][cc-mcp]                                                                                                            | `.codex/config.toml` from the project root to the working directory (trusted projects) [docs][codex-mcp] [source][codex-src-config-loader] | `.cursor/mcp.json` [docs][cursor-mcp]                                                                        | CLI: `.mcp.json`, `.github/mcp.json`; VS Code: `.vscode/mcp.json`, `.mcp.json`; cloud agent: repository settings, not a file [CLI][gh-cli-mcp] [VS Code][vscode-mcp-ref] [cloud][gh-cloud-mcp]                    | `.gemini/settings.json` [docs][gemini-mcp]                                                                                                                    | Devin Local: `.devin/mcp_config.json`; imports `.mcp.json`, `.cursor/mcp.json`, `.claude/settings.json`, `opencode.json`, `.zed/settings.json` [docs][devin-cli-mcp] [import][devin-cli-import] | None documented; user-level file only [docs][cline-mcp]                                                                        |
| Hooks config in the repository                    | `.claude/settings.json`, `.claude/settings.local.json` [docs][cc-hooks]                                                               | `.codex/hooks.json`, `.codex/config.toml` (trusted projects) [docs][codex-hooks]                                                           | `.cursor/hooks.json`; Claude Code settings files [docs][cursor-hooks] [Claude format][cursor-hooks-claude]   | `.github/hooks/*.json`; CLI also `.claude/settings.json` [docs][gh-hooks-ref]                                                                                                                                     | `.gemini/settings.json` [docs][gemini-hooks]                                                                                                                  | Devin Local: `.devin/hooks.v1.json`, `.claude/settings.json`; Cascade: `.devin/hooks.json` [Local][devin-cli-hooks] [Cascade (archived)][devin-hooks]                                           | Plugin hooks in JavaScript or TypeScript [docs][cline-plugins]                                                                 |
| Hook crashes, exits non-zero (not 2) or times out | Action proceeds; `"onFailure": "block"` blocks [docs][cc-hooks]                                                                       | Action proceeds [docs][codex-hooks]                                                                                                        | Action proceeds; `"failClosed": true` blocks [docs][cursor-hooks]                                            | `preToolUse`: denied, except on timeout; other events proceed [docs][gh-hooks-ref]                                                                                                                                | Action proceeds with a warning; timeouts not documented [docs][gemini-hooks]                                                                                  | Action proceeds [Local][devin-cli-hooks] [Cascade (archived)][devin-hooks]                                                                                                                      | Run continues (`hookErrorMode: "ignore"`) [docs][cline-plugins]                                                                |
| Hook timeout unit and default                     | Seconds; 600 for command hooks [docs][cc-hooks]                                                                                       | Seconds; 600 [docs][codex-hooks]                                                                                                           | Seconds; default not documented [docs][cursor-hooks]                                                         | Seconds; 30 [docs][gh-hooks]                                                                                                                                                                                      | Milliseconds; 60,000 [docs][gemini-hooks]                                                                                                                     | Seconds (Devin Local); default not documented [docs][devin-cli-hooks]                                                                                                                           | 3 seconds per hook call [docs][cline-plugins]                                                                                  |

## Claude Code

### Files and locations

| File              | Locations                                                                                                                                                                                                                                                              | Source                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `CLAUDE.md`       | Managed: `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux and WSL), `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows). User: `~/.claude/CLAUDE.md`. Project: `./CLAUDE.md` or `./.claude/CLAUDE.md`.                   | [Memory][cc-memory]             |
| `CLAUDE.local.md` | `./CLAUDE.local.md`, for personal notes. The docs say to add it to `.gitignore`; agentcheckup reports one that is not ignored.                                                                                                                                         | [Memory][cc-memory]             |
| `AGENTS.md`       | `AGENTS.md` and `.claude/AGENTS.md` in the working directory and above, under the conditions in the next section. Never read: `AGENTS.local.md`, `AGENTS.override.md`, anything under `.agents/`.                                                                      | [Memory][cc-memory]             |
| Rules             | `.claude/rules/**/*.md` (recursive), `~/.claude/rules/`                                                                                                                                                                                                                | [Memory][cc-memory]             |
| Skills            | Enterprise: `.claude/skills/<name>/SKILL.md` in the managed settings directory. Personal: `~/.claude/skills/<name>/SKILL.md`. Project: `.claude/skills/<name>/SKILL.md`. Nested: `<subdir>/.claude/skills/<name>/SKILL.md`. Plugin: `<plugin>/skills/<name>/SKILL.md`. | [Skills][cc-skills]             |
| Commands          | `.claude/commands/**/*.md`, the older format. A skill with the same name wins.                                                                                                                                                                                         | [Skills][cc-skills]             |
| Subagents         | `.claude/agents/**/*.md`, `~/.claude/agents/**/*.md`, managed `.claude/agents/`                                                                                                                                                                                        | [Subagents][cc-subagents]       |
| Settings          | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings                                                                                                                                                                    | [Settings][cc-settings]         |
| MCP               | `.mcp.json` at the project root (project scope); `~/.claude.json` (local and user scope)                                                                                                                                                                               | [MCP][cc-mcp]                   |
| Plugins           | `.claude-plugin/plugin.json`. A `CLAUDE.md` at the plugin root is not loaded. A folder of the working directory's `.claude/skills/` with a `.claude-plugin/plugin.json` loads as the plugin `<name>@skills-dir`.                                                       | [Plugins reference][cc-plugins] |

### Discovery and precedence

- `CLAUDE.md` and `CLAUDE.local.md` in the working directory and every directory above it load at launch. A file in a subdirectory loads the first time Claude reads, writes or edits a file in that subdirectory. [Memory][cc-memory]
- Files are concatenated, not overridden. The order is managed, user, then project files from the filesystem root down to the working directory. In each directory, `CLAUDE.local.md` comes after `CLAUDE.md`. Instructions closer to the working directory are read last. [Memory][cc-memory]
- User rules load before project rules. A rule without `paths` loads at launch with the same priority as `.claude/CLAUDE.md`. A path-scoped rule loads when Claude reads, writes or edits a matching file. [Memory][cc-memory]
- `AGENTS.md` requires v2.1.277 or later. In the default mode, `claude-md-or-agents-md`, Claude Code reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above it. `~/.claude/CLAUDE.md`, the managed `CLAUDE.md` and `.claude/rules/` do not count. When it does read `AGENTS.md`, a subdirectory's `AGENTS.md` loads when Claude opens a file there with the Read tool and that subdirectory has no `CLAUDE.md` files. [Memory][cc-memory]
- Other modes: `claude-md-and-agents-md` (each directory's `CLAUDE.md` files first, then its `AGENTS.md`), `claude-md`, `managed-only`. The mode is read from `~/.claude/settings.json`, a `--settings` file or managed settings, and ignored in project and local settings. [Memory][cc-memory]
- Block-level HTML comments are removed before the content reaches the model. Comments inside code blocks are kept. [Memory][cc-memory]
- Skills with the same name: enterprise wins over personal, personal over project. Project skills load from `.claude/skills/` in the working directory and every parent up to the repository root. A nested `.claude/skills/` loads the first time Claude reads or edits a file in that subdirectory. [Skills][cc-skills]
- Subagents with the same name: managed, then the `--agents` flag, then `.claude/agents/`, then `~/.claude/agents/`, then plugins. [Subagents][cc-subagents]
- Settings, highest precedence first: managed, `--settings`, `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`. Lists such as `permissions.allow` merge. `permissions.defaultMode` values `auto` and `bypassPermissions` do not take effect from project or local settings (since v2.1.257); agentcheckup reports this. [Settings][cc-settings]
- `env` in project and local settings cannot set variables "that a checked-out repository shouldn't control": Claude Code drops, among others, `CLAUDE_CONFIG_DIR`, `HOME` and the `XDG_*` variables, the OpenTelemetry exporter variables (`OTEL_EXPORTER_OTLP_*` names ending in `_ENDPOINT`, `_HEADERS`, `_PROTOCOL`, `_CERTIFICATE`, `_CLIENT_KEY` or `_INSECURE`, the exporter selectors, the content switches), `BETA_TRACING_ENDPOINT`, `CLAUDE_CODE_PROCESS_WRAPPER` and `CLAUDE_CODE_PLUGIN_SEED_DIR`, keeping only values that turn telemetry off (v2.1.282+ for the OpenTelemetry group). agentcheckup lists these overrides as not effective. [Settings reference][cc-settings-reference], [Environment variables][cc-env-vars]
- Which project settings files a session reads: `.claude/settings.json` of the working directory, with no fallback to the directories above it, and `.claude/settings.local.json` of the git repository root, also in a session started in a subdirectory (since v2.1.211). A `.claude/settings.local.json` that an earlier version left in the starting directory is still read; where both local files set a key, the root's value applies. On Windows, outside a git repository, and when the repository root is the home directory or not owned by the user, the local file stays next to `.claude/settings.json`; agentcheckup's plans assume macOS or Linux. [Settings][cc-settings], [Permissions][cc-permissions]

### Imports

- Syntax: `@path` anywhere in the file, except in code spans and fenced code blocks. Relative paths resolve from the importing file. Absolute paths and `~/` paths work. [Memory][cc-memory]
- Imported files can import other files, up to four hops. [Memory][cc-memory]
- Escape spaces with a backslash, as in `@Design\ Docs/api.md`. A quoted path is never imported. [Memory][cc-memory]
- An import in a project file that resolves outside the working directory needs approval once per project. If you decline, those imports stay disabled. [Memory][cc-memory]
- Imported files load at launch, so imports organize a file but do not reduce its context cost. [Memory][cc-memory]
- In an `AGENTS.md` read through the **Project instructions** setting, imports are expanded too. An import outside the working directory loads only if external imports were already approved for the project. [Memory][cc-memory]
- A `CLAUDE.md` that is a symlink, such as `CLAUDE.md -> AGENTS.md`, is read through the link, so the target's imports are expanded as the `CLAUDE.md`'s. The docs do not say whether relative imports then resolve from the link's directory or from the target's; this matters only when the two differ, as in `.claude/CLAUDE.md -> ../AGENTS.md` (**Unverified**). agentcheckup resolves them from the link's directory, like Gemini CLI, and marks what depends on it as unverified. [Memory][cc-memory]

### Size limits and truncation

- `CLAUDE.md`: a file up to 4 MiB loads in full; a larger file is skipped. The recommended size is under 200 lines per file; agentcheckup reports longer files. Claude Code warns at startup when a file is over the recommended length or when files add up past a combined limit. [Memory][cc-memory]
- Files that load on demand: a subdirectory's `CLAUDE.md` or `CLAUDE.local.md` and the files it imports, the rules of a subdirectory's `.claude/rules/`, and path-scoped rules. Claude receives only the start of such a file, with a note to read the rest: 40,000 characters in a 200K context window; in a 1M window, 200,000 on Claude Opus 4.6 and Sonnet 4.6 and 150,000 on later models (since v2.1.309). agentcheckup cuts these files at 40,000 characters, or at 150,000 with `--context-window` of 1,000,000 or more, and shows where the cut falls. The docs name no limit for a nested `AGENTS.md`. [Memory][cc-memory]
- Rules: the patterns in one rule's `paths` share a budget of 1,000 expanded brace patterns and 4 MiB. A pattern that exceeds it is used unexpanded and matches no files. [Memory][cc-memory]
- Skills: the listing always holds every skill's name; the combined `description` and `when_to_use` text is cut at 1,536 characters (`skillListingMaxDescChars`). The listing budget is 1% of the context window (`skillListingBudgetFraction`). When the listing overflows, descriptions of the least-used skills are dropped first. A skill with `disable-model-invocation: true` is not in the listing and loads only when the user runs `/name`. `skillOverrides` in the settings lists a skill by `name-only`, hides it from the model (`user-invocable-only`) or turns it `off`. The docs recommend keeping `SKILL.md` under 500 lines. [Skills][cc-skills]
- After compaction, Claude Code re-attaches the latest invocation of each skill, keeping the first 5,000 tokens of each, within 25,000 tokens in total. [Skills][cc-skills]

### Frontmatter fields

- `CLAUDE.md` and `AGENTS.md`: no frontmatter fields are documented. [Memory][cc-memory]
- Rules: `paths` is the only field read, as a YAML list or a comma-separated string. Other fields are ignored without an error. If the YAML does not parse, the frontmatter is ignored and the rule loads as if it had no `paths`, that is, always. A pattern with a `[` that is not a valid bracket expression matches nothing; the rule's other patterns still work. [Memory][cc-memory]
- Skills: frontmatter is read only when `---` is the first line. All fields are optional. `name` defaults to the directory name and `description` to the first non-empty line of the body. Unknown fields are ignored without an error. If the YAML does not parse, the skill loads with no fields, so `/name` works but Claude cannot match the skill on its description. Some invalid YAML may never reach that point: the agentcheckup rule authors report that the Claude Code 2.1.300 bundle repairs an unquoted `: ` inside a top-level value. The docs do not describe this repair (**Unverified**). Booleans accept `yes`, `no`, `on`, `off`, `1` and `0` (v2.1.218+). [Skills][cc-skills]
- Skill fields: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility` (up to 500 characters). [Skills][cc-skills]
- Skills uploaded to claude.ai, sent through the Skills API or packaged with `package_skill.py` may use only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. Any other field is a hard error. There, `name` is at most 64 characters of lowercase letters, digits and hyphens, with no XML tags and without the words "anthropic" or "claude". `description` is non-empty, at most 1,024 characters, with no XML tags. [Skills][cc-skills], [Agent Skills overview][claude-api-skills]
- Claude Code refuses a skill or command name that contains a zero-width, control, private-use, unassigned or text-direction character, `<`, `>`, or any blank other than single spaces between words. [Skills][cc-skills]
- `` !`command` `` (at the start of a line or after whitespace) and ` ```! ` blocks run before the model sees the skill. They never prompt: each command is checked against permission rules. Outside auto mode, a command that is not allowed, or one that fails, aborts the whole skill. [Skills][cc-skills]
- `allowed-tools` is not gated by workspace trust. It applies even in a `-p` run in a folder that was never trusted. [Skills][cc-skills]
- Subagents: `name` (required; at most 256 characters; no `:`; no leading `-`) and `description` (required). A file without `name` is treated as documentation and skipped without a message. A missing `description` or invalid YAML skips the file, with the reason only in the debug log. [Subagents][cc-subagents]
- Subagent context: each subagent's name and description are in the session's context, and Claude Code warns at startup when they pass 15,000 tokens. A call starts in a context window of its own with the subagent's prompt, the CLAUDE.md files the session loads (none with `omitClaudeMd: true`, managed ones aside), the full content of the skills its `skills` field preloads (the first 32 names), the memory `memory` adds, git status and the task message. Project subagents are found from the working directory up to the repository root; the closest folder wins on a name. [Subagents][cc-subagents]
- Subagent `hooks` run only while the subagent runs; a `Stop` hook becomes `SubagentStop`. Each `mcpServers` entry is either the name of a configured server, which shares the session's connection, or an inline server in the format of `.mcp.json`, which connects when the subagent starts. A project subagent's frontmatter hooks (v2.1.218+) and inline servers (v2.1.238+) need a trusted folder. Plugin subagents ignore `hooks`, `mcpServers` and `permissionMode`. agentcheckup lists these hooks and inline servers in the security inventory. [Subagents][cc-subagents]
- `permissionMode` takes effect only when the main conversation is in `default` or `dontAsk` mode. In `bypassPermissions`, `acceptEdits` or auto mode the subagent runs in the main conversation's mode, and in `plan` mode it stays in plan mode. Since v2.1.267 a subagent set to `bypassPermissions` keeps the main conversation's mode. [Subagents][cc-subagents]
- The `agent` setting, which any settings file may set, starts every session as the named subagent, with its prompt, tools and model; its frontmatter hooks then run in the main session. [Settings reference][cc-settings-reference], [Subagents][cc-subagents]
- Undocumented: Claude Code 2.1.272 reads frontmatter with `/^---\s*\n([\s\S]*?)---\s*\n?/`, so the block ends at the first `---`, even inside a line, and parses it with `Bun.YAML.parse`, which keeps the last of repeated keys and applies `<<` merge keys. When that fails, it retries with unquoted values quoted. Read from the binary; agentcheckup's security inventory reads both the documented block and this one.
- Skill and command `hooks` are registered when the skill is invoked and keep running for the rest of the session; `once: true` removes one after its first successful run. A file in `.claude/commands/` accepts a skill's frontmatter fields except `name` and `paths`, so its `allowed-tools` and `hooks` apply as a skill's do. [Hooks][cc-hooks], [Skills][cc-skills]
- Plugins in a skills folder: a folder of the working directory's `.claude/skills/` with a `.claude-plugin/plugin.json` loads, once the workspace is trusted, as `<name>@skills-dir` with its own agents, hooks and MCP servers. Claude Code does not look for such plugins in the skills folders of parent directories. It is on when the manifest's `defaultEnabled` is (the default), unless `enabledPlugins` sets `"<name>@skills-dir"`. Its MCP servers ask for approval like `.mcp.json` servers; an MCP bundle (`.mcpb`, `.dxt`) or a file outside the plugin folder is skipped. agentcheckup plans these plugins and lists their `hooks/hooks.json` hooks in the security inventory; the files in their `agents/` folder are listed but not read, and a manifest that names other hook or MCP files is incomplete, so `--gate` fails closed on it. [Skills][cc-skills], [Plugin loading][cc-plugin-loading]
- Plugins: `name` is the only required key in `plugin.json`; use kebab-case. `claude plugin validate` reports an error for names that start with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-`, but Claude Code still installs and loads such a plugin. Component paths must start with `./` and stay inside the plugin root. agentcheckup reports reserved names and invalid component paths. [Plugins reference][cc-plugins]

### Hooks

- Locations: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings, plugin `hooks/hooks.json` and the manifest's `hooks`, and skill and subagent frontmatter. Hooks from all sources merge. `disableAllHooks: true` in any settings file turns off user, project, local and plugin hooks; managed hooks keep running. [Hooks][cc-hooks], [Settings reference][cc-settings-reference]
- Shape: `hooks.<Event>[]` holds `{ "matcher", "hooks": [ ... ] }`. Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. [Hooks][cc-hooks]
- Events: PascalCase. The reference lists 33 events, including `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SessionStart`. [Hooks][cc-hooks]
- Matcher: a value made only of letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or a list of names. Any other value is an unanchored JavaScript regular expression. [Hooks][cc-hooks]
- Timeout: seconds. Defaults: 600 for `command`, `http` and `mcp_tool`; 30 for `prompt`; 60 for `agent`. The default drops to 30 on `UserPromptSubmit`, `PreModelSwitch` and `PostModelSwitch`, and to 10 on `MessageDisplay`. [Hooks][cc-hooks]
- Failure: exit code 2 blocks on events that can be blocked. Any other non-zero exit, a script that cannot start or invalid JSON output is a non-blocking error, and the action proceeds. A hook that times out is canceled; on most events, including `PreToolUse`, the action proceeds. `"onFailure": "block"` on a `command` or `http` hook makes a failure act like exit 2 (v2.1.295+). It has no effect on `Stop`, `SubagentStop`, `TaskCompleted`, `TeammateIdle` or background hooks. [Hooks][cc-hooks]
- Trust: an interactive session holds back hooks from settings files until the workspace trust dialog is accepted. In `-p` and SDK sessions the folder is treated as trusted, so hooks committed in `.claude/settings.json` run. [Hooks][cc-hooks]

### MCP

- Project servers live in `.mcp.json` at the project root, under `mcpServers`. Local and user servers live in `~/.claude.json`. When a server is defined in more than one place, Claude Code uses the whole entry from the highest source: local, project, user, plugin, claude.ai connector. Scopes match by name; plugins and connectors match by endpoint. [MCP][cc-mcp]
- `type`: `stdio`, `http` (alias `streamable-http`), `sse` (deprecated) or `ws`. An entry with `url` but no `type` is read as a stdio server, reported as a configuration error and skipped. agentcheckup reports this. A `"type": "sdk"` entry is skipped with a message: only an SDK host application can register such a server. [MCP][cc-mcp]
- Variables: `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url` and `headers`. An unset variable without a default stays as literal text, with a warning. Credential variables such as `ANTHROPIC_API_KEY` read as empty in a remote server's `url` and `headers`. [MCP][cc-mcp]
- Approval: interactive sessions ask before using servers from `.mcp.json`. `claude -p`, Agent SDK and cloud sessions load them without asking. `enableAllProjectMcpServers` or `enabledMcpjsonServers` in the project's `.claude/settings.json` approve servers only after the folder is trusted. [MCP][cc-mcp]

## Codex

### Files and locations

| File        | Locations                                                                                                                                                                                                                                                                     | Source                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AGENTS.md` | Global: `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md` (`CODEX_HOME` defaults to `~/.codex`). Project: at most one file per directory, from the project root to the working directory.                                                                           | [AGENTS.md][codex-agents-md]                                           |
| Skills      | `.agents/skills/` in every directory from the working directory up to the repository root; `~/.agents/skills/`; `/etc/codex/skills`; bundled system skills. The source also scans `.codex/skills/` in trusted project config folders and the deprecated `$CODEX_HOME/skills`. | [Build skills][codex-skills], [source][codex-src-skill-roots]          |
| Hooks       | `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`, plugin `hooks/hooks.json`                                                                                                                                             | [Hooks][codex-hooks]                                                   |
| MCP         | `~/.codex/config.toml`; `.codex/config.toml` in trusted projects                                                                                                                                                                                                              | [MCP][codex-mcp]                                                       |
| Settings    | `~/.codex/config.toml`; `.codex/config.toml` in each directory from the project root to the working directory, in trusted projects                                                                                                                                            | [Config basics][codex-config-basic], [source][codex-src-config-loader] |

### Discovery and precedence

- Codex builds the instruction chain once per run; in the TUI, once per session. [AGENTS.md][codex-agents-md]
- Global scope: `AGENTS.override.md` if it exists and is not empty, otherwise `AGENTS.md`. [AGENTS.md][codex-agents-md], [source][codex-src-global]
- The project root is the nearest ancestor that contains an entry of `project_root_markers` (default `[".git"]`). Without a root, Codex checks only the working directory. `project_root_markers = []` turns off the upward search. [Advanced configuration][codex-config-advanced], [source][codex-src-agents-md]
- In each directory from the root down to the working directory, Codex checks `AGENTS.override.md`, then `AGENTS.md`, then each name in `project_doc_fallback_filenames` (empty by default), and uses at most one file. [AGENTS.md][codex-agents-md]
- The source takes the first candidate that exists as a file. If that file is empty or whitespace only, it is skipped and the other candidates in the directory are not tried. An empty `AGENTS.override.md` therefore hides the `AGENTS.md` next to it. [source][codex-src-agents-md]
- Files are joined with blank lines, root first. Later files take priority because they appear later in the prompt. [AGENTS.md][codex-agents-md]
- `project_doc_max_bytes` and `project_doc_fallback_filenames` may be set in a project `.codex/config.toml`; the file closest to the working directory wins. [AGENTS.md][codex-agents-md], [Config basics][codex-config-basic], [Configuration reference][codex-config-ref]
- In a project marked `trust_level = "untrusted"`, Codex loads no project `AGENTS.md` (source) and skips the project `.codex/` config, hooks and rules (docs). [source][codex-src-agents-md], [Config basics][codex-config-basic]
- A fallback name that contains `/`, or that is `.` or `..`, is ignored. [source][codex-src-agents-md]
- Skills with the same `name` are not merged; both can appear in skill selectors. Symlinked skill folders are followed. [Build skills][codex-skills]

### Imports

- None. Codex adds the file text as is; the loader has no import or frontmatter handling. [source][codex-src-agents-md]

### Size limits and truncation

- `project_doc_max_bytes` defaults to 32,768 bytes (32 KiB) and is one budget for all project files in the chain. The file that crosses it is cut at the byte boundary, and files after it are dropped. The global file in `CODEX_HOME` does not count. agentcheckup reports chains over the budget. [AGENTS.md][codex-agents-md], [source][codex-src-agents-md]
- The configuration pages describe the same key as a per-file limit ("how much to read from each `AGENTS.md` file"). The source applies one budget to the whole chain. [Advanced configuration][codex-config-advanced], [Configuration reference][codex-config-ref], [source][codex-src-agents-md]
- Skill list: at most 2% of the context window, or 8,000 characters when the window is unknown. Codex shortens descriptions first and may leave skills out, with a warning. `skills.max_context_tokens` sets another budget, up to 10,000 tokens. [Build skills][codex-skills]
- Skill discovery stops at 6 directory levels and 2,000 directories per root (source). [source][codex-src-skill-limits]
- Hook output: about 2,500 tokens per model-visible message by default (`additionalContextLimit`). Larger output is saved to a file and the model gets a preview. [Hooks][codex-hooks]

### Frontmatter fields

- `AGENTS.md`: none. [source][codex-src-agents-md]
- `SKILL.md`: `---` must be the first line and must be closed, or the skill does not load; agentcheckup reports a `SKILL.md` without frontmatter on the first line. The docs say `name` and `description` are required. The source makes `name` optional, defaulting to the parent directory name, and limits it to 64 characters. A missing or empty `description` is an error. Values are collapsed to one line. [Build skills][codex-skills], [parser][codex-src-skill-parser], [loader][codex-src-skill-loader]
- When the YAML does not parse, the source retries once after quoting plain values that contain `: `, such as `description: Deploy: ECS`. [parser][codex-src-skill-parser]
- Optional `agents/openai.yaml`: `interface`, `policy.allow_implicit_invocation`, `dependencies`. [Build skills][codex-skills]

### Project configuration (`config.toml`)

- Codex reads `.codex/config.toml` in every directory from the project root down to the working directory, in trusted projects only. Files merge table by table, and a value in a file closer to the working directory replaces the one above it. [Config basics][codex-config-basic], [source][codex-src-config-loader]
- In a trusted project, a project file that is not valid TOML stops Codex at startup with "Error parsing project config file", so no session starts. agentcheckup reports this. [source][codex-src-config-loader]
- Codex parses the file with the Rust `toml` crate. At `ce0323f` its `Cargo.lock` pins `toml` 0.9.11+spec-1.1.0 and `toml_parser` 1.1.3+spec-1.1.0, so TOML 1.1 syntax is accepted: line breaks, comments and a trailing comma inside inline tables, the `\e` and `\xHH` escapes, and times without seconds. One leading UTF-8 byte order mark is skipped. [Cargo.lock][codex-cargo-lock], [TOML 1.1][toml-spec-11], [lexer][toml-parser-lexer], [parser][toml-parser-document], [string decoder][toml-parser-strings], [toml_datetime][toml-datetime]
- Every TOML spelling of a table is the same table: `[mcp_servers.docs]`, `[mcp_servers."docs"]`, a top-level `mcp_servers.docs.command = "..."` and an inline `mcp_servers = { docs = { ... } }` all declare the server `docs`. [TOML 1.0][toml-spec]
- Codex removes these top-level keys from every project file and warns at startup ("Ignored unsupported project-local config keys"): `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `responses_api_metadata`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `experimental_realtime_webrtc_call_base_url`, `experimental_realtime_ws_base_url` and `otel` (`PROJECT_LOCAL_CONFIG_DENYLIST`). It also removes `features.respect_system_proxy`, `features.system_proxy_fallback`, `features.credential_masking`, `features.multi_agent_v2.message_board_remote` and the two permission-mode keys of `tui.keymap.chat`. [source][codex-src-config-loader]
- `project_root_markers` and `projects` have no effect in a project file: Codex reads them before it loads project files, to find the project root and decide whether to trust it. [source][codex-src-config-loader]
- `hooks.state`, the record of the hooks a user trusts, is read only from user and session configuration, so a project file cannot trust or turn on a hook. [source][codex-src-hook-state]
- Settings that let Codex act without asking: `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `sandbox_workspace_write.network_access = true` and extra `sandbox_workspace_write.writable_roots`. `shell_environment_policy.set` sets environment variables for every command Codex runs. [Configuration reference][codex-config-ref]
- agentcheckup reports the keys Codex ignores in a project file. Its inventory and `--gate` read the servers, hooks, permission settings and environment overrides of every `.codex/config.toml`.

### Hooks

- Hooks from all locations run. A layer can hold both `hooks.json` and inline `[hooks]`; they merge, with a warning. [Hooks][codex-hooks]
- Shape: the same three levels as Claude Code, `hooks.<Event>[]` with `{ "matcher", "hooks": [ ... ] }`. Handler types `command` and `mcp_tool`; `prompt` and `agent` handlers are parsed but skipped. [Hooks][codex-hooks]
- Events (PascalCase): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. [Hooks][codex-hooks]
- The source also fires `PreModelRequest` and `PostModelRequest` around each model request, retries included, since rust-v0.165.0; the documentation does not list them yet. Their hooks only observe: their output cannot block the request or change what the model receives. [source][codex-src-hook-events], [commit][codex-model-request-hooks]
- Matcher: a regular expression. It is ignored for `UserPromptSubmit`, `Stop` and `Interrupt`, and in the source also for `PreModelRequest` and `PostModelRequest`. [Hooks][codex-hooks], [source][codex-src-hook-events]
- Timeout: seconds, default 600. `SessionEnd` and `Interrupt` default to 1 second, with a maximum of 3. [Hooks][codex-hooks]
- Failure: exit code 2 with a reason on stderr blocks. Errors, timeouts, missing MCP servers and unavailable tools do not block. In the source, a `PreToolUse` hook that exits 2 with empty stderr is recorded as failed and does not block. [Hooks][codex-hooks], [source][codex-src-pretooluse]
- Trust: a non-managed hook runs only after you review and trust its exact definition in `/hooks`. A changed hook needs a new review. Project hooks load only when the project `.codex/` folder is trusted. [Hooks][codex-hooks]
- `features.hooks = false`, or its deprecated alias `features.codex_hooks = false`, turns hooks off. [Hooks][codex-hooks], [Configuration reference][codex-config-ref]

### MCP

- Servers are `[mcp_servers.<name>]` tables in `config.toml`. Transports: stdio (`command`, `args`, `env`, `env_vars`, `cwd`) and streamable HTTP (`url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`). [MCP][codex-mcp]
- There is no `type` field. An entry with `command` is a stdio server; otherwise an entry with `url` is a streamable HTTP server. Codex rejects an entry with neither ("invalid transport") and a field its transport does not take, such as `url` next to `command` ("url is not supported for stdio"). `bearer_token`, a token written into the file, is accepted by neither transport; `bearer_token_env_var` names the variable to read instead. [source][codex-src-mcp-types]
- Whether a rejected entry stops Codex at startup or only drops that server is **Unverified**. agentcheckup reports rejected entries.
- `http_headers` maps header names to values, `env_http_headers` maps them to environment variable names, and `http_headers_helper` is a local command whose output Codex sends as headers. `enabled = false` turns a server off. [MCP][codex-mcp]
- Tool approval: `default_tools_approval_mode` per server and `tools.<tool>.approval_mode` per tool, with the values `auto`, `prompt`, `writes` and `approve`; `writes` prompts for tools that are not marked read-only. agentcheckup lists every mode other than `prompt` as a permission. [MCP][codex-mcp]
- Variables: no `${VAR}` syntax is documented. Values come from the environment by name: `env_vars` forwards variables, and `bearer_token_env_var` and `env_http_headers` name the variables to read. [MCP][codex-mcp]
- Timeouts: `startup_timeout_sec` (default 10) and `tool_timeout_sec` (default 60). The source also reads `startup_timeout_ms`; when both startup keys are set, `startup_timeout_sec` wins. [MCP][codex-mcp], [source][codex-src-mcp-types]
- The MCP docs document only `config.toml` and do not mention `.mcp.json`. `/import` in Codex CLI copies MCP servers from a Claude Code or Cursor setup into the Codex configuration. [MCP][codex-mcp], [Import][codex-import]

## Cursor

### Files and locations

| File           | Locations                                                                                                                                                                                                                                                               | Source                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Project rules  | `.cursor/rules/**/*.mdc`; subfolders work. A `.md` file in `.cursor/rules` is ignored.                                                                                                                                                                                  | [Rules][cursor-rules], [Rules help][cursor-rules-help]          |
| User rules     | Customize → Rules (stored in the account); rule files in `~/.cursor/rules` (stay on the machine)                                                                                                                                                                        | [Rules help][cursor-rules-help]                                 |
| `AGENTS.md`    | Project root and any subdirectory                                                                                                                                                                                                                                       | [Rules][cursor-rules]                                           |
| `CLAUDE.md`    | Project root, read the same way as `AGENTS.md`                                                                                                                                                                                                                          | [Rules help][cursor-rules-help]                                 |
| `.cursorrules` | Project root. Legacy; the help center says it "will be deprecated" and describes how to migrate.                                                                                                                                                                        | [Rules help][cursor-rules-help]                                 |
| Skills         | `.agents/skills/`, `.cursor/skills/`, `~/.agents/skills/`, `~/.cursor/skills/`; for compatibility also `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`. Nested `.cursor/skills/` and `.agents/skills/` folders anywhere in the repository. | [Skills][cursor-skills]                                         |
| Hooks          | `.cursor/hooks.json`, `~/.cursor/hooks.json`, enterprise and team hooks, Claude Code settings files                                                                                                                                                                     | [Hooks][cursor-hooks], [Third-party hooks][cursor-hooks-claude] |
| MCP            | `.cursor/mcp.json`, `~/.cursor/mcp.json`                                                                                                                                                                                                                                | [MCP][cursor-mcp]                                               |

### Discovery and precedence

- Rules apply in the order Team Rules, Project Rules, User Rules. All applicable rules are merged; earlier sources win when guidance conflicts. [Rules][cursor-rules]
- Nested `AGENTS.md` files combine with their parents, and more specific instructions take precedence. [Rules][cursor-rules]
- `CLAUDE.md` is applied to every conversation, whatever its `alwaysApply` value. [Rules help][cursor-rules-help]
- Rules are identified by full path. Two rules with the same file name in different folders both apply. [Rules help][cursor-rules-help]
- Rules apply only to Agent (Chat), not to Tab completion or Bugbot PR reviews. [Rules help][cursor-rules-help]
- A skill in a nested `.cursor/skills/` or `.agents/skills/` folder is offered only for files under that directory. [Skills][cursor-skills]
- Nested `.cursor/rules` folders below the project root: **Unverified**. The docs describe subfolders inside `.cursor/rules` only.

### Imports

- None. A file mention such as `@service-template.ts` in a rule tells the agent where to look; the file is not inlined. [Rules][cursor-rules]

### Size limits and truncation

- No hard limit is documented. The docs recommend keeping rules under 500 lines. [Rules][cursor-rules]

### Frontmatter fields

- `.mdc` rules: `description`, `globs` (comma-separated patterns) and `alwaysApply`. [Rules][cursor-rules]

  | `alwaysApply` | `description` | `globs` | Behavior                                    |
  | ------------- | ------------- | ------- | ------------------------------------------- |
  | `true`        | any           | any     | Always included                             |
  | `false`       | any           | set     | Attached when a matching file is in context |
  | `false`       | set           | not set | Included when the agent finds it relevant   |
  | `false`       | not set       | not set | Included only when @-mentioned              |

- `globs` as a YAML list: **Unverified**. The docs show comma-separated strings only. [Rules][cursor-rules]
- Behavior with invalid YAML: not documented.
- `SKILL.md`: `name` (required; lowercase letters, digits and hyphens; must match the folder name), `description` (required), `paths`, `disable-model-invocation`, `icon`, `color`, `metadata`. The legacy `globs` field is accepted as a fallback for `paths`. [Skills][cursor-skills]

### Hooks

- Format: `{ "version": 1, "hooks": { "<event>": [ { "command", "type", "timeout", "loop_limit", "failClosed", "matcher" } ] } }`. `type` is `command` or `prompt`. [Hooks][cursor-hooks]
- Events: camelCase. Agent hooks: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. Tab hooks: `beforeTabFileRead`, `afterTabFileEdit`. App hook: `workspaceOpen`. [Hooks][cursor-hooks]
- Matcher: a regular expression; an empty string or `"*"` matches everything. [Hooks][cursor-hooks]
- Timeout: seconds. The default is "platform default" and its value is not documented. [Hooks][cursor-hooks]
- Failure: exit code 2 denies the action. Crashes, timeouts and other exit codes let the action proceed unless `failClosed` is `true`. Permission hooks (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeTabFileRead`, `subagentStart`, `preToolUse`) block on invalid JSON or an invalid response even when `failClosed` is `false`. [Hooks][cursor-hooks]
- Priority: enterprise, team, project, user. All matching hooks run; `deny` wins over `ask`, and `ask` over `allow`. Project hooks run only in trusted workspaces, from the project root. [Hooks][cursor-hooks]
- Claude Code hooks: when **Include Third-Party Plugins, Skills, and Other Configs** is on (the default), Cursor also runs hooks from `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json`, below its own sources. Event and tool names are mapped, for example `PreToolUse` to `preToolUse` and `Bash` to `Shell`. `Notification` and `PermissionRequest` are not supported. [Third-party hooks][cursor-hooks-claude]

### MCP

- Servers live under `mcpServers` in `.cursor/mcp.json` or `~/.cursor/mcp.json`. Transports: stdio, SSE and streamable HTTP. Remote servers use `url`. [MCP][cursor-mcp]
- The stdio field table lists `type: "stdio"` as required, but the docs' own examples omit `type`. [MCP][cursor-mcp]
- Variables in `command`, `args`, `env`, `url` and `headers`: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, and `${pathSeparator}` or `${/}`. `envFile` works for stdio servers only. [MCP][cursor-mcp]

## GitHub Copilot

Copilot reads different files on different surfaces. This section covers Copilot on GitHub.com (Chat, cloud agent and code review), Copilot CLI and VS Code. agentcheckup plans three of them as separate agents: Copilot CLI (`copilot-cli`), Copilot in VS Code with the Local agent harness (`copilot-vscode`) and the Copilot cloud agent (`copilot-cloud`). Chat and code review on GitHub.com are not planned.

VS Code now starts with the Copilot harness: "Start with the Copilot harness for day-to-day coding and agent tasks", and Local appears only with experimental settings such as `"chat.defaultToCopilotHarness": false`, or when an organization keeps it as the default. The VS Code plan still models the Local harness, as an assumption with origin `assumed`, because that is the harness the VS Code pages below describe setting by setting. The Copilot harness shares the runtime of the Copilot CLI and reads more: inline `hooks` in `.github/copilot/settings.json` and `.github/copilot/settings.local.json`, the repository's `.claude/settings.json` and `.claude/settings.local.json`, and MCP servers VS Code forwards to it, except those that need interactive input such as `${input:...}`. So the VS Code plan does not claim that VS Code skips `.claude/settings.json`: that skip is **Unverified**. [Agent harnesses][vscode-harnesses], [VS Code hooks][vscode-hooks], [VS Code MCP][vscode-mcp-ref]

**Next:** plan VS Code's Copilot harness, from the Copilot CLI's model and what VS Code forwards to it, which needs a decision record of its own: whether it becomes a fourth Copilot agent or replaces the Local plan.

### Files and locations

| File                                        | Where Copilot reads it                                                                                                                                                                                                                                                                       | Source                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/copilot-instructions.md`           | GitHub.com, CLI, VS Code, Visual Studio, JetBrains IDEs                                                                                                                                                                                                                                      | [Support matrix][gh-instructions-support]                                                                                             |
| `.github/instructions/**/*.instructions.md` | GitHub.com cloud agent and code review only; CLI; VS Code                                                                                                                                                                                                                                    | [Repository instructions][gh-repo-instructions], [Support matrix][gh-instructions-support]                                            |
| `AGENTS.md`                                 | Cloud agent and code review: anywhere in the repository. CLI: the standard locations described below. VS Code: the workspace root, with `chat.useAgentsMdFile`; nested files only with `chat.useNestedAgentsMdFiles`.                                                                        | [Repository instructions][gh-repo-instructions], [CLI instructions][gh-cli-instructions], [VS Code instructions][vscode-instructions] |
| `CLAUDE.md`, `GEMINI.md`                    | Cloud agent and code review: one file at the repository root. CLI: standard locations, and also `.claude/CLAUDE.md`. VS Code: `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` at the workspace root, with `chat.useClaudeMdFile`.                                                     | [Repository instructions][gh-repo-instructions], [CLI instructions][gh-cli-instructions], [VS Code instructions][vscode-instructions] |
| `.claude/rules/**/*.md`                     | CLI: at the git root and in the working directory, read like `*.instructions.md` files; `paths` (a string or a list) or `applyTo` scopes a file. VS Code Local harness: read as instructions files, recursively. `paths` scopes a file; a file without `paths` applies to every file (`**`). | [CLI reference][gh-cli-ref], [VS Code instructions][vscode-instructions]                                                              |
| `REVIEW.md`                                 | Code review on GitHub.com                                                                                                                                                                                                                                                                    | [Support matrix][gh-instructions-support]                                                                                             |
| User instructions                           | CLI: `~/.copilot/copilot-instructions.md`, `~/.copilot/instructions/**/*.instructions.md`                                                                                                                                                                                                    | [CLI instructions][gh-cli-instructions]                                                                                               |
| Skills                                      | `.github/skills/`, `.claude/skills/`, `.agents/skills/`; personal `~/.copilot/skills/`, `~/.agents/skills/`. VS Code also reads `~/.claude/skills/`. CLI also: a parent directory's `.github/skills/`, and `.claude/commands/*.md` as skills.                                                | [Agent skills][gh-skills], [CLI reference][gh-cli-ref], [VS Code skills][vscode-skills]                                               |
| Hooks                                       | `.github/hooks/*.json` (cloud agent and CLI). CLI also: `~/.copilot/hooks/*.json`; `hooks` in `.github/copilot/settings.json`, `.github/copilot/settings.local.json` and `~/.copilot/settings.json`; `.claude/settings.json` and `.claude/settings.local.json`.                              | [Hooks reference][gh-hooks-ref]                                                                                                       |
| MCP                                         | Cloud agent: repository settings on GitHub.com. CLI: `.mcp.json`, `.github/mcp.json`, `~/.copilot/mcp-config.json`. VS Code: `.vscode/mcp.json`, `.mcp.json` at the workspace root.                                                                                                          | [Cloud agent MCP][gh-cloud-mcp], [CLI MCP][gh-cli-mcp], [VS Code MCP][vscode-mcp-ref]                                                 |

### Discovery and precedence

- GitHub.com: when Copilot works, the nearest `AGENTS.md` in the directory tree takes precedence. [Repository instructions][gh-repo-instructions]
- GitHub.com: personal instructions have the highest priority, then repository instructions, then organization instructions. All relevant sets are sent. [Repository instructions][gh-repo-instructions]
- A path-specific file applies when its `applyTo` pattern matches; repository-wide instructions are used as well. [Repository instructions][gh-repo-instructions]
- Code review reads instructions, agent instructions and skills from the pull request's head branch, not the base branch. [Repository instructions][gh-repo-instructions]
- CLI: "standard locations" are the repository root, the working directory, the directories between them, and directories in the path of a file the CLI works on. `*.instructions.md` files are not searched in intermediate directories. The CLI combines all files, removes identical copies and defines no precedence between them. Edits apply after you restart or resume the session. [CLI instructions][gh-cli-instructions]
- CLI: `.claude/rules/**/*.md` at the git root and in the working directory are read "the same way" as `*.instructions.md` files. A rule scoped with `paths` or `applyTo` is delivered when the agent reads or edits a matching file. What the CLI does with a rule that has neither is **Unverified**, as for an `*.instructions.md` file without `applyTo`. [CLI reference][gh-cli-ref]
- CLI skills: of two skills with the same name, the first found wins, in this order: `.github/skills/`, `.agents/skills/`, `.claude/skills/`, then a parent directory's `.github/skills/` ("monorepo parent directory support"). agentcheckup takes the project folders to be those of the working directory and ranks parents closest first, which is **Unverified**; a parent's `.agents/skills/` and `.claude/skills/` are not in the list, so their skills are **Unverified**. Two skills of one name in the same folder are both listed. [CLI reference][gh-cli-ref]
- CLI commands: each `.claude/commands/*.md` file is "an alternative to skills", named after the file, with `argument-hint`, `description`, `allowed-tools` and `disable-model-invocation`. A skill with the same name wins. Which directories' `.claude/commands/` the CLI reads, and whether it reads subfolders, is **Unverified**; agentcheckup lists those of the directories from the root to the working directory, as for skills. [CLI reference][gh-cli-ref]
- CLI repository settings: `disabledSkills` and `disabledMcpServers` in `.github/copilot/settings.json` or `.github/copilot/settings.local.json` name skills that are "discovered but not loaded" and MCP servers that are "configured but not started"; repository lists add to the user's. Whether `disabledSkills` turns off a command is **Unverified**. [CLI configuration][gh-cli-config]
- VS Code: what loads depends on the selected agent harness (Copilot, Claude, Codex or Local). In the Local harness, nested `AGENTS.md` support (`chat.useNestedAgentsMdFiles`) is off by default, and `chat.useAgentsMdFile`, which turns the root `AGENTS.md` on or off, "is enabled by default". `chat.useClaudeMdFile` turns the `CLAUDE.md` files on or off, and `github.copilot.chat.codeGeneration.useInstructionFiles` the `.github/copilot-instructions.md` file. agentcheckup assumes both are on; their defaults are **Unverified**. [VS Code instructions][vscode-instructions]
- VS Code searches `.github/instructions` and `.claude/rules` recursively, so a rule in a subfolder of `.claude/rules` is read too. [VS Code instructions][vscode-instructions]
- VS Code applies an instructions file through `applyTo`; one with only a `description` when the model finds it relevant; one with neither only when you attach it. [VS Code instructions][vscode-instructions]
- Cloud agent: a path-specific file without a valid `applyTo` is never applied, and `excludeAgent: "cloud-agent"` excludes a file. [Repository instructions][gh-repo-instructions]
- Order: no surface documents the order of instruction files. The CLI combines them without precedence. agentcheckup lists them per directory from the root down, then the skills listing, and marks every position **Unverified**. [CLI instructions][gh-cli-instructions], [VS Code instructions][vscode-instructions]

### Imports

- CLI: `@` followed by a relative path includes another file in `.github/copilot-instructions.md`, `AGENTS.md` or `CLAUDE.md`, and references can nest. Referenced files must stay in the repository; absolute and `~/` paths are not loaded. References are not expanded in `GEMINI.md` or `*.instructions.md`. [CLI instructions][gh-cli-instructions]
- The CLI reference disagrees on absolute paths: "Paths can be relative to the instruction file's directory or absolute", resolved recursively "up to a depth limit, with cycle and size guards". agentcheckup skips an absolute path as **Unverified**, and reports the depth limit as one whose value is not documented. [CLI reference][gh-cli-ref]
- VS Code: reference files with Markdown links; relative paths resolve from the instructions file. [VS Code instructions][vscode-instructions]
- GitHub.com: no import syntax is documented.

### Size limits and truncation

- No hard limit is documented. For code review, GitHub recommends at most about 1,000 lines per instruction file. [Code review tutorial][gh-code-review-tutorial]

### Frontmatter fields

- `*.instructions.md`: `applyTo` (glob patterns, comma-separated) and `excludeAgent` (`"code-review"` or `"cloud-agent"`). VS Code also reads `name` and `description`. [Repository instructions][gh-repo-instructions], [VS Code instructions][vscode-instructions]
- `SKILL.md`: `name` (required; lowercase, hyphens for spaces), `description` (required), `license`, `allowed-tools`. [Add skills][gh-skills-howto]
- VS Code `SKILL.md`: `name` must match the parent directory and is at most 64 characters; an invalid name makes the skill "silently fail to load". `description` is at most 1,024 characters. VS Code also reads `argument-hint`, `user-invocable`, `disable-model-invocation` and `context`. [VS Code skills][vscode-skills]

### Hooks

- Format: `{ "version": 1, "hooks": { "<event>": [ { "type": "command", "bash", "powershell", "cwd", "env", "timeoutSec" } ] } }`. [About hooks][gh-hooks]
- Events: camelCase, such as `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `agentStop`, `subagentStop` and `errorOccurred`; the CLI supports more. PascalCase names such as `SessionStart` select the VS Code-compatible payload format. For `PreToolUse` and `PermissionRequest`, PascalCase also selects Claude Code matcher rules. The reference gives no PascalCase name for `userPromptTransformed`, `subagentStart` and `notification`, so agentcheckup marks `SubagentStart` and `Notification` **Unverified** on the CLI. [About hooks][gh-hooks], [Hooks reference][gh-hooks-ref]
- Agent-scoped hooks (CLI): a `hooks` event map in a custom agent's frontmatter runs only while that agent is selected, in addition to the other hooks. Runtime names and aliases are accepted, commands resolve from the repository root, and a subagent's `Stop` hooks run at `SubagentStop`. VS Code's custom agent file reference lists the same `hooks` field for its Local and Copilot harnesses. The security inventory lists these hooks with the subagent scope. [Hooks reference][gh-hooks-ref], [VS Code custom agent file][vscode-custom-agent-file]
- `disableAllHooks: true` at the top of a `.github/hooks/*.json` file skips only that file's hooks, on the CLI and the cloud agent. At the top level of the repository's settings it skips every hook from every source, CLI only; policy hooks still run. The CLI reads it in `.github/copilot/settings.json`, `.github/copilot/settings.local.json` (which wins over the first), `.claude/settings.json` and `.claude/settings.local.json`. Which of these wins when they disagree is not documented, so agentcheckup marks the skip **Unverified** then. VS Code's Local hooks reference does not mention the key. [Hooks reference][gh-hooks-ref], [CLI configuration][gh-cli-config]
- Matcher: a regular expression anchored as `^(?:PATTERN)$`. A hook with an invalid regular expression is skipped. [Hooks reference][gh-hooks-ref]
- Timeout: seconds (`timeoutSec`), default 30. [About hooks][gh-hooks]
- Failure: for most events, non-zero exits and timeouts are logged and execution continues. `preToolUse` command hooks fail closed: exit 2, a crash or any other non-zero exit denies the tool call, even if stdout says `allow`. Timeouts always fail open. HTTP `preToolUse` hooks fail open. A hook registered under the PascalCase name `PreToolUse` uses the VS Code-compatible format, and VS Code continues after any exit code other than 2, so agentcheckup treats it as failing open. [Hooks reference][gh-hooks-ref], [VS Code hooks reference][vscode-hooks-ref]
- A malformed hook item is dropped and its siblings still load. Invalid JSON, a bad `version` or an event list that is not an array rejects the whole file. Inline `hooks` in a settings file "remain strict": one malformed item rejects the whole `hooks` field. agentcheckup counts as malformed what the field tables require: an item that is not an object, a command hook without `bash`, `powershell`, `command` or `exec` (or with `exec` next to one of the others), an HTTP hook without `url`, a prompt hook without `prompt`; a `type` the reference does not list is **Unverified**. [Hooks reference][gh-hooks-ref]
- Cloud agent: only `.github/hooks/*.json` from the cloned repository is read, and a subset of events fires. [Hooks reference][gh-hooks-ref]
- VS Code Local harness: `.github/hooks/*.json` and `~/.copilot/hooks/*.json`. Claude Code settings files load only with `chat.useClaudeHooks`, whose default the page no longer gives (agentcheckup assumes it off, **Unverified**), and their matcher values are ignored, so every command for the event runs. Timeout in seconds, default 30. Exit 2 blocks; other exit codes show a warning and processing continues. [VS Code hooks][vscode-hooks], [VS Code hooks reference][vscode-hooks-ref]
- VS Code Local harness events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop` and `PreCompact`; "Local accepts PascalCase and Copilot event aliases", such as `preToolUse` and `agentStop`. Other events, such as `SessionEnd`, are **Unverified** there. [VS Code hooks reference][vscode-hooks-ref]

### MCP

- Cloud agent: JSON in the repository's settings on GitHub.com. Each server needs `type` (`local`, `stdio`, `http` or `sse`) and `tools`. Values can reference Copilot environment secrets and variables whose names start with `COPILOT_MCP_`, as `$VAR`, `${VAR}` or `${VAR:-default}`. The agent uses the tools without asking for approval. [Cloud agent MCP][gh-cloud-mcp]
- CLI: `.mcp.json` in every directory from the working directory up to the git root, and `.github/mcp.json`. In the same directory `.mcp.json` wins; on a name conflict the file closer to the working directory wins; project files win over `~/.copilot/mcp-config.json`. Project servers load only in trusted folders. [CLI MCP][gh-cli-mcp]
- CLI: `.github/mcp.json` holds either an `mcpServers` object or the server names as top-level keys. agentcheckup reads `.mcp.json` the same way for the CLI, so a top-level entry with `command`, `url` or `type` counts as a server there, though Claude Code ignores it. How a file that mixes both forms is read is **Unverified**. [CLI MCP][gh-cli-mcp]
- CLI `type`: `local` or `stdio`, `http` (alias `streamable-http`), `sse`. `env` supports `$VAR`, `${VAR}` and `${VAR:-default}`. The CLI reference marks `tools` as required, but the `.mcp.json` example in the how-to omits it. [CLI reference][gh-cli-ref], [CLI MCP][gh-cli-mcp]
- The CLI does not read `.vscode/mcp.json`. [CLI MCP][gh-cli-mcp]
- VS Code: `.vscode/mcp.json` uses a `servers` object and supports `${input:...}` variables and predefined variables such as `${workspaceFolder}`. `.mcp.json` at the workspace root uses `mcpServers` and supports stdio and HTTP servers. [VS Code MCP][vscode-mcp-ref]
- VS Code reads `.vscode/mcp.json` as a workspace configuration file, like `tasks.json`, so comments and trailing commas are allowed. [source][vscode-src-config], [parser][vscode-src-config-models], [json.ts][vscode-src-json]

## Gemini CLI

Google announced that from June 18, 2026, Gemini CLI stops serving requests for Google AI Pro and Ultra subscribers and for free use through Gemini Code Assist for individuals, and moved those users to Antigravity CLI. Gemini Code Assist Standard and Enterprise licenses and paid API keys keep access. [Google announcement][gemini-antigravity] How Antigravity CLI handles the files below is **Unverified**.

### Files and locations

| File                     | Locations                                                                                                                                                                                                                  | Source                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI.md`              | `~/.gemini/GEMINI.md`; workspace directories and their parents; directories a tool accesses, up to a trusted root                                                                                                          | [GEMINI.md][gemini-md]                                                                                                                 |
| Other file names         | `context.fileName` in the working directory's `.gemini/settings.json`, a string or a list, for example `["AGENTS.md", "GEMINI.md"]`. The source adds these names in front of `GEMINI.md`, which stays a context file name. | [GEMINI.md][gemini-md], [settings.ts][gemini-src-settings], [config.ts][gemini-src-cli-config], [memoryTool.ts][gemini-src-memorytool] |
| Skills                   | Workspace: `.gemini/skills/` or `.agents/skills/`. User: `~/.gemini/skills/` or `~/.agents/skills/`. Extension and built-in skills.                                                                                        | [Skills][gemini-skills]                                                                                                                |
| Settings (hooks and MCP) | `.gemini/settings.json` (project), `~/.gemini/settings.json` (user), `/etc/gemini-cli/settings.json` (system); extensions                                                                                                  | [Hooks][gemini-hooks]                                                                                                                  |

### Discovery and precedence

- Load order: the global file, then workspace and parent directories, then just-in-time files found when a tool accesses a directory. All found files are concatenated. [GEMINI.md][gemini-md]
- The configuration reference says the upward search stops at the project root (a folder with `.git`) or the home directory. It also describes a scan of subdirectories below the working directory, limited to 200 directories (`context.discoveryMaxDirs`). [Configuration][gemini-config]
- Without `context.fileName`, only `GEMINI.md` is read, and `AGENTS.md` is ignored. [GEMINI.md][gemini-md], [source][gemini-src-memorytool]
- `settings.context.fileName` is the only key the source reads for file names. Since version 0.3 settings are grouped, such as `context.fileName`, `ui.theme` and `tools.exclude`. Versions up to 0.23 moved an old top-level key, such as `contextFileName`, into its group when they loaded a settings file; 0.24 removed that migration. Current versions keep an unknown top-level key without reading it and without a warning, so `{ "contextFileName": "AGENTS.md" }` loads only `GEMINI.md`. agentcheckup reports such keys. [Configuration][gemini-config], [config.ts][gemini-src-cli-config], [settings-validation.ts][gemini-src-settings-validation], [0.23.0 settings.ts][gemini-src-settings-migration]
- In the source, the context files found from the project root down to the working directory are sorted by path, which puts the root first unless a directory name sorts before the file name. [source][gemini-src-discovery]
- Skills with the same name: workspace wins over user, user over extension, extension over built-in. In the same tier, `.agents/skills/` wins over `.gemini/skills/`. Gemini CLI asks for consent before it activates a skill. [Skills][gemini-skills]
- The source looks for `SKILL.md` only in a skills folder itself and one level below it (`<skills>/<name>/SKILL.md`). Skills grouped in category folders are not found. [source][gemini-src-skills]
- Hook settings, highest precedence first: project, user, system, extensions. For other settings, the configuration reference gives the system settings file the highest precedence. [Hooks][gemini-hooks], [Configuration][gemini-config]
- Folder trust is off by default. When it is on, an untrusted folder's `.gemini/settings.json` is ignored and MCP servers do not connect. [Trusted folders][gemini-trust]
- The sources disagree on that default: the configuration reference lists `security.folderTrust.enabled` with the default `true`, and the source fills in that schema default. agentcheckup follows the trusted folders page and assumes folder trust is off. [Configuration][gemini-config], [Trusted folders][gemini-trust], [settings.ts][gemini-src-settings]

### Imports

- `@./file.md`, `@../file.md` and `@/absolute/path.md`. Imported files can import others, up to 5 levels by default. Circular imports are detected, `@` inside code spans and code blocks is ignored, and a missing file becomes an error comment. [Memory import processor][gemini-memport]
- In the source, a path that starts with a letter, such as `@AGENTS.md`, is also an import. An import that resolves outside the project root (the nearest `.git`) is replaced by an "Import failed ... Path traversal attempt" comment. agentcheckup reports such imports. [source][gemini-src-import]
- A `GEMINI.md` is read at the path where it was found, through symlinks, and its imports resolve from that path's directory, so a `GEMINI.md -> AGENTS.md` link resolves them from the link's directory. [source][gemini-src-discovery]

### Size limits and truncation

- No size limit is documented for `GEMINI.md`. The import depth defaults to 5. [Memory import processor][gemini-memport]
- The subdirectory scan stops after 200 directories by default (`context.discoveryMaxDirs`). [Configuration][gemini-config]

### Frontmatter fields

- `GEMINI.md`: none.
- `SKILL.md`: `name`, which should match the directory name, and `description`. [Creating skills][gemini-creating-skills]
- In the source, the frontmatter must start on the first line, and a skill without string `name` and `description` values is skipped. If the YAML does not parse, a line-based fallback reads the `name:` and `description:` lines. [source][gemini-src-skills]
- In the source since v0.66.0, Gemini CLI removes a byte order mark before it reads `SKILL.md`, and closes the frontmatter only at a line that is `---` and optional spaces or tabs: a block closed by `----` or an indented `---` is not frontmatter, and the skill is skipped. [source][gemini-src-skills]

### Hooks

- Config: `hooks` in `settings.json`, with the shape `hooks.<Event>[]` holding `{ "matcher", "hooks": [ { "type": "command", "command", "name", "timeout", "description" } ] }`. [Hooks][gemini-hooks]
- Events: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`. [Hooks][gemini-hooks]
- Matcher: a regular expression for `BeforeTool` and `AfterTool`, an exact string for lifecycle events. `"*"` or `""` matches all. [Hooks][gemini-hooks]
- Timeout: milliseconds, default 60,000. agentcheckup reports timeouts that look like seconds. [Hooks][gemini-hooks]
- Failure: exit code 2 blocks and uses stderr as the reason. Other exit codes show a warning and the action proceeds. Output on stdout that is not JSON is treated as "Allow" and shown as a system message. [Hooks][gemini-hooks]
- Gemini CLI fingerprints project hooks. A hook whose name or command changed is treated as a new, untrusted hook, and you are warned before it runs. [Hooks][gemini-hooks]

### MCP

- Servers live under `mcpServers` in `settings.json`. The key sets the transport: `command` (stdio), `url` (SSE) or `httpUrl` (streamable HTTP). The source also accepts `type: "http"` or `type: "sse"` with `url`, and detects the transport when `type` is missing. [MCP servers][gemini-mcp], [source][gemini-src-config]
- `timeout` is in milliseconds (default 600,000). `trust: true` skips every tool confirmation for that server; agentcheckup reports it. [MCP servers][gemini-mcp]
- Variables: any string value in `settings.json` can use `$VAR`, `${VAR}` or `${VAR:-default}`, resolved when the settings load. The MCP page also documents `%VAR%` in `env` on Windows. [Configuration][gemini-config], [MCP servers][gemini-mcp]
- Server names must not contain `_`. The policy parser splits names on the first underscore after `mcp_`, so wildcard rules and security policies can fail silently. agentcheckup reports this. [MCP servers][gemini-mcp]

## Devin Desktop (formerly Windsurf)

Windsurf became Devin Desktop on June 2, 2026. New tabs start with the Devin Local agent, which shares its harness and configuration with Devin CLI: "every customization uses the Devin CLI format and discovery". Cascade is the legacy agent; existing Cascade conversations remain available. [Devin Local][devin-local], [customizations][devin-customizations], [Cascade (legacy)][devin-cascade]

agentcheckup plans Devin Local only, under the agent id `windsurf`. Cascade's files are listed here but not planned. Devin Desktop's pages on Cascade's rules, `AGENTS.md`, skills, hooks and MCP were removed in October 2026 and redirect to the Devin Local customizations page; the Cascade statements below cite archived copies from October 21 and 22, 2026.

### Files and locations

| File        | Devin Local (default agent)                                                                                                                                                                                                                                                                                            | Cascade (legacy agent)                                                                                                                                                                             | Source                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` | `AGENTS.md` (or `agents.md`), `AGENTS.local.md` and `AGENT.md` at the root and in subdirectories; global `~/.config/devin/AGENTS.md`                                                                                                                                                                                   | `AGENTS.md` or `agents.md` in any directory                                                                                                                                                        | [Devin CLI rules][devin-cli-rules], [changelog][devin-cli-changelog], [Cascade AGENTS.md (archived)][devin-agents-md] |
| `CLAUDE.md` | Project files and `~/.claude/CLAUDE.md`                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                  | [Devin CLI rules][devin-cli-rules]                                                                                    |
| Rules       | `.devin/rules/*.md`, `.windsurf/rules/*.md`, `.devin/global_rules.md`, `.windsurf/global_rules.md`, `~/.devin/rules/*.md`, `.windsurfrules`, `.cursor/rules/*.md` and `*.mdc`                                                                                                                                          | `.devin/rules/*.md` (preferred), `.windsurf/rules/*.md`, `.windsurfrules`; global `~/.codeium/windsurf/memories/global_rules.md`; system `/etc/devin/rules/` and the macOS and Windows equivalents | [Devin CLI rules][devin-cli-rules], [Cascade rules (archived)][devin-rules], [FAQ][devin-faq]                         |
| Skills      | `.agents/skills/`, `.devin/skills/`, `.windsurf/skills/`, `~/.agents/skills/`, `~/.config/devin/skills/`, `~/.codeium/<channel>/skills/`; imports `.claude/skills/`, `.github/skills/` and, as skills, `.claude/commands/**/*.md`                                                                                      | `.devin/skills/`, `.windsurf/skills/`, `.agents/skills/`, `~/.codeium/windsurf/skills/`, `~/.config/devin/skills/`, `~/.agents/skills/`; `.claude/skills/` when Claude Code config reading is on   | [Devin CLI skills][devin-cli-skills], [import][devin-cli-import], [Cascade skills (archived)][devin-skills]           |
| Hooks       | `.devin/hooks.v1.json`; `hooks` in `.devin/config.json`, `.devin/config.local.json`, `.claude/settings.json`, `.claude/settings.local.json`, `~/.config/devin/config.json`, `~/.claude.json`, `~/.claude/settings.json`                                                                                                | `.devin/hooks.json` (legacy `.windsurf/hooks.json`), `~/.codeium/windsurf/hooks.json`, system `hooks.json`                                                                                         | [Devin CLI hooks][devin-cli-hooks], [Cascade hooks (archived)][devin-hooks]                                           |
| MCP         | `.devin/mcp_config.json`, `.devin/mcp_config.local.json`, `~/.config/devin/mcp_config.json`; imports `.mcp.json`, `.cursor/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, `opencode.json`, `.zed/settings.json` and the user files of Claude Code, Windsurf, OpenCode and Zed; Devin Cloud servers | `~/.config/devin/mcp_config.json` only                                                                                                                                                             | [Devin CLI MCP][devin-cli-mcp], [import][devin-cli-import], [Cascade MCP (archived)][devin-mcp]                       |

Devin Local imports other agents' files by default. `read_config_from` in `~/.config/devin/config.json` or `.devin/config.json` turns each source off: `agents_standard`, `cursor`, `windsurf`, `claude`, `copilot`, `opencode`, `zed`. `cloud`, read from the user configuration only, keeps out the remote MCP servers and personal plugins of the Devin Cloud account. It does not import `.github/copilot-instructions.md` or `*.instructions.md`. Findings in `.claude/commands/` files name Devin Local among their readers; its load plan does not list them yet. [Configuration import][devin-cli-import]

### Discovery and precedence

- Cascade: `.devin/` takes precedence over `.windsurf/`. Rules are found in the workspace, its subdirectories, and parent directories up to the git root. System rules merge with workspace and global rules. [Cascade rules (archived)][devin-rules]
- Cascade: a root `AGENTS.md` is an always-on rule. A subdirectory `AGENTS.md` becomes a glob rule for `<directory>/**`. Both `AGENTS.md` and `agents.md` are recognized. [Cascade AGENTS.md (archived)][devin-agents-md]
- Devin Local: files at the workspace root load at session start; files in subdirectories load when the agent accesses files there. `AGENTS.md` rules are always on. If both `.devin/global_rules.md` and `.windsurf/global_rules.md` exist, only the `.devin/` file loads; rule files in both `rules/` folders load. [Devin CLI rules][devin-cli-rules]
- Devin Local: lowercase `agents.md` files are discovered too since v3000.4.16, and the FAQ says Devin Desktop "reads rules from `AGENTS.md` / `agents.md` files". agentcheckup reads a lowercase `agents.md` only at the root of the scan, as it does for every agent: elsewhere such a file is usually documentation. [Changelog][devin-cli-changelog], [FAQ][devin-faq]
- Devin Local: the order of the startup context is not documented (**Unverified**). [Devin CLI rules][devin-cli-rules]

### Imports

- No import syntax is documented for either agent.

### Size limits and truncation

- Cascade in Devin Desktop: the global rules file was limited to 6,000 characters and each workspace rule file to 12,000 characters. Devin Desktop no longer documents either limit. [Cascade rules (archived)][devin-rules]
- Cascade in the Windsurf JetBrains plugin: "Rules files are limited to 12000 characters each." What happens above the limit is not documented. agentcheckup reports rule files of Devin Desktop over 12,000 characters, as information. [JetBrains plugin rules][devin-jetbrains-rules]
- Cascade: at most 100 MCP tools at a time. [Cascade MCP (archived)][devin-mcp]
- Devin Local: no limits are documented. [Customizations][devin-customizations]

### Frontmatter fields

- Rules: `trigger` (`always_on`, `model_decision`, `glob` or `manual`), `globs` and `description`. Devin CLI also accepts `trigger: agent`. The global rules file and a root `AGENTS.md` take no frontmatter. [Customizations][devin-customizations], [Devin CLI rules][devin-cli-rules]
- A rule without `trigger`, with an unknown value or with frontmatter that does not parse: neither agent documents what happens (**Unverified**). Neither documents what `trigger: agent` does either.
- Cascade `SKILL.md`: `name` and `description` are required. Names use lowercase letters, digits and hyphens. [Cascade skills (archived)][devin-skills]
- Devin Local `SKILL.md`: frontmatter is optional, and `name` defaults to the directory name. Other fields include `allowed-tools`, `permissions`, `triggers`, `model`, `subagent`, `agent` and `argument-hint`. [Creating skills][devin-cli-skills-create], [Devin CLI skills][devin-cli-skills]
- Devin Local `allowed-tools`: the tools it lists (`read`, `edit`, `grep`, `glob`, `exec`, MCP tools, and since v3000.11.1 `write`) are auto-approved while the skill runs inline, with no permission prompt. The field does not restrict the tools the skill can use; `permissions.deny` blocks one. A skill that runs as a subagent (`subagent: true` or `agent`) gets its tools from the subagent profile instead. agentcheckup lists the entries as permissions and reports a bare `exec`, which runs any shell command. [Creating skills][devin-cli-skills-create], [Devin CLI skills][devin-cli-skills], [changelog][devin-cli-changelog]

### Hooks

- Devin Local events: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `PostCompaction`, `SessionStart`, `SessionEnd`. Handler types `command` and `prompt`; `timeout` in seconds. [Devin CLI hooks][devin-cli-hooks]
- Devin Local failure: exit code 2 blocks; any other exit code is logged and does not block. [Devin CLI hooks][devin-cli-hooks]
- Devin Local matcher: a regular expression on `tool_name`, for tool events only. Tool names are Devin's own, such as `exec`, `edit` and `read`. No mapping from Claude Code names such as `Bash` is documented. [Lifecycle hooks][devin-cli-hook-events]
- Cascade events are snake_case: `pre_read_code`, `post_read_code`, `pre_write_code`, `post_write_code`, `pre_run_command`, `post_run_command`, `pre_mcp_tool_use`, `post_mcp_tool_use`, `pre_user_prompt`, `post_cascade_response`, `post_cascade_response_with_transcript`, `post_setup_worktree`. There is no matcher, and no timeout field is documented. [Cascade hooks (archived)][devin-hooks]
- Cascade failure: only pre-hooks can block, with exit code 2. Any other exit code lets the action proceed. Hooks from system, user and workspace files all run, in that order. [Cascade hooks (archived)][devin-hooks]
- In Restricted Mode, agents are unavailable, and hooks neither load nor run. [Devin Local][devin-local]

### MCP

- Devin Local imports servers from `.mcp.json`, `.cursor/mcp.json`, `.claude/settings.json` and `.claude/settings.local.json` (whose `mcpServers` Claude Code itself does not read), and from `opencode.json` and `.zed/settings.json`. OpenCode's schema is converted on import, and Zed keeps servers under `context_servers`. agentcheckup lists the servers of the first four; it does not read the OpenCode and Zed files, so a plan lists them as not read and is incomplete. [Configuration import][devin-cli-import]
- Devin Local: `mcpServers` in `.devin/mcp_config.json`, `.devin/mcp_config.local.json` (gitignored) or `~/.config/devin/mcp_config.json`. Versions before v3000.3 kept servers in `.devin/config.json` and the related config files. Remote servers use `url` and an optional `transport` (`http`, the default, or `sse`); HTTP falls back to SSE on 4xx errors other than authentication errors. `${env:VAR}` and `${file:/path}` are documented for OAuth fields. `"disabled": true` turns a server off. [Devin CLI MCP][devin-cli-mcp]
- Cascade: `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows). Remote servers use `serverUrl` or `url`. `command`, `args`, `env`, `serverUrl`, `url` and `headers` support `${env:VAR}`, which resolves to an empty string when the variable is unset, and `${file:/path}`. [Cascade MCP (archived)][devin-mcp]

## Cline

### Files and locations

| File                | Locations                                                                                                                                                                                                                                          | Source                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Rules               | `.clinerules/` and `.cline/rules/`: files ending in `.md`, `.markdown` or `.txt`. Files in the `workflows/`, `hooks/` and `skills/` folders of `.clinerules/` are not rules. Global: `~/Documents/Cline/Rules`, `~/.cline/rules`, `~/Cline/Rules`. | [Rules][cline-rules], [source][cline-src-rules], [loader][cline-src-loader] |
| Other agents' files | `.cursorrules`, `.windsurfrules`, `AGENTS.md` at the project root, `~/.agents/AGENTS.md`. The SDK also reads a legacy `.clinerules` file.                                                                                                          | [Rules][cline-rules], [Config][cline-config], [loader][cline-src-loader]    |
| Workflows           | `.clinerules/workflows/`, `.cline/workflows/`, run as slash commands                                                                                                                                                                               | [Config][cline-config], [source][cline-src-paths]                           |
| Skills              | `.cline/skills/`, `.clinerules/skills/`, `.claude/skills/`, `.agents/skills/`; global `~/.cline/skills/`, `~/.agents/skills/`                                                                                                                      | [Skills][cline-skills], [Config][cline-config]                              |
| Hooks               | Plugin hooks. Hook folders: `.cline/hooks/`, `.clinerules/hooks/`, `~/.cline/hooks/`, `~/Documents/Cline/Hooks/`                                                                                                                                   | [Config][cline-config], [Plugins][cline-plugins]                            |
| MCP                 | `~/.cline/data/settings/cline_mcp_settings.json` for the CLI (`CLINE_MCP_SETTINGS_PATH` overrides it); the IDE extensions open their own MCP settings file                                                                                         | [MCP][cline-mcp]                                                            |

### Discovery and precedence

- Cline combines the files in both rules folders. When workspace and global rules conflict, workspace rules win. Each rule can be turned off in the Rules panel. [Rules][cline-rules]
- The Rules panel writes its toggle into the rule's frontmatter, and the SDK reads it from there: `disabled: true` turns a rule, workflow or skill off, and so does `enabled: false` when `disabled` is not set. A disabled skill is left out of the listing. Toggles that older versions kept in extension state are not in the repository, and the SDK does not read them. [source][cline-src-rules], [loader][cline-src-loader]
- The SDK searches, in this order: the workspace's `AGENTS.md`, `.clinerules/`, `.cline/rules/`, then the legacy single files. Within a folder it lists files in file-system order. [source][cline-src-paths]
- The SDK reads only the `AGENTS.md` at the workspace root, and the docs mention only the project root. A nested `AGENTS.md` is not read. [source][cline-src-paths], [Config][cline-config]
- Rule files in subfolders of a rules folder are not read: the SDK reads only the files directly in the folder, and the extension says nested files never reach the model. [loader][cline-src-loader], [source][cline-src-rules]
- The SDK drops a rule, workflow or skill without a body or with a `disabled` or `enabled` that is not a boolean, and a workflow or skill whose frontmatter does not parse. [loader][cline-src-loader]
- Skills with the same name: the global skill wins over the project skill. [Skills][cline-skills]

### Imports

- None documented.

### Size limits and truncation

- None documented for rules. A skill `description` is at most 1,024 characters. [Skills][cline-skills]

### Frontmatter fields

- Rules: `paths` is the only documented field, a list of globs. A rule without frontmatter is always active; `paths: []` is never active. If the YAML does not parse, Cline fails open: the rule is active and its raw content is visible. [Rules][cline-rules]
- The SDK also reads `disabled` and `enabled` from rules, workflows and skills (see above). [loader][cline-src-loader]
- The SDK drops such a rule instead, so the sources disagree on invalid YAML (**Unverified**). [loader][cline-src-loader]
- `SKILL.md`: `name`, which must exactly match the directory name, and `description` (at most 1,024 characters). [Skills][cline-skills]

### Hooks

- The hooks page points to SDK plugins. Plugin hooks are JavaScript or TypeScript functions: `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`. `beforeTool` blocks a call by returning `{ skip: true, reason }`. [Hooks][cline-hooks], [Plugins][cline-plugins]
- Timeout: 3 seconds per hook call. With the default `hookErrorMode: "ignore"`, a hook that throws or times out is recorded and the run continues; `"throw"` fails the run. [Plugins][cline-plugins]
- Script hooks in `.clinerules/hooks/` or `.cline/hooks/`, and plugins in `.cline/plugins/`: **Unverified**. The config page lists the folders but documents no file names, events or exit codes. agentcheckup lists these files as not analyzed. [Config][cline-config]

### MCP

- Servers live under `mcpServers`. Local servers use `command` and `args`. Remote servers use `url` and `type`, either `"streamableHttp"` or `"sse"`. A remote server without `type` uses the legacy SSE transport. [MCP][cline-mcp]
- No project-level MCP file and no variable syntax are documented. [MCP][cline-mcp]

## Cross-agent formats

- `AGENTS.md` is plain Markdown with no required fields. The format site says agents read the nearest file in the directory tree and that the closest file wins on conflicts. [AGENTS.md][agents-md]
- Agent Skills specification: `SKILL.md` starts with YAML frontmatter. `name` (required) has 1 to 64 characters, lowercase letters, digits and hyphens, no leading or trailing hyphen, no `--`, and equals the directory name. `description` (required) has 1 to 1,024 characters. Optional: `license`, `compatibility` (up to 500 characters), `metadata` (string keys to string values), `allowed-tools` (a space-separated string, experimental). The spec recommends a body under 500 lines and 5,000 tokens, and file references one level deep. [Specification][skills-spec]
- The `skills-ref` validator applies NFKC normalization, accepts any Unicode letters and digits for which Python's `isalnum()` is true, and rejects fields outside the six above. [validator.py][skills-ref]

## Known gotchas

1. **Codex reads at most 32 KiB of project instructions in total.** `project_doc_max_bytes` (default 32,768 bytes) is one budget for every project `AGENTS.md` from the project root to the working directory. The file that crosses it is cut at the byte boundary, and the files after it are dropped. The global file in `~/.codex` does not count. Codex's configuration pages call it a per-file limit; the source applies it to the whole chain. agentcheckup reports this. Sources: [AGENTS.md][codex-agents-md], [agents_md.rs][codex-src-agents-md].
2. **An empty `AGENTS.override.md` hides `AGENTS.md` in Codex.** In each project directory Codex takes the first candidate file that exists. If it is empty or whitespace only, Codex skips it and does not fall back to the `AGENTS.md` next to it. At the global level an empty override does fall through. agentcheckup reports this. Sources: [agents_md.rs][codex-src-agents-md], [global loader][codex-src-global].
3. **Codex skips project instructions in untrusted projects.** With `trust_level = "untrusted"`, Codex loads no project `AGENTS.md` (source) and no project `.codex/` config, hooks or rules (docs). Sources: [agents_md.rs][codex-src-agents-md], [Config basics][codex-config-basic].
4. **A `CLAUDE.md` or `CLAUDE.local.md` on the path stops Claude Code from reading `AGENTS.md`.** By default Claude Code reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above it. A personal `CLAUDE.local.md` is enough to switch `AGENTS.md` off. Versions before v2.1.277 never read it. Import it with `@AGENTS.md` instead. agentcheckup reports this. Source: [Memory][cc-memory].
5. **Gemini CLI does not read `AGENTS.md` by default.** It reads only `GEMINI.md` until `context.fileName` lists other names. The old top-level `contextFileName` key no longer counts: since version 0.24 Gemini CLI ignores it without a warning. agentcheckup reports it. Sources: [GEMINI.md][gemini-md], [memoryTool.ts][gemini-src-memorytool], [config.ts][gemini-src-cli-config], [0.23.0 settings.ts][gemini-src-settings-migration].
6. **`.md` files in `.cursor/rules` are not Cursor rules.** Cursor loads only `.mdc` files there. Devin Local reads both `.md` and `.mdc` from `.cursor/rules`, so the same file can apply in one agent and not in the other. agentcheckup reports `.md` files in `.cursor/rules`. Sources: [Cursor rules][cursor-rules], [Devin CLI rules][devin-cli-rules].
7. **`@path` is not a portable import.** Claude Code and Gemini CLI inline the file. Copilot CLI inlines it only from `copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md`. Cursor treats `@file` as a pointer the agent may follow. Codex passes the text through unchanged. agentcheckup reports Claude Code and Gemini CLI imports that point to missing files. Sources: [Memory][cc-memory], [Memory import processor][gemini-memport], [CLI instructions][gh-cli-instructions], [Cursor rules][cursor-rules], [agents_md.rs][codex-src-agents-md].
8. **Symlinks become text files in Windows clones.** Git checks out a committed symlink as a plain text file unless `core.symlinks` is enabled, so a symlinked `CLAUDE.md` turns into a one-line file that holds the target path. Creating symlinks on Windows also needs Administrator rights or Developer Mode. Prefer an `@AGENTS.md` import. agentcheckup reports symlinks that Git checked out as plain text files. Source: [Memory][cc-memory].
9. **A remote MCP server without `type` is read differently.** Claude Code reads an entry with `url` and no `type` as stdio, reports a configuration error and skips it. Cline uses legacy SSE when `type` is missing. Gemini CLI's docs treat `url` as SSE and `httpUrl` as streamable HTTP. Set `type` on every remote server. agentcheckup reports this. Sources: [Claude Code MCP][cc-mcp], [Cline MCP][cline-mcp], [Gemini MCP][gemini-mcp].
10. **MCP variable syntax is not portable.** Claude Code, Copilot CLI and Gemini CLI use `${VAR}`. Cursor and Devin use `${env:VAR}`. Codex takes variable names, not references. Claude Code keeps an unset `${VAR}` as literal text. agentcheckup reports `${env:NAME}` and Cursor variables such as `${workspaceFolder}` in `.mcp.json` and `.gemini/settings.json`, and `$NAME` or `%NAME%` in `.mcp.json`. Sources: [Claude Code MCP][cc-mcp], [CLI reference][gh-cli-ref], [Gemini configuration][gemini-config], [Cursor MCP][cursor-mcp], [Cascade MCP (archived)][devin-mcp], [Codex MCP][codex-mcp].
11. **Most hooks fail open.** In Claude Code, Codex, Cursor, Gemini CLI, Devin Desktop and Cline, a hook that crashes or exits with a code other than 2 lets the action proceed; in Codex, Cursor and Cline a timeout does too, and in Claude Code it does on most events. A policy hook with a wrong script path enforces nothing. Claude Code (`"onFailure": "block"`, v2.1.295+) and Cursor (`"failClosed": true`) can fail closed on request. Copilot is the exception: a `preToolUse` command hook that crashes or exits non-zero denies the tool call, but a timeout still lets it through. agentcheckup reports tool-gating hooks that fail open. Sources: [Claude Code hooks][cc-hooks], [Codex hooks][codex-hooks], [Cursor hooks][cursor-hooks], [Gemini hooks][gemini-hooks], [Devin CLI hooks][devin-cli-hooks], [Cascade hooks (archived)][devin-hooks], [Cline plugins][cline-plugins], [Copilot hooks reference][gh-hooks-ref].
12. **Codex needs a reason with exit code 2.** A `PreToolUse` hook that exits 2 with nothing on stderr is recorded as failed, and the tool call goes ahead. Source: [pre_tool_use.rs][codex-src-pretooluse].
13. **Hook timeouts are milliseconds in Gemini CLI.** The other agents use seconds, so `"timeout": 30` gives a Gemini CLI hook 30 milliseconds. agentcheckup reports likely unit mix-ups. Sources: [Gemini hooks][gemini-hooks], [Claude Code hooks][cc-hooks].
14. **Committed hooks may not run for your teammates.** Codex runs a non-managed hook only after each user trusts its exact definition in `/hooks`, and again after every change. Gemini CLI warns before it runs a project hook whose name or command changed. Cursor runs project hooks only in trusted workspaces. Sources: [Codex hooks][codex-hooks], [Gemini hooks][gemini-hooks], [Cursor hooks][cursor-hooks].
15. **Headless Claude Code trusts the repository.** In `claude -p` and Agent SDK sessions, hooks from `.claude/settings.json` run and `.mcp.json` servers load without a prompt. Sources: [Claude Code hooks][cc-hooks], [Claude Code MCP][cc-mcp].
16. **Other agents run Claude Code hooks with their own rules.** Cursor (on by default), Copilot CLI and Devin Local (on by default) load hooks from `.claude/settings.json`; VS Code does so only with `chat.useClaudeHooks`. Cursor maps `Bash` to `Shell` and does not support `Notification` or `PermissionRequest`. VS Code ignores the matcher and runs the command for every event of that type. Devin matches its own tool names, such as `exec`. Copilot fails closed when a `PreToolUse` command hook crashes. Sources: [Cursor third-party hooks][cursor-hooks-claude], [Copilot hooks reference][gh-hooks-ref], [Devin CLI hooks][devin-cli-hooks], [VS Code hooks][vscode-hooks].
17. **Skill names must match their folder in most agents.** The Agent Skills spec, Cursor, VS Code and Cline require `name` to equal the directory name. VS Code skips a skill with an invalid name without an error. Claude Code and Codex fall back to the directory name when `name` is missing. agentcheckup reports a missing `name`, a name that is not lowercase letters, digits and hyphens, and a name that does not match its directory. Sources: [Specification][skills-spec], [Cursor skills][cursor-skills], [VS Code skills][vscode-skills], [Cline skills][cline-skills], [Claude Code skills][cc-skills], [Codex parser][codex-src-skill-parser].
18. **Claude Code-only skill fields fail outside Claude Code.** Claude Code ignores unknown fields, but claude.ai uploads, the Skills API and `package_skill.py` reject any field other than `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. agentcheckup reports fields outside the Agent Skills specification. Source: [Claude Code skills][cc-skills].
19. **Broken YAML frontmatter fails differently per file.** In Claude Code a rule with invalid YAML loads unconditionally, a skill loads with no fields and never triggers on its description, and a subagent is skipped with the reason only in the debug log. Cline loads a rule with invalid frontmatter and shows its raw text. agentcheckup reports invalid frontmatter in Claude Code rules, skills and subagents. Sources: [Memory][cc-memory], [Skills][cc-skills], [Subagents][cc-subagents], [Cline rules][cline-rules].
20. **Gemini CLI MCP server names with `_` break policies, and `trust: true` skips confirmations.** The policy parser splits tool names on the first underscore after `mcp_`, so rules can silently miss. `trust: true` bypasses all tool confirmations for that server. agentcheckup reports both. Source: [Gemini MCP][gemini-mcp].
21. **A repository cannot turn on `bypassPermissions` in Claude Code.** `permissions.defaultMode` values `auto` and `bypassPermissions` are ignored in `.claude/settings.json` and `.claude/settings.local.json` (since v2.1.257). agentcheckup reports this. Source: [Settings][cc-settings].
22. **Size limits skip or cut content.** Claude Code skips a `CLAUDE.md` over 4 MiB and cuts each skill's listing text at 1,536 characters. Cascade in the Windsurf JetBrains plugin limits each rules file to 12,000 characters. Codex shortens skill descriptions when the skill list exceeds 2% of the context window. agentcheckup reports Devin Desktop rule files over 12,000 characters and skill descriptions over the 1,024 and 1,536 character limits. Sources: [Memory][cc-memory], [Claude Code skills][cc-skills], [JetBrains plugin rules][devin-jetbrains-rules], [Codex skills][codex-skills].
23. **Skill folder depth differs.** Cursor walks its skills folders recursively and Codex scans up to 6 levels, but Gemini CLI finds only `<skills>/<name>/SKILL.md`. Keep each skill one level below the skills folder. Sources: [Cursor skills][cursor-skills], [Codex loader][codex-src-skill-limits], [Gemini skill loader][gemini-src-skills].
24. **Path-specific Copilot instructions do not reach Copilot Chat on GitHub.com.** On GitHub.com only the cloud agent and code review use `.github/instructions/*.instructions.md`. Code review reads instructions and skills from the pull request's head branch. Source: [Repository instructions][gh-repo-instructions].
25. **A broken `.codex/config.toml` stops Codex, and some keys in it do nothing.** In a trusted project, a project config file that is not valid TOML stops Codex at startup. Codex removes keys such as `model_provider`, `profiles` and `notify` from project files with a warning, and ignores `project_root_markers`, `projects` and `hooks.state` there. agentcheckup reports both. Sources: [config loader][codex-src-config-loader], [config_rules.rs][codex-src-hook-state].
26. **Not every file in `.clinerules/` is a rule.** Cline reads files in `.clinerules/workflows/` as slash commands and does not treat `.clinerules/hooks/` or `.clinerules/skills/` as rules. Sources: [cline-rules.ts][cline-src-rules], [paths.ts][cline-src-paths].

## Source code checked

Facts marked "source" were read at these commits. Links point to the `main` branch unless they name a version.

| Repository                 | Commit or version                          | Read       | What                                                             |
| -------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------- |
| `openai/codex`             | `ae11049`                                  | 2026-10-14 | `AGENTS.md`, skills, hooks                                       |
| `openai/codex`             | `ce0323f`                                  | 2026-10-17 | `config.toml` loading, MCP server entries, `hooks.state`, crates |
| `google-gemini/gemini-cli` | `3647e4d`                                  | 2026-10-14 | imports, discovery, skills, MCP                                  |
| `google-gemini/gemini-cli` | `ed96fae`                                  | 2026-10-17 | `context.fileName`, workspace settings, discovery order          |
| `cline/cline`              | `a42df8c`                                  | 2026-10-17 | rule folders, rule files, `AGENTS.md`, workflows                 |
| `toml-rs/toml`             | `toml_parser` 1.1.3, `toml_datetime` 0.7.5 | 2026-10-17 | the TOML that Codex accepts                                      |
| `microsoft/vscode`         | `main`                                     | 2026-10-17 | how `.vscode/mcp.json` is parsed                                 |
| `agentskills/agentskills`  | `69ef37e`                                  | 2026-10-14 | the skills validator                                             |

[cc-memory]: https://code.claude.com/docs/en/memory
[cc-skills]: https://code.claude.com/docs/en/skills
[cc-subagents]: https://code.claude.com/docs/en/sub-agents
[codex-subagents]: https://learn.chatgpt.com/docs/agent-configuration/subagents
[cursor-subagents]: https://cursor.com/docs/subagents
[vscode-custom-agents]: https://code.visualstudio.com/docs/agent-customization/custom-agents
[vscode-custom-agent-file]: https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference
[gh-cli-agents]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
[gh-custom-agents]: https://docs.github.com/en/copilot/reference/custom-agents-configuration
[gemini-subagents]: https://geminicli.com/docs/core/subagents/
[devin-cli-subagents]: https://docs.devin.ai/cli/subagents
[cc-settings]: https://code.claude.com/docs/en/settings
[cc-settings-reference]: https://code.claude.com/docs/en/settings-reference
[cc-hooks]: https://code.claude.com/docs/en/hooks
[cc-mcp]: https://code.claude.com/docs/en/mcp
[cc-plugins]: https://code.claude.com/docs/en/plugins-reference
[cc-plugin-loading]: https://code.claude.com/docs/en/plugins/loading
[cc-env-vars]: https://code.claude.com/docs/en/env-vars
[cc-permissions]: https://code.claude.com/docs/en/permissions
[claude-api-skills]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
[codex-agents-md]: https://learn.chatgpt.com/docs/agent-configuration/agents-md
[codex-rules]: https://learn.chatgpt.com/docs/agent-configuration/rules
[codex-config-basic]: https://learn.chatgpt.com/docs/config-file/config-basic
[codex-config-advanced]: https://learn.chatgpt.com/docs/config-file/config-advanced
[codex-config-ref]: https://learn.chatgpt.com/docs/config-file/config-reference
[codex-skills]: https://learn.chatgpt.com/docs/build-skills
[codex-hooks]: https://learn.chatgpt.com/docs/hooks
[codex-mcp]: https://learn.chatgpt.com/docs/extend/mcp
[codex-import]: https://learn.chatgpt.com/docs/import
[codex-src-agents-md]: https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs
[codex-src-global]: https://github.com/openai/codex/blob/main/codex-rs/codex-home/src/instructions/mod.rs
[codex-src-skill-parser]: https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs
[codex-src-skill-loader]: https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/host.rs
[codex-src-skill-limits]: https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/mod.rs
[codex-src-skill-roots]: https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs
[codex-src-pretooluse]: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs
[codex-src-config-loader]: https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs
[codex-src-mcp-types]: https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs
[codex-src-hook-state]: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/config_rules.rs
[codex-src-hook-events]: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs
[codex-model-request-hooks]: https://github.com/openai/codex/commit/70b3bb6d8814ab3f2045238b4ae14c43da99783b
[codex-cargo-lock]: https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/Cargo.lock
[toml-spec]: https://toml.io/en/v1.0.0
[toml-spec-11]: https://toml.io/en/v1.1.0
[toml-parser-lexer]: https://github.com/toml-rs/toml/blob/toml_parser-v1.1.3/crates/toml_parser/src/lexer/mod.rs
[toml-parser-document]: https://github.com/toml-rs/toml/blob/toml_parser-v1.1.3/crates/toml_parser/src/parser/document.rs
[toml-parser-strings]: https://github.com/toml-rs/toml/blob/toml_parser-v1.1.3/crates/toml_parser/src/decoder/string.rs
[toml-datetime]: https://github.com/toml-rs/toml/blob/toml_datetime-v0.7.5/crates/toml_datetime/src/datetime.rs
[cursor-rules]: https://cursor.com/docs/rules
[cursor-rules-help]: https://cursor.com/help/customization/rules
[cursor-skills]: https://cursor.com/docs/skills
[cursor-hooks]: https://cursor.com/docs/hooks
[cursor-hooks-claude]: https://cursor.com/docs/reference/third-party-hooks
[cursor-mcp]: https://cursor.com/docs/mcp
[gh-repo-instructions]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions
[gh-instructions-support]: https://docs.github.com/en/copilot/reference/custom-instructions-support
[gh-cli-instructions]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
[gh-code-review-tutorial]: https://docs.github.com/en/copilot/tutorials/customize-code-review
[gh-skills]: https://docs.github.com/en/copilot/concepts/customizations/agent-skills
[gh-skills-howto]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
[gh-hooks]: https://docs.github.com/en/copilot/concepts/customizations/hooks
[gh-hooks-ref]: https://docs.github.com/en/copilot/reference/hooks-reference
[gh-cloud-mcp]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
[gh-cli-mcp]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
[gh-cli-ref]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
[gh-cli-config]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
[vscode-instructions]: https://code.visualstudio.com/docs/agent-customization/custom-instructions
[vscode-skills]: https://code.visualstudio.com/docs/agent-customization/agent-skills
[vscode-hooks]: https://code.visualstudio.com/docs/agent-customization/hooks
[vscode-hooks-ref]: https://code.visualstudio.com/docs/agents/reference/hooks-reference
[vscode-mcp-ref]: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
[vscode-harnesses]: https://code.visualstudio.com/docs/agents/run/agent-harnesses
[vscode-src-config]: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/configuration/common/configuration.ts
[vscode-src-config-models]: https://github.com/microsoft/vscode/blob/main/src/vs/platform/configuration/common/configurationModels.ts
[vscode-src-json]: https://github.com/microsoft/vscode/blob/main/src/vs/base/common/json.ts
[gemini-md]: https://geminicli.com/docs/cli/gemini-md/
[gemini-memport]: https://geminicli.com/docs/reference/memport/
[gemini-skills]: https://geminicli.com/docs/cli/skills/
[gemini-creating-skills]: https://geminicli.com/docs/cli/creating-skills/
[gemini-hooks]: https://geminicli.com/docs/hooks/
[gemini-mcp]: https://geminicli.com/docs/tools/mcp-server/
[gemini-trust]: https://geminicli.com/docs/cli/trusted-folders/
[gemini-config]: https://geminicli.com/docs/reference/configuration/
[gemini-antigravity]: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
[gemini-src-import]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts
[gemini-src-discovery]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts
[gemini-src-memorytool]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/memoryTool.ts
[gemini-src-config]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/config.ts
[gemini-src-skills]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts
[gemini-src-cli-config]: https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts
[gemini-src-settings]: https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts
[gemini-src-settings-validation]: https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings-validation.ts
[gemini-src-settings-migration]: https://github.com/google-gemini/gemini-cli/blob/v0.23.0/packages/cli/src/config/settings.ts
[devin-faq]: https://docs.devin.ai/desktop/devin-desktop-faq
[devin-local]: https://docs.devin.ai/desktop/devin-local/overview
[devin-customizations]: https://docs.devin.ai/desktop/devin-local/customizations
[devin-cascade]: https://docs.devin.ai/desktop/cascade
[devin-jetbrains-rules]: https://docs.devin.ai/windsurf/plugins/cascade/memories
[devin-rules]: https://web.archive.org/web/20261022220354/https://docs.devin.ai/desktop/cascade/memories
[devin-agents-md]: https://web.archive.org/web/20261022220405/https://docs.devin.ai/desktop/cascade/agents-md
[devin-skills]: https://web.archive.org/web/20261021094352/https://docs.devin.ai/desktop/cascade/skills
[devin-hooks]: https://web.archive.org/web/20261022220405/https://docs.devin.ai/desktop/cascade/hooks
[devin-mcp]: https://web.archive.org/web/20261021094355/https://docs.devin.ai/desktop/cascade/mcp
[devin-cli-rules]: https://docs.devin.ai/cli/extensibility/rules
[devin-cli-import]: https://docs.devin.ai/cli/reference/configuration/read-config-from
[devin-cli-skills]: https://docs.devin.ai/cli/extensibility/skills/overview
[devin-cli-skills-create]: https://docs.devin.ai/cli/extensibility/skills/creating-skills
[devin-cli-hooks]: https://docs.devin.ai/cli/extensibility/hooks/overview
[devin-cli-hook-events]: https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks
[devin-cli-mcp]: https://docs.devin.ai/cli/extensibility/mcp/configuration
[devin-cli-changelog]: https://docs.devin.ai/cli/changelog/stable
[cline-rules]: https://docs.cline.bot/customization/cline-rules
[cline-config]: https://docs.cline.bot/getting-started/config
[cline-skills]: https://docs.cline.bot/customization/skills
[cline-hooks]: https://docs.cline.bot/customization/hooks
[cline-plugins]: https://docs.cline.bot/sdk/plugins
[cline-mcp]: https://docs.cline.bot/mcp/mcp-overview
[cline-src-rules]: https://github.com/cline/cline/blob/main/apps/vscode/src/core/context/instructions/user-instructions/cline-rules.ts
[cline-src-loader]: https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts
[cline-src-paths]: https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts
[agents-md]: https://agents.md/
[skills-spec]: https://agentskills.io/specification
[skills-ref]: https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py
