<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/claude-rule-frontmatter`

Claude Code rule frontmatter is invalid or ignored.

|            |               |
| ---------- | ------------- |
| Severity   | `warn`        |
| Category   | `loading`     |
| Platforms  | Claude Code   |
| Applies to | `claude-rule` |
| Fixable    | No            |
| Since      | 2026.10       |

## Why

Claude Code reads one field from the frontmatter of a `.claude/rules/` file: `paths`, a YAML list of glob patterns or a comma-separated string. A rule without `paths` loads in every session. If the YAML does not parse, Claude Code ignores the frontmatter and loads the rule in every session too. Other fields, including Cursor's `globs` and GitHub Copilot's `applyTo`, are ignored without an error.

In a pattern, `[` starts a bracket expression. A pattern with a `[` and no closing `]` is invalid and matches no files; the rule's other patterns keep working. Invalid YAML in a rule that has no `paths` is reported as information, and so is a `paths` value that is empty or not a pattern or list of patterns, because the documentation does not say what Claude Code does with it.

Rename `globs` or `applyTo` to `paths`, fix the YAML, and escape a literal bracket as `\[`.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/claude-rule-frontmatter": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/claude-rule-frontmatter -- reason -->
```
