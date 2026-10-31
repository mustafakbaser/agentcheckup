# One configuration for every agent

Last verified: 2026-10-14

This guide shows how to keep one set of instructions, skills, MCP servers and hooks for Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Desktop (formerly Windsurf) and Cline. No single layout works for all seven agents, so the setup below shares files where the agents allow it and adds small bridges where they do not. Each claim links its source; [What coding agents read](platforms.md) has the details for every agent.

## The layout

```text
AGENTS.md                        shared instructions
CLAUDE.md                        "@AGENTS.md" plus Claude Code notes
.gemini/settings.json            context.fileName lists AGENTS.md
.agents/skills/<name>/SKILL.md   shared skills
.claude/skills/<name>            symlink to ../../.agents/skills/<name>
.mcp.json                        MCP servers, the source for the other MCP files
scripts/hooks/                   hook scripts, registered in each agent's file
```

## Instructions

### Use `AGENTS.md` as the source of truth

| Agent          | Reads `AGENTS.md`                                                                              | What to add                                   | Source                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Codex          | Yes                                                                                            | Nothing                                       | [Codex][codex-agents-md]                                              |
| Cursor         | Yes, including nested files                                                                    | Nothing                                       | [Cursor][cursor-rules]                                                |
| GitHub Copilot | Cloud agent, code review, CLI and VS Code                                                      | Nothing                                       | [Copilot][gh-repo-instructions], [Copilot CLI][gh-cli-instructions]   |
| Devin Desktop  | Yes, including nested files                                                                    | Nothing                                       | [Devin Local][devin-cli-rules], [Cascade (archived)][devin-agents-md] |
| Cline          | Yes; the docs mention the project root only                                                    | Nothing                                       | [Cline][cline-config]                                                 |
| Claude Code    | Only when no `CLAUDE.md` or `CLAUDE.local.md` is in the working directory or above (v2.1.277+) | A `CLAUDE.md` that imports `AGENTS.md`        | [Claude Code][cc-memory]                                              |
| Gemini CLI     | Only when configured                                                                           | `context.fileName` in `.gemini/settings.json` | [Gemini CLI][gemini-md]                                               |

### Claude Code: import `AGENTS.md` from `CLAUDE.md`

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

- The import keeps working when someone adds a `CLAUDE.local.md`, which switches off direct `AGENTS.md` reading, and in sessions that cannot read `AGENTS.md` directly, such as versions before v2.1.277. Claude Code never loads `AGENTS.md` twice because of the import. [Memory][cc-memory]
- With a root `CLAUDE.md`, Claude Code reads only `CLAUDE.md` files by default, so it skips nested `AGENTS.md` files. Put a `CLAUDE.md` that contains `@AGENTS.md` next to each nested `AGENTS.md`. Each user can instead set **Project instructions** to `claude-md-and-agents-md` in `~/.claude/settings.json`. [Memory][cc-memory]
- Do not replace `CLAUDE.md` with a symlink to `AGENTS.md` if anyone clones on Windows. Git checks a symlink out as a one-line text file unless `core.symlinks` is enabled. [Memory][cc-memory]
- Other agents read `CLAUDE.md` too. Cursor applies it to every conversation, Copilot's cloud agent, code review and CLI read it, and Devin Local loads it as an always-on rule. Keep the Claude Code section short and harmless for other agents. [Cursor][cursor-rules-help], [Copilot][gh-repo-instructions], [Copilot CLI][gh-cli-instructions], [Devin Local][devin-cli-rules]
- Copilot CLI expands `@AGENTS.md` inside `CLAUDE.md` and also reads `AGENTS.md` itself. It removes identical copies of instruction files, but whether that covers an imported copy is not documented (**Unverified**). [Copilot CLI][gh-cli-instructions]

### Gemini CLI: add `AGENTS.md` to `context.fileName`

Save this as `.gemini/settings.json`:

```json
{
  "context": {
    "fileName": ["AGENTS.md", "GEMINI.md"]
  }
}
```

