<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `directive/unknown-rule`

Suppression directive names a rule that does not exist.

|            |                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity   | `warn`                                                                                                                                                                                                                                                                                                                         |
| Category   | `correctness`                                                                                                                                                                                                                                                                                                                  |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                                                                                        |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `imported-file` |
| Fixable    | No                                                                                                                                                                                                                                                                                                                             |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                        |

## Why

agentcheckup has no rule with this id, so the directive suppresses nothing for it. Rules the same directive names correctly are still suppressed.

Check the id against the rule catalog; usually it is misspelled.

## Evidence

- [agentcheckup inline suppression directives](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/configuration.md#inline-suppressions), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "directive/unknown-rule": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line directive/unknown-rule -- reason -->
```
