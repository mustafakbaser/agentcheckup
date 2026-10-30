<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/broad-allowed-tools`

Skill pre-approves shell commands or file edits without limits.

|            |                             |
| ---------- | --------------------------- |
| Severity   | `warn`                      |
| Category   | `risk`                      |
| Platforms  | Claude Code, GitHub Copilot |
| Applies to | `skill`                     |
| Fixable    | Yes, `review`               |
| Since      | 2026.10                     |

## Why

`allowed-tools` lets the agent use the listed tools without asking. In Claude Code, `Bash` or `Bash(*)` pre-approves every shell command, `PowerShell` every PowerShell command, and a bare `Write` or `Edit` every file, during the turn that invokes the skill. Workspace trust does not gate the field: Claude Code applies a project skill's `allowed-tools` even in a `-p` run in a directory that was never trusted, so a cloned repository can grant itself shell access through `.claude/skills`.

GitHub Copilot warns that pre-approving `shell` or `bash` removes the confirmation step for terminal commands and can let attacker-controlled skills or prompt injections run arbitrary commands.

Scope each rule to the commands the skill needs, such as `Bash(git status *)`, or leave the tool out so the agent asks.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-30
- [Claude Code: Configure permissions](https://code.claude.com/docs/en/permissions), verified, checked 2026-10-30
- [GitHub Copilot: Add skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Replaces `Bash` with rules for the commands in the skill's shell code blocks, such as `Bash(git status *)`, and removes bare `Write`, `Edit`, `PowerShell`, `shell` and `bash`. Keeps a string or a list as it is. Offered only when it finds a command; each new rule is listed with its source line.

Preview the fix with `agentcheckup fix --rule skill/broad-allowed-tools`.

## Configuration

```json
{
  "rules": {
    "skill/broad-allowed-tools": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/broad-allowed-tools -- reason -->
```
