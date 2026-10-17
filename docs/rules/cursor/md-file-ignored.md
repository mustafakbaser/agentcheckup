<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `cursor/md-file-ignored`

Cursor ignores .md files in .cursor/rules.

|            |                         |
| ---------- | ----------------------- |
| Severity   | `error`                 |
| Category   | `loading`               |
| Platforms  | Cursor                  |
| Applies to | `cursor-rule-md`        |
| Fixable    | Yes, `safe` or `review` |
| Since      | 2026.10                 |

## Why

Cursor loads project rules from `.cursor/rules` only when they use the `.mdc` extension. Its documentation says a plain `.md` file there "is ignored by the rules system" because it has no frontmatter to set `description`, `globs` and `alwaysApply`. Devin Local, the default agent in Windsurf (now Devin Desktop), does read `.md` files in `.cursor/rules`, so the same file applies in Windsurf and not in Cursor.

A `README.md` in the directory is treated as documentation and is not reported.

Rename the file to `.mdc` and add frontmatter, or move plain Markdown instructions to `AGENTS.md`.

## Evidence

- [Cursor: Rules](https://cursor.com/docs/rules), verified, checked 2026-10-14
- [Devin CLI: Rules (reads .cursor/rules/*.md and *.mdc)](https://docs.devin.ai/cli/extensibility/rules), verified, checked 2026-10-14

## Fix

Classes: `safe`, `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Renames the file to .mdc. Safe when its frontmatter already sets description, globs or alwaysApply; otherwise for review, adding "alwaysApply: true" or renaming "paths" or "applyTo" to "globs".

Preview the fix with `agentcheckup fix --rule cursor/md-file-ignored`.

## Configuration

```json
{
  "rules": {
    "cursor/md-file-ignored": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line cursor/md-file-ignored -- reason -->
```
