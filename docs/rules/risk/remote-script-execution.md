<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `risk/remote-script-execution`

Command downloads a script and runs it in one step.

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Category   | `risk`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                                                                                                                                                                                                |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `claude-settings`, `codex-hooks`, `cursor-hooks`, `gemini-settings`, `mcp-json`, `cursor-mcp`, `claude-plugin-manifest` |
| Fixable    | No                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Why

Agents run commands from their instruction and skill files, including commands in code blocks. `curl -fsSL https://… | sh` downloads a script and runs it in one step, so whoever controls that address when the command runs decides what executes, with the user's permissions, and nothing reviews it. Hook commands and MCP server command lines do this on every event or server start, without anyone deciding to run them. Claude Code does not auto-approve `curl` and `wget` by default, as a defense against prompt injection.

The rule reports `curl` or `wget` piped into a shell or interpreter, `bash <(curl …)`, `bash -c "$(curl …)"`, `eval "$(curl …)"` and PowerShell `irm … | iex` with a real URL. Not reported: placeholder URLs such as `https://example.com`, commands that their line, paragraph or heading says not to run, and commands addressed to a person ("tell the user to install it with …"), because a person sees those before anything runs.

Pin the download to a version and checksum, or install from a package manager or a vendored script.

## Evidence

- [Claude Code: Security (network command approval)](https://code.claude.com/docs/en/security), verified, checked 2026-10-14
- [AGENTS.md open format](https://agents.md/), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "risk/remote-script-execution": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line risk/remote-script-execution -- reason -->
```
