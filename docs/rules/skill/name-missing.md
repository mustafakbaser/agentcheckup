<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/name-missing`

Skill name is missing or empty.

|            |                                                        |
| ---------- | ------------------------------------------------------ |
| Severity   | `error`                                                |
| Category   | `portability`                                          |
| Platforms  | Claude Code, Cursor, GitHub Copilot, Gemini CLI, Cline |
| Applies to | `skill`                                                |
| Fixable    | Yes, `safe`                                            |
| Since      | 2026.10                                                |

## Why

The Agent Skills specification, Cursor, GitHub Copilot, Cline and the Claude API require a `name` field. Gemini CLI skips a SKILL.md whose frontmatter has no `name`, and loads a skill whose `name` is empty under an empty name. Claude Code, Codex and Devin Local fall back to the directory name, so the skill works there but not in the agents that require the field.

Add `name` with the directory name, in lowercase letters, digits and hyphens.

## Evidence

- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [Cursor: Skills](https://cursor.com/docs/skills), verified, checked 2026-10-14
- [GitHub Copilot: Add skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), verified, checked 2026-10-14
- [Cline: Skills](https://docs.cline.bot/customization/skills), verified, checked 2026-10-17
- [Claude API: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), verified, checked 2026-10-14
- [Gemini CLI source: skillLoader.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-17
- [Codex source: skill loader (default name from the directory)](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/host.rs), verified, checked 2026-10-14
- [Devin CLI: Creating skills (optional frontmatter, name defaults to the directory name)](https://docs.devin.ai/cli/extensibility/skills/creating-skills), verified, checked 2026-10-17

## Fix

Classes: `safe` ([fix classes](../../fix.md#safe-review-and-manual)).

Sets `name` to the directory name when that is a valid skill name.

Preview the fix with `agentcheckup fix --rule skill/name-missing`.

## Configuration

```json
{
  "rules": {
    "skill/name-missing": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/name-missing -- reason -->
```
