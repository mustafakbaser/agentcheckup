<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `analysis/partial`

File was only partly analyzed.

|            |                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity   | `info`                                                                                                                                                                                                                                                                                                                                           |
| Category   | `clarity`                                                                                                                                                                                                                                                                                                                                        |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline                                                                                                                                                                                                                                                                       |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cline-workflow`, `imported-file` |
| Fixable    | No                                                                                                                                                                                                                                                                                                                                               |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                                          |

## Why

agentcheckup limits the time and memory it spends on each file, because the Markdown parser it uses can take tens of seconds on a small crafted file. It analyzes at most the first 131,072 characters and 8,192 lines of a file, and fewer when the scan-wide budget runs low. Past a cost estimate it also skips list, block quote and setext heading structure, simplifies deeply nested lines, and ignores inline formatting in the most expensive paragraphs.

Rules do not check the skipped parts, so findings there can be missing. This notice never affects the score. Files that an instruction file imports with `@path`, such as a `README.md`, are checked too; they are parsed after the agent configuration, so a large imported file does not take the budget the configuration needs.

An instruction file this large is costly for agents too: Codex reads at most 32 KiB of `AGENTS.md` files, and Claude Code recommends `CLAUDE.md` files under 200 lines. Split the file or move reference material out of it.

## Evidence

- [ADR 0003: Treat scanned repositories as hostile](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/adr/0003-treat-scanned-repositories-as-hostile.md), verified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "analysis/partial": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line analysis/partial -- reason -->
```