- Without it, Gemini CLI reads only `GEMINI.md`. [GEMINI.md][gemini-md]
- Gemini CLI concatenates every context file it finds and inlines `@` imports. Do not also import `AGENTS.md` from `GEMINI.md`, or the same text loads twice. [GEMINI.md][gemini-md], [Memory import processor][gemini-memport], [source][gemini-src-discovery]
- When folder trust is on, Gemini CLI ignores `.gemini/settings.json` in untrusted folders. The same setting also works in `~/.gemini/settings.json`. [Trusted folders][gemini-trust], [GEMINI.md][gemini-md]

### Stay inside every agent's limits

- Codex reads at most 32 KiB from all project `AGENTS.md` files on the path combined and drops the rest. Keep the total below that, or raise `project_doc_max_bytes` in each user's Codex configuration. [Codex][codex-agents-md], [agents_md.rs][codex-src-agents-md]
- Do not commit an empty `AGENTS.override.md`. Codex picks it over the `AGENTS.md` in the same directory, finds it empty and loads neither. [agents_md.rs][codex-src-agents-md]
- Refer to other files by plain path in `AGENTS.md`. Claude Code, Copilot CLI and Gemini CLI inline `@path`, while Codex and Cursor leave it as text. [Claude Code][cc-memory], [Copilot CLI][gh-cli-instructions], [Gemini CLI][gemini-memport], [agents_md.rs][codex-src-agents-md], [Cursor][cursor-rules]

### Scope instructions with nested `AGENTS.md` files

There is no shared format for path-scoped rules. Nested `AGENTS.md` files come closest:

| Agent          | Nested `AGENTS.md`                                              | Path-scoped rule format                                 | Source                          |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| Claude Code    | Through a nested `CLAUDE.md` with `@AGENTS.md`                  | `.claude/rules/*.md` with `paths`                       | [Claude Code][cc-memory]        |
| Codex          | Only between the project root and the directory Codex starts in | None                                                    | [Codex][codex-agents-md]        |
| Cursor         | Yes                                                             | `.cursor/rules/*.mdc` with `globs`                      | [Cursor][cursor-rules]          |
| GitHub Copilot | Yes; on GitHub.com the nearest file wins                        | `.github/instructions/*.instructions.md` with `applyTo` | [Copilot][gh-repo-instructions] |
| Gemini CLI     | Yes, once `AGENTS.md` is in `context.fileName`                  | None                                                    | [Gemini CLI][gemini-md]         |
| Devin Desktop  | Yes                                                             | `.devin/rules/*.md` with `trigger: glob` and `globs`    | [Devin][devin-rules]            |
| Cline          | **Unverified**                                                  | `.clinerules/*.md` with `paths`                         | [Cline][cline-rules]            |

Use nested `AGENTS.md` files for directory-specific guidance. Use the per-agent rule formats only for file-type rules that no directory boundary can express.

## Skills

### Keep skills in `.agents/skills` and link them for Claude Code

| Agent          | `.agents/skills/` | `.claude/skills/`                                                                         | Source                                                              |
| -------------- | ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Claude Code    | No                | Yes                                                                                       | [Skills][cc-skills], [Memory][cc-memory]                            |
| Codex          | Yes               | No                                                                                        | [Codex][codex-skills], [source][codex-src-skill-roots]              |
| Cursor         | Yes               | Yes                                                                                       | [Cursor][cursor-skills]                                             |
| GitHub Copilot | Yes               | Yes                                                                                       | [Copilot][gh-skills]                                                |
| Gemini CLI     | Yes               | Not documented                                                                            | [Gemini CLI][gemini-skills]                                         |
| Devin Desktop  | Yes               | Devin Local imports it by default; Cascade reads it when Claude Code config reading is on | [Devin Local][devin-cli-import], [Cascade (archived)][devin-skills] |
| Cline          | Yes               | Yes                                                                                       | [Cline][cline-config], [Cline skills][cline-skills]                 |

No directory is read by all seven agents. Keep each skill once, in `.agents/skills/<name>/`. Do not group skills in category folders, because Gemini CLI finds only `<skills>/<name>/SKILL.md` ([source][gemini-src-skills]). Then give Claude Code one link per skill:

