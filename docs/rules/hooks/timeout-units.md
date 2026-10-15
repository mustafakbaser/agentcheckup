<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `hooks/timeout-units`

Hook timeout looks like the wrong unit.

|            |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| Severity   | `warn`                                                              |
| Category   | `correctness`                                                       |
| Platforms  | Claude Code, Codex, Cursor, Gemini CLI                              |
| Applies to | `claude-settings`, `codex-hooks`, `cursor-hooks`, `gemini-settings` |
| Fixable    | No                                                                  |
| Since      | 2026.10                                                             |

## Why

Claude Code, Codex and Cursor read a hook's `timeout` in seconds; Claude Code and Codex default to 600. Gemini CLI reads it in milliseconds and defaults to 60,000. A value in the other unit is off by a factor of 1,000: `"timeout": 5000` meant as five seconds lets a hung hook block Claude Code for 83 minutes, and `"timeout": 30` cancels a Gemini CLI hook after 30 milliseconds.

In seconds-based files the rule reports values of 1,000 or more that are multiples of 500, and values of a day or more; durations such as 1,800 or 3,600 seconds are not reported. In Gemini CLI settings it reports values below 1,000.

Write the timeout in the unit of the agent that reads the file.

## Evidence

- [Claude Code: Hooks](https://code.claude.com/docs/en/hooks), verified, checked 2026-10-14
- [Codex: Hooks](https://learn.chatgpt.com/docs/hooks), verified, checked 2026-10-14
- [Codex source: hooks/src/engine/discovery.rs (parse errors, timeouts)](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs), verified, checked 2026-10-14
- [Cursor: Hooks](https://cursor.com/docs/hooks), verified, checked 2026-10-14
- [Gemini CLI: Hooks reference](https://geminicli.com/docs/hooks/reference), verified, checked 2026-10-14
- [Gemini CLI source: hookRunner.ts (timeout in milliseconds)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRunner.ts), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "hooks/timeout-units": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line hooks/timeout-units -- reason -->
```
