<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `settings/plugin-manifest`

Plugin manifest has an invalid name or component path.

|            |                          |
| ---------- | ------------------------ |
| Severity   | `error`                  |
| Category   | `loading`                |
| Platforms  | Claude Code              |
| Applies to | `claude-plugin-manifest` |
| Fixable    | No                       |
| Since      | 2026.10                  |

## Why

`name` is the only required field in `.claude-plugin/plugin.json`. Without it, or with spaces, `@`, `:`, path separators, control or bidirectional characters in it, the manifest is invalid and the plugin cannot be installed. A `homepage` that does not parse as a URL makes the plugin fail to load. Every component path must start with `./`, stay inside the plugin directory and exist, or the manifest fails validation or the component does not load. `skills` also accepts `"."`, and `mcpServers` an `https://` bundle URL.

Two problems are warnings, because the plugin still loads: a name that is not kebab-case, which `claude plugin validate` warns about, and a reserved name (starting with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-`, a name such as `claude-code`, or `official` next to `claude` or `anthropic`), which `claude plugin validate` reports as an error and `claude plugin init` and `claude plugin tag` refuse.

Fix the field the finding points to.

## Evidence

- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference), verified, checked 2026-10-14
- [Claude Code: Troubleshoot plugins (corrupt manifest file, Invalid JSON syntax)](https://code.claude.com/docs/en/plugins/troubleshooting), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "settings/plugin-manifest": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line settings/plugin-manifest -- reason -->
```