```sh
mkdir -p .claude/skills
ln -s ../../.agents/skills/deploy .claude/skills/deploy
```

- Claude Code follows a symlinked skill folder and loads a target once, even when several entries point to it. A symlink for the whole `.claude/skills` directory is not documented. [Skills][cc-skills]
- Windows clones need `core.symlinks` enabled, or Git writes each link as a small text file. Contributors on Windows can copy the folders instead. [Memory][cc-memory]
- Cursor, Copilot, Cline and Devin Local read both directories. Whether they list a linked skill once or twice is not documented (**Unverified**). Check the skill list in each agent after you add links.

### Write frontmatter that every agent accepts

```markdown
---
name: deploy
description: Deploy the web app to staging or production. Use when the user asks to deploy, release or roll back.
---
```

- `name`: 1 to 64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphens, equal to the folder name. Cursor, VS Code and Cline require the match, and VS Code skips a skill with an invalid name without an error. agentcheckup reports names that break these rules. [Specification][skills-spec], [Cursor][cursor-skills], [VS Code][vscode-skills], [Cline][cline-skills]
- `description`: at most 1,024 characters; Codex, Cursor and Copilot require it. Put the trigger words first. Claude Code cuts the listing text at 1,536 characters, and Codex shortens descriptions when its skill list runs out of budget. [Specification][skills-spec], [Codex parser][codex-src-skill-parser], [Cursor][cursor-skills], [Copilot][gh-skills-howto], [Claude Code][cc-skills], [Codex][codex-skills]
- Other fields in the specification: `license`, `compatibility` (up to 500 characters), `metadata` (string values) and `allowed-tools` (experimental; support varies). [Specification][skills-spec]
- Fields outside the specification, such as `when_to_use`, `argument-hint` or `hooks`, are agent-specific. Claude Code accepts them, but claude.ai uploads, the Skills API and skill packaging reject them with a hard error. agentcheckup reports them. [Claude Code][cc-skills]
- `` !`command` `` lines are a Claude Code feature: Claude Code runs them before the model sees the skill. claude.ai chat and the API do not run them, and the other agents do not document the syntax. [Claude Code][cc-skills]

## MCP servers

No MCP file is read by all seven agents. Keep `.mcp.json` as the source and generate the other files from it.

| Agent               | Project file                                                                                                                      | Remote server entry                 | Variables                                                                | Source                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Claude Code         | `.mcp.json`                                                                                                                       | `"type": "http"`, `"url"`           | `${VAR}`, `${VAR:-default}`                                              | [Claude Code][cc-mcp]                                    |
| Copilot CLI         | `.mcp.json`, `.github/mcp.json`                                                                                                   | `"type": "http"`, `"url"`           | `$VAR`, `${VAR}`, `${VAR:-default}` in `env`                             | [CLI MCP][gh-cli-mcp], [CLI reference][gh-cli-ref]       |
| VS Code             | `.vscode/mcp.json` (`servers`) or `.mcp.json`                                                                                     | `"type": "http"`, `"url"`           | `${input:...}`, predefined variables                                     | [VS Code][vscode-mcp-ref]                                |
| Copilot cloud agent | Repository settings on GitHub.com                                                                                                 | `"type"`, `"url"`, `"tools"`        | `$COPILOT_MCP_*`, `${COPILOT_MCP_*}`                                     | [Cloud agent][gh-cloud-mcp]                              |
| Cursor              | `.cursor/mcp.json`                                                                                                                | `"url"`                             | `${env:NAME}`, `${workspaceFolder}`                                      | [Cursor][cursor-mcp]                                     |
| Codex               | `.codex/config.toml`                                                                                                              | `url` in `[mcp_servers.<name>]`     | Variable names in `env_vars`, `bearer_token_env_var`, `env_http_headers` | [Codex][codex-mcp]                                       |
| Gemini CLI          | `.gemini/settings.json`                                                                                                           | `"httpUrl"`                         | `$VAR`, `${VAR}`, `${VAR:-default}` in any settings string               | [Gemini CLI][gemini-mcp], [configuration][gemini-config] |
| Devin Local         | `.devin/mcp_config.json`; imports `.mcp.json`, `.cursor/mcp.json`, `.claude/settings.json`, `opencode.json`, `.zed/settings.json` | `"url"`, optional `"transport"`     | `${env:VAR}`, `${file:path}` in OAuth fields                             | [Devin Local][devin-cli-mcp], [import][devin-cli-import] |
| Cline               | User settings only                                                                                                                | `"type": "streamableHttp"`, `"url"` | Not documented                                                           | [Cline][cline-mcp]                                       |

