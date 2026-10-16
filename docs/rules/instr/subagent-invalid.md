<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/subagent-invalid`

Claude Code skips a subagent with invalid frontmatter.

|            |                |
| ---------- | -------------- |
| Severity   | `error`        |
| Category   | `loading`      |
| Platforms  | Claude Code    |
| Applies to | `claude-agent` |
| Fixable    | Yes, `safe`    |
| Since      | 2026.10        |

## Why

Claude Code loads a subagent from `.claude/agents/` only when YAML frontmatter on the first line has a `name` and a `description`. Without a `name`, or with frontmatter that does not start on the first line, the file is treated as documentation. A `name` that starts with `-`, contains `:` (reserved for plugin subagents) or is longer than 256 characters, a missing `description`, and YAML that does not parse also make Claude Code skip the file. The session shows no message; the reason, if any, is only in the debug log (`claude --debug`).

Files without frontmatter, such as a README in the agents directory, are documentation and are not reported.

Start the file with the `---` line, add the missing field, and fix the name or the YAML.

## Evidence

- [Claude Code: Subagents](https://code.claude.com/docs/en/sub-agents), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/subagent-invalid": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/subagent-invalid -- reason -->
```
