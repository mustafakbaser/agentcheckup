<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `directive/missing-reason`

Suppression directive has no rule id or no reason.

|            |                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity   | `warn`                                                                                                                                                                                                                                                                                                                         |
| Category   | `correctness`                                                                                                                                                                                                                                                                                                                  |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                                                                                        |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `imported-file` |
| Fixable    | No                                                                                                                                                                                                                                                                                                                             |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                        |

## Why

An inline directive such as `<!-- agentcheckup-disable-next-line instr/import-unresolved -- generated file -->` must name the rules it disables and give a reason after `--`. A directive without either has no effect.

Add the rule ids and a short reason.

## Evidence

- [agentcheckup inline suppression directives](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/configuration.md#inline-suppressions), verified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "directive/missing-reason": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line directive/missing-reason -- reason -->
```
