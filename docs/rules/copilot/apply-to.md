<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `copilot/apply-to`

Path-specific GitHub Copilot instructions have no valid applyTo.

|            |                             |
| ---------- | --------------------------- |
| Severity   | `warn`                      |
| Category   | `loading`                   |
| Platforms  | GitHub Copilot              |
| Applies to | `copilot-path-instructions` |
| Fixable    | Yes, `safe`                 |
| Since      | 2026.10                     |

## Why

A `*.instructions.md` file applies to the files that its `applyTo` frontmatter matches (comma-separated glob patterns). On GitHub.com, only Copilot cloud agent and Copilot code review use these files, and only through `applyTo`. VS Code also loads a file on demand when its `description` matches the task; with neither field, you attach the file to a chat by hand.

A file with a `description` but no `applyTo` is a documented VS Code choice, so it is information only. So are an `applyTo` YAML list, which is not documented, and `excludeAgent: "coding-agent"`, a value from GitHub's November 2025 announcement that the current documentation no longer lists. The documented `excludeAgent` values are `"code-review"` and `"cloud-agent"`.

Add `applyTo` with the patterns the instructions are for, such as `applyTo: "**/*.ts"`.

## Evidence

- [GitHub Copilot: Repository custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions), verified, checked 2026-10-14
- [VS Code: Custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), verified, checked 2026-10-14
- [GitHub changelog, 2025-11-12: agent-specific instructions ("coding-agent")](https://github.blog/changelog/2025-11-12-copilot-code-review-and-coding-agent-now-support-agent-specific-instructions/), unverified, checked 2026-10-14

## Fix

Classes: `safe` ([fix classes](../../fix.md#safe-review-and-manual)).

Joins an "applyTo" YAML list into one comma-separated string.

Preview the fix with `agentcheckup fix --rule copilot/apply-to`.

## Configuration

```json
{
  "rules": {
    "copilot/apply-to": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line copilot/apply-to -- reason -->
```
