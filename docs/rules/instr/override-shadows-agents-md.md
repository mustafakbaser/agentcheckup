<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/override-shadows-agents-md`

AGENTS.override.md hides AGENTS.md from Codex.

|            |                      |
| ---------- | -------------------- |
| Severity   | `error`              |
| Category   | `loading`            |
| Platforms  | Codex                |
| Applies to | `agents-override-md` |
| Fixable    | No                   |
| Since      | 2026.10              |

## Why

In each directory, Codex reads only the first of `AGENTS.override.md` and `AGENTS.md` that exists as a file. It picks the override even when it is empty, then skips it because it has no content, so an empty or whitespace-only `AGENTS.override.md` leaves Codex with no instructions from that directory.

A non-empty override replaces `AGENTS.md` for Codex only: Claude Code never reads `AGENTS.override.md`, and the other agents do not document it. That case is reported as information.

Delete an override you no longer need, or keep it out of version control.

## Evidence

- [Codex: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), verified, checked 2026-10-14
- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "instr/override-shadows-agents-md": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/override-shadows-agents-md -- reason -->
```
