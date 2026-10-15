<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/gemini-server-name`

Gemini CLI MCP server name contains an underscore.

|            |                   |
| ---------- | ----------------- |
| Severity   | `warn`            |
| Category   | `correctness`     |
| Platforms  | Gemini CLI        |
| Applies to | `gemini-settings` |
| Fixable    | No                |
| Since      | 2026.10           |

## Why

Gemini CLI names MCP tools `mcp_<server>_<tool>`, and its policy parser splits such a name at the first underscore after `mcp_` to find the server. A server named `my_server` is read as server `my` with tool `server_<tool>`, so wildcard rules such as `mcp_my_server_*` and other security policies for this server can fail silently. The documentation says: "Do not use underscores (`_`) in your MCP server names".

Use hyphens instead, for example `my-server`.

## Evidence

- [Gemini CLI: MCP servers](https://geminicli.com/docs/tools/mcp-server/), verified, checked 2026-10-14
- [Gemini CLI: Policy engine (MCP server names and underscores)](https://geminicli.com/docs/reference/policy-engine/), verified, checked 2026-10-14
- [Gemini CLI source: mcp-tool.ts (FQN parsing)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-tool.ts), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "mcp/gemini-server-name": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line mcp/gemini-server-name -- reason -->
```
