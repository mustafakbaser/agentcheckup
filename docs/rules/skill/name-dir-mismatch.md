<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/name-dir-mismatch`

Skill name does not match its directory name.

|            |                                            |
| ---------- | ------------------------------------------ |
| Severity   | `error`                                    |
| Category   | `correctness`                              |
| Platforms  | Claude Code, Cursor, GitHub Copilot, Cline |
| Applies to | `skill`                                    |
| Fixable    | Yes, `safe` or `review`                    |
| Since      | 2026.10                                    |

## Why

The Agent Skills specification, Cursor, Cline and GitHub Copilot in VS Code require `name` to equal the name of the directory that contains SKILL.md, and VS Code does not load a skill whose name does not match. The skills-ref validator compares both after NFKC normalization and rejects a mismatch. The Claude Skills API is out of beta: only a request that still sends the `skills-2025-10-02` beta header needs the uploaded files inside a top-level directory named after the skill, and without it `SKILL.md` may sit at the root of the upload. Claude Code and Codex do not require a match.

Only the agents that load the skill where it is count, so a skill in a plugin is judged by the plugin's agents. A SKILL.md at a plugin root is exempt, because there `name` deliberately differs from the plugin directory. The specification and upload requirements count only for skills that are installed or uploaded on their own.

Rename the directory or change `name` so that they match.

## Evidence

- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [VS Code: Use Agent Skills (GitHub Copilot)](https://code.visualstudio.com/docs/agent-customization/agent-skills), verified, checked 2026-10-14
- [Cursor: Skills](https://cursor.com/docs/skills), verified, checked 2026-10-14
- [Cline: Skills](https://docs.cline.bot/customization/skills), verified, checked 2026-10-17
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [Claude API: Using Agent Skills with the API](https://platform.claude.com/docs/en/build-with-claude/skills-guide), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-30

## Fix

Classes: `safe`, `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Sets `name` to the directory name: safe when that is the name in lowercase with hyphens, review otherwise. Directories are never renamed.

Preview the fix with `agentcheckup fix --rule skill/name-dir-mismatch`.

## Configuration

```json
{
  "rules": {
    "skill/name-dir-mismatch": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/name-dir-mismatch -- reason -->
```
