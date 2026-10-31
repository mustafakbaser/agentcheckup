<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `hooks/fails-open`

Tool-gating hook lets the tool call proceed when it fails.

|            |                                                                                     |
| ---------- | ----------------------------------------------------------------------------------- |
| Severity   | `info`                                                                              |
| Category   | `risk`                                                                              |
| Platforms  | Claude Code, Codex, Cursor, Gemini CLI                                              |
| Applies to | `claude-settings`, `codex-hooks`, `codex-config`, `cursor-hooks`, `gemini-settings` |
| Fixable    | Yes, `review`                                                                       |
| Since      | 2026.10                                                                             |

## Why

Hooks on events such as `PreToolUse` (Claude Code, Codex), `beforeShellExecution` (Cursor) and `BeforeTool` (Gemini CLI) can block a tool call, so they are used to enforce policies. By default all four agents fail open: when such a hook crashes or cannot start, the tool call proceeds as if the hook had allowed it. Claude Code, Codex and Cursor also let it proceed when the hook times out. A policy hook with a broken path or a slow dependency therefore protects nothing.

This is documented behavior, so the finding is advice. To fail closed, set `"onFailure": "block"` on a Claude Code command or HTTP hook (v2.1.295 or later), or `"failClosed": true` on a Cursor hook. Codex and Gemini CLI have no such setting: the script has to catch its own errors and exit with code 2 (in Codex, with a reason on stderr).

## Evidence

- [Claude Code: Hooks](https://code.claude.com/docs/en/hooks), verified, checked 2026-10-14
- [Cursor: Hooks](https://cursor.com/docs/hooks), verified, checked 2026-10-30
- [Codex: Hooks](https://learn.chatgpt.com/docs/hooks), verified, checked 2026-10-14
- [Gemini CLI: Hooks](https://geminicli.com/docs/hooks/), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Sets "onFailure": "block" on the Claude Code hook or "failClosed": true on the Cursor hook. Codex and Gemini CLI have no such setting, so their scripts must be changed by hand.

Preview the fix with `agentcheckup fix --rule hooks/fails-open`.

## Configuration

```json
{
  "rules": {
    "hooks/fails-open": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line hooks/fails-open -- reason -->
```
