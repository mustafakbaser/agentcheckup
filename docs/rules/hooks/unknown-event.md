<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `hooks/unknown-event`

Hook event name is not one the agent fires.

|            |                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Severity   | `error`                                                                                                            |
| Category   | `loading`                                                                                                          |
| Platforms  | Claude Code, Codex, Cursor, Gemini CLI, Devin Local                                                                |
| Applies to | `claude-settings`, `codex-hooks`, `codex-config`, `cursor-hooks`, `gemini-settings`, `devin-config`, `devin-hooks` |
| Fixable    | Yes, `review`                                                                                                      |
| Since      | 2026.10                                                                                                            |

## Why

Each agent fires a fixed, case-sensitive set of hook events: Claude Code and Codex use PascalCase names such as `PreToolUse`, Cursor camelCase names such as `beforeShellExecution`, and Gemini CLI its own names such as `BeforeTool`. Hooks under any other name never run. Claude Code skips them with a Settings Warning, Gemini CLI with an "Invalid hook event name" warning, and Codex without a warning. Codex's list follows its source, which fires `PreModelRequest` and `PostModelRequest` around each model request before its documentation lists them.

Devin Local fires the eight events its documentation lists, such as `PreToolUse` and `PostCompaction`, for the hooks in `.devin/hooks.v1.json` and under `"hooks"` in `.devin/config.json` and `.devin/config.local.json`; hooks under any other name never run. Whether it also matches a listed name in another letter case is not documented, so such a name is information only. Cascade's snake_case events in `.devin/hooks.json` are not checked.

Wrong case (`preToolUse` in Claude Code, `PreToolUse` in `.cursor/hooks.json`) and names copied from another agent are the usual causes; the message gives the right name. In `.codex/hooks.json`, an event at the top level instead of inside `"hooks"` makes Codex skip the whole file. Inline `[hooks]` tables in `.codex/config.toml` are checked too, without a fix.

Rename the key to an event the agent fires.

## Evidence

- [Claude Code: Hooks](https://code.claude.com/docs/en/hooks), verified, checked 2026-10-14
- [Claude Code: Settings](https://code.claude.com/docs/en/settings), verified, checked 2026-10-14
- [Codex: Hooks](https://learn.chatgpt.com/docs/hooks), verified, checked 2026-10-14
- [Codex source: hook_config.rs (hooks.json top level: description and hooks only)](https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs), verified, checked 2026-10-30
- [Codex source: hooks/src/lib.rs (HOOK_EVENT_NAMES, and the events whose matcher is used)](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs), verified, checked 2026-10-30
- [Cursor: Hooks](https://cursor.com/docs/hooks), verified, checked 2026-10-14
- [Gemini CLI: Hooks reference](https://geminicli.com/docs/hooks/reference), verified, checked 2026-10-14
- [Gemini CLI source: hookRegistry.ts (invalid event names are skipped)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRegistry.ts), verified, checked 2026-10-14
- [Devin CLI: Hooks](https://docs.devin.ai/cli/extensibility/hooks/overview), verified, checked 2026-10-17
- [Devin CLI: Lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks), verified, checked 2026-10-17

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Renames the key to the event the message names: the same name in the right case, or the event within two edits of it. Always a review fix, because the hooks under it start to run. Not offered when the file already has that event.

Preview the fix with `agentcheckup fix --rule hooks/unknown-event`.

## Configuration

```json
{
  "rules": {
    "hooks/unknown-event": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line hooks/unknown-event -- reason -->
```
