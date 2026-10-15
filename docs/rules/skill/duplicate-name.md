<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/duplicate-name`

Two skills in one skills directory have the same name.

|            |                                                |
| ---------- | ---------------------------------------------- |
| Severity   | `warn`                                         |
| Category   | `loading`                                      |
| Platforms  | Claude Code, Codex, GitHub Copilot, Gemini CLI |
| Applies to | `skill`                                        |
| Fixable    | No                                             |
| Since      | 2026.10                                        |

## Why

Agents identify a skill by its `name`, or by its directory name when `name` is missing. When two skills in the same skills directory share a name, Claude Code gives the `/name` command to only one of them, Codex lists both under the same name, Gemini CLI loads only the last one it finds, and GitHub Copilot requires names to be unique.

Only skills that an agent finds in the same skills directory are compared: Claude Code reads `<root>/<name>/SKILL.md`, Gemini CLI also `<root>/SKILL.md`, and Codex searches the whole tree. GitHub Copilot does not document a depth and is treated like Claude Code. A skill reached through several symlinks counts once.

Rename one of the skills.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-14
- [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills), verified, checked 2026-10-14
- [Gemini CLI: Agent Skills](https://geminicli.com/docs/cli/skills/), verified, checked 2026-10-14
- [Gemini CLI source: skillManager.ts (same-name skills override each other)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillManager.ts), verified, checked 2026-10-14
- [GitHub Copilot: Add skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "skill/duplicate-name": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line skill/duplicate-name -- reason -->
```