- Claude Code, Copilot CLI and VS Code read `.mcp.json` directly, and Devin Local imports it by default. How Devin Local treats Claude Code-style `${VAR}` references in an imported file is not documented (**Unverified**). [Claude Code][cc-mcp], [Copilot CLI][gh-cli-mcp], [VS Code][vscode-mcp-ref], [Devin Local][devin-cli-import]
- Set `"type"` on every remote server. Claude Code skips an entry with `url` and no `type`, and Cline falls back to legacy SSE. agentcheckup reports a missing `type` in `.mcp.json`. [Claude Code][cc-mcp], [Cline][cline-mcp]
- Rewrite variable references for each file: `${API_KEY}` in `.mcp.json` becomes `${env:API_KEY}` in `.cursor/mcp.json`. The agents document different syntaxes, as the table shows. agentcheckup reports `${env:NAME}` and Cursor variables such as `${workspaceFolder}` in `.mcp.json` and `.gemini/settings.json`. [Claude Code][cc-mcp], [Cursor][cursor-mcp]
- Copilot cloud agent takes MCP servers from repository settings, not from a file. Each entry needs `tools`, and secrets must be named `COPILOT_MCP_*`. [Cloud agent][gh-cloud-mcp]
- In Gemini CLI, keep `_` out of server names and leave `trust: true` out of shared settings. agentcheckup reports both. [Gemini CLI][gemini-mcp]

## Hooks

There is no shared hooks format. Keep the logic in scripts under version control and register each script in every agent's own file.

| Agent          | Config file                        | Block an action                                   | Crash or other exit code                              | Timeout                                                | Timeout unit       | Source                                               |
| -------------- | ---------------------------------- | ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ | ------------------ | ---------------------------------------------------- |
| Claude Code    | `.claude/settings.json`            | Exit 2                                            | Proceeds, unless `"onFailure": "block"`               | Proceeds on most events, unless `"onFailure": "block"` | Seconds            | [Claude Code][cc-hooks]                              |
| Codex          | `.codex/hooks.json`                | Exit 2 with a reason on stderr                    | Proceeds                                              | Proceeds                                               | Seconds            | [Codex][codex-hooks], [source][codex-src-pretooluse] |
| Cursor         | `.cursor/hooks.json`               | Exit 2                                            | Proceeds, unless `"failClosed": true`                 | Proceeds, unless `"failClosed": true`                  | Seconds            | [Cursor][cursor-hooks]                               |
| GitHub Copilot | `.github/hooks/*.json`             | Exit 2 on `preToolUse` and `permissionRequest`    | `preToolUse` command hooks deny; other events proceed | Proceeds                                               | Seconds            | [Copilot][gh-hooks-ref]                              |
| Gemini CLI     | `.gemini/settings.json`            | Exit 2                                            | Proceeds with a warning                               | Not documented                                         | Milliseconds       | [Gemini CLI][gemini-hooks]                           |
| Devin Local    | `.devin/hooks.v1.json`             | Exit 2                                            | Proceeds                                              | Not documented                                         | Seconds            | [Devin Local][devin-cli-hooks]                       |
| Cascade        | `.devin/hooks.json`                | Exit 2 on pre-hooks                               | Proceeds                                              | Not documented                                         | No timeout field   | [Cascade (archived)][devin-hooks]                    |
| Cline          | Plugin in JavaScript or TypeScript | Return `{ skip: true, reason }` from `beforeTool` | Continues                                             | Continues                                              | 3 seconds per call | [Cline][cline-plugins]                               |

