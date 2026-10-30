<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `codex/ignored-project-key`

Codex ignores this key in a project config file.

|            |                |
| ---------- | -------------- |
| Severity   | `warn`         |
| Category   | `loading`      |
| Platforms  | Codex          |
| Applies to | `codex-config` |
| Fixable    | No             |
| Since      | 2026.10        |

## Why

Repository content must not choose where Codex sends credentials or which local commands it runs, so Codex removes some keys from a project `.codex/config.toml` and warns at startup: `model_provider`, `model_providers`, `profile`, `profiles`, `notify`, `otel`, `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `responses_api_metadata`, the two `experimental_realtime_*` URLs, some `features` and the `tui.keymap.chat` permission-mode keys.

Other keys have no effect there either: Codex reads `project_root_markers` and `projects` before it loads project files, to find the project root and decide whether to trust it, and it reads `hooks.state`, the record of trusted hooks, only from user and session configuration.

Move the setting to your user configuration (`~/.codex/config.toml`), or delete it.

## Evidence

- [Codex source: config loader (.codex/config.toml from the project root down, parse errors, project key denylist)](https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs), verified, checked 2026-10-30
- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [Codex source: config_rules.rs (hooks.state only from user and session layers)](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/config_rules.rs), verified, checked 2026-10-17
- [Codex: Config basics](https://learn.chatgpt.com/docs/config-file/config-basic), verified, checked 2026-10-14
- [Codex: Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), verified, checked 2026-10-17

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "codex/ignored-project-key": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line codex/ignored-project-key -- reason -->
```
