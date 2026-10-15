<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/windsurf-rule-too-long`

Windsurf rule file exceeds Cascade's 12,000-character limit.

|            |                                          |
| ---------- | ---------------------------------------- |
| Severity   | `info`                                   |
| Category   | `budget`                                 |
| Platforms  | Windsurf                                 |
| Applies to | `windsurf-rule`, `windsurf-legacy-rules` |
| Fixable    | No                                       |
| Since      | 2026.10                                  |

## Why

Cascade, the older agent in Windsurf (now Devin Desktop), limits each workspace rule file in `.devin/rules/` or `.windsurf/rules/` to 12,000 characters; agentcheck applies the same limit to the legacy `.windsurfrules`. The documentation does not say whether a longer file is cut off or rejected, and the default Devin Local agent documents no limit, so this is information only.

agentcheck counts Unicode characters after the frontmatter, with a CRLF line break as one character, so it reports only files that are over the limit however you count.

Split the rule into several rule files with their own activation modes, or move reference material into files the rule points to.

## Evidence

- [Devin Desktop (Windsurf): Memories and rules](https://docs.devin.ai/desktop/cascade/memories), verified, checked 2026-10-14
- [Devin Desktop (Windsurf): what happens past the 12,000-character limit is not documented](https://docs.devin.ai/desktop/cascade/memories), unverified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/windsurf-rule-too-long": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line instr/windsurf-rule-too-long -- reason -->
```
