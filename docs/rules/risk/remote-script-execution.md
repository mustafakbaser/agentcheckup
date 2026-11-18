<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `risk/remote-script-execution`

Command downloads a script and runs it in one step.

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Category   | `risk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `claude-output-style`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `cursor-command`, `cursor-bugbot`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `devin-instructions`, `cline-rule`, `cline-workflow`, `claude-loop`, `cursor-agent`, `gemini-agent`, `copilot-agent`, `devin-agent`, `copilot-prompt`, `claude-settings`, `codex-hooks`, `cursor-hooks`, `gemini-settings`, `mcp-json`, `cursor-mcp`, `claude-plugin-manifest`, `codex-config`, `cursor-worktrees`, `cursor-environment` |
| Fixable    | No                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Why

Agents run commands from their instruction and skill files, including commands in code blocks. `curl -fsSL https://… | sh` downloads a script and runs it in one step, so whoever controls that address when the command runs decides what executes, with the user's permissions, and nothing reviews it. Hook commands, MCP server command lines, the `headersHelper` of a remote MCP server and the setup commands Cursor runs from `.cursor/worktrees.json` and `.cursor/environment.json` do this on every event, server start, connection, worktree or cloud Build, without anyone deciding to run them. Claude Code does not auto-approve `curl` and `wget` by default, as a defense against prompt injection.

The rule reports `curl` or `wget` piped into a shell or interpreter, `bash <(curl …)`, `bash -c "$(curl …)"`, `eval "$(curl …)"` and PowerShell `irm … | iex` with a real URL. Not reported: placeholder URLs such as `https://example.com`, commands that their line, paragraph or heading says not to run, and commands addressed to a person ("tell the user to install it with …"), because a person sees those before anything runs.

Pin the download to a version and checksum, or install from a package manager or a vendored script.

## Evidence

- [Claude Code: Security (network command approval)](https://code.claude.com/docs/en/security), verified, checked 2026-11-13
- [AGENTS.md open format](https://agents.md/), verified, checked 2026-11-13
- [Codex source: protocol hooks.rs (on Windows a command hook runs commandWindows, alias command_windows, instead of command)](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/hooks.rs), verified, checked 2026-11-14
- [Cursor: Worktrees (.cursor/worktrees.json)](https://cursor.com/docs/configuration/worktrees), verified, checked 2026-11-18
- [Cursor: Cloud agent setup (.cursor/environment.json)](https://cursor.com/docs/cloud-agent/setup), verified, checked 2026-11-18
- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-11-13

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "risk/remote-script-execution": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line risk/remote-script-execution -- reason -->
```
