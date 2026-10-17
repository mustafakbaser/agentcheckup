<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `codex/config-invalid`

Codex project config is not valid.

|            |                |
| ---------- | -------------- |
| Severity   | `error`        |
| Category   | `loading`      |
| Platforms  | Codex          |
| Applies to | `codex-config` |
| Fixable    | No             |
| Since      | 2026.10        |

## Why

Codex reads `.codex/config.toml` in each directory from the project root down to the working directory. When one of them is not valid TOML, Codex stops at startup with "Error parsing project config file" in a trusted project, so no session starts there. A file that is not valid UTF-8 stops it with "Failed to read project config file", trusted or not. Codex reads TOML 1.1, so line breaks and a trailing comma in an inline table, `\e`, `\xHH` and times without seconds are fine.

The rule also warns about MCP server entries Codex rejects: one with neither `command` nor `url`, one with both, a field the transport does not take, and `bearer_token`, which Codex does not accept at all. Whether such an entry stops Codex at startup or only drops the server is not verified. Server entries are judged as Codex merges them across the project config files above.

Fix the syntax at the position the message gives, or the server entry.

## Evidence

- [Codex source: config loader (.codex/config.toml from the project root down, parse errors, project key denylist)](https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs), verified, checked 2026-10-17
- [Codex source: read_file_text decodes UTF-8 without removing a byte order mark](https://github.com/openai/codex/blob/main/codex-rs/file-system/src/lib.rs), verified, checked 2026-10-14
- [Codex source: mcp_types.rs (transport from command or url, startup timeouts)](https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs), verified, checked 2026-10-17
- [Codex: MCP](https://learn.chatgpt.com/docs/extend/mcp), verified, checked 2026-10-14
- [Codex: Config basics](https://learn.chatgpt.com/docs/config-file/config-basic), verified, checked 2026-10-14
- [Codex source: Cargo.lock at ce0323f (toml 0.9.11+spec-1.1.0, toml_parser 1.1.3+spec-1.1.0)](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/Cargo.lock), verified, checked 2026-10-17
- [TOML v1.1.0](https://toml.io/en/v1.1.0), verified, checked 2026-10-17

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "codex/config-invalid": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line codex/config-invalid -- reason -->
```
