<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/url-without-type`

MCP server has a "url" but no "type".

|            |                                      |
| ---------- | ------------------------------------ |
| Severity   | `error`                              |
| Category   | `loading`                            |
| Platforms  | Claude Code                          |
| Applies to | `mcp-json`, `claude-plugin-manifest` |
| Fixable    | No                                   |
| Since      | 2026.10                              |

## Why

Claude Code reads an MCP server entry without `type` as a stdio server, so an entry with a `url` but no `type` is a configuration error: Claude Code skips the server and reports `MCP server "<name>" has a "url" but no "type"`. This applies to `.mcp.json` and to servers that a plugin manifest declares inline.

Add `"type": "http"`, or `"sse"` or `"ws"` to match the server.

## Evidence

- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-10-14
- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "mcp/url-without-type": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line mcp/url-without-type -- reason -->
```
