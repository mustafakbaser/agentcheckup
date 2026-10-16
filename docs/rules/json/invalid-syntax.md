<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `json/invalid-syntax`

Configuration file is not valid JSON.

|            |                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Severity   | `error`                                                                                                                 |
| Category   | `loading`                                                                                                               |
| Platforms  | Claude Code, Codex, Cursor, Gemini CLI                                                                                  |
| Applies to | `claude-settings`, `claude-plugin-manifest`, `mcp-json`, `cursor-mcp`, `cursor-hooks`, `codex-hooks`, `gemini-settings` |
| Fixable    | Yes, `review`                                                                                                           |
| Since      | 2026.10                                                                                                                 |

## Why

Agents read these files with strict JSON parsers, so a `//` comment or a comma after the last entry breaks the whole file. Claude Code reports a Settings Error and runs without the settings file (a `-p` run skips it silently). A `plugin.json` that does not parse is a corrupt manifest, and the plugin cannot be installed. Codex skips a `hooks.json` it cannot parse, with a warning. Gemini CLI does not start until `settings.json` parses.

Gemini CLI removes comments from `settings.json` before parsing, and agentcheckup reads the file the same way, so only trailing commas are reported there. Claude Code and Cursor do not document how they treat comments and trailing commas in `.mcp.json`, `.cursor/mcp.json` and `.cursor/hooks.json`, so those are `info` findings. Other syntax errors are errors in every file.

The finding points at the first syntax error. Fix it and run agentcheckup again.

## Evidence

- [Claude Code: Settings](https://code.claude.com/docs/en/settings), verified, checked 2026-10-14
- [Claude Code: Troubleshoot plugins (corrupt manifest file, Invalid JSON syntax)](https://code.claude.com/docs/en/plugins/troubleshooting), verified, checked 2026-10-14
- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-10-14
- [Codex source: hooks/src/engine/discovery.rs (failed to parse hooks config)](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs), verified, checked 2026-10-14
- [Gemini CLI source: packages/cli/src/config/settings.ts (strip-json-comments, FatalConfigError)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts), verified, checked 2026-10-14
- [Cursor: MCP](https://cursor.com/docs/mcp), verified, checked 2026-10-14
- [Cursor: Hooks](https://cursor.com/docs/hooks), verified, checked 2026-10-14
- [Cursor forum: "The mcp.json parser can't handle JavaScript comments" (user report)](https://forum.cursor.com/t/92529), unverified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "json/invalid-syntax": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line json/invalid-syntax -- reason -->
```
