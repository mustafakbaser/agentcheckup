<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/name-format`

Skill name does not follow the Agent Skills naming rules.

|            |                                                   |
| ---------- | ------------------------------------------------- |
| Severity   | `error`                                           |
| Category   | `correctness`                                     |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Cline |
| Applies to | `skill`                                           |
| Fixable    | Yes, `safe` or `review`                           |
| Since      | 2026.10                                           |

## Why

The Agent Skills specification allows 1 to 64 lowercase letters, digits and hyphens in `name`, with no hyphen at the start or end and no `--`. GitHub Copilot in VS Code does not load a skill whose name has other characters, Cursor requires the same characters, and Codex skips a skill whose name is longer than 64 characters. Claude Code refuses a name with hidden, direction-changing or blank-like characters, `<` or `>`, so typing the name does not invoke the skill. Codex skips a skill whose `name` is a list or a mapping, and Cline one whose `name` is not text, even a number or a boolean.

For a skill that is installed or uploaded on its own, the skills-ref validator and the anthropics/skills packager reject a name that breaks these rules, and claude.ai upload rejects one with other characters or more than 64. skills-ref accepts non-ASCII lowercase letters, but the packager accepts only `a-z`, `0-9` and `-`.

Rename the skill to lowercase ASCII words joined by single hyphens, and rename its directory to match.

## Evidence

- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-30
- [VS Code: Use Agent Skills (GitHub Copilot)](https://code.visualstudio.com/docs/agent-customization/agent-skills), verified, checked 2026-10-30
- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14
- [Cline source: user-instruction-config-loader.ts (.md, .markdown and .txt rules; root AGENTS.md; disabled and enabled flags)](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts), verified, checked 2026-10-30
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14
- [Claude API: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), verified, checked 2026-10-30
- [Cursor: Skills](https://cursor.com/docs/skills), verified, checked 2026-10-30
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-30

## Fix

Classes: `safe`, `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Sets `name` to the directory name: safe when that is the name in lowercase with hyphens, review otherwise. A non-ASCII name or an invalid directory name is left to you.

Preview the fix with `agentcheckup fix --rule skill/name-format`.

## Configuration

```json
{
  "rules": {
    "skill/name-format": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/name-format -- reason -->
```
