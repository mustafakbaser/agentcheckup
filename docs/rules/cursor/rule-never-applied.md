<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `cursor/rule-never-applied`

Cursor rule is applied only when @-mentioned.

|            |               |
| ---------- | ------------- |
| Severity   | `info`        |
| Category   | `loading`     |
| Platforms  | Cursor        |
| Applies to | `cursor-rule` |
| Fixable    | Yes, `review` |
| Since      | 2026.10       |

## Why

Cursor decides when to include a rule from its frontmatter. With `alwaysApply: true` the rule is always included; with `globs` it is attached when a matching file is in context; with only a `description` the agent includes it when relevant. With none of them the rule is included only when you @-mention it in chat.

That manual mode is useful on purpose, so a rule that sets `alwaysApply: false` explicitly is not reported. A rule without frontmatter, or whose frontmatter sets none of the three fields, is reported as information because it is often an accident, for example a file copied from another tool.

Add `alwaysApply: true`, `globs` or a `description`, or set `alwaysApply: false` to keep the rule manual on purpose.

## Evidence

- [Cursor: Rules](https://cursor.com/docs/rules), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Needs your words: `agentcheckup fix -i` asks for the glob patterns of the files the rule is for and writes them as "globs", adding frontmatter when the file has none.

Preview the fix with `agentcheckup fix --rule cursor/rule-never-applied`.

## Configuration

```json
{
  "rules": {
    "cursor/rule-never-applied": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line cursor/rule-never-applied -- reason -->
```
