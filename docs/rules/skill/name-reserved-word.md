<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/name-reserved-word`

Skill name uses a reserved word or name.

|            |               |
| ---------- | ------------- |
| Severity   | `warn`        |
| Category   | `portability` |
| Platforms  | Claude Code   |
| Applies to | `skill`       |
| Fixable    | No            |
| Since      | 2026.10       |

## Why

The Claude API and claude.ai upload reject a skill whose `name` contains the reserved words `anthropic` or `claude`. This matters only for skills that are installed or uploaded on their own, so it is not reported for skills in an agent's skills directory or in a plugin.

Claude Code reserves names for skills synced from claude.ai. Outside a plugin, a skill directory or frontmatter `name` that is `anthropic-skills` or starts with `anthropic-skills:` does not load, and Claude Code skips a skill directory named `synced`, in any letter case, in its enterprise, personal and project skills directories. Of these, agentcheckup sees only the project's `.claude/skills` at the scan root, so it checks `synced` there and not in nested `.claude/skills` directories.

Choose a name without these words.

## Evidence

- [Claude API: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), verified, checked 2026-10-14
- [Claude API: Using Agent Skills with the API](https://platform.claude.com/docs/en/build-with-claude/skills-guide), verified, checked 2026-10-14
- [Claude API: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "skill/name-reserved-word": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/name-reserved-word -- reason -->
```
