<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/non-portable-field`

Skill frontmatter uses a field outside the Agent Skills specification.

|            |                                                                            |
| ---------- | -------------------------------------------------------------------------- |
| Severity   | `warn`                                                                     |
| Category   | `portability`                                                              |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline |
| Applies to | `skill`                                                                    |
| Fixable    | Yes, `review` or `input`                                                   |
| Since      | 2026.10                                                                    |

## Why

The Agent Skills specification defines six frontmatter fields: `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. Claude Code reads its own extensions, such as `when_to_use`, and ignores unknown fields, but claude.ai upload, the Claude API and the anthropics/skills packager fail with a hard error on any other field, and the skills-ref validator rejects it too. Cursor documents `paths`, `disable-model-invocation`, `icon`, `color` and `globs`, GitHub Copilot in VS Code documents `argument-hint`, `user-invocable`, `disable-model-invocation` and `context`, Devin Local documents `argument-hint`, `model` and `agent` among others, and Cline documents none.

For a skill that is installed or uploaded on its own, all such fields are reported together. For a skill in an agent's skills directory or a plugin, a documented extension field is reported only when some of the agents that load the skill there document it and others do not. Fields that none of them document, including unknown fields, are ignored by all of them alike and are not reported there.

Keep extension fields in skills that only their agents load, and move your own data under `metadata`.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-30
- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14
- [Cursor: Skills](https://cursor.com/docs/skills), verified, checked 2026-10-14
- [VS Code: Use Agent Skills (GitHub Copilot)](https://code.visualstudio.com/docs/agent-customization/agent-skills), verified, checked 2026-10-14
- [Devin CLI: Creating skills (optional frontmatter, name defaults to the directory name)](https://docs.devin.ai/cli/extensibility/skills/creating-skills), verified, checked 2026-10-17
- [Cline: Skills](https://docs.cline.bot/customization/skills), verified, checked 2026-10-17

## Fix

Classes: `review`, `input` ([fix classes](../../fix.md#safe-review-and-manual)).

Moves keys that no agent documents under `metadata`, as quoted text, in a skill uploaded or installed on its own. `fix -i` can instead record why the fields stay, as a suppression with your reason, or remove agent-specific fields that do not restrict the model.

Preview the fix with `agentcheckup fix --rule skill/non-portable-field`.

## Configuration

```json
{
  "rules": {
    "skill/non-portable-field": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/non-portable-field -- reason -->
```