- To block, exit 2 and write the reason to stderr. Every script-based agent in the table treats exit 2 as a block on events that can be blocked; in Copilot those are `preToolUse` and `permissionRequest`. Codex does not block on exit 2 in `PreToolUse` when stderr is empty. [Claude Code][cc-hooks], [Codex][codex-src-pretooluse], [Cursor][cursor-hooks], [Copilot][gh-hooks-ref], [Gemini CLI][gemini-hooks], [Devin Local][devin-cli-hooks], [Cascade (archived)][devin-hooks]
- To fail closed, catch errors inside the script and exit 2 yourself. A timeout is outside the script's control: Claude Code, Codex, Cursor, Copilot and Devin Local let the tool call proceed when a hook times out, unless you opt in to failing closed where the agent allows it. agentcheckup reports tool-gating hooks that fail open. [Claude Code][cc-hooks], [Codex][codex-hooks], [Cursor][cursor-hooks], [Copilot][gh-hooks-ref]
- Convert timeouts: Gemini CLI counts milliseconds, the others count seconds. agentcheckup reports likely unit mix-ups. [Gemini CLI][gemini-hooks]
- Event names differ: `PreToolUse` (Claude Code, Codex, Devin Local), `preToolUse` (Cursor, Copilot), `BeforeTool` (Gemini CLI), `pre_run_command` and its siblings (Cascade), `beforeTool` (Cline). So do tool names: the shell tool is `Bash` in Claude Code and Codex, `Shell` in Cursor, `bash` in Copilot hooks with camelCase event names, `run_shell_command` in Gemini CLI and `exec` in Devin Local. agentcheckup reports event names an agent does not fire. [Claude Code][cc-hooks], [Codex][codex-hooks], [Cursor][cursor-hooks-claude], [Copilot][gh-hooks-ref], [Gemini CLI hooks reference][gemini-hooks-ref], [Devin Local][devin-cli-hook-events], [Cascade (archived)][devin-hooks], [Cline][cline-plugins]
- Cursor and Devin Local load Claude Code's hooks from `.claude/settings.json` by default, Copilot CLI loads them too, and VS Code loads them when `chat.useClaudeHooks` is on. Test the hook in each agent: Cursor maps `Bash` to `Shell`, VS Code ignores the matcher, Devin matches its own tool names, and Copilot denies the tool call when a `PreToolUse` command hook crashes. [Cursor][cursor-hooks-claude], [Devin Local][devin-cli-hooks], [Copilot][gh-hooks-ref], [VS Code][vscode-hooks]
- Expect a review step for committed hooks. Codex runs a hook only after each user trusts it in `/hooks`, Gemini CLI warns about changed project hooks, Cursor runs project hooks only in trusted workspaces, and interactive Claude Code waits for the workspace trust dialog. [Codex][codex-hooks], [Gemini CLI][gemini-hooks], [Cursor][cursor-hooks], [Claude Code][cc-hooks]

## Check what each agent loaded

| Agent       | Where to look                                                                    | Source                                                                                    |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Claude Code | `/context` (Memory files) and `/memory`                                          | [Memory][cc-memory]                                                                       |
| Codex       | `codex --ask-for-approval never "Summarize the current instructions."`; `/hooks` | [Codex][codex-agents-md], [Codex hooks][codex-hooks]                                      |
| Cursor      | Customize → Rules and Customize → Skills                                         | [Cursor rules][cursor-rules], [Cursor skills][cursor-skills]                              |
| Copilot CLI | `/instructions`, `/skills info <name>`, `/mcp`                                   | [Instructions][gh-cli-instructions], [Skills][gh-cli-skills], [CLI reference][gh-cli-ref] |
| Gemini CLI  | `/memory show`, `/skills list`, `/hooks panel`                                   | [GEMINI.md][gemini-md], [Skills][gemini-skills], [Hooks][gemini-hooks]                    |
| Devin Local | `/hooks`, and **Open customizations** for rules, skills, hooks and MCP servers   | [Hooks][devin-cli-hooks], [Devin Local][devin-local]                                      |
| Cline       | The Rules and Skills panels; `cline config`                                      | [Rules][cline-rules], [Config][cline-config]                                              |

