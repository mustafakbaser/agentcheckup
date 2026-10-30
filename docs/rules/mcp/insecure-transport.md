<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/insecure-transport`

MCP server uses an unencrypted connection to another host.

|            |                                                                                       |
| ---------- | ------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                |
| Category   | `risk`                                                                                |
| Platforms  | Claude Code, Cursor, Gemini CLI, Codex                                                |
| Applies to | `mcp-json`, `claude-plugin-manifest`, `cursor-mcp`, `gemini-settings`, `codex-config` |
| Fixable    | Yes, `review`                                                                         |
| Since      | 2026.10                                                                               |

## Why

An `http://` or `ws://` URL sends every tool call, result and header, including `Authorization` tokens, in clear text. Anyone on the network path, for example on a shared Wi-Fi network, can read the traffic and change tool results, which the agent then trusts. `claude plugin validate` also warns about `http://` and `ws://` URLs to hosts other than loopback.

Loopback hosts such as `localhost`, `127.0.0.1` and `::1` are not reported. A Claude Code server with `"type": "sse"` gets an `info` finding, because Claude Code has deprecated the SSE transport in favor of `"type": "http"`. Codex servers in `.codex/config.toml` are checked too; the rule offers no fix there.

Use `https://` or `wss://`.

## Evidence

- [Claude Code: Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference), verified, checked 2026-10-30
- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-10-14
- [Cursor: MCP](https://cursor.com/docs/mcp), verified, checked 2026-10-14
- [Gemini CLI: MCP servers](https://geminicli.com/docs/tools/mcp-server/), verified, checked 2026-10-14
- [Codex: MCP](https://learn.chatgpt.com/docs/extend/mcp), verified, checked 2026-10-30

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Changes http:// to https:// and ws:// to wss:// in the server URL. Moving off the deprecated SSE transport is left to you.

Preview the fix with `agentcheckup fix --rule mcp/insecure-transport`.

## Configuration

```json
{
  "rules": {
    "mcp/insecure-transport": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line mcp/insecure-transport -- reason -->
```
