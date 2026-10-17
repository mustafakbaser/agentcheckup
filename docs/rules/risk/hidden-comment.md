<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `risk/hidden-comment`

HTML comment hides instructions for the agent from human readers.

|            |                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity   | `info`                                                                                                                                                                                                                                                                                                                                           |
| Category   | `risk`                                                                                                                                                                                                                                                                                                                                           |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                                                                                                          |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cline-workflow`, `imported-file` |
| Fixable    | No                                                                                                                                                                                                                                                                                                                                               |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                                          |

## Why

An HTML comment does not show in rendered Markdown, on GitHub or in most editors, but it is still part of the file. Codex passes `AGENTS.md` to the model as written, comments included, and the other agents do not document removing comments; only Claude Code documents removing block-level HTML comments, from `CLAUDE.md`. Instructions in a comment therefore reach the agent while a reviewer of the rendered file never sees them.

This rule reports comments that read as instructions for an AI agent: they address the agent ("Note for AI agents: …"), try to override its instructions ("ignore all previous instructions"), or ask it to hide something from the user. Short comments, agentcheckup directives and text that is not English prose are not reported. Files that an instruction file imports with `@path` are checked too, because the agent loads them with the file that imports them.

Move instructions you intend into visible text, or delete them.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [AGENTS.md open format](https://agents.md/), verified, checked 2026-10-14
- [Cursor: Rules (does not say whether HTML comments reach the model)](https://cursor.com/docs/rules), unverified, checked 2026-10-14
- [GitHub Copilot: Repository custom instructions (does not say whether HTML comments reach the model)](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions), unverified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "risk/hidden-comment": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line risk/hidden-comment -- reason -->
```