Run `npx agentcheckup` in the repository to check these files. [Known gotchas](platforms.md#known-gotchas) marks the problems it reports.

[cc-memory]: https://code.claude.com/docs/en/memory
[cc-skills]: https://code.claude.com/docs/en/skills
[cc-hooks]: https://code.claude.com/docs/en/hooks
[cc-mcp]: https://code.claude.com/docs/en/mcp
[codex-agents-md]: https://learn.chatgpt.com/docs/agent-configuration/agents-md
[codex-skills]: https://learn.chatgpt.com/docs/build-skills
[codex-hooks]: https://learn.chatgpt.com/docs/hooks
[codex-mcp]: https://learn.chatgpt.com/docs/extend/mcp
[codex-src-agents-md]: https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs
[codex-src-skill-parser]: https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs
[codex-src-pretooluse]: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs
[codex-src-skill-roots]: https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs
[cursor-rules]: https://cursor.com/docs/rules
[cursor-rules-help]: https://cursor.com/help/customization/rules
[cursor-skills]: https://cursor.com/docs/skills
[cursor-hooks]: https://cursor.com/docs/hooks
[cursor-hooks-claude]: https://cursor.com/docs/reference/third-party-hooks
[cursor-mcp]: https://cursor.com/docs/mcp
[gh-repo-instructions]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions
[gh-cli-instructions]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
[gh-skills]: https://docs.github.com/en/copilot/concepts/customizations/agent-skills
[gh-skills-howto]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
[gh-cli-skills]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
[gh-hooks-ref]: https://docs.github.com/en/copilot/reference/hooks-reference
[gh-cloud-mcp]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
[gh-cli-mcp]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
[gh-cli-ref]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
[vscode-skills]: https://code.visualstudio.com/docs/agent-customization/agent-skills
[vscode-hooks]: https://code.visualstudio.com/docs/agent-customization/hooks
[vscode-mcp-ref]: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
[gemini-md]: https://geminicli.com/docs/cli/gemini-md/
[gemini-memport]: https://geminicli.com/docs/reference/memport/
[gemini-skills]: https://geminicli.com/docs/cli/skills/
[gemini-hooks]: https://geminicli.com/docs/hooks/
[gemini-hooks-ref]: https://geminicli.com/docs/hooks/reference/
[gemini-mcp]: https://geminicli.com/docs/tools/mcp-server/
[gemini-trust]: https://geminicli.com/docs/cli/trusted-folders/
[gemini-src-discovery]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts
[gemini-src-skills]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts
[gemini-config]: https://geminicli.com/docs/reference/configuration/
[devin-local]: https://docs.devin.ai/desktop/devin-local/overview
[devin-rules]: https://docs.devin.ai/desktop/devin-local/customizations
[devin-agents-md]: https://web.archive.org/web/20261022220405/https://docs.devin.ai/desktop/cascade/agents-md
[devin-skills]: https://web.archive.org/web/20261021094352/https://docs.devin.ai/desktop/cascade/skills
[devin-hooks]: https://web.archive.org/web/20261022220405/https://docs.devin.ai/desktop/cascade/hooks
[devin-cli-rules]: https://docs.devin.ai/cli/extensibility/rules
[devin-cli-import]: https://docs.devin.ai/cli/reference/configuration/read-config-from
[devin-cli-hooks]: https://docs.devin.ai/cli/extensibility/hooks/overview
[devin-cli-hook-events]: https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks
[devin-cli-mcp]: https://docs.devin.ai/cli/extensibility/mcp/configuration
[cline-rules]: https://docs.cline.bot/customization/cline-rules
[cline-config]: https://docs.cline.bot/getting-started/config
[cline-skills]: https://docs.cline.bot/customization/skills
[cline-plugins]: https://docs.cline.bot/sdk/plugins
[cline-mcp]: https://docs.cline.bot/mcp/mcp-overview
[skills-spec]: https://agentskills.io/specification
