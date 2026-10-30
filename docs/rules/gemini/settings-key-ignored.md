<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `gemini/settings-key-ignored`

Gemini CLI ignores a top-level key from its old settings format.

|            |                   |
| ---------- | ----------------- |
| Severity   | `warn`            |
| Category   | `loading`         |
| Platforms  | Gemini CLI        |
| Applies to | `gemini-settings` |
| Fixable    | No                |
| Since      | 2026.10           |

## Why

Since version 0.3, Gemini CLI keeps its settings in nested categories, such as `context.fileName`, `ui.theme` and `tools.exclude`. Versions up to 0.23 moved the old top-level keys into place when they loaded a settings file. Version 0.24 removed that migration, and current versions keep an unknown top-level key without reading it and without a warning.

So a committed `.gemini/settings.json` with `{ "contextFileName": "AGENTS.md" }` no longer makes Gemini CLI read `AGENTS.md`: it reads only `GEMINI.md`. Every old key this rule reports has a nested place in the current settings schema.

Move each key to its nested place, for example `"context": { "fileName": "AGENTS.md" }`.

## Evidence

- [Gemini CLI: Configuration](https://geminicli.com/docs/reference/configuration/), verified, checked 2026-10-30
- [Gemini CLI source: cli/src/config/config.ts (context.fileName sets the context file names)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts), verified, checked 2026-10-30
- [Gemini CLI source: settings.ts (workspace settings of the working directory)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts), verified, checked 2026-10-30
- [Gemini CLI source: settings-validation.ts (unknown top-level settings keys are kept, not read)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings-validation.ts), verified, checked 2026-10-17
- [Gemini CLI 0.23.0 source: settings.ts (MIGRATION_MAP, the last release that moved top-level keys)](https://github.com/google-gemini/gemini-cli/blob/v0.23.0/packages/cli/src/config/settings.ts), verified, checked 2026-10-17

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "gemini/settings-key-ignored": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line gemini/settings-key-ignored -- reason -->
```
