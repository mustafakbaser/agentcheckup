<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `settings/ignored-permission-mode`

Claude Code ignores this permission mode in project settings.

|            |                   |
| ---------- | ----------------- |
| Severity   | `warn`            |
| Category   | `loading`         |
| Platforms  | Claude Code       |
| Applies to | `claude-settings` |
| Fixable    | No                |
| Since      | 2026.10           |

## Why

Since v2.1.257, Claude Code ignores the `permissions.defaultMode` values `auto` and `bypassPermissions` in project settings (`.claude/settings.json`) and local settings (`.claude/settings.local.json`); before that version, `bypassPermissions` took effect from any file. A team that commits one of these values does not get the mode it set.

Set the mode in `~/.claude/settings.json` or managed settings, or pass `--permission-mode` for one session.

## Evidence

- [Claude Code: Settings](https://code.claude.com/docs/en/settings), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "settings/ignored-permission-mode": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line settings/ignored-permission-mode -- reason -->
```
