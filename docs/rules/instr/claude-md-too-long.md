<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/claude-md-too-long`

CLAUDE.md is longer than 200 lines.

|            |                                |
| ---------- | ------------------------------ |
| Severity   | `info`                         |
| Category   | `budget`                       |
| Platforms  | Claude Code                    |
| Applies to | `claude-md`, `claude-local-md` |
| Fixable    | No                             |
| Since      | 2026.10                        |

## Why

Claude Code loads every `CLAUDE.md` and `CLAUDE.local.md` in the working directory and above it at the start of each session. Its documentation recommends under 200 lines per file, because longer files consume more context and reduce adherence, and Claude Code warns at startup about a longer file. The file still loads in full (up to 4 MiB), so this is information only.

Moving text into `@path` imports does not help: imported files load at launch too. Move instructions that matter for only part of the codebase into path-scoped rules in `.claude/rules/`, which load when Claude works with matching files, or into skills, which load on demand. The `maxLines` option changes the limit.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/claude-md-too-long": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line instr/claude-md-too-long -- reason -->
```
