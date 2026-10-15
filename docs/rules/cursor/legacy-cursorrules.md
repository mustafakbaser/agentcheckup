<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `cursor/legacy-cursorrules`

.cursorrules is a legacy file that Cursor plans to deprecate.

|            |                       |
| ---------- | --------------------- |
| Severity   | `info`                |
| Category   | `loading`             |
| Platforms  | Cursor                |
| Applies to | `cursor-legacy-rules` |
| Fixable    | No                    |
| Since      | 2026.10               |

## Why

Cursor's help center calls the `.cursorrules` file in the project root "legacy" and says it "will be deprecated". Its migration steps move the content into a project rule in `.cursor/rules` with the type **Always Apply**, which matches the old behavior.

Cline also reads `.cursorrules`. Moving the instructions to `AGENTS.md` instead keeps them working in Cursor and Cline, and also in Codex, GitHub Copilot and Windsurf.

## Evidence

- [Cursor Help: Rules](https://cursor.com/help/customization/rules), verified, checked 2026-10-14

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
