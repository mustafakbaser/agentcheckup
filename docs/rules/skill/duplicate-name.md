<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/duplicate-name`

Two skills that an agent reads together have the same name.

|            |                                                                            |
| ---------- | -------------------------------------------------------------------------- |
| Severity   | `warn`                                                                     |
| Category   | `loading`                                                                  |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline |
| Applies to | `skill`                                                                    |
| Fixable    | No                                                                         |
| Since      | 2026.10                                                                    |

## Why

Agents identify a skill by its `name`, or by its directory name when `name` is missing. When two skills that an agent reads together share a name, Claude Code gives the `/name` command to only one of them, Codex lists both under the same name, Gemini CLI and Cline load only the last one they find, and GitHub Copilot requires names to be unique. Cursor and Devin Local identify a skill by its directory and do not document what happens to two skills of one name.

An agent reads skills together when they are in one of its skills directories, or in two of its skills directories of the same project: Cursor, GitHub Copilot, Devin Local and Cline read both `.claude/skills` and `.agents/skills`, so a skill copied into both is two skills of one name to them. Claude Code reads `<root>/<name>/SKILL.md`, Gemini CLI and Cline also `<root>/SKILL.md`, and Codex and Cursor search the whole tree. GitHub Copilot does not document a depth and is treated like Claude Code. A skill without frontmatter counts under its directory name for the agents that load it so: Claude Code, Cursor, Devin Local and Cline. A skill reached through several symlinks counts once, so a symlink from one skills directory to the other is not reported.

Rename one of the skills, or, when they are the same skill, keep one copy and link to it from the other skills directory.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-17
- [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills), verified, checked 2026-10-14
- [Gemini CLI: Agent Skills](https://geminicli.com/docs/cli/skills/), verified, checked 2026-10-14
- [Gemini CLI source: skillManager.ts (same-name skills override each other)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillManager.ts), verified, checked 2026-10-14
- [GitHub Copilot: Add skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), verified, checked 2026-10-14
- [Cursor: Skills](https://cursor.com/docs/skills), verified, checked 2026-10-14
- [Devin CLI: Creating skills (optional frontmatter, name defaults to the directory name)](https://docs.devin.ai/cli/extensibility/skills/creating-skills), verified, checked 2026-10-17
- [Cline source: unified-config-file-watcher.ts (a later skill with the same name replaces an earlier one)](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/config/unified-config-file-watcher.ts), verified, checked 2026-10-17

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "skill/duplicate-name": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/duplicate-name -- reason -->
```
