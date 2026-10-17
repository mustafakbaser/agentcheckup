<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `cursor/legacy-cursorrules`

.cursorrules is a legacy file that Cursor plans to deprecate.

|            |                       |
| ---------- | --------------------- |
| Severity   | `info`                |
| Category   | `loading`             |
| Platforms  | Cursor                |
| Applies to | `cursor-legacy-rules` |
| Fixable    | Yes, `review`         |
| Since      | 2026.10               |

## Why

Cursor's help center calls the `.cursorrules` file in the project root "legacy" and says it "will be deprecated". Its migration steps move the content into a project rule in `.cursor/rules` with the type **Always Apply**, which matches the old behavior.

Cline also reads `.cursorrules`. Moving the instructions to `AGENTS.md` instead keeps them working in Cursor and Cline, and also in Codex, GitHub Copilot and Windsurf.

## Evidence

- [Cursor Help: Rules](https://cursor.com/help/customization/rules), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Moves the file to .cursor/rules/cursorrules.mdc with "alwaysApply: true", as Cursor's migration steps do. `fix -i` also offers renaming it to AGENTS.md when the directory has none.

Preview the fix with `agentcheckup fix --rule cursor/legacy-cursorrules`.

## Configuration

```json
{
  "rules": {
    "cursor/legacy-cursorrules": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line cursor/legacy-cursorrules -- reason -->
```
