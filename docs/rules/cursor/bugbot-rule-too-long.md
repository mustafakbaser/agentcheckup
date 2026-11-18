<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `cursor/bugbot-rule-too-long`

BUGBOT.md exceeds Bugbot's 30,000-character limit per rule.

|            |                 |
| ---------- | --------------- |
| Severity   | `warn`          |
| Category   | `budget`        |
| Platforms  | Cursor          |
| Applies to | `cursor-bugbot` |
| Fixable    | No              |
| Since      | 2026.10         |

## Why

Bugbot, Cursor's pull request reviewer, and Agent Review read `.cursor/BUGBOT.md` files as review rules: the root file in every review, and a nested one when the review covers files below its directory. Bugbot truncates each rule at 30,000 characters when it includes it in a review, so the guidance past that point never reaches the reviewer. All rules of a review together are capped at 100,000 characters, and rules past that cap may be left out.

agentcheckup counts Unicode characters, without the frontmatter and with a CRLF line break as one character, so it reports only files that are over the limit however Bugbot counts. Files a `BUGBOT.md` links to count as rules of their own and are not checked.

Move parts of the file into `.md` files it links to, each with its own 30,000-character limit, or into a nested `.cursor/BUGBOT.md` for the directory the guidance is about.

## Evidence

- [Cursor: Bugbot](https://cursor.com/docs/bugbot), verified, checked 2026-11-18
- [Cursor: Agent Review](https://cursor.com/docs/agent/agent-review), verified, checked 2026-11-18

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "cursor/bugbot-rule-too-long": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line cursor/bugbot-rule-too-long -- reason -->
```
