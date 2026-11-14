<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/gemini-trust`

Gemini CLI MCP server is trusted and skips tool confirmations.

|            |                   |
| ---------- | ----------------- |
| Severity   | `warn`            |
| Category   | `risk`            |
| Platforms  | Gemini CLI        |
| Applies to | `gemini-settings` |
| Fixable    | Yes, `review`     |
| Since      | 2026.10           |

## Why

In Gemini CLI, `"trust": true` on an MCP server "bypasses all tool call confirmations for this server". Every tool the server offers, including tools a later version adds, runs without the user approving the call. In a committed `.gemini/settings.json` this applies to everyone who trusts the project, which Gemini CLI asks about the first time it opens a folder: folder trust is on by default.

Remove `trust`, or allow only the specific tools you need with the server's `includeTools` list and Gemini CLI's policy rules.

## Evidence

- [Gemini CLI: MCP servers](https://geminicli.com/docs/tools/mcp-server/), verified, checked 2026-10-14
- [Gemini CLI source: cli/src/config/trustedFolders.ts (folder trust is on unless security.folderTrust.enabled is false)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/trustedFolders.ts), verified, checked 2026-11-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Removes "trust" from the server, so Gemini CLI asks before each tool call again.

Preview the fix with `agentcheckup fix --rule mcp/gemini-trust`.

## Configuration

```json
{
  "rules": {
    "mcp/gemini-trust": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line mcp/gemini-trust -- reason -->
```
