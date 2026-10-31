<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/windsurf-rule-too-long`

Rule file exceeds Cascade's 12,000-character limit in JetBrains.

|            |                                          |
| ---------- | ---------------------------------------- |
| Severity   | `info`                                   |
| Category   | `budget`                                 |
| Platforms  | Devin Local                              |
| Applies to | `windsurf-rule`, `windsurf-legacy-rules` |
| Fixable    | No                                       |
| Since      | 2026.10                                  |

## Why

Cascade in the Windsurf JetBrains plugin limits each rules file to 12,000 characters. agentcheckup applies the same limit to the rule files of Devin Desktop (formerly Windsurf) in `.devin/rules/` and `.windsurf/rules/` and to the legacy `.windsurfrules`. The plugin's documentation does not say whether a longer file is cut off or rejected, and Devin Local, the default agent of Devin Desktop, documents no limit, so this is information only.

agentcheckup counts Unicode characters after the frontmatter, with a CRLF line break as one character, so it reports only files that are over the limit however you count.

Split the rule into several rule files with their own activation modes, or move reference material into files the rule points to.

## Evidence

- [Windsurf JetBrains plugin: Cascade memories and rules ("Rules files are limited to 12000 characters each")](https://docs.devin.ai/windsurf/plugins/cascade/memories), verified, checked 2026-10-30
- [Windsurf JetBrains plugin: what happens past the 12,000-character limit is not documented](https://docs.devin.ai/windsurf/plugins/cascade/memories), unverified, checked 2026-10-30

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "instr/windsurf-rule-too-long": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/windsurf-rule-too-long -- reason -->
```
