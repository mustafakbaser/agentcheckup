<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `directive/missing-reason`

Suppression directive has no rule id or no reason.

|            |                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                                                                                                                                                                                                                                        |
| Category   | `correctness`                                                                                                                                                                                                                                                                                                 |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                                                                       |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule` |
| Fixable    | No                                                                                                                                                                                                                                                                                                            |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                       |

## Why

An inline directive such as `<!-- agentcheck-disable-next-line instr/import-unresolved -- generated file -->` must name the rules it disables and give a reason after `--`. A directive without either has no effect.

Add the rule ids and a short reason.

## Evidence

- [agentcheck inline suppression directives](https://github.com/mustafakbaser/agentcheck/blob/main/docs/configuration.md#inline-suppressions), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "directive/missing-reason": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line directive/missing-reason -- reason -->
```
