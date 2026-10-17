<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `json/duplicate-key`

JSON object repeats a key.

|            |                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                                                                                                                                                                |
| Category   | `correctness`                                                                                                                                                                                                                         |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline                                                                                                                                                            |
| Applies to | `claude-settings`, `claude-plugin-manifest`, `cursor-hooks`, `cursor-mcp`, `gemini-settings`, `mcp-json`, `codex-hooks`, `copilot-hooks`, `copilot-mcp`, `copilot-settings`, `vscode-mcp`, `devin-config`, `devin-mcp`, `devin-hooks` |
| Fixable    | Yes, `safe`                                                                                                                                                                                                                           |
| Since      | 2026.10                                                                                                                                                                                                                               |

## Why

RFC 8259 leaves the result of a repeated key open. `JSON.parse`, which Gemini CLI uses for `settings.json`, keeps only the last value (ECMA-262); some parsers reject the object instead. Either way the earlier value never takes effect: a second `"hooks"` block replaces the first, and a second `.mcp.json` server with the same name replaces the first server, without an error.

The finding points at the earlier key, the one that is ignored. Merge the two entries or delete the one you do not want.

## Evidence

- [ECMA-262: ParseJSON (duplicate names: lexically preceding values are overwritten)](https://tc39.es/ecma262/multipage/structured-data.html#sec-ParseJSON), verified, checked 2026-10-14
- [RFC 8259, section 4: names within an object SHOULD be unique](https://www.rfc-editor.org/rfc/rfc8259#section-4), verified, checked 2026-10-14
- [Gemini CLI source: packages/cli/src/config/settings.ts (strip-json-comments, FatalConfigError)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts), verified, checked 2026-10-14

## Fix

Classes: `safe` ([fix classes](../../fix.md#safe-review-and-manual)).

Deletes the earlier key and its value, which JSON.parse ignores, so the configuration agents read does not change. Not offered when the deletion would remove a comment.

Preview the fix with `agentcheckup fix --rule json/duplicate-key`.

## Configuration

```json
{
  "rules": {
    "json/duplicate-key": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line json/duplicate-key -- reason -->
```
