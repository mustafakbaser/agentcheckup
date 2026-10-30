<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/body-too-long`

Skill body is longer than recommended.

|            |                                                                            |
| ---------- | -------------------------------------------------------------------------- |
| Severity   | `info`                                                                     |
| Category   | `budget`                                                                   |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline |
| Applies to | `skill`                                                                    |
| Fixable    | Yes, `review`                                                              |
| Since      | 2026.10                                                                    |

## Why

Agents load the whole SKILL.md body when a skill runs. In Claude Code the body then stays in the conversation on later turns, so every line is a recurring token cost, and after compaction Claude Code re-attaches only the first 5,000 tokens of each invoked skill.

Claude Code and the Agent Skills specification recommend keeping SKILL.md under 500 lines, and the specification recommends a body under 5,000 tokens. Both are recommendations, so findings are advice and do not affect the score. Tokens are estimated at four characters per token. Set `maxLines` to change the line limit.

Move reference material into separate files next to SKILL.md and link to them.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-30
- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [Claude API: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), verified, checked 2026-10-14
- [Claude API: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Moves the largest sections of the body into files next to SKILL.md, leaving a link under each heading, until the body fits. The start of the body stays, as do sections with commands or placeholders Claude Code replaces, hidden text, or links that would break. Other bodies are left to you.

Preview the fix with `agentcheckup fix --rule skill/body-too-long`.

## Configuration

```json
{
  "rules": {
    "skill/body-too-long": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/body-too-long -- reason -->
```
