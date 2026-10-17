<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/description-quality`

Skill description is too short or does not say when to use it.

|            |                                                        |
| ---------- | ------------------------------------------------------ |
| Severity   | `info`                                                 |
| Category   | `clarity`                                              |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI |
| Applies to | `skill`                                                |
| Fixable    | Yes, `review`                                          |
| Since      | 2026.10                                                |

## Why

Agents decide whether to load a skill by matching the request against its `name` and `description`. The Claude skill authoring guide and the Agent Skills specification ask for a description that says what the skill does and when to use it, with the keywords a request would contain. A description of a few words, or one without a "Use when ..." clause, gives the agent little to match.

This check reads English only and skips descriptions in other languages. Findings are advice and do not affect the score.

Say what the skill does, then add a "Use when ..." clause with the situations and keywords that should trigger it.

## Evidence

- [Claude API: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), verified, checked 2026-10-14
- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-17

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Needs your words: `agentcheckup fix -i` asks for a "Use when ..." sentence and appends it to the description, or for a new description when it has fewer than 8 words, and checks the answer against this rule before writing it.

Preview the fix with `agentcheckup fix --rule skill/description-quality`.

## Configuration

```json
{
  "rules": {
    "skill/description-quality": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/description-quality -- reason -->
```
