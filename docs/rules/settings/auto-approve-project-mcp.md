<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `settings/auto-approve-project-mcp`

Settings approve every project MCP server automatically.

|            |                   |
| ---------- | ----------------- |
| Severity   | `warn`            |
| Category   | `risk`            |
| Platforms  | Claude Code       |
| Applies to | `claude-settings` |
| Fixable    | Yes, `review`     |
| Since      | 2026.10           |

## Why

In interactive sessions, Claude Code asks before it uses a server from a project's `.mcp.json`. `"enableAllProjectMcpServers": true` approves every server in that file without asking, including servers that a later commit or pull request adds. In a committed `.claude/settings.json` it takes effect once a teammate trusts the project; from then on, whoever can change `.mcp.json` can start a new process on that teammate's machine without a prompt.

List the servers you trust by name in `enabledMcpjsonServers` instead.

## Evidence

- [Claude Code: Settings](https://code.claude.com/docs/en/settings), verified, checked 2026-10-14
- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Replaces "enableAllProjectMcpServers": true with "enabledMcpjsonServers" listing the servers the project's .mcp.json declares today, so later additions need approval. Not offered when the file already has such a list or .mcp.json cannot be read.

Preview the fix with `agentcheckup fix --rule settings/auto-approve-project-mcp`.

## Configuration

```json
{
  "rules": {
    "settings/auto-approve-project-mcp": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line settings/auto-approve-project-mcp -- reason -->
```
