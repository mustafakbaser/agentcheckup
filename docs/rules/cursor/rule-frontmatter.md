<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `cursor/rule-frontmatter`

Cursor rule frontmatter field is unknown or has the wrong type.

|            |                         |
| ---------- | ----------------------- |
| Severity   | `warn`                  |
| Category   | `correctness`           |
| Platforms  | Cursor                  |
| Applies to | `cursor-rule`           |
| Fixable    | Yes, `safe` or `review` |
| Since      | 2026.10                 |

## Why

Three frontmatter fields configure a Cursor rule: `description` (text), `globs` (comma-separated glob patterns) and `alwaysApply` (`true` or `false`). Together they decide whether the rule is always included, attached to matching files, picked by the agent from its description, or included only when @-mentioned. A quoted `"true"` is not a boolean, and a field with another name does nothing. When that name is another tool's scoping field, such as `paths` or `applyTo`, the rule does not apply when you expect.

A `globs` YAML list is not documented and other unknown fields are harmless, so both are information only. Unquoted globs such as `globs: *.ts` are not valid YAML, and how Cursor reads them is not documented, so agentcheckup checks only frontmatter that parses as YAML.

Rename the field to `description`, `globs` or `alwaysApply`, and write `alwaysApply: true` without quotes.

## Evidence

- [Cursor: Rules](https://cursor.com/docs/rules), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "cursor/rule-frontmatter": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line cursor/rule-frontmatter -- reason -->
```
