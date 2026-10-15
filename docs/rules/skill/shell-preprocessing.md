<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/shell-preprocessing`

Skill runs a risky shell command before Claude reads it.

|            |             |
| ---------- | ----------- |
| Severity   | `warn`      |
| Category   | `risk`      |
| Platforms  | Claude Code |
| Applies to | `skill`     |
| Fixable    | No          |
| Since      | 2026.10     |

## Why

In a skill, a code span that follows an exclamation mark at the start of a line or after whitespace, such as `` !`git status` ``, and a fenced code block opened with ` ```! `, are shell commands. Claude Code runs them when the skill is invoked, before Claude sees the skill, and replaces them with their output. They never prompt: Claude Code checks each command against your permission rules, and outside auto mode a command that is not allowed aborts the skill. A command that your rules or the skill's `allowed-tools` allow runs without asking.

This rule reports injected commands that pipe downloaded content into a shell, run `eval`, or delete files with `rm -rf`. Ordinary commands such as `git status` are not reported.

Review these commands before you invoke the skill, or set `disableSkillShellExecution` to `true` in managed settings to replace them with a placeholder.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-14
- [Claude Code: Configure permissions](https://code.claude.com/docs/en/permissions), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "skill/shell-preprocessing": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line skill/shell-preprocessing -- reason -->
```
