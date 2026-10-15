<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `directive/unused`

Suppression directive does not suppress anything.

|            |                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                                                                                                                                                                                                                                        |
| Category   | `correctness`                                                                                                                                                                                                                                                                                                 |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                                                                       |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule` |
| Fixable    | No                                                                                                                                                                                                                                                                                                            |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                       |

## Why

None of the rules the directive names reports a finding where it applies, so it suppresses nothing. Remove it so it cannot hide a future problem.

## Evidence

- [agentcheckup inline suppression directives](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/configuration.md#inline-suppressions), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "directive/unused": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line directive/unused -- reason -->
```
