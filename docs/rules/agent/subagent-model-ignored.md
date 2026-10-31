<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `agent/subagent-model-ignored`

Claude Code ignores the subagent's model.

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| Severity   | `warn`                                                                         |
| Category   | `correctness`                                                                  |
| Platforms  | Claude Code                                                                    |
| Applies to | `claude-agent`, `cursor-agent`, `gemini-agent`, `copilot-agent`, `devin-agent` |
| Fixable    | No                                                                             |
| Since      | 2026.10                                                                        |

## Why

While `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on, Claude Code ignores the `model` field of every subagent and runs each one on `CLAUDE_CODE_SUBAGENT_MODEL`, or on the main conversation's model when that is not set. A repository turns it on in the `env` block of `.claude/settings.json` or `.claude/settings.local.json`, so a subagent's `model` there has no effect, though the file says otherwise. Requires Claude Code v2.1.257 or later.

Remove `model` from the subagent, or turn `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` off if subagents should keep their own models.

## Evidence

- [Claude Code: Subagents](https://code.claude.com/docs/en/sub-agents), verified, checked 2026-10-30
- [Claude Code: Model configuration](https://code.claude.com/docs/en/model-config), verified, checked 2026-10-30

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "agent/subagent-model-ignored": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line agent/subagent-model-ignored -- reason -->
```
