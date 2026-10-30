<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `agent/model-not-documented`

Agent definition sets a model value the agent does not document.

|            |                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                        |
| Category   | `correctness`                                                                                 |
| Platforms  | Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Devin Local                           |
| Applies to | `claude-agent`, `codex-agent`, `cursor-agent`, `gemini-agent`, `copilot-agent`, `devin-agent` |
| Fixable    | No                                                                                            |
| Since      | 2026.10                                                                                       |

## Why

Each agent documents the values its agent files take for `model`. Claude Code takes an alias (`sonnet`, `opus`, `haiku`, `fable`), a full model id or `inherit`; Cursor takes `inherit` or one of its model ids; Gemini CLI takes `inherit` or a model id; Codex takes a model id; GitHub Copilot takes a model id or the name its model picker shows; Devin Local takes the values of its `--model` flag. A value outside them, such as `Claude Sonnet 4` for Claude Code, may run the agent on another model than the one you meant, or none: what the agent does with it is not documented.

The rule judges a file by the agent whose format it is. Cursor and the Copilot CLI read Claude Code's `.claude/agents` too, where a Claude alias is not a value they document, though Copilot in VS Code maps it; `agentcheckup agents` shows that, and the file is right for Claude Code, so it is not reported. A file `.claude/agents` reaches through a symlink is judged as Claude Code's too.

Set a value the agent documents, or remove `model` to use the default.

## Evidence

- [Claude Code: Subagents](https://code.claude.com/docs/en/sub-agents), verified, checked 2026-10-14
- [Claude Code: Model configuration](https://code.claude.com/docs/en/model-config), verified, checked 2026-10-30
- [Codex: Subagents and custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents), verified, checked 2026-10-26
- [Cursor: Subagents](https://cursor.com/docs/subagents), verified, checked 2026-10-26
- [Gemini CLI: Subagents](https://geminicli.com/docs/core/subagents/), verified, checked 2026-10-26
- [VS Code: Custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents), verified, checked 2026-10-26
- [VS Code: Custom agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference), verified, checked 2026-10-30
- [GitHub Copilot CLI: Custom agents reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), verified, checked 2026-10-30
- [Devin CLI: Subagents](https://docs.devin.ai/cli/subagents), verified, checked 2026-10-26

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "agent/model-not-documented": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line agent/model-not-documented -- reason -->
```
