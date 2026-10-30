<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/description-too-long`

Skill description exceeds the upload or Claude Code listing limit.

|            |             |
| ---------- | ----------- |
| Severity   | `error`     |
| Category   | `budget`    |
| Platforms  | Claude Code |
| Applies to | `skill`     |
| Fixable    | No          |
| Since      | 2026.10     |

## Why

The Agent Skills specification and the Claude API limit `description` to 1,024 characters. The skills-ref validator, the anthropics/skills packager and claude.ai upload reject a longer one, so this limit is checked only for skills that are installed or uploaded on their own. Claude Code appends `when_to_use` to the description in its skill listing and cuts the combined text at 1,536 characters, so Claude does not see the rest when it chooses a skill.

Put the key use case first and move details into the body.

## Evidence

- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [Claude API: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), verified, checked 2026-10-14
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-30

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "skill/description-too-long": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/description-too-long -- reason -->
```
