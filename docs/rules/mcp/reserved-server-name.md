<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/reserved-server-name`

MCP server uses a name Claude Code reserves.

|            |             |
| ---------- | ----------- |
| Severity   | `error`     |
| Category   | `loading`   |
| Platforms  | Claude Code |
| Applies to | `mcp-json`  |
| Fixable    | No          |
| Since      | 2026.10     |

## Why

Claude Code reserves the names of its built-in MCP servers, including `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview` and `Claude Browser`. A server in `.mcp.json` with one of these names is skipped at load time, with a warning asking you to rename it, so its tools never reach the session.

Rename the server. agentcheckup offers no fix: the new name is yours to choose, and permission rules, `enabledMcpjsonServers` and scripts that name the server must change with it. Names are compared exactly; servers that a plugin declares are not checked, because the documentation does not say whether the reserved names apply to them.

## Evidence

- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-11-13

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "mcp/reserved-server-name": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line mcp/reserved-server-name -- reason -->
```
