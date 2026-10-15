<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `hooks/unknown-event`

Hook event name is not one the agent fires.

|            |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| Severity   | `error`                                                             |
| Category   | `loading`                                                           |
| Platforms  | Claude Code, Codex, Cursor, Gemini CLI                              |
| Applies to | `claude-settings`, `codex-hooks`, `cursor-hooks`, `gemini-settings` |
| Fixable    | No                                                                  |
| Since      | 2026.10                                                             |

## Why

Each agent fires a fixed, case-sensitive set of hook events: Claude Code and Codex use PascalCase names such as `PreToolUse`, Cursor camelCase names such as `beforeShellExecution`, and Gemini CLI its own names such as `BeforeTool`. Hooks under any other name never run. Claude Code skips them with a Settings Warning, Gemini CLI with an "Invalid hook event name" warning, and Codex without a warning.

Wrong case (`preToolUse` in Claude Code, `PreToolUse` in `.cursor/hooks.json`) and names copied from another agent are the usual causes; the message gives the right name. In `.codex/hooks.json`, an event at the top level instead of inside `"hooks"` makes Codex skip the whole file.

Rename the key to an event the agent fires.

## Evidence

- [Claude Code: Hooks](https://code.claude.com/docs/en/hooks), verified, checked 2026-10-14
- [Claude Code: Settings](https://code.claude.com/docs/en/settings), verified, checked 2026-10-14
- [Codex: Hooks](https://learn.chatgpt.com/docs/hooks), verified, checked 2026-10-14
- [Codex source: hook_config.rs (event names, hooks.json schema)](https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs), verified, checked 2026-10-14
- [Cursor: Hooks](https://cursor.com/docs/hooks), verified, checked 2026-10-14
- [Gemini CLI: Hooks reference](https://geminicli.com/docs/hooks/reference), verified, checked 2026-10-14
- [Gemini CLI source: hookRegistry.ts (invalid event names are skipped)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRegistry.ts), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "hooks/unknown-event": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line hooks/unknown-event -- reason -->
```
