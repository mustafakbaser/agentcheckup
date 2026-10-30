<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `hooks/script-missing`

Hook command runs a script that does not exist.

|            |                                                                  |
| ---------- | ---------------------------------------------------------------- |
| Severity   | `error`                                                          |
| Category   | `correctness`                                                    |
| Platforms  | Claude Code, Codex, Cursor                                       |
| Applies to | `claude-settings`, `codex-hooks`, `codex-config`, `cursor-hooks` |
| Fixable    | No                                                               |
| Since      | 2026.10                                                          |

## Why

A command hook whose script is missing fails on every run. Claude Code treats a hook that "fails to start, for example because the script or executable doesn't exist" as a non-blocking error and, by default, lets the action proceed; Codex and Cursor also continue. The check the hook was meant to run never happens. With `"onFailure": "block"` (Claude Code) or `"failClosed": true` (Cursor), the same mistake blocks the action every time instead.

The rule reports only paths it can resolve with certainty: `$CLAUDE_PROJECT_DIR`, `$CURSOR_PROJECT_DIR`, relative paths in Cursor (which runs project hooks from the project root), `$(git rev-parse --show-toplevel)` in a repository-root `.codex/hooks.json`, and script arguments of interpreters such as `node`, `python3` and `bash`. Claude Code runs hooks in the session's current directory, so a relative path there is reported only when no directory in the project has the file. Ignored and unlisted directories are never reported.

Fix the path or add the script.

## Evidence

- [Claude Code: Hooks](https://code.claude.com/docs/en/hooks), verified, checked 2026-10-14
- [Cursor: Hooks](https://cursor.com/docs/hooks), verified, checked 2026-10-14
- [Codex: Hooks](https://learn.chatgpt.com/docs/hooks), verified, checked 2026-10-14
- [Codex source: hooks/src/engine/discovery.rs (parse errors, timeouts)](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs), verified, checked 2026-10-30

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "hooks/script-missing": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line hooks/script-missing -- reason -->
```
